// src/git-objects.ts — git object model: SHA-1 ids, commit/tree/tag
// parse+serialize, pack v2 build/parse (including deltas), reachability
// walks, tree updates and commit creation.
//
// Pure and deterministic: no clock, no randomness, no I/O. Object bytes
// pushed by a client are stored and re-emitted exactly as received; these
// helpers never rewrite an object. Data held in a GitObject is the raw
// content WITHOUT the "<type> <len>\0" header; the SHA-1 is over header+data.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** A repo's git state, structurally: only the fields the git layer needs. */
export interface GitRepo {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
const CODE_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** SHA-1 hex of "<type> <len>\0" + data. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

export interface CommitPerson {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export interface CommitHeader {
  key: string;
  value: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: CommitPerson;
  committer: CommitPerson;
  message: string;
  /** Every header line in original order (continuation lines folded into
   *  the previous header's value). serializeCommit rebuilds from these, so
   *  a parse -> serialize round-trip is byte-exact, including unknown
   *  headers. */
  headers: CommitHeader[];
  raw: Buffer;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: CommitPerson | null;
  message: string;
  headers: CommitHeader[];
  raw: Buffer;
}

function parsePerson(value: string): CommitPerson {
  const fallback: CommitPerson = { name: value.trim(), email: '', time: 0, tz: '+0000' };
  const lt = value.lastIndexOf('<');
  const gt = value.lastIndexOf('>');
  if (lt < 0 || gt < lt) return fallback;
  const name = value.slice(0, lt).trim();
  const email = value.slice(lt + 1, gt);
  const rest = value.slice(gt + 1).trim().split(/\s+/).filter((s) => s.length > 0);
  const time = rest.length > 0 ? Number.parseInt(rest[0] as string, 10) : 0;
  return {
    name,
    email,
    time: Number.isFinite(time) ? time : 0,
    tz: rest.length > 1 ? (rest[1] as string) : '+0000',
  };
}

function formatPerson(person: CommitPerson): string {
  return `${person.name} <${person.email}> ${person.time} ${person.tz}`;
}

function splitHeadersAndMessage(data: Buffer): {
  headers: CommitHeader[];
  message: string;
} {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const headers: CommitHeader[] = [];
  if (headerText.length > 0) {
    for (const line of headerText.split('\n')) {
      // A line starting with a space continues the previous header.
      if (line.startsWith(' ') && headers.length > 0) {
        const prev = headers[headers.length - 1] as CommitHeader;
        prev.value += `\n${line}`;
        continue;
      }
      const space = line.indexOf(' ');
      if (space < 0) headers.push({ key: line, value: '' });
      else headers.push({ key: line.slice(0, space), value: line.slice(space + 1) });
    }
  }
  return { headers, message };
}

function serializeHeadersAndMessage(headers: CommitHeader[], message: string): Buffer {
  const head = headers.map((h) => `${h.key} ${h.value}`).join('\n');
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    Buffer.from('\n\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
}

export function parseCommit(data: Buffer): ParsedCommit {
  const { headers, message } = splitHeadersAndMessage(data);
  let tree = '';
  const parents: string[] = [];
  let author: CommitPerson = { name: '', email: '', time: 0, tz: '+0000' };
  let committer: CommitPerson = { name: '', email: '', time: 0, tz: '+0000' };
  for (const header of headers) {
    if (header.key === 'tree' && tree === '') tree = header.value;
    else if (header.key === 'parent') parents.push(header.value);
    else if (header.key === 'author') author = parsePerson(header.value);
    else if (header.key === 'committer') committer = parsePerson(header.value);
  }
  return { tree, parents, author, committer, message, headers, raw: Buffer.from(data) };
}

/** Byte-exact for anything parseCommit produced (headers + message bytes). */
export function serializeCommit(commit: ParsedCommit): Buffer {
  return serializeHeadersAndMessage(commit.headers, commit.message);
}

export function parseTag(data: Buffer): ParsedTag {
  const { headers, message } = splitHeadersAndMessage(data);
  let object = '';
  let type = '';
  let tag = '';
  let tagger: CommitPerson | null = null;
  for (const header of headers) {
    if (header.key === 'object' && object === '') object = header.value;
    else if (header.key === 'type' && type === '') type = header.value;
    else if (header.key === 'tag' && tag === '') tag = header.value;
    else if (header.key === 'tagger') tagger = parsePerson(header.value);
  }
  return { object, type, tag, tagger, message, headers, raw: Buffer.from(data) };
}

/** Byte-exact for anything parseTag produced. */
export function serializeTag(tag: ParsedTag): Buffer {
  return serializeHeadersAndMessage(tag.headers, tag.message);
}

// ---------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: entry has no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) {
      throw new Error('malformed tree: entry has no name terminator or sha');
    }
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git tree order: by name, with directory names compared as if they had a
 *  trailing '/'. Modes are emitted exactly as stored ('40000' for dirs). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const keyOf = (entry: TreeEntry): Buffer =>
    Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
  const sorted = [...entries].sort((a, b) => Buffer.compare(keyOf(a), keyOf(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!/^[0-9a-f]{40}$/.test(entry.sha)) {
      throw new Error(`tree entry ${entry.name} has a bad sha ${JSON.stringify(entry.sha)}`);
    }
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

/** Pack object header: type/size varint (first byte holds 4 size bits). */
function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Pack v2, undeltified entries only, objects in deterministic sha order,
 *  each zlib-deflated at level 6, then the 20-byte SHA-1 trailer. */
export function buildPack(objects: Map<string, GitObject>): Buffer {
  const shas = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = objects.get(sha) as GitObject;
    parts.push(packObjectHeader(TYPE_CODE[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate one zlib stream starting at `offset` (never past `limit`);
 *  returns its bytes and the offset just past the stream. */
function inflateAt(
  buf: Buffer,
  offset: number,
  limit: number,
): { data: Buffer; next: number } {
  const view = buf.subarray(offset, limit);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(
      `zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`,
    );
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) {
    throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  }
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta to a base object's bytes (copy/insert instruction
 *  stream; first two varints are the source and target sizes). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) {
        throw new Error('delta copy is out of the base');
      }
      if (written + copySize > targetSize) {
        throw new Error('delta writes past its target size');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) {
        throw new Error('delta writes past its target size');
      }
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) {
    throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  }
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: Buffer;
  resolvedType?: GitObjectType;
  oid?: string;
}

/** Parse a pack (version 2 or 3), resolve OFS_DELTA / REF_DELTA entries
 *  against bases in the same pack, and verify the SHA-1 trailer. Throws on
 *  any mismatch or truncation. */
export function parsePack(buf: Buffer): {
  objects: Map<string, GitObject>;
  count: number;
} {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported pack version ${version}`);
  }
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1')
    .update(buf.subarray(0, trailerStart))
    .digest('hex');
  if (trailer !== computedTrailer) {
    throw new Error('pack trailer checksum mismatch');
  }

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = buf[offset] as number;
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = buf[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawPackEntry = {
      offset: entryOffset,
      typeCode,
      size,
      data: Buffer.alloc(0),
    };
    if (typeCode === 6) {
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      byte = buf[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = buf[offset] as number;
        offset += 1;
        value = (value + 1) * 128 + (byte & 0x7f);
      }
      if (value <= 0 || value > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${value}`);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf, offset, trailerStart);
    if (inflated.data.length !== size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) {
      throw new Error(`delta cycle at pack offset ${entry.offset}`);
    }
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) {
        throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      }
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (baseEntry === undefined) {
        throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      }
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) {
      objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    }
  }
  return { objects, count };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export interface WalkOptions {
  /** Commit generations to follow from each tip (1 = tips only). Omit for
   *  the full history. Trees/blobs of an included commit are always whole. */
  depth?: number;
  /** Oids to subtract from the result after walking. */
  exclude?: Set<string>;
  /** Commits whose parents are not followed (included with their trees,
   *  like a shallow boundary). Used for the haves side of a fetch. */
  boundary?: Set<string>;
}

