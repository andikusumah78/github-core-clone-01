// src/graphql.ts — GraphQL v4 executor for github-core-clone-01.
//
// A small, real GraphQL parser + executor (no GraphQL library, no string
// matching against known documents): it tokenizes and parses any operation
// document generically — operation type/name, variables, arguments (strings,
// ints, floats, booleans, null, enums, lists, inline input objects),
// aliases, fragment spreads and inline fragments — and resolves it against
// the Store. All timestamps come from the Store; this file never reads the
// wall clock and never generates random values.
//
// Store contract: this file does NOT import './store.ts' (Builder B writes
// it in parallel). It defines the minimal structural surface it consumes
// below (StoreLike); the real Store is assignable to it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathOf, readBody, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// Minimal Store surface consumed here (structural; the real Store matches).
// ---------------------------------------------------------------------------

export interface StoreUser {
  login: string;
  id?: number;
  type?: string;
}

export interface StoreIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
  user: StoreUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface StorePull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: StoreUser | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export interface StoreComment {
  id: number;
  body: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreRepo {
  id: number;
  databaseId: number;
  name: string;
  full_name?: string;
  // NOTE: the real Store keeps the owner as a plain login string
  // (Repo.owner: string), not an object; ownerLogin() below reads both.
  owner: string;
  ownerId: number;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt?: string;
  updatedAt?: string;
  pushedAt?: string;
  created_at?: string;
  updated_at?: string;
  objects: Map<string, { type: string; data: Buffer }>;
  refs: Map<string, string>;
  issues: StoreIssue[];
  pulls: StorePull[];
  labels: Map<string, unknown>;
}

export interface StoreLike {
  token: string;
  tokenLogin: string;
  getRepo(owner: string, name: string): StoreRepo | undefined | null;
  createRepo(...args: unknown[]): StoreRepo;
  createIssue(repo: StoreRepo, title: string, body: string, labels?: string[]): StoreIssue;
  getIssue(repo: StoreRepo, number: number): StoreIssue | undefined | null;
  closeIssue(repo: StoreRepo, number: number): StoreIssue | void;
  createPull(repo: StoreRepo, head: string, base: string, title: string, body: string): StorePull;
  getPull(repo: StoreRepo, number: number): StorePull | undefined | null;
  mergePull(repo: StoreRepo, number: number, method: string): StorePull | { ok: boolean; sha?: string; status?: number; message?: string } | void;
  addComment(repo: StoreRepo, issueNumber: number, body: string): StoreComment;
  listComments?(repo: StoreRepo, issueNumber: number): StoreComment[];
  createLabel?(...args: unknown[]): unknown;
  createBranch?(...args: unknown[]): unknown;
  getBranchTip?(repo: StoreRepo, ref: string): string | undefined | null;
  getBranchTipByName?(repo: StoreRepo, branch: string): string | undefined | null;
  nextRequestId?(): string;
  nextRepoId?(): number;
}

// ---------------------------------------------------------------------------
// Opaque, stable global ids. Never the plain databaseId or issue number.
// ---------------------------------------------------------------------------

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string | null {
  if (typeof text !== 'string' || text.length === 0 || /[^A-Za-z0-9_-]/.test(text)) return null;
  try {
    const decoded = Buffer.from(text, 'base64url').toString('utf8');
    if (b64urlEncode(decoded) !== text) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function encodeRepoId(owner: string, name: string): string {
  return `R_${b64urlEncode(`repo:${owner}/${name}`)}`;
}

export function encodeIssueId(owner: string, repo: string, number: number): string {
  return `I_${b64urlEncode(`issue:${owner}/${repo}#${number}`)}`;
}

export function encodePullId(owner: string, repo: string, number: number): string {
  return `P_${b64urlEncode(`pull:${owner}/${repo}#${number}`)}`;
}

export function encodeCommentId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return `C_${b64urlEncode(`comment:${owner}/${repo}#${issueNumber}:${commentId}`)}`;
}

export function decodeRepoId(id: unknown): { owner: string; name: string } | null {
  if (typeof id !== 'string' || !id.startsWith('R_')) return null;
  const payload = b64urlDecode(id.slice(2));
  if (payload === null || !payload.startsWith('repo:')) return null;
  const rest = payload.slice(5);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1 || rest.indexOf('/', slash + 1) !== -1) return null;
  return { owner: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

export function decodeIssueId(id: unknown): { owner: string; repo: string; number: number } | null {
  if (typeof id !== 'string' || !id.startsWith('I_')) return null;
  const payload = b64urlDecode(id.slice(2));
  if (payload === null || !payload.startsWith('issue:')) return null;
  return decodeNumberedRef(payload.slice(6));
}

export function decodePullId(id: unknown): { owner: string; repo: string; number: number } | null {
  if (typeof id !== 'string' || !id.startsWith('P_')) return null;
  const payload = b64urlDecode(id.slice(2));
  if (payload === null || !payload.startsWith('pull:')) return null;
  return decodeNumberedRef(payload.slice(5));
}

export function decodeCommentId(
  id: unknown,
): { owner: string; repo: string; issueNumber: number; commentId: number } | null {
  if (typeof id !== 'string' || !id.startsWith('C_')) return null;
  const payload = b64urlDecode(id.slice(2));
  if (payload === null || !payload.startsWith('comment:')) return null;
  const rest = payload.slice(8);
  const hash = rest.indexOf('#');
  const colon = rest.lastIndexOf(':');
  if (hash <= 0 || colon <= hash + 1) return null;
  const ownerRepo = rest.slice(0, hash);
  const slash = ownerRepo.indexOf('/');
  if (slash <= 0 || slash === ownerRepo.length - 1 || ownerRepo.indexOf('/', slash + 1) !== -1) return null;
  const issueNumber = Number.parseInt(rest.slice(hash + 1, colon), 10);
  const commentId = Number.parseInt(rest.slice(colon + 1), 10);
  if (!Number.isInteger(issueNumber) || issueNumber < 1 || !Number.isInteger(commentId) || commentId < 1) return null;
  return { owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1), issueNumber, commentId };
}

function decodeNumberedRef(rest: string): { owner: string; repo: string; number: number } | null {
  const hash = rest.indexOf('#');
  if (hash <= 0 || hash === rest.length - 1 || rest.indexOf('#', hash + 1) !== -1) return null;
  const ownerRepo = rest.slice(0, hash);
  const slash = ownerRepo.indexOf('/');
  if (slash <= 0 || slash === ownerRepo.length - 1 || ownerRepo.indexOf('/', slash + 1) !== -1) return null;
  const number = Number.parseInt(rest.slice(hash + 1), 10);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner: ownerRepo.slice(0, slash), repo: ownerRepo.slice(slash + 1), number };
}

export function encodeCursor(number: number): string {
  return b64urlEncode(`cursor:${number}`);
}

export function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const payload = b64urlDecode(cursor);
  if (payload === null || !payload.startsWith('cursor:')) return null;
  const number = Number.parseInt(payload.slice(7), 10);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

// ---------------------------------------------------------------------------
// createRepo adapter. The Store's createRepo shape is fixed by Builder B;
// call it in the form its declared arity suggests, validate the result, and
// fall back to the other form only when the first call throws (a throw means
// no repo was created, so no duplicate is risked).
// ---------------------------------------------------------------------------

export interface CreateRepoInput {
  owner: string;
  name: string;
  description: string;
  private: boolean;
}

export function callCreateRepo(store: StoreLike, input: CreateRepoInput): StoreRepo {
  const fn = store.createRepo as unknown as (...args: unknown[]) => unknown;
  if (typeof fn !== 'function') throw new Error('store.createRepo is not available');
  const opts = { description: input.description, private: input.private };
  // The real Store declares createRepo(owner, ownerId, name, opts = {})
  // (arity 3, ownerId 1000 for the token login — same value REST passes).
  // Other plausible shapes are tried only if the arity-preferred one throws.
  const attempts: Array<() => unknown> =
    fn.length >= 3
      ? [
          () => fn.call(store, input.owner, 1000, input.name, opts),
          () => fn.call(store, input.name, input.owner, opts),
          () => fn.call(store, { name: input.name, owner: input.owner, description: input.description, private: input.private }),
        ]
      : fn.length === 2
        ? [
            () => fn.call(store, input.name, input.owner, opts),
            () => fn.call(store, input.owner, 1000, input.name, opts),
            () => fn.call(store, { name: input.name, owner: input.owner, description: input.description, private: input.private }),
          ]
        : [
            () => fn.call(store, { name: input.name, owner: input.owner, description: input.description, private: input.private }),
            () => fn.call(store, input.owner, 1000, input.name, opts),
            () => fn.call(store, input.name, input.owner, opts),
          ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (isRecord(result) && result.name === input.name && typeof result.id === 'number') {
        const owner = (result as Record<string, unknown>).owner;
        const ownerOk =
          owner === input.owner || (isRecord(owner) && owner.login === input.owner) || owner === undefined;
        if (ownerOk) return result as unknown as StoreRepo;
      }
      throw new Error('store.createRepo returned an unexpected value');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('store.createRepo failed');
}

/** The repo owner's login. The real Store keeps it as a plain string. */
export function ownerLogin(repo: StoreRepo): string {
  const owner = repo.owner as unknown;
  if (typeof owner === 'string') return owner;
  if (isRecord(owner) && typeof owner.login === 'string') return owner.login;
  return '';
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class GqlError extends Error {}

class FieldError extends GqlError {}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new GqlError(`${what} must be a string`);
  return value;
}

function asInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new GqlError(`${what} must be an integer`);
  return value;
}

function repoOf(store: StoreLike, owner: string, name: string): StoreRepo | null {
  const repo = store.getRepo(owner, name);
  return repo === undefined || repo === null ? null : repo;
}

function issueStateGql(issue: StoreIssue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullStateGql(pull: StorePull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function issueUrl(repo: StoreRepo, issue: StoreIssue): string {
  return `https://github.com/${ownerLogin(repo)}/${repo.name}/issues/${issue.number}`;
}

function pullUrl(repo: StoreRepo, pull: StorePull): string {
  return `https://github.com/${ownerLogin(repo)}/${repo.name}/pull/${pull.number}`;
}

function repoUrl(repo: StoreRepo): string {
  return `https://github.com/${ownerLogin(repo)}/${repo.name}`;
}

/** Executor wrapper: __typename plus the payload the field resolvers need. */
interface Obj {
  __typename: string;
  [key: string]: unknown;
}

function wrap(typename: string, fields: Record<string, unknown>): Obj {
  return { __typename: typename, ...fields };
}

// ---------------------------------------------------------------------------
// GraphQL lexer. Tokens: names, ints, floats, strings, $variables, `...`,
// and single-character punctuation. Commas and `#` comments are insignificant.
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'var' | 'punct' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);

  while (i < n) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      if (j >= n || !isNameStart(source[j])) throw new GqlError(`Syntax Error: Expected Name, found ${source[j] ?? 'EOF'}.`);
      while (j < n && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      if (source[i + 1] === '"' && source[i + 2] === '"') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlError('Syntax Error: Unterminated string.');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const ch = source[j];
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === '\n' || ch === '\r') throw new GqlError('Syntax Error: Unterminated string.');
        if (ch === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GqlError('Syntax Error: Invalid unicode escape.');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === undefined || !(esc in simple)) throw new GqlError('Syntax Error: Invalid escape sequence.');
          out += simple[esc];
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (!closed) throw new GqlError('Syntax Error: Unterminated string.');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      if (j >= n || !isDigit(source[j])) throw new GqlError('Syntax Error: Invalid number.');
      while (j < n && isDigit(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < n && isDigit(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (isDigit(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < n && isDigit(source[j])) j += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < n && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('!()[]{}:=@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    throw new GqlError(`Syntax Error: Unexpected character: ${JSON.stringify(c)}.`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// GraphQL parser. Produces operations and fragment definitions.
// ---------------------------------------------------------------------------

type ValueNode =
  | { k: 'str'; v: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'var'; v: string }
  | { k: 'list'; v: ValueNode[] }
  | { k: 'obj'; v: Array<[string, ValueNode]> };

interface SelectionField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selectionSet: Selection[];
}

interface SelectionSpread {
  kind: 'spread';
  name: string;
}

interface SelectionInline {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: Selection[];
}

type Selection = SelectionField | SelectionSpread | SelectionInline;

interface VarDef {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface Operation {
  type: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selectionSet: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new GqlError(`Syntax Error: Expected "${value}", found ${describeToken(tok)}.`);
    }
  }

  private expectName(what = 'Name'): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new GqlError(`Syntax Error: Expected ${what}, found ${describeToken(tok)}.`);
    return tok.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ type: 'query', name: null, varDefs: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind !== 'name') throw new GqlError(`Syntax Error: Unexpected ${describeToken(tok)}.`);
      if (tok.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new GqlError('Syntax Error: Expected "on", found ' + JSON.stringify(on) + '.');
        const typeCondition = this.expectName('fragment type condition');
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selectionSet });
        continue;
      }
      if (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription') {
        const type = tok.value as Operation['type'];
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVariableDefinitions();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ type, name, varDefs, selectionSet });
        continue;
      }
      throw new GqlError(`Syntax Error: Unexpected ${describeToken(tok)}.`);
    }
    if (operations.length === 0) throw new GqlError('Syntax Error: Expected an operation definition.');
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: Unterminated variable definitions.');
      const varTok = this.next();
      if (varTok.kind !== 'var') throw new GqlError(`Syntax Error: Expected variable, found ${describeToken(varTok)}.`);
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name: varTok.value, type, defaultValue });
    }
    this.next();
    return defs;
  }

  private parseType(): string {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName('type');
    let out = name;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: Unterminated selection set.');
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): Selection {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName('fragment type condition');
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const name = this.expectName('field');
    let alias: string | null = null;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName('field');
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: Selection[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name: fieldName, alias, args, selectionSet };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: Unterminated arguments.');
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.next();
    return args;
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'var') return { k: 'var', v: tok.value };
    if (tok.kind === 'int') return { k: 'int', v: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { k: 'float', v: Number.parseFloat(tok.value) };
    if (tok.kind === 'string') return { k: 'str', v: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { k: 'bool', v: true };
      if (tok.value === 'false') return { k: 'bool', v: false };
      if (tok.value === 'null') return { k: 'null' };
      return { k: 'enum', v: tok.value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: Unterminated list.');
        items.push(this.parseValue());
      }
      this.next();
      return { k: 'list', v: items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const entries: Array<[string, ValueNode]> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new GqlError('Syntax Error: Unterminated input object.');
        const name = this.expectName('input field');
        this.expectPunct(':');
        entries.push([name, this.parseValue()]);
      }
      this.next();
      return { k: 'obj', v: entries };
    }
    throw new GqlError(`Syntax Error: Unexpected value ${describeToken(tok)}.`);
  }
}

