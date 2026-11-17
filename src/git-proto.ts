// src/git-proto.ts — git smart HTTP: pkt-line framing, v0/v2 upload-pack
// (info/refs, ls-refs, fetch) and v0 receive-pack, ref advertisement,
// fast-forward checks and report-status.
//
// The handler never throws out: malformed input anywhere is answered 400
// with a short text body and the store is left untouched. No clock, no
// randomness, no I/O beyond the request/response pair.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendRaw } from './util.ts';
import {
  buildPack,
  parseCommit,
  parsePack,
  parseTag,
  walkReachable,
} from './git-objects.ts';
import type { GitObject } from './git-objects.ts';
import type { Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_RE = /^[0-9a-f]{40}$/;
const PKT_LINE_MAX = 65520;
/** Pack bytes per sideband packet: pkt-line max minus its 4-byte length
 *  header minus the 1-byte sideband channel. */
const SIDEBAND_CHUNK = PKT_LINE_MAX - 5;

/** The store surface this handler needs. The real Store satisfies it. */
export interface GitStore {
  getRepo(owner: string, name: string): Repo | undefined;
  token: string;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

function pktLineBuf(payload: Buffer): Buffer {
  if (payload.length + 4 > PKT_LINE_MAX) {
    throw new Error('pkt-line payload too large');
  }
  const header = Buffer.alloc(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, payload]);
}

/** Frame a string as one pkt-line (4-hex length + utf8 payload). */
export function pktLine(s: string): Buffer {
  return pktLineBuf(Buffer.from(s, 'utf8'));
}

/** The flush packet, "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** Decode a whole pkt-line stream. Returns one entry per packet: the
 *  payload string for a data packet, null for a flush (0000) or delim
 *  (0001) packet — both act as section boundaries for the parsers here.
 *  Throws on any garbage. Callers must catch. */
export function parsePktLines(buf: Buffer): (string | null)[] {
  const out: (string | null)[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    const len = Number.parseInt(head, 16);
    if (len === 0 || len === 1) {
      out.push(null);
      offset += 4;
      continue;
    }
    if (len < 4) throw new Error(`bad pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  return out;
}

/** Split parsed pkt-lines into sections on null (flush/delim) entries. */
function splitSections(lines: (string | null)[]): string[][] {
  const sections: string[][] = [[]];
  for (const item of lines) {
    if (item === null) sections.push([]);
    else (sections[sections.length - 1] as string[]).push(item);
  }
  return sections;
}

/** Wrap bytes in sideband band-1 packets, each framed as a pkt-line. */
function sidebandPackets(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += SIDEBAND_CHUNK) {
    const chunk = data.subarray(off, off + SIDEBAND_CHUNK);
    parts.push(pktLineBuf(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

interface RefInfo {
  name: string;
  oid: string;
  /** Commit an annotated tag peels to, if this ref points at a tag. */
  peeled?: string;
}

/** Peel an oid through annotated tags to its commit, or undefined when the
 *  oid is not a tag pointing (transitively) at a commit. */
function peelToCommit(
  objects: Map<string, GitObject>,
  oid: string,
): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return undefined;
    if (seen.has(current)) return undefined;
    seen.add(current);
    let tag;
    try {
      tag = parseTag(obj.data);
    } catch {
      return undefined;
    }
    if (tag.type !== 'commit') return undefined;
    current = tag.object;
  }
}

function sortedRefs(repo: Repo): RefInfo[] {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => {
    const oid = repo.refs.get(name) as string;
    const info: RefInfo = { name, oid };
    const peeled = peelToCommit(repo.objects, oid);
    if (peeled !== undefined && peeled !== oid) info.peeled = peeled;
    return info;
  });
}

function uploadPackCaps(repo: Repo): string {
  return (
    `symref=HEAD:refs/heads/${repo.defaultBranch} ` +
    'side-band-64k multi_ack_detailed thin-pack ofs-delta shallow'
  );
}

const RECEIVE_PACK_CAPS = 'report-status side-band-64k delete-refs ofs-delta';

/** v0 advertisement: service preamble + flush, then ref lines with the
 *  capabilities after a NUL on the first line, then a flush. HEAD is
 *  listed first; peeled tags get extra "<oid> <ref>^{}" lines. An empty
 *  repo (or an unborn default branch) is advertised with the zero oid. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps = service === 'git-upload-pack' ? uploadPackCaps(repo) : RECEIVE_PACK_CAPS;
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  const lines: string[] = [`${tip ?? ZERO_OID} HEAD`];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} ${defaultRef}`);
  } else {
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 upload-pack advertisement: service preamble, then "version 2" and
 *  one capability per line. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow unborn\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function handleInfoRefs(
  repo: Repo,
  service: 'git-upload-pack' | 'git-receive-pack',
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const isV2 =
    service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
  const contentType =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  const body = isV2 ? v2Advertisement() : v0Advertisement(repo, service);
  sendRaw(res, 200, body, { 'content-type': contentType });
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, lines: (string | null)[], res: ServerResponse): void {
  const sections = splitSections(lines);
  const commandSection = sections[0] ?? [];
  const argSection = sections[1] ?? [];
  const command = (commandSection[0] ?? '').replace(/\n$/, '');
  if (command !== 'command=ls-refs') {
    throw new Error('ls-refs: first line is not command=ls-refs');
  }
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of argSection) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') {
      // Unborn refs are listed whenever the branch is unborn; nothing to do.
    } else if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
    }
    // Anything else (agent, object-format, unknown args) is ignored.
  }
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  if (matches('HEAD')) {
    if (tip === undefined) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}`);
    } else {
      out.push(`${tip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    out.push(line);
  }
  if (tip === undefined && matches(defaultRef)) {
    out.push(`unborn ${defaultRef}`);
  }
  const parts = out.map((line) => pktLine(`${line}\n`));
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), {
    'content-type': 'application/x-git-upload-pack-result',
  });
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