/** Everything reachable from `tips`: commits (parents), their trees
 *  (recursive) and blobs; annotated tags contribute the tag object plus
 *  their target. Missing objects are skipped, never fatal. */
export function walkReachable(
  objects: Map<string, GitObject>,
  tips: string[],
  opts: WalkOptions = {},
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const depth = opts.depth;
  const boundary = opts.boundary ?? new Set<string>();
  const expanded = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, level: 1 });
  let head = 0;

  const addTree = (treeSha: string): void => {
    const stack: string[] = [treeSha];
    const seenTrees = new Set<string>();
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seenTrees.has(sha)) continue;
      seenTrees.add(sha);
      const obj = objects.get(sha);
      if (obj === undefined || obj.type !== 'tree') continue;
      out.set(sha, obj);
      let entries: TreeEntry[];
      try {
        entries = parseTree(obj.data);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const child = objects.get(entry.sha);
        if (child === undefined) continue;
        if (entry.mode === '40000') stack.push(entry.sha);
        else out.set(entry.sha, child);
      }
    }
  };

  while (head < queue.length) {
    const item = queue[head] as { oid: string; level: number };
    head += 1;
    const obj = objects.get(item.oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (out.has(item.oid)) continue;
      out.set(item.oid, obj);
      let tag: ParsedTag;
      try {
        tag = parseTag(obj.data);
      } catch {
        continue;
      }
      const target = objects.get(tag.object);
      if (target === undefined) continue;
      if (target.type === 'commit') queue.push({ oid: tag.object, level: item.level });
      else if (target.type === 'tree') addTree(tag.object);
      else out.set(tag.object, target);
      continue;
    }
    if (obj.type === 'tree') {
      addTree(item.oid);
      continue;
    }
    if (obj.type === 'blob') {
      out.set(item.oid, obj);
      continue;
    }
    // commit
    if (expanded.has(item.oid)) continue;
    expanded.add(item.oid);
    out.set(item.oid, obj);
    let commit: ParsedCommit;
    try {
      commit = parseCommit(obj.data);
    } catch {
      continue;
    }
    addTree(commit.tree);
    if ((depth === undefined || item.level < depth) && !boundary.has(item.oid)) {
      for (const parent of commit.parents) {
        queue.push({ oid: parent, level: item.level + 1 });
      }
    }
  }

  if (opts.exclude !== undefined) {
    for (const oid of opts.exclude) out.delete(oid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// tree updates and commit creation
// ---------------------------------------------------------------------------

function emptyTreeSha(objects: Map<string, GitObject>): string {
  const data = serializeTree([]);
  const sha = hashObject('tree', data);
  if (!objects.has(sha)) objects.set(sha, { type: 'tree', data });
  return sha;
}

/** Recursive worker: returns the new tree sha, or null when the tree
 *  became empty (the caller then drops the directory entry). */
function updateTreeRec(
  objects: Map<string, GitObject>,
  treeSha: string | null,
  segments: string[],
  blobSha: string | null,
): string | null {
  let entries: TreeEntry[] = [];
  if (treeSha !== null) {
    const obj = objects.get(treeSha);
    if (obj !== undefined && obj.type === 'tree') {
      try {
        entries = parseTree(obj.data);
      } catch {
        entries = [];
      }
    }
  }
  if (segments.length === 0) {
    if (treeSha === null) return null;
    return treeSha;
  }
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) {
      entries[idx] = { mode: '100644', name: head, sha: blobSha };
    } else {
      entries.push({ mode: '100644', name: head, sha: blobSha });
    }
  } else {
    const childSha =
      idx !== -1 && entries[idx]?.mode === '40000' ? (entries[idx] as TreeEntry).sha : null;
    if (blobSha === null && childSha === null) {
      // Deleting below a directory that does not exist: no change.
    } else {
      const newChild = updateTreeRec(objects, childSha, rest, blobSha);
      if (newChild === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '40000', name: head, sha: newChild };
      } else {
        entries.push({ mode: '40000', name: head, sha: newChild });
      }
    }
  }
  if (entries.length === 0) return null;
  const data = serializeTree(entries);
  const sha = hashObject('tree', data);
  if (!objects.has(sha)) objects.set(sha, { type: 'tree', data });
  return sha;
}