function describeToken(tok: Token): string {
  if (tok.kind === 'eof') return '<EOF>';
  return JSON.stringify(tok.value);
}

// ---------------------------------------------------------------------------
// Value resolution (variables, enums, lists, input objects).
// ---------------------------------------------------------------------------

interface ExecCtx {
  store: StoreLike;
  vars: Record<string, unknown>;
  declaredVars: Set<string>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.k) {
    case 'str':
      return node.v;
    case 'int':
    case 'float':
      return node.v;
    case 'bool':
      return node.v;
    case 'null':
      return null;
    case 'enum':
      return node.v;
    case 'var': {
      if (!ctx.declaredVars.has(node.v)) throw new GqlError(`Variable "$${node.v}" is not defined by operation.`);
      return ctx.vars[node.v] ?? null;
    }
    case 'list':
      return node.v.map((item) => resolveValue(item, ctx));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.v) out[key] = resolveValue(value, ctx);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, ctx);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection tables.
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'private', 'fork', 'hasWikiEnabled'],
  User: ['id', 'login', 'name', 'url'],
  Viewer: ['login'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Git tree diff for pullRequest.files (local tree walk over repo.objects).
// ---------------------------------------------------------------------------

function parseTreeEntries(data: Buffer): Array<{ mode: string; name: string; sha: string }> {
  const entries: Array<{ mode: string; name: string; sha: string }> = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space === -1) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function commitTreeSha(repo: StoreRepo, sha: string, depth = 0): string | null {
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || depth > 4) return null;
  const obj = repo.objects.get(sha);
  if (!obj) return null;
  if (obj.type === 'tree') return sha;
  const text = obj.data.toString('utf8');
  if (obj.type === 'commit') {
    const m = /^tree ([0-9a-f]{40})$/m.exec(text);
    return m ? m[1] : null;
  }
  if (obj.type === 'tag') {
    const m = /^object ([0-9a-f]{40})$/m.exec(text);
    return m ? commitTreeSha(repo, m[1], depth + 1) : null;
  }
  return null;
}