/** One parser for both shapes: v2 (command section, delim, args) and v0
 *  (wants section, flush, haves section). deepen-since / deepen-not and
 *  filter lines are parsed and ignored (depth unlimited). */
function parseFetchArgs(lines: (string | null)[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const section of splitSections(lines)) {
    for (const raw of section) {
      const line = raw.replace(/\n$/, '');
      if (
        line === 'command=fetch' ||
        line.startsWith('agent=') ||
        line.startsWith('object-format=') ||
        line === 'thin-pack' ||
        line === 'no-progress' ||
        line === 'ofs-delta' ||
        line === 'done' ||
        line.startsWith('filter ') ||
        line.startsWith('deepen-since ') ||
        line.startsWith('deepen-not ')
      ) {
        continue;
      }
      if (line.startsWith('want ')) {
        // v0 puts capabilities after the oid on the first want line.
        const oid = line.slice(5).trim().split(/\s+/)[0] ?? '';
        if (oid.length > 0) args.wants.push(oid);
      } else if (line.startsWith('have ')) {
        args.haves.push(line.slice(5).trim());
      } else if (line.startsWith('shallow ')) {
        args.shallow.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
      // Unknown lines are ignored: a fetch must not die on an extra arg.
    }
  }
  return args;
}

interface FetchPlan {
  toSend: Map<string, GitObject>;
  shallowOut: string[];
  unshallowOut: string[];
  ack: string | null;
  wantedRefs: Array<{ oid: string; ref: string }>;
}

function computeFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const objects = repo.objects;
  const wants = [...new Set(args.wants)].filter((oid) => OID_RE.test(oid));
  const haves = [...new Set(args.haves)].filter((oid) => OID_RE.test(oid));
  const shallowSet = new Set(args.shallow.filter((oid) => OID_RE.test(oid)));

  const fullWant = walkReachable(objects, wants);
  const wantWalk =
    args.depth !== undefined ? walkReachable(objects, wants, { depth: args.depth }) : fullWant;
  // Objects the client already holds: walk the haves, but never cross a
  // known shallow boundary (the client holds the boundary commit and its
  // tree/blobs, not its parents).
  const haveWalk =
    haves.length > 0
      ? walkReachable(objects, haves, { boundary: shallowSet })
      : new Map<string, GitObject>();
  const toSend = new Map<string, GitObject>();
  for (const [oid, obj] of wantWalk) {
    if (!haveWalk.has(oid)) toSend.set(oid, obj);
  }

  // Boundary commits of the walk: commits whose parents exist in the store
  // but were cut off (by depth). Those are the new shallow boundaries.
  const shallowOut: string[] = [];
  for (const oid of wantWalk.keys()) {
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let commit;
    try {
      commit = parseCommit(obj.data);
    } catch {
      continue;
    }
    for (const parent of commit.parents) {
      if (objects.has(parent) && !wantWalk.has(parent)) {
        shallowOut.push(oid);
        break;
      }
    }
  }
  shallowOut.sort();
  // Previously-shallow boundaries that this walk fully expanded.
  const unshallowOut: string[] = [];
  for (const oid of shallowSet) {
    if (!wantWalk.has(oid)) continue;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let commit;
    try {
      commit = parseCommit(obj.data);
    } catch {
      continue;
    }
    const expanded = commit.parents.every(
      (p) => !objects.has(p) || wantWalk.has(p),
    );
    if (expanded) unshallowOut.push(oid);
  }
  unshallowOut.sort();

  let ack: string | null = null;
  for (const have of haves) {
    if (fullWant.has(have)) {
      ack = have;
      break;
    }
  }
  const wantSet = new Set(wants);
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    if (wantSet.has(oid)) wantedRefs.push({ oid, ref: name });
  }
  return { toSend, shallowOut, unshallowOut, ack, wantedRefs };
}