/** Return the sha of a new tree equal to `baseTreeSha` with `path` set to
 *  `blobSha` (or removed when `blobSha` is null). Creates intermediate
 *  directory trees as needed and prunes directories emptied by a removal;
 *  writes every new tree object into `objects`. A null base tree starts
 *  from empty; a fully-emptied root yields the empty tree. */
export function updateTree(
  objects: Map<string, GitObject>,
  baseTreeSha: string | null,
  path: string,
  blobSha: string | null,
): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  const result = updateTreeRec(objects, baseTreeSha, segments, blobSha);
  if (result === null) return emptyTreeSha(objects);
  return result;
}

export interface CreateCommitOptions {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

/** Build a commit object (`tree`, `parent` lines, `author`/`committer` with
 *  `<unix> +0000`, blank line, message exactly as given), store it in
 *  `objects`, return its sha. The caller supplies all timestamps. */
export function createCommit(
  objects: Map<string, GitObject>,
  opts: CreateCommitOptions,
): string {
  const author: CommitPerson = {
    name: opts.authorName,
    email: opts.authorEmail,
    time: opts.authorTime,
    tz: '+0000',
  };
  const committer: CommitPerson = {
    name: opts.committerName,
    email: opts.committerEmail,
    time: opts.committerTime,
    tz: '+0000',
  };
  const headers: CommitHeader[] = [{ key: 'tree', value: opts.tree }];
  for (const parent of opts.parents) headers.push({ key: 'parent', value: parent });
  headers.push({ key: 'author', value: formatPerson(author) });
  headers.push({ key: 'committer', value: formatPerson(committer) });
  const data = serializeHeadersAndMessage(headers, opts.message);
  const sha = hashObject('commit', data);
  if (!objects.has(sha)) objects.set(sha, { type: 'commit', data });
  return sha;
}