function walkTree(objects: Map<string, { type: string; data: Buffer }>, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTreeEntries(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') walkTree(objects, entry.sha, path, out);
    else out.set(path, entry.sha);
  }
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (const byte of data) if (byte === 0x0a) n += 1;
  return data[data.length - 1] === 0x0a ? n : n + 1;
}

function splitLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiffCounts(baseData: Buffer, headData: Buffer): { additions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of splitLines(baseData)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of splitLines(headData)) {
    const c = counts.get(line) ?? 0;
    if (c > 0) counts.set(line, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

function blobData(repo: StoreRepo, sha: string | undefined): Buffer {
  if (!sha) return Buffer.alloc(0);
  const obj = repo.objects.get(sha);
  return obj && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
}

interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

function diffTrees(repo: StoreRepo, baseSha: string, headSha: string): FileChange[] {
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  const baseTree = commitTreeSha(repo, baseSha);
  if (baseTree) walkTree(repo.objects, baseTree, '', baseMap);
  const headTree = commitTreeSha(repo, headSha);
  if (headTree) walkTree(repo.objects, headTree, '', headMap);
  const changes: FileChange[] = [];
  for (const [path, sha] of headMap) {
    if (!baseMap.has(path)) {
      changes.push({ path, status: 'added', additions: countLines(blobData(repo, sha)), deletions: 0 });
    } else if (baseMap.get(path) !== sha) {
      const { additions, deletions } = lineDiffCounts(blobData(repo, baseMap.get(path)), blobData(repo, sha));
      changes.push({ path, status: 'modified', additions, deletions });
    }
  }
  for (const [path, sha] of baseMap) {
    if (!headMap.has(path)) {
      changes.push({ path, status: 'removed', additions: 0, deletions: countLines(blobData(repo, sha)) });
    }
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

// ---------------------------------------------------------------------------
// Selection execution.
// ---------------------------------------------------------------------------

function executeSelectionSet(selections: Selection[], typeName: string, obj: Obj, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.alias ?? sel.name;
      try {
        const args = resolveArgs(sel.args, ctx);
        const value = resolveField(typeName, sel.name, obj, args, ctx);
        out[key] = maybeExecuteSubSelection(value, sel.selectionSet, ctx);
      } catch (error) {
        if (error instanceof FieldError) {
          ctx.errors.push({ message: error.message });
        } else if (error instanceof GqlError) {
          ctx.errors.push({ message: error.message });
          out[key] = null;
        } else {
          ctx.errors.push({ message: error instanceof Error ? error.message : 'Internal error' });
          out[key] = null;
        }
      }
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition === null || sel.typeCondition === typeName || sel.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(sel.selectionSet, typeName, obj, ctx));
      }
      continue;
    }
    const frag = ctx.fragments.get(sel.name);
    if (!frag) {
      ctx.errors.push({ message: `Unknown fragment "${sel.name}".` });
      continue;
    }
    if (frag.typeCondition === typeName || frag.typeCondition === 'Node') {
      Object.assign(out, executeSelectionSet(frag.selectionSet, typeName, obj, ctx));
    }
  }
  return out;
}