function sendFetchV2(res: ServerResponse, plan: FetchPlan): void {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.ack !== null) {
    parts.push(pktLine(`ACK ${plan.ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  parts.push(pktLine('shallow-info\n'));
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktFlush());
  parts.push(pktLine('wanted-refs\n'));
  for (const ref of plan.wantedRefs) parts.push(pktLine(`${ref.oid} ${ref.ref}\n`));
  parts.push(pktFlush());
  parts.push(pktLine('packfile\n'));
  if (plan.toSend.size > 0) parts.push(...sidebandPackets(buildPack(plan.toSend)));
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), {
    'content-type': 'application/x-git-upload-pack-result',
  });
}

function sendFetchV0(res: ServerResponse, plan: FetchPlan): void {
  const parts: Buffer[] = [];
  if (plan.ack !== null) parts.push(pktLine(`ACK ${plan.ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.toSend.size > 0) parts.push(...sidebandPackets(buildPack(plan.toSend)));
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), {
    'content-type': 'application/x-git-upload-pack-result',
  });
}

function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = parsePktLines(body);
  const first = lines.find((line) => line !== null);
  if (first === undefined) throw new Error('upload-pack: empty request');
  if (first.startsWith('command=ls-refs')) {
    handleLsRefs(repo, lines, res);
    return;
  }
  const args = parseFetchArgs(lines);
  const plan = computeFetch(repo, args);
  if (first.startsWith('command=fetch')) sendFetchV2(res, plan);
  else sendFetchV0(res, plan);
}

// ---------------------------------------------------------------------------
// receive-pack (v0 only)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its pkt-lined command section (up to the
 *  first flush) and the raw pack bytes that follow. Throws on malformed
 *  framing. */
function splitCommands(body: Buffer): { lines: string[]; packOffset: number } {
  const lines: string[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) {
      throw new Error('receive-pack: commands not terminated by flush');
    }
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error('receive-pack: bad pkt-line header');
    }
    const len = Number.parseInt(head, 16);
    if (len === 0) return { lines, packOffset: offset + 4 };
    if (len < 4) throw new Error('receive-pack: bad pkt-line length');
    if (offset + len > body.length) {
      throw new Error('receive-pack: truncated command line');
    }
    lines.push(body.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
}

/** True when `ancestor` is reachable from `descendant` by following
 *  parents (tag oids are peeled to their commit first). */
