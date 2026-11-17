// Store: the single in-memory state for the forge — repos, git objects, issues,
// pulls, labels and comments. One instance is constructed in app.ts and shared
// by the REST, GraphQL, MCP and git handlers.
//
// Determinism: every timestamp comes from the LogicalClock (never the wall
// clock, never Math.random). Git objects are content-addressed with SHA-1 via
// hashObject() from ./git-objects.ts; commit/tree bytes are built and parsed
// here so this module depends on exactly one git-objects export.

import { LogicalClock } from './util.ts';
import { hashObject } from './git-objects.ts';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  user: { login: string; id: number };
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string }[];
  user: { login: string; id: number };
  assignee: null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string; id: number };
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface Repo {
  id: number;
  databaseId: number;
  name: string;
  owner: string;
  ownerId: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
}

/** Derive the login a bearer token names. See the task contract. */
export function deriveLogin(token: string): string {
  const loginRe = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
  if (loginRe.test(token)) return token;
  // Token is itself JSON containing a login field.
  try {
    const obj = JSON.parse(token) as unknown;
    if (obj !== null && typeof obj === 'object') {
      const login = (obj as Record<string, unknown>).login;
      if (typeof login === 'string' && login.length > 0) return login;
    }
  } catch {
    // Not plain JSON; try base64url-encoded JSON next.
  }
  // Token is base64url-encoded JSON containing a login field.
  try {
    const text = Buffer.from(
      token.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const obj = JSON.parse(text) as unknown;
    if (obj !== null && typeof obj === 'object') {
      const login = (obj as Record<string, unknown>).login;
      if (typeof login === 'string' && login.length > 0) return login;
    }
  } catch {
    // Not base64url JSON either.
  }
  // Last segment after ':' or '/' that looks like a login.
  const parts = token.split(/[:/]/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  if (last !== undefined && loginRe.test(last)) return last;
  return 'viewer';
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const header = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceAt = data.indexOf(0x20, offset);
    if (spaceAt === -1) break;
    const mode = data.toString('utf8', offset, spaceAt);
    const nulAt = data.indexOf(0x00, spaceAt + 1);
    if (nulAt === -1 || nulAt + 21 > data.length) break;
    const name = data.toString('utf8', spaceAt + 1, nulAt);
    const sha = data.subarray(nulAt + 1, nulAt + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nulAt + 21;
  }
  return entries;
}

function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function withTrailingNewline(message: string): string {
  return message.endsWith('\n') ? message : `${message}\n`;
}

export class Store {
  tokenLogin: string;
  token: string;
  clock: LogicalClock;
  repos: Map<string, Repo>;
  private requestCounter = 0;
  private repoCounter = 0;

  constructor(tokenLogin: string, token = '') {
    this.tokenLogin = tokenLogin;
    this.token = token;
    this.clock = new LogicalClock();
    this.repos = new Map<string, Repo>();
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  nextRepoId(): number {
    this.repoCounter += 1;
    return this.repoCounter;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  createRepo(
    owner: string,
    ownerId: number,
    name: string,
    opts: { description?: string; private?: boolean } = {},
  ): Repo {
    const id = this.nextRepoId();
    const ts = this.clock.now();
    const repo: Repo = {
      id,
      databaseId: id,
      name,
      owner,
      ownerId,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      issues: [],
      pulls: [],
      labels: new Map<string, { name: string; color: string }>(),
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
      createdAt: ts,
      updatedAt: ts,
      pushedAt: ts,
    };
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  // ---- internal git helpers ----

  private storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const sha = hashObject(type, data);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
    return sha;
  }

  private commitOf(repo: Repo, sha: string): CommitInfo | undefined {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data);
  }

  private treeOfCommit(repo: Repo, commitSha: string): string | undefined {
    const commit = this.commitOf(repo, commitSha);
    return commit === undefined ? undefined : commit.tree;
  }

  /** Create a commit object, store it, return its sha. */
  private makeCommit(
    repo: Repo,
    treeSha: string,
    parents: string[],
    message: string,
  ): string {
    const unix = this.clock.nowUnix();
    const email = `${this.tokenLogin}@users.noreply.github.com`;
    const ident = `${this.tokenLogin} <${email}> ${unix} +0000`;
    const lines: string[] = [`tree ${treeSha}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`);
    lines.push(`committer ${ident}`);
    const data = Buffer.from(
      `${lines.join('\n')}\n\n${withTrailingNewline(message)}`,
      'utf8',
    );
    return this.storeObject(repo, 'commit', data);
  }

  /** Ancestors of a tip, breadth-first (tip first), deduplicated. */
  private ancestors(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      order.push(sha);
      const commit = this.commitOf(repo, sha);
      if (commit !== undefined) {
        for (const parent of commit.parents) queue.push(parent);
      }
    }
    return order;
  }

  private mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const bAncestors = new Set(this.ancestors(repo, b));
    for (const sha of this.ancestors(repo, a)) {
      if (bAncestors.has(sha)) return sha;
    }
    return undefined;
  }

  /** Flatten a tree into path -> blob sha (files only). */
  private flattenTree(
    repo: Repo,
    treeSha: string | undefined,
    prefix: string,
    out: Map<string, string>,
  ): void {
    if (treeSha === undefined) return;
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.sha, path, out);
      } else {
        out.set(path, entry.sha);
      }
    }
  }

  /** Blob sha at a path within a tree, or undefined. */
  private blobAtPath(
    repo: Repo,
    treeSha: string | undefined,
    segments: string[],
  ): string | undefined {
    let current = treeSha;
    for (let i = 0; i < segments.length; i += 1) {
      if (current === undefined) return undefined;
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return undefined;
      if (i === segments.length - 1) {
        return entry.mode === '40000' ? undefined : entry.sha;
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.sha;
    }
    return undefined;
  }

  /**
   * Return the sha of a tree identical to `treeSha` except that the file at
   * `segments` holds `blobSha` (null removes it). Stores new tree objects.
   */
  private updateTree(
    repo: Repo,
    treeSha: string | undefined,
    segments: string[],
    blobSha: string | null,
  ): string {
    const entries: TreeEntry[] =
      treeSha === undefined
        ? []
        : (() => {
            const obj = repo.objects.get(treeSha);
            return obj !== undefined && obj.type === 'tree'
              ? parseTree(obj.data)
              : [];
          })();
    const [head, ...rest] = segments;
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
        idx !== -1 && entries[idx].mode === '40000' ? entries[idx].sha : undefined;
      if (blobSha === null && childSha === undefined) {
        // Deleting below a directory that does not exist: no change.
      } else {
        const newChild = this.updateTree(repo, childSha, rest, blobSha);
        const childObj = repo.objects.get(newChild);
        const childEmpty =
          childObj !== undefined &&
          childObj.type === 'tree' &&
          parseTree(childObj.data).length === 0;
        if (childEmpty) {
          if (idx !== -1) entries.splice(idx, 1);
        } else if (idx !== -1) {
          entries[idx] = { mode: '40000', name: head, sha: newChild };
        } else {
          entries.push({ mode: '40000', name: head, sha: newChild });
        }
      }
    }
    return this.storeObject(repo, 'tree', serializeTree(entries));
  }

  // ---- branches ----

  createBranch(repo: Repo, ref: string, sha: string): boolean {
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  getBranchTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  getBranchTipByName(repo: Repo, branchName: string): string | undefined {
    return repo.refs.get(`refs/heads/${branchName}`);
  }

  // ---- issues / labels / comments ----

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labels: string[] = [],
  ): Issue {
    const number = repo.issueCounter + 1;
    repo.issueCounter = number;
    const ts = this.clock.now();
    const issue: Issue = {
      id: repo.id * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      labels: labels.map((name) => ({ name })),
      user: { login: this.tokenLogin, id: 1000 },
      assignee: null,
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  closeIssue(repo: Repo, number: number): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    const ts = this.clock.now();
    issue.state = 'closed';
    issue.closed_at = ts;
    issue.updated_at = ts;
    return issue;
  }

  createLabel(
    repo: Repo,
    name: string,
    color?: string,
  ): { name: string; color: string } {
    const label = { name, color: color ?? 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment {
    const issue = this.getIssue(repo, issueNumber);
    const ts = this.clock.now();
    const comment: Comment = {
      id: repo.commentCounter + 1,
      body,
      created_at: ts,
      updated_at: ts,
      user: { login: this.tokenLogin, id: 1000 },
    };
    repo.commentCounter = comment.id;
    if (issue !== undefined) issue.comments.push(comment);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    const issue = this.getIssue(repo, issueNumber);
    return issue === undefined ? [] : [...issue.comments];
  }

  // ---- pull requests ----

  createPull(
    repo: Repo,
    head: string,
    base: string,
    title: string,
    body: string,
  ): PullRequest {
    const number = repo.pullCounter + 1;
    repo.pullCounter = number;
    const ts = this.clock.now();
    const pull: PullRequest = {
      id: repo.id * 1000000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      head: { ref: head, sha: this.getBranchTipByName(repo, head) ?? '' },
      base: { ref: base, sha: this.getBranchTipByName(repo, base) ?? '' },
      user: { login: this.tokenLogin, id: 1000 },
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  mergePull(
    repo: Repo,
    number: number,
    method: string,
  ): { ok: true; sha: string } | { ok: false; status: number; message: string } {
    const pull = this.getPull(repo, number);
    if (pull === undefined) {
      return { ok: false, status: 404, message: 'Not Found' };
    }
    if (pull.merged || pull.state !== 'open') {
      return { ok: false, status: 405, message: 'Pull request already merged or closed' };
    }
    const headTip =
      this.getBranchTipByName(repo, pull.head.ref) ?? pull.head.sha;
    const baseTip =
      this.getBranchTipByName(repo, pull.base.ref) ?? pull.base.sha;
    // Refresh the stored shas: the base branch may have moved since the PR
    // was created (e.g. another PR merged first), and conflict detection
    // must compare against the base tip as it stands now.
    const headCommit = headTip === '' ? undefined : this.commitOf(repo, headTip);
    const baseCommit = baseTip === '' ? undefined : this.commitOf(repo, baseTip);
    if (headCommit === undefined || baseCommit === undefined) {
      return { ok: false, status: 405, message: 'Merge conflict' };
    }
    // Conflict detection: a file modified on BOTH sides relative to the
    // merge-base, with different resulting blobs, cannot be squash-merged.
    const baseOfMerge = this.mergeBase(repo, headTip, baseTip);
    const mergeTree =
      baseOfMerge === undefined ? undefined : this.treeOfCommit(repo, baseOfMerge);
    const headFiles = new Map<string, string>();
    const baseFiles = new Map<string, string>();
    const ancestorFiles = new Map<string, string>();
    this.flattenTree(repo, headCommit.tree, '', headFiles);
    this.flattenTree(repo, baseCommit.tree, '', baseFiles);
    this.flattenTree(repo, mergeTree, '', ancestorFiles);
    const allPaths = new Set<string>([
      ...headFiles.keys(),
      ...baseFiles.keys(),
      ...ancestorFiles.keys(),
    ]);
    for (const path of allPaths) {
      const headSha = headFiles.get(path);
      const baseSha = baseFiles.get(path);
      const ancestorSha = ancestorFiles.get(path);
      const headChanged = headSha !== ancestorSha;
      const baseChanged = baseSha !== ancestorSha;
      if (headChanged && baseChanged && headSha !== baseSha) {
        return { ok: false, status: 405, message: 'Merge conflict' };
      }
    }
    void method;
    const sha = this.makeCommit(repo, headCommit.tree, [baseTip], pull.title);
    const baseRef = `refs/heads/${pull.base.ref}`;
    repo.refs.set(baseRef, sha);
    pull.head.sha = headTip;
    pull.base.sha = sha;
    const ts = this.clock.now();
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = ts;
    pull.closed_at = ts;
    pull.updated_at = ts;
    pull.merge_commit_sha = sha;
    repo.updatedAt = ts;
    repo.pushedAt = ts;
    return { ok: true, sha };
  }

  // ---- contents ----

  putContent(
    repo: Repo,
    branch: string,
    path: string,
    contentBase64: string,
    message: string,
    sha?: string,
  ):
    | { ok: true; contentSha: string; commitSha: string; created: boolean }
    | { ok: false; status: number; message: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return { ok: false, status: 422, message: 'Invalid path' };
    }
    const currentTree = tip === undefined ? undefined : this.treeOfCommit(repo, tip);
    const currentSha =
      currentTree === undefined
        ? undefined
        : this.blobAtPath(repo, currentTree, segments);
    if (sha !== undefined && sha !== currentSha) {
      return { ok: false, status: 409, message: 'sha does not match' };
    }
    const created = currentSha === undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentBase64, 'base64');
    } catch {
      return { ok: false, status: 422, message: 'Invalid base64 content' };
    }
    const contentSha = this.storeObject(repo, 'blob', content);
    const newTree = this.updateTree(repo, currentTree, segments, contentSha);
    const parents = tip === undefined ? [] : [tip];
    const commitSha = this.makeCommit(repo, newTree, parents, message);
    repo.refs.set(ref, commitSha);
    const ts = this.clock.now();
    repo.updatedAt = ts;
    repo.pushedAt = ts;
    return { ok: true, contentSha, commitSha, created };
  }

  deleteContent(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    sha: string,
  ):
    | { ok: true; commitSha: string }
    | { ok: false; status: number; message: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) {
      return { ok: false, status: 404, message: 'Not Found' };
    }
    const segments = path.split('/').filter((s) => s.length > 0);
    const currentTree = this.treeOfCommit(repo, tip);
    const currentSha =
      currentTree === undefined
        ? undefined
        : this.blobAtPath(repo, currentTree, segments);
    if (currentSha === undefined) {
      return { ok: false, status: 404, message: 'Not Found' };
    }
    if (sha !== '' && sha !== currentSha) {
      return { ok: false, status: 409, message: 'sha does not match' };
    }
    const newTree = this.updateTree(repo, currentTree, segments, null);
    const commitSha = this.makeCommit(repo, newTree, [tip], message);
    repo.refs.set(ref, commitSha);
    const ts = this.clock.now();
    repo.updatedAt = ts;
    repo.pushedAt = ts;
    return { ok: true, commitSha };
  }

  getContent(
    repo: Repo,
    branch: string,
    path: string,
  ):
    | { kind: 'file'; content: Buffer; sha: string; size: number }
    | {
        kind: 'dir';
        entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[];
      }
    | { kind: 'missing' } {
    const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { kind: 'missing' };
    const treeSha = this.treeOfCommit(repo, tip);
    if (treeSha === undefined) return { kind: 'missing' };
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      return { kind: 'dir', entries: this.dirEntries(repo, treeSha, '') };
    }
    // Walk to the parent tree of the last segment.
    let current = treeSha;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return { kind: 'missing' };
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (entry === undefined || entry.mode !== '40000') {
        return { kind: 'missing' };
      }
      current = entry.sha;
    }
    const parentObj = repo.objects.get(current);
    if (parentObj === undefined || parentObj.type !== 'tree') {
      return { kind: 'missing' };
    }
    const entry = parseTree(parentObj.data).find(
      (e) => e.name === segments[segments.length - 1],
    );
    if (entry === undefined) return { kind: 'missing' };
    if (entry.mode === '40000') {
      return {
        kind: 'dir',
        entries: this.dirEntries(repo, entry.sha, segments.join('/')),
      };
    }
    const blob = repo.objects.get(entry.sha);
    if (blob === undefined || blob.type !== 'blob') return { kind: 'missing' };
    return {
      kind: 'file',
      content: blob.data,
      sha: entry.sha,
      size: blob.data.length,
    };
  }

  private dirEntries(
    repo: Repo,
    treeSha: string,
    prefix: string,
  ): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
    const obj = repo.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return [];
    return parseTree(obj.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
    }));
  }

  /** Commit info (tree/parents/message) for a sha, for other handlers. */
  readCommit(repo: Repo, sha: string): CommitInfo | undefined {
    return this.commitOf(repo, sha);
  }

  /** Flat path -> blob sha map for the tree of a commit. */
  filesOfCommit(repo: Repo, commitSha: string): Map<string, string> {
    const out = new Map<string, string>();
    const tree = this.treeOfCommit(repo, commitSha);
    this.flattenTree(repo, tree, '', out);
    return out;
  }

  /** Raw blob bytes for a sha, or undefined. */
  blobBytes(repo: Repo, sha: string): Buffer | undefined {
    const obj = repo.objects.get(sha);
    return obj !== undefined && obj.type === 'blob' ? obj.data : undefined;
  }
}