function maybeExecuteSubSelection(value: unknown, selectionSet: Selection[], ctx: ExecCtx): unknown {
  if (selectionSet.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      isRecord(entry) && typeof entry.__typename === 'string'
        ? executeSelectionSet(selectionSet, entry.__typename, entry as Obj, ctx)
        : entry,
    );
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelectionSet(selectionSet, value.__typename, value as Obj, ctx);
  }
  return value;
}

function unknownField(field: string, typeName: string): FieldError {
  return new FieldError(`Cannot query field "${field}" on type "${typeName}".`);
}

function resolveField(typeName: string, field: string, obj: Obj, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  if (field === '__typename') return typeName;
  switch (typeName) {
    case 'Query':
      return resolveQueryField(field, args, ctx);
    case 'Mutation':
      return resolveMutationField(field, args, ctx);
    case 'Viewer':
      if (field === 'login') return ctx.store.tokenLogin;
      throw unknownField(field, typeName);
    case 'Repository':
      return resolveRepositoryField(field, obj, args, ctx);
    case 'Issue':
      return resolveIssueField(field, obj, args, ctx);
    case 'PullRequest':
      return resolvePullRequestField(field, obj, args, ctx);
    case 'User':
      if (field === 'login') return String(obj.__login ?? '');
      if (field === 'id') return typeof obj.__id === 'number' ? obj.__id : null;
      if (field === 'name') return String(obj.__login ?? '');
      if (field === 'url') return `https://github.com/${String(obj.__login ?? '')}`;
      throw unknownField(field, typeName);
    case 'Ref':
      if (field === 'name') return String(obj.__name ?? '');
      throw unknownField(field, typeName);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
      return resolveConnectionField(field, obj);
    case 'PageInfo':
      if (field === 'hasNextPage') return Boolean(obj.__hasNextPage);
      if (field === 'hasPreviousPage') return Boolean(obj.__hasPreviousPage);
      if (field === 'endCursor') return (obj.__endCursor as string | null) ?? null;
      if (field === 'startCursor') return (obj.__startCursor as string | null) ?? null;
      throw unknownField(field, typeName);
    case 'IssueCommentEdge':
      if (field === 'node') return obj.__node as Obj;
      if (field === 'cursor') return (obj.__cursor as string | null) ?? null;
      throw unknownField(field, typeName);
    case 'Edge':
      if (field === 'node') return obj.__node as Obj;
      if (field === 'cursor') return (obj.__cursor as string | null) ?? null;
      throw unknownField(field, typeName);
    case 'IssueComment':
      if (field === 'id') return String(obj.__id ?? '');
      if (field === 'body') return String(obj.__body ?? '');
      if (field === 'createdAt') return (obj.__createdAt as string | undefined) ?? null;
      if (field === 'url') return String(obj.__url ?? '');
      throw unknownField(field, typeName);
    case 'PullRequestFile':
      if (field === 'path') return String(obj.__path ?? '');
      if (field === 'filename') return String(obj.__path ?? '');
      if (field === 'additions') return Number(obj.__additions ?? 0);
      if (field === 'deletions') return Number(obj.__deletions ?? 0);
      if (field === 'changes') return Number(obj.__additions ?? 0) + Number(obj.__deletions ?? 0);
      if (field === 'status') return String(obj.__status ?? '');
      throw unknownField(field, typeName);
    case 'Label':
      if (field === 'name') return String(obj.__name ?? '');
      throw unknownField(field, typeName);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'issue') return obj.__issue as Obj;
      if (field === 'clientMutationId') return (obj.__clientMutationId as string | null) ?? null;
      throw unknownField(field, typeName);
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return obj.__pullRequest as Obj;
      if (field === 'clientMutationId') return (obj.__clientMutationId as string | null) ?? null;
      throw unknownField(field, typeName);
    case 'AddCommentPayload':
      if (field === 'commentEdge') return obj.__commentEdge as Obj;
      if (field === 'clientMutationId') return (obj.__clientMutationId as string | null) ?? null;
      throw unknownField(field, typeName);
    case '__Type':
      return resolveIntrospectionTypeField(field, obj, args);
    case '__Field':
      if (field === 'name') return String(obj.__name ?? '');
      if (field === 'description') return null;
      throw unknownField(field, typeName);
    case '__EnumValue':
      if (field === 'name') return String(obj.__name ?? '');
      if (field === 'description') return null;
      throw unknownField(field, typeName);
    case '__Schema':
      if (field === 'queryType') return wrap('__Type', { __name: 'Query', __kind: 'OBJECT', __fields: [], __enumValues: [] });
      if (field === 'types') return [];
      throw unknownField(field, typeName);
    default:
      throw unknownField(field, typeName);
  }
}