function isAncestor(
  objects: Map<string, GitObject>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const start = peelToCommit(objects, descendant);
  if (start === undefined) return false;
  const target = peelToCommit(objects, ancestor);
  const queue: string[] = [start];
  const seen = new Set<string>([start]);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (oid === ancestor || oid === target) return true;
    const obj = objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    let commit;
    try {
      commit = parseCommit(obj.data);
    } catch {
      continue;
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

function applyCommand(
  repo: Repo,
  cmd: PushCommand,
): { ok: boolean; reason?: string } {
  const current = repo.refs.get(cmd.ref);
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'non-fast-forward' };
    if (cmd.newOid === ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ok: true };
  }
  if (cmd.newOid === ZERO_OID) {
    // Delete (idempotent: deleting a ref that does not exist is ok).
    if (current === undefined) return { ok: true };
    if (cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ok: true };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (cmd.oldOid === cmd.newOid) return { ok: true };
  if (!repo.objects.has(cmd.newOid)) return { ok: false, reason: 'object not found' };
  if (!isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ok: true };
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { lines, packOffset } = splitCommands(body);
  if (lines.length === 0) throw new Error('receive-pack: no commands');
  let caps = '';
  const commands: PushCommand[] = [];
  lines.forEach((rawLine, index) => {
    let text = rawLine.replace(/\n$/, '');
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        caps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/);
    if (m === null) {
      throw new Error(`receive-pack: bad command line ${JSON.stringify(text.slice(0, 80))}`);
    }
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  });
  const sideband = caps.split(' ').includes('side-band-64k');
  const packBytes = body.subarray(packOffset);
  const needsPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'empty pack';
    } else {
      try {
        const parsed = parsePack(packBytes);
        for (const [oid, obj] of parsed.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch {
        unpackOk = false;
        unpackDetail = 'pack parse failed';
      }
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const result = applyCommand(repo, cmd);
    reportLines.push(
      result.ok ? `ok ${cmd.ref}` : `ng ${cmd.ref} ${result.reason ?? 'failed'}`,
    );
  }
  // The report-status stream is itself pkt-lined; with side-band-64k it
  // travels inside band-1 packets, otherwise raw.
  const inner = Buffer.concat([
    ...reportLines.map((line) => pktLine(`${line}\n`)),
    pktFlush(),
  ]);
  const out = sideband
    ? Buffer.concat([...sidebandPackets(inner), pktFlush()])
    : inner;
  sendRaw(res, 200, out, {
    'content-type': 'application/x-git-receive-pack-result',
  });
}

// ---------------------------------------------------------------------------
// router entry point
// ---------------------------------------------------------------------------

/** Handle one request. Returns true when the path is a git smart-HTTP
 *  route (handled, or answered with a git-flavoured error), false when
 *  the path is not ours and another router should try it. Never throws. */
export async function handleGitRequest(
  store: GitStore,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  let pathname: string;
  let search: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    search = url.searchParams;
  } catch {
    return false;
  }
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/);
  if (m === null) return false;
  const owner = m[1] as string;
  const repoName = m[2] as string;
  const suffix = m[3] ?? '';
  if (!NAME_RE.test(owner) || !NAME_RE.test(repoName) || repoName.endsWith('.git')) {
    return false;
  }
  try {
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendRaw(res, 404, Buffer.from('Not Found', 'utf8'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return true;
    }
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${store.token}`) {
      sendRaw(res, 401, Buffer.from('Unauthorized', 'utf8'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return true;
    }
    if (suffix === 'info/refs' && req.method === 'GET') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendRaw(res, 400, Buffer.from('bad request', 'utf8'), {
          'content-type': 'text/plain; charset=utf-8',
        });
        return true;
      }
      handleInfoRefs(repo, service, req, res);
      return true;
    }
    if (suffix === 'git-upload-pack' && req.method === 'POST') {
      const body = await readBody(req);
      handleUploadPack(repo, body, res);
      return true;
    }
    if (suffix === 'git-receive-pack' && req.method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(repo, body, res);
      return true;
    }
    sendRaw(res, 404, Buffer.from('Not Found', 'utf8'), {
      'content-type': 'text/plain; charset=utf-8',
    });
    return true;
  } catch {
    // Malformed input, a bad pack, an oversized body: answer 400 and keep
    // the server (and the store) healthy. Never throw out of the handler.
    try {
      if (!res.headersSent) {
        sendRaw(res, 400, Buffer.from('bad request', 'utf8'), {
          'content-type': 'text/plain; charset=utf-8',
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {
      // The socket is already gone; nothing more to do.
    }
    return true;
  }
}
