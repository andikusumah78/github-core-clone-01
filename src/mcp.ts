// src/mcp.ts — MCP (Model Context Protocol) JSON-RPC 2.0 over Streamable HTTP
// for github-core-clone-01.
//
// Supports both protocol eras: modern 2026-07-28 via `server/discover`
// (plus `initialize` in modern mode) and legacy 2025-11-25 and earlier via
// the `initialize` + `notifications/initialized` handshake. Every POST
// requires `Authorization: Bearer <store.token>`; a missing or wrong token
// is HTTP 401. All timestamps come from the Store; this file never reads the
// wall clock and never generates random values.
//
// The tools list is built once at module load and deep-frozen, so two
// `tools/list` calls return byte-identical arrays. Every JSON-RPC response
// echoes the request's own `id`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathOf, readBody, sendJson } from './util.ts';
import type { StoreLike, StorePull, StoreRepo } from './graphql.ts';
import { callCreateRepo } from './graphql.ts';

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const KNOWN_VERSIONS: ReadonlySet<string> = new Set([MODERN_VERSION, ...LEGACY_VERSIONS]);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string }>;
    required: string[];
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The six canonical tools, in a fixed order. Built once, never mutated. */
export const TOOLS: readonly ToolDef[] = deepFreeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash merge method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

const DISCOVER_RESULT = deepFreeze({
  supportedVersions: [MODERN_VERSION],
  capabilities: { tools: {} },
  serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  instructions: 'GitHub-compatible forge tools: create and read repositories, issues and pull requests.',
});

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope helpers.
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Best-effort id extraction from a truncated (unparseable) JSON body. */
function extractId(text: string): JsonRpcId {
  const match = /"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")/.exec(text);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed === 'number' || typeof parsed === 'string') return parsed;
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool-name and argument normalization (spec §6.4/§6.5).
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CANONICAL_TOOLS: Readonly<Record<string, string>> = {
  createrepo: 'create_repo',
  getrepo: 'get_repo',
  createissue: 'create_issue',
  listissues: 'list_issues',
  createpullrequest: 'create_pull_request',
  mergepullrequest: 'merge_pull_request',
};

function canonicalToolName(name: string): string | null {
  const normalized = normalizeName(name);
  if (normalized in CANONICAL_TOOLS) return CANONICAL_TOOLS[normalized];
  for (const [key, canonical] of Object.entries(CANONICAL_TOOLS)) {
    if (normalized.endsWith(key)) return canonical;
  }
  return null;
}

// Synonym lists from spec §6.5, already in normalized form (lowercase,
// non-alphanumerics removed), first match wins.
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  owner: ['owner', 'ownerlogin', 'org', 'organization', 'organisation', 'user', 'userlogin', 'login', 'account', 'namespace', 'ownername'],
  repo: ['repo', 'repository', 'repositoryname', 'reponame', 'reposlug', 'project', 'projectname'],
  repo_full_name: ['fullname', 'repofullname', 'repositoryfullname'],
  title: ['title', 'issuetitle', 'prtitle', 'pullrequesttitle', 'subject'],
  body: ['body', 'issuebody', 'description', 'content', 'text', 'comment'],
  head: ['head', 'headref', 'headbranch', 'pullrequesthead', 'prhead', 'source', 'sourceref', 'sourcebranch', 'from', 'frombranch', 'branch'],
  base: ['base', 'baseref', 'basebranch', 'pullrequestbase', 'prbase', 'target', 'targetref', 'targetbranch', 'into', 'intobranch'],
  pull_number: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber', 'index'],
  name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'isprivate'],
  state: ['state', 'status'],
};

function normalizedArgs(args: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(args)) {
    const normalized = normalizeName(key);
    if (!map.has(normalized)) map.set(normalized, value);
  }
  return map;
}

function resolveArg(map: Map<string, unknown>, semantic: string): unknown {
  const synonyms = SYNONYMS[semantic] ?? [semantic];
  for (const synonym of synonyms) {
    if (map.has(synonym)) return map.get(synonym);
  }
  return undefined;
}