function resolveConnectionField(field: string, obj: Obj): unknown {
  if (field === 'nodes') return (obj.__nodes as Obj[]) ?? [];
  if (field === 'edges') {
    const nodes = (obj.__nodes as Obj[]) ?? [];
    return nodes.map((node) => wrap('Edge', { __node: node, __cursor: null }));
  }
  if (field === 'pageInfo') {
    return wrap('PageInfo', {
      __hasNextPage: Boolean(obj.__hasNextPage),
      __hasPreviousPage: false,
      __endCursor: (obj.__endCursor as string | null) ?? null,
      __startCursor: (obj.__startCursor as string | null) ?? null,
    });
  }
  if (field === 'totalCount') return Number(obj.__total ?? ((obj.__nodes as Obj[]) ?? []).length);
  throw unknownField(field, String(obj.__typename));
}

function resolveIntrospectionTypeField(field: string, obj: Obj, _args: Record<string, unknown>): unknown {
  if (field === 'name') return String(obj.__name ?? '');
  if (field === 'kind') return String(obj.__kind ?? 'OBJECT');
  if (field === 'description') return null;
  if (field === 'fields') {
    const names = (obj.__fields as string[]) ?? [];
    return names.map((name) => wrap('__Field', { __name: name }));
  }
  if (field === 'enumValues') {
    const names = (obj.__enumValues as string[]) ?? [];
    return names.map((name) => wrap('__EnumValue', { __name: name }));
  }
  throw unknownField(field, '__Type');
}

// ---------------------------------------------------------------------------
// Root, Repository, Issue and PullRequest resolvers.
// ---------------------------------------------------------------------------

function resolveQueryField(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  if (field === 'viewer') {
    return wrap('Viewer', {});
  }
  if (field === 'repository') {
    const owner = asString(args.owner, 'repository.owner');
    const name = asString(args.name, 'repository.name');
    const repo = repoOf(store, owner, name);
    if (!repo) return null;
    return wrap('Repository', { __repo: repo });
  }
  if (field === 'node') {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const repoId = decodeRepoId(id);
    if (repoId) {
      const repo = repoOf(store, repoId.owner, repoId.name);
      if (!repo) return null;
      return wrap('Repository', { __repo: repo });
    }
    const issueId = decodeIssueId(id);
    if (issueId) {
      const repo = repoOf(store, issueId.owner, issueId.repo);
      const issue = repo ? repo.issues.find((entry) => entry.number === issueId.number) ?? null : null;
      if (!repo || !issue) return null;
      return wrap('Issue', { __repo: repo, __issue: issue });
    }
    const pullId = decodePullId(id);
    if (pullId) {
      const repo = repoOf(store, pullId.owner, pullId.repo);
      const pull = repo ? repo.pulls.find((entry) => entry.number === pullId.number) ?? null : null;
      if (!repo || !pull) return null;
      return wrap('PullRequest', { __repo: repo, __pull: pull });
    }
    const commentId = decodeCommentId(id);
    if (commentId) {
      const repo = repoOf(store, commentId.owner, commentId.repo);
      if (!repo) return null;
      const comments = typeof store.listComments === 'function' ? store.listComments(repo, commentId.issueNumber) : [];
      const comment = comments.find((entry) => entry.id === commentId.commentId) ?? null;
      if (!comment) return null;
      return wrap('IssueComment', {
        __id: id,
        __body: comment.body,
        __createdAt: comment.created_at ?? null,
        __url: `${issueUrl(repo, { number: commentId.issueNumber } as StoreIssue)}#issuecomment-${comment.id}`,
      });
    }
    return null;
  }
  if (field === '__type') {
    const name = asString(args.name, '__type.name');
    if (name in TYPE_FIELDS) {
      return wrap('__Type', { __name: name, __kind: 'OBJECT', __fields: TYPE_FIELDS[name], __enumValues: [] });
    }
    if (name in TYPE_ENUM_VALUES) {
      return wrap('__Type', { __name: name, __kind: 'ENUM', __fields: [], __enumValues: TYPE_ENUM_VALUES[name] });
    }
    return null;
  }
  if (field === '__schema') {
    return wrap('__Schema', {});
  }
  throw unknownField(field, 'Query');
}

function repoFromObj(obj: Obj): StoreRepo {
  return obj.__repo as StoreRepo;
}

function resolveRepositoryField(field: string, obj: Obj, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = repoFromObj(obj);
  switch (field) {
    case 'id':
      return encodeRepoId(ownerLogin(repo), repo.name);
    case 'databaseId':
      return typeof repo.databaseId === 'number' ? repo.databaseId : repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${ownerLogin(repo)}/${repo.name}`;
    case 'owner':
      return wrap('User', { __login: ownerLogin(repo), __id: repo.ownerId });
    case 'defaultBranchRef':
      return wrap('Ref', { __name: repo.defaultBranch });
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'hasWikiEnabled':
      return true;
    case 'description':
      return repo.description ?? '';
    case 'url':
      return repoUrl(repo);
    case 'createdAt':
      return repo.createdAt ?? repo.created_at ?? null;
    case 'updatedAt':
      return repo.updatedAt ?? repo.updated_at ?? null;
    case 'private':
      return Boolean(repo.private);
    case 'fork':
      return false;
    case 'issue': {
      const number = asInt(args.number, 'issue.number');
      const issue = repo.issues.find((entry) => entry.number === number) ?? null;
      if (!issue) return null;
      return wrap('Issue', { __repo: repo, __issue: issue });
    }
    case 'issues':
      return issuesConnection(repo, args);
    case 'pullRequests':
      return pullRequestsConnection(repo, args);
    case 'pullRequest': {
      const number = asInt(args.number, 'pullRequest.number');
      const pull = repo.pulls.find((entry) => entry.number === number) ?? null;
      if (!pull) return null;
      return wrap('PullRequest', { __repo: repo, __pull: pull });
    }
    default:
      throw unknownField(field, 'Repository');
  }
}

function issuesConnection(repo: StoreRepo, args: Record<string, unknown>): Obj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  if (orderBy) {
    const direction = String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
    const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
    list.sort((a, b) => {
      let cmp = 0;
      if (field === 'CREATED_AT') cmp = a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
      else if (field === 'UPDATED_AT') cmp = a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0;
      if (cmp === 0) cmp = a.number - b.number;
      return direction * cmp;
    });
  } else {
    list.sort((a, b) => b.number - a.number);
  }
  const afterNumber = decodeCursor(args.after);
  if (afterNumber !== null) {
    const index = list.findIndex((issue) => issue.number === afterNumber);
    if (index !== -1) list = list.slice(index + 1);
    else {
      const descending = !orderBy || String(orderBy.direction ?? 'DESC').toUpperCase() !== 'ASC';
      list = list.filter((issue) => (descending ? issue.number < afterNumber : issue.number > afterNumber));
    }
  }
  const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const last = page.length > 0 ? page[page.length - 1] : null;
  return wrap('IssueConnection', {
    __nodes: page.map((issue) => wrap('Issue', { __repo: repo, __issue: issue })),
    __total: list.length,
    __hasNextPage: hasNextPage,
    __endCursor: last ? encodeCursor(last.number) : null,
    __startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
  });
}

function pullRequestsConnection(repo: StoreRepo, args: Record<string, unknown>): Obj {
  const list = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : list.length;
  const page = list.slice(0, first);
  const last = page.length > 0 ? page[page.length - 1] : null;
  return wrap('PullRequestConnection', {
    __nodes: page.map((pull) => wrap('PullRequest', { __repo: repo, __pull: pull })),
    __total: list.length,
    __hasNextPage: list.length > page.length,
    __endCursor: last ? encodeCursor(last.number) : null,
    __startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
  });
}

function resolveIssueField(field: string, obj: Obj, _args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = obj.__repo as StoreRepo;
  const issue = obj.__issue as StoreIssue;
  switch (field) {
    case 'id':
      return encodeIssueId(ownerLogin(repo), repo.name, issue.number);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body ?? '';
    case 'state':
      return issueStateGql(issue);
    case 'url':
      return issueUrl(repo, issue);
    case 'createdAt':
      return issue.created_at ?? null;
    case 'updatedAt':
      return issue.updated_at ?? null;
    case 'closedAt':
      return issue.closed_at ?? null;
    case 'author':
      return wrap('User', { __login: issue.user?.login ?? ownerLogin(repo) });
    case 'labels': {
      const labels = Array.isArray(issue.labels) ? issue.labels : [];
      return wrap('LabelConnection', {
        __nodes: labels.map((label) => wrap('Label', { __name: label.name })),
        __total: labels.length,
        __hasNextPage: false,
        __endCursor: null,
        __startCursor: null,
      });
    }
    case 'comments': {
      const store = ctx.store;
      const comments = typeof store.listComments === 'function' ? store.listComments(repo, issue.number) : [];
      return wrap('IssueCommentConnection', {
        __nodes: comments.map((comment) =>
          wrap('IssueComment', {
            __id: encodeCommentId(ownerLogin(repo), repo.name, issue.number, comment.id),
            __body: comment.body,
            __createdAt: comment.created_at ?? null,
            __url: `${issueUrl(repo, issue)}#issuecomment-${comment.id}`,
          }),
        ),
        __total: comments.length,
        __hasNextPage: false,
        __endCursor: null,
        __startCursor: null,
      });
    }
    default:
      throw unknownField(field, 'Issue');
  }
}