function resolveOwnerRepo(map: Map<string, unknown>, fallbackOwner: string): { owner: string | undefined; repo: string | undefined } {
  let owner = resolveArg(map, 'owner');
  let repo = resolveArg(map, 'repo');
  if ((owner === undefined || repo === undefined) && resolveArg(map, 'repo_full_name') !== undefined) {
    const fullName = resolveArg(map, 'repo_full_name');
    if (typeof fullName === 'string') {
      const slash = fullName.indexOf('/');
      if (slash > 0 && slash < fullName.length - 1) {
        if (owner === undefined) owner = fullName.slice(0, slash);
        if (repo === undefined) repo = fullName.slice(slash + 1);
      }
    }
  }
  return {
    owner: typeof owner === 'string' && owner !== '' ? owner : owner === undefined ? fallbackOwner : undefined,
    repo: typeof repo === 'string' && repo !== '' ? repo : undefined,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

// ---------------------------------------------------------------------------
// Tool execution. Every tool returns either { result } or { error } (the
// latter is answered with isError: true, never an HTTP 500).
// ---------------------------------------------------------------------------

type ToolOutcome = { result: unknown } | { error: string };

function missingArg(name: string): ToolOutcome {
  return { error: `Missing required argument: ${name}` };
}

function repoOf(store: StoreLike, owner: string, repoName: string): StoreRepo | null {
  const repo = store.getRepo(owner, repoName);
  return repo === undefined || repo === null ? null : repo;
}

function toolTextResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function executeTool(store: StoreLike, canonical: string, args: Record<string, unknown>): ToolOutcome {
  const map = normalizedArgs(args);
  switch (canonical) {
    case 'create_repo': {
      const name = asNonEmptyString(resolveArg(map, 'name'));
      if (name === undefined) return missingArg('name');
      const owner = asNonEmptyString(resolveArg(map, 'owner')) ?? store.tokenLogin;
      const description = asNonEmptyString(resolveArg(map, 'description')) ?? '';
      const isPrivate = toBool(resolveArg(map, 'private')) ?? false;
      try {
        const repo = callCreateRepo(store, { owner, name, description, private: isPrivate });
        return {
          result: {
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name ?? `${owner}/${name}`,
            private: Boolean(repo.private),
            default_branch: repo.defaultBranch ?? 'main',
          },
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'create_repo failed' };
      }
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(map, store.tokenLogin);
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const repo = repoOf(store, owner, repoName);
      if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
      return {
        result: {
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name ?? `${owner}/${repoName}`,
          description: repo.description ?? '',
          private: Boolean(repo.private),
          default_branch: repo.defaultBranch ?? 'main',
        },
      };
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(map, store.tokenLogin);
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const title = asNonEmptyString(resolveArg(map, 'title'));
      if (title === undefined) return missingArg('title');
      const body = asNonEmptyString(resolveArg(map, 'body')) ?? '';
      const repo = repoOf(store, owner, repoName);
      if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
      try {
        const issue = store.createIssue(repo, title, body);
        return { result: { number: issue.number, id: issue.id, title: issue.title, state: issue.state } };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'create_issue failed' };
      }
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(map, store.tokenLogin);
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const state = asNonEmptyString(resolveArg(map, 'state')) ?? 'open';
      const repo = repoOf(store, owner, repoName);
      if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
      const wanted = state.toLowerCase();
      const issues = [...repo.issues]
        .sort((a, b) => a.number - b.number)
        .filter((issue) => wanted === 'all' || issue.state === wanted)
        .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
      return { result: issues };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(map, store.tokenLogin);
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const title = asNonEmptyString(resolveArg(map, 'title'));
      if (title === undefined) return missingArg('title');
      const head = asNonEmptyString(resolveArg(map, 'head'));
      if (head === undefined) return missingArg('head');
      const base = asNonEmptyString(resolveArg(map, 'base'));
      if (base === undefined) return missingArg('base');
      const body = asNonEmptyString(resolveArg(map, 'body')) ?? '';
      const repo = repoOf(store, owner, repoName);
      if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
      try {
        const pull: StorePull = store.createPull(repo, head, base, title, body);
        return {
          result: {
            number: pull.number,
            id: pull.id,
            title: pull.title,
            state: pull.state,
            head: { ref: head, sha: pull.head?.sha ?? '' },
            base: { ref: base, sha: pull.base?.sha ?? '' },
          },
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'create_pull_request failed' };
      }
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(map, store.tokenLogin);
      if (owner === undefined) return missingArg('owner');
      if (repoName === undefined) return missingArg('repo');
      const rawNumber = resolveArg(map, 'pull_number');
      let pullNumber: number | undefined;
      if (typeof rawNumber === 'number' && Number.isInteger(rawNumber)) pullNumber = rawNumber;
      else if (typeof rawNumber === 'string' && /^\d+$/.test(rawNumber)) pullNumber = Number.parseInt(rawNumber, 10);
      if (pullNumber === undefined) return missingArg('pull_number');
      const repo = repoOf(store, owner, repoName);
      if (!repo) return { error: `Repository not found: ${owner}/${repoName}` };
      const existing = store.getPull(repo, pullNumber) ?? repo.pulls.find((entry) => entry.number === pullNumber) ?? null;
      if (!existing) return { error: `Pull request not found: #${pullNumber}` };
      try {
        const merged = store.mergePull(repo, pullNumber, 'SQUASH');
        if (isRecord(merged) && 'ok' in merged && merged.ok === false) {
          return { error: typeof merged.message === 'string' ? merged.message : 'merge_pull_request failed' };
        }
        return { result: { number: pullNumber, merged: true, state: 'closed' } };
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'merge_pull_request failed' };
      }
    }
    default:
      return { error: `Unknown tool: ${canonical}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch.
// ---------------------------------------------------------------------------

function dispatch(store: StoreLike, method: string, params: unknown, id: JsonRpcId): Record<string, unknown> {
  if (method === 'server/discover') {
    return rpcResult(id, DISCOVER_RESULT);
  }
  if (method === 'initialize') {
    const offered = isRecord(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    if (offered === null) {
      return rpcResult(id, { protocolVersion: MODERN_VERSION, capabilities: { tools: {} }, serverInfo: serverInfo() });
    }
    if (!KNOWN_VERSIONS.has(offered)) {
      return rpcError(id, -32602, `Unsupported protocol version: ${offered}`, { supported: [MODERN_VERSION, ...LEGACY_VERSIONS] });
    }
    return rpcResult(id, { protocolVersion: offered, capabilities: { tools: {} }, serverInfo: serverInfo() });
  }
  if (method === 'notifications/initialized') {
    return rpcResult(id, {});
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (!isRecord(params)) {
      return rpcError(id, -32602, 'Invalid params: tools/call requires an object with name and arguments.');
    }
    const name = params.name;
    if (typeof name !== 'string' || name === '') {
      return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name.');
    }
    const canonical = canonicalToolName(name);
    if (canonical === null) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = executeTool(store, canonical, args);
    if ('error' in outcome) {
      return rpcResult(id, toolErrorResult(outcome.error));
    }
    return rpcResult(id, toolTextResult(outcome.result));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// HTTP handler.
// ---------------------------------------------------------------------------

export async function handleMcp(store: StoreLike, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  if (req.method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const text = raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: extractId(text), error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${store.token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  const hasId = Object.prototype.hasOwnProperty.call(parsed, 'id');
  const id: JsonRpcId = hasId ? (parsed.id as JsonRpcId) : null;
  const method = parsed.method;
  if (typeof method !== 'string' || method === '') {
    if (hasId) sendJson(res, 200, rpcError(id, -32600, 'Invalid Request: missing method.'));
    else sendJson(res, 202, {});
    return true;
  }
  if (!hasId) {
    // A notification (e.g. notifications/initialized): no response body.
    sendJson(res, 202, {});
    return true;
  }
  sendJson(res, 200, dispatch(store, method, parsed.params, id));
  return true;
}