function resolvePullRequestField(field: string, obj: Obj, args: Record<string, unknown>, _ctx: ExecCtx): unknown {
  const repo = obj.__repo as StoreRepo;
  const pull = obj.__pull as StorePull;
  switch (field) {
    case 'id':
      return encodePullId(ownerLogin(repo), repo.name, pull.number);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body ?? '';
    case 'state':
      return pullStateGql(pull);
    case 'merged':
      return pull.merged === true;
    case 'mergeable':
      if (pull.state !== 'open') return 'UNKNOWN';
      return pull.mergeable === false ? 'CONFLICTING' : 'MERGEABLE';
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'headRefOid':
      return pull.head.sha;
    case 'baseRefOid':
      return pull.base.sha;
    case 'createdAt':
      return pull.created_at ?? null;
    case 'updatedAt':
      return pull.updated_at ?? null;
    case 'closedAt':
      return pull.closed_at ?? null;
    case 'mergedAt':
      return pull.merged_at ?? null;
    case 'url':
      return pullUrl(repo, pull);
    case 'author':
      return wrap('User', { __login: pull.user?.login ?? ownerLogin(repo) });
    case 'files': {
      const first = typeof args.first === 'number' && Number.isInteger(args.first) && args.first >= 0 ? args.first : Number.POSITIVE_INFINITY;
      const changes = diffTrees(repo, pull.base.sha, pull.head.sha);
      const page = changes.slice(0, first);
      return wrap('PullRequestFileConnection', {
        __nodes: page.map((change) =>
          wrap('PullRequestFile', {
            __path: change.path,
            __status: change.status,
            __additions: change.additions,
            __deletions: change.deletions,
          }),
        ),
        __total: changes.length,
        __hasNextPage: changes.length > page.length,
        __endCursor: null,
        __startCursor: null,
      });
    }
    default:
      throw unknownField(field, 'PullRequest');
  }
}

// ---------------------------------------------------------------------------
// Mutations.
// ---------------------------------------------------------------------------

function issueWrapper(repo: StoreRepo, issue: StoreIssue): Obj {
  return wrap('Issue', { __repo: repo, __issue: issue });
}

function pullWrapper(repo: StoreRepo, pull: StorePull): Obj {
  return wrap('PullRequest', { __repo: repo, __pull: pull });
}

function clientMutationIdOf(input: Record<string, unknown>): string | null {
  return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
}

function resolveMutationField(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const store = ctx.store;
  const input = isRecord(args.input) ? args.input : {};
  switch (field) {
    case 'createIssue': {
      const repoRef = decodeRepoId(input.repositoryId);
      if (!repoRef) throw new GqlError('Invalid repositoryId.');
      const repo = repoOf(store, repoRef.owner, repoRef.name);
      if (!repo) throw new GqlError(`Repository not found: ${repoRef.owner}/${repoRef.name}.`);
      const title = asString(input.title, 'createIssue.input.title');
      const body = typeof input.body === 'string' ? input.body : '';
      const created = store.createIssue(repo, title, body);
      const issue = isRecord(created) && typeof created.number === 'number' ? (created as unknown as StoreIssue) : store.getIssue(repo, 0) ?? null;
      const readBack = issue ?? repo.issues.find((entry) => entry.title === title) ?? null;
      if (!readBack) throw new GqlError('createIssue did not create an issue.');
      return wrap('CreateIssuePayload', { __issue: issueWrapper(repo, readBack), __clientMutationId: clientMutationIdOf(input) });
    }
    case 'closeIssue': {
      const issueRef = decodeIssueId(input.issueId);
      if (!issueRef) throw new GqlError('Invalid issueId.');
      const repo = repoOf(store, issueRef.owner, issueRef.repo);
      if (!repo) throw new GqlError(`Repository not found: ${issueRef.owner}/${issueRef.repo}.`);
      const existing = store.getIssue(repo, issueRef.number) ?? repo.issues.find((entry) => entry.number === issueRef.number) ?? null;
      if (!existing) throw new GqlError(`Issue not found: #${issueRef.number}.`);
      const closed = store.closeIssue(repo, issueRef.number);
      const readBack =
        (isRecord(closed) && typeof closed.number === 'number' ? (closed as unknown as StoreIssue) : null) ??
        store.getIssue(repo, issueRef.number) ??
        existing;
      return wrap('CloseIssuePayload', { __issue: issueWrapper(repo, readBack), __clientMutationId: clientMutationIdOf(input) });
    }
    case 'createPullRequest': {
      const repoRef = decodeRepoId(input.repositoryId);
      if (!repoRef) throw new GqlError('Invalid repositoryId.');
      const repo = repoOf(store, repoRef.owner, repoRef.name);
      if (!repo) throw new GqlError(`Repository not found: ${repoRef.owner}/${repoRef.name}.`);
      const baseRefName = asString(input.baseRefName, 'createPullRequest.input.baseRefName');
      const headRefName = asString(input.headRefName, 'createPullRequest.input.headRefName');
      const title = asString(input.title, 'createPullRequest.input.title');
      const body = typeof input.body === 'string' ? input.body : '';
      const created = store.createPull(repo, headRefName, baseRefName, title, body);
      const pull = isRecord(created) && typeof created.number === 'number' ? (created as unknown as StorePull) : null;
      const readBack = pull ?? repo.pulls.find((entry) => entry.head.ref === headRefName && entry.base.ref === baseRefName) ?? null;
      if (!readBack) throw new GqlError('createPullRequest did not create a pull request.');
      return wrap('CreatePullRequestPayload', { __pullRequest: pullWrapper(repo, readBack), __clientMutationId: clientMutationIdOf(input) });
    }
    case 'mergePullRequest': {
      const pullRef = decodePullId(input.pullRequestId);
      if (!pullRef) throw new GqlError('Invalid pullRequestId.');
      const repo = repoOf(store, pullRef.owner, pullRef.repo);
      if (!repo) throw new GqlError(`Repository not found: ${pullRef.owner}/${pullRef.repo}.`);
      const existing = store.getPull(repo, pullRef.number) ?? repo.pulls.find((entry) => entry.number === pullRef.number) ?? null;
      if (!existing) throw new GqlError(`Pull request not found: #${pullRef.number}.`);
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const merged = store.mergePull(repo, pullRef.number, method);
      if (isRecord(merged) && 'ok' in merged && merged.ok === false) {
        throw new GqlError(typeof merged.message === 'string' ? merged.message : 'Merge failed.');
      }
      const readBack =
        (isRecord(merged) && typeof merged.number === 'number' ? (merged as unknown as StorePull) : null) ??
        store.getPull(repo, pullRef.number) ??
        existing;
      return wrap('MergePullRequestPayload', { __pullRequest: pullWrapper(repo, readBack), __clientMutationId: clientMutationIdOf(input) });
    }
    case 'addComment': {
      const issueRef = decodeIssueId(input.subjectId);
      if (!issueRef) throw new GqlError('Invalid subjectId.');
      const repo = repoOf(store, issueRef.owner, issueRef.repo);
      if (!repo) throw new GqlError(`Repository not found: ${issueRef.owner}/${issueRef.repo}.`);
      const existing = store.getIssue(repo, issueRef.number) ?? repo.issues.find((entry) => entry.number === issueRef.number) ?? null;
      if (!existing) throw new GqlError(`Issue not found: #${issueRef.number}.`);
      const body = asString(input.body, 'addComment.input.body');
      const comment = store.addComment(repo, issueRef.number, body);
      const commentId = isRecord(comment) && typeof comment.id === 'number' ? comment.id : 1;
      const node = wrap('IssueComment', {
        __id: encodeCommentId(ownerLogin(repo), repo.name, issueRef.number, commentId),
        __body: body,
        __createdAt: isRecord(comment) && typeof comment.created_at === 'string' ? comment.created_at : null,
        __url: `${issueUrl(repo, existing)}#issuecomment-${commentId}`,
      });
      const edge = wrap('IssueCommentEdge', { __node: node, __cursor: encodeCursor(commentId) });
      return wrap('AddCommentPayload', { __commentEdge: edge, __clientMutationId: clientMutationIdOf(input) });
    }
    default:
      throw unknownField(field, 'Mutation');
  }
}

// ---------------------------------------------------------------------------
// Document execution and HTTP handler.
// ---------------------------------------------------------------------------

interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeDocument(store: StoreLike, body: unknown): GraphQLResult {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string.' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(body.query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax Error.' }] };
  }
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((op) => op.name === operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const ctx: ExecCtx = {
    store,
    vars: {},
    declaredVars: new Set(operation.varDefs.map((def) => def.name)),
    errors: [],
    fragments: doc.fragments,
  };
  for (const def of operation.varDefs) {
    if (Object.prototype.hasOwnProperty.call(variables, def.name) && variables[def.name] !== undefined) {
      ctx.vars[def.name] = variables[def.name];
    } else if (def.defaultValue !== null) {
      try {
        ctx.vars[def.name] = resolveValue(def.defaultValue, ctx);
      } catch {
        ctx.vars[def.name] = null;
      }
    } else if (def.type.endsWith('!')) {
      return { data: null, errors: [{ message: `Variable "$${def.name}" of required type "${def.type}" was not provided.` }] };
    } else {
      ctx.vars[def.name] = null;
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, rootType, wrap(rootType, {}), ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export async function handleGraphQL(store: StoreLike, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${store.token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body too large.' }] });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body.' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeDocument(store, entry)));
    return true;
  }
  sendJson(res, 200, executeDocument(store, parsed));
  return true;
}
