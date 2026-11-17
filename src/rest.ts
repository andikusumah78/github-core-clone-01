// REST v3 handlers for the forge: every route under /api/v3.
//
// Contract notes:
// - Every reply (including 401/404/400) carries X-GitHub-Request-Id.
// - All replies are JSON via sendJson, except DELETE repo (204, empty body).
// - Every route requires `Authorization: Bearer <store.token>`.
// - A repo under any owner other than the token login is 404, never 403.
// - No wall clock, no randomness: timestamps come from the store's clock.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, readBody, sendJson } from './util.ts';
import { deriveLogin } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

export { deriveLogin };

type JsonObject = Record<string, unknown>;

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeSegment);
}

function parsePositiveInt(
  value: string | null,
  fallback: number,
): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nodeIdForRepo(repo: Repo): string {
  return `R_${Buffer.from(`${repo.owner}/${repo.name}`, 'utf8').toString('base64url')}`;
}

function repoObject(repo: Repo, origin: string): JsonObject {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    node_id: nodeIdForRepo(repo),
    name: repo.name,
    full_name: fullName,
    owner: { login: repo.owner, id: repo.ownerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    language: null,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    clone_url: `https://github.com/${fullName}.git`,
    html_url: `https://github.com/${fullName}`,
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    url: `${origin}/api/v3/repos/${fullName}`,
  };
}

function issueObject(issue: Issue, repo: Repo, origin: string): JsonObject {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    user: issue.user,
    assignee: null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments: issue.comments.length,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(pull: PullRequest, repo: Repo, origin: string): JsonObject {
  const repoRef = { name: repo.name, full_name: `${repo.owner}/${repo.name}` };
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha, repo: repoRef },
    base: { ref: pull.base.ref, sha: pull.base.sha, repo: repoRef },
    user: pull.user,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function lineCount(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not start a new line.
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/**
 * Handle a REST request. Returns true when the path is under /api/v3 (the
 * request was answered here), false otherwise so the caller can route it
 * elsewhere.
 */
export async function handleRest(
  store: Store,
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
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) {
    return false;
  }
  const requestId = store.nextRequestId();
  const origin = originOf(req);
  const method = (req.method ?? 'GET').toUpperCase();

  const reply = (
    status: number,
    body: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    sendJson(res, status, body, {
      'X-GitHub-Request-Id': requestId,
      ...extra,
    });
  };
  const notFound = (message = 'Not Found'): void => {
    reply(404, { message });
  };

  // Auth: every /api/v3 route requires the bearer token.
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${store.token}`) {
    reply(401, { message: 'Unauthorized' });
    return true;
  }

  // Read + parse a JSON body for methods that carry one. Malformed JSON is 400.
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      reply(400, { message: 'Bad Request' });
      return true;
    }
    const parsed = parseJsonBody(raw);
    if (!parsed.ok && !parsed.empty) {
      reply(400, { message: 'Malformed JSON' });
      return true;
    }
    body = parsed.ok ? parsed.value : {};
  }
  const bodyObj =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as JsonObject)
      : {};

  const segments = splitPath(pathname);
  // segments[0] === 'api', segments[1] === 'v3'

  // ---- API root and meta ----
  if (segments.length === 2) {
    if (method === 'GET') {
      reply(
        200,
        {
          current_user_url: `${origin}/api/v3/user`,
          rate_limit_url: `${origin}/api/v3/rate_limit`,
        },
        { 'X-OAuth-Scopes': 'repo, read:org' },
      );
    } else {
      notFound();
    }
    return true;
  }

  if (segments.length === 3 && segments[2] === 'meta') {
    if (method === 'GET') {
      reply(200, { installed_version: '1.0.0' });
    } else {
      notFound();
    }
    return true;
  }

  // ---- /user ----
  if (segments.length === 3 && segments[2] === 'user') {
    if (method === 'GET') {
      reply(200, { login: store.tokenLogin, id: 1000, type: 'User' });
    } else {
      notFound();
    }
    return true;
  }

  // ---- /user/repos ----
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const perPage = parsePositiveInt(search.get('per_page'), 30);
      const page = parsePositiveInt(search.get('page'), 1);
      const all = store.listRepos(store.tokenLogin);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      if (totalPages > 1) {
        const pageUrl = (p: number): string =>
          `${origin}/api/v3/user/repos?per_page=${perPage}&page=${p}`;
        const links: string[] = [];
        if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
        if (page > 1) links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
        links.push(`<${pageUrl(1)}>; rel="first"`);
        links.push(`<${pageUrl(totalPages)}>; rel="last"`);
        extra.Link = links.join(', ');
      }
      reply(
        200,
        slice.map((repo) => repoObject(repo, origin)),
        extra,
      );
      return true;
    }
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      if (name === '') {
        reply(422, { message: 'name is required' });
        return true;
      }
      if (store.getRepo(store.tokenLogin, name) !== undefined) {
        reply(422, { message: 'already exists' });
        return true;
      }
      const repo = store.createRepo(store.tokenLogin, 1000, name, {
        description:
          typeof bodyObj.description === 'string' ? bodyObj.description : '',
        private: bodyObj.private === true,
      });
      reply(201, repoObject(repo, origin));
      return true;
    }
    notFound();
    return true;
  }

  // ---- /repos/{owner}/{repo}[...] ----
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = segments[3];
    const repoName = segments[4];
    if (repoName === undefined || repoName === '') {
      notFound();
      return true;
    }
    // Owner mismatch is 404, never 403.
    if (owner !== store.tokenLogin) {
      notFound();
      return true;
    }
    const repo = store.getRepo(owner, repoName);

    // /repos/{o}/{r}
    if (segments.length === 5) {
      if (method === 'GET') {
        if (repo === undefined) {
          notFound();
          return true;
        }
        reply(200, repoObject(repo, origin));
        return true;
      }
      if (method === 'PATCH') {
        if (repo === undefined) {
          notFound();
          return true;
        }
        if (typeof bodyObj.description === 'string') {
          repo.description = bodyObj.description;
          repo.updatedAt = store.clock.now();
        }
        reply(200, repoObject(repo, origin));
        return true;
      }
      if (method === 'DELETE') {
        if (repo === undefined) {
          notFound();
          return true;
        }
        store.deleteRepo(owner, repoName);
        res.writeHead(204, { 'X-GitHub-Request-Id': requestId });
        res.end();
        return true;
      }
      notFound();
      return true;
    }

    if (repo === undefined) {
      notFound();
      return true;
    }

    const sub = segments[5];

    // ---- git/refs ----
    if (sub === 'git' && segments[6] === 'refs') {
      if (method === 'POST' && segments.length === 7) {
        const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        if (ref === '' || sha === '') {
          reply(422, { message: 'ref and sha are required' });
          return true;
        }
        if (!store.createBranch(repo, ref, sha)) {
          reply(422, { message: 'Reference already exists' });
          return true;
        }
        reply(201, { ref, object: { sha } });
        return true;
      }
      if (
        method === 'GET' &&
        segments.length === 9 &&
        segments[7] === 'heads'
      ) {
        const branch = segments[8];
        const tip = store.getBranchTip(repo, `refs/heads/${branch}`);
        if (tip === undefined) {
          notFound();
          return true;
        }
        reply(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
        return true;
      }
      notFound();
      return true;
    }

    // ---- branches ----
    if (sub === 'branches') {
      if (method === 'GET' && segments.length === 6) {
        const out: JsonObject[] = [];
        for (const [ref, sha] of repo.refs) {
          if (ref.startsWith('refs/heads/')) {
            out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
          }
        }
        reply(200, out);
        return true;
      }
      if (method === 'GET' && segments.length === 7) {
        const tip = store.getBranchTipByName(repo, segments[6]);
        if (tip === undefined) {
          notFound();
          return true;
        }
        reply(200, { name: segments[6], commit: { sha: tip } });
        return true;
      }
      notFound();
      return true;
    }

    // ---- commits ----
    if (sub === 'commits') {
      if (method === 'GET' && segments.length === 6) {
        const shaParam = search.get('sha');
        let tip: string | undefined;
        if (shaParam !== null && shaParam !== '') {
          tip =
            store.getBranchTipByName(repo, shaParam) ??
            store.getBranchTip(repo, shaParam) ??
            (repo.objects.has(shaParam) ? shaParam : undefined);
        }
        if (tip === undefined) {
          tip = store.getBranchTipByName(repo, repo.defaultBranch);
        }
        const out: JsonObject[] = [];
        if (tip !== undefined) {
          const seen = new Set<string>();
          const stack: string[] = [tip];
          while (stack.length > 0) {
            const sha = stack.pop() as string;
            if (seen.has(sha)) continue;
            seen.add(sha);
            const commit = store.readCommit(repo, sha);
            if (commit === undefined) continue;
            out.push({
              sha,
              commit: { message: commit.message.replace(/\n+$/, '') },
            });
            for (const parent of commit.parents) stack.push(parent);
          }
        }
        reply(200, out);
        return true;
      }
      notFound();
      return true;
    }

    // ---- contents ----
    if (sub === 'contents') {
      const contentPath = segments.slice(6).join('/');
      if (method === 'PUT') {
        const content =
          typeof bodyObj.content === 'string' ? bodyObj.content : '';
        const message =
          typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const branch =
          typeof bodyObj.branch === 'string' && bodyObj.branch !== ''
            ? bodyObj.branch
            : repo.defaultBranch;
        const sha =
          typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
        const result = store.putContent(
          repo,
          branch,
          contentPath,
          content,
          message,
          sha,
        );
        if (!result.ok) {
          reply(result.status, { message: result.message });
          return true;
        }
        reply(result.created ? 201 : 200, {
          content: { sha: result.contentSha, encoding: 'base64' },
          commit: { sha: result.commitSha },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = search.get('ref');
        const branch =
          refParam !== null && refParam !== ''
            ? refParam
            : repo.defaultBranch;
        const result = store.getContent(repo, branch, contentPath);
        if (result.kind === 'missing') {
          notFound();
          return true;
        }
        if (result.kind === 'file') {
          reply(200, {
            type: 'file',
            encoding: 'base64',
            content: result.content.toString('base64'),
            sha: result.sha,
            size: result.size,
          });
          return true;
        }
        reply(200, result.entries);
        return true;
      }
      if (method === 'DELETE') {
        const message =
          typeof bodyObj.message === 'string' ? bodyObj.message : '';
        const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
        const branch =
          typeof bodyObj.branch === 'string' && bodyObj.branch !== ''
            ? bodyObj.branch
            : repo.defaultBranch;
        const result = store.deleteContent(
          repo,
          branch,
          contentPath,
          message,
          sha,
        );
        if (!result.ok) {
          reply(result.status, { message: result.message });
          return true;
        }
        reply(200, { commit: { sha: result.commitSha } });
        return true;
      }
      notFound();
      return true;
    }

    // ---- labels ----
    if (sub === 'labels') {
      if (method === 'POST' && segments.length === 6) {
        const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
        if (name === '') {
          reply(422, { message: 'name is required' });
          return true;
        }
        const color =
          typeof bodyObj.color === 'string' ? bodyObj.color : undefined;
        const label = store.createLabel(repo, name, color);
        reply(201, { name: label.name, color: label.color });
        return true;
      }
      notFound();
      return true;
    }

    // ---- issues ----
    if (sub === 'issues') {
      // /issues
      if (segments.length === 6) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const sort = search.get('sort') ?? 'created';
          const direction = search.get('direction') ?? 'desc';
          const perPage = parsePositiveInt(search.get('per_page'), 30);
          let list = [...repo.issues];
          if (state === 'open') {
            list = list.filter((issue) => issue.state === 'open');
          } else if (state === 'closed') {
            list = list.filter((issue) => issue.state === 'closed');
          }
          if (sort === 'created') {
            list.sort((a, b) => {
              if (a.created_at !== b.created_at) {
                return a.created_at < b.created_at ? -1 : 1;
              }
              return a.number - b.number;
            });
          }
          if (direction === 'desc') list.reverse();
          reply(
            200,
            list
              .slice(0, perPage)
              .map((issue) => issueObject(issue, repo, origin)),
          );
          return true;
        }
        if (method === 'POST') {
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          const issueBody =
            typeof bodyObj.body === 'string' ? bodyObj.body : '';
          const labelNames = Array.isArray(bodyObj.labels)
            ? (bodyObj.labels as unknown[]).filter(
                (label): label is string => typeof label === 'string',
              )
            : [];
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              reply(422, { message: `Label does not exist: ${labelName}` });
              return true;
            }
          }
          const issue = store.createIssue(repo, title, issueBody, labelNames);
          reply(201, issueObject(issue, repo, origin));
          return true;
        }
        notFound();
        return true;
      }
      // /issues/{n} and /issues/{n}/comments
      const issueNumber = Number.parseInt(segments[6] ?? '', 10);
      if (!Number.isInteger(issueNumber)) {
        notFound();
        return true;
      }
      const issue = store.getIssue(repo, issueNumber);
      if (segments.length === 7) {
        if (method === 'GET') {
          if (issue === undefined) {
            notFound();
            return true;
          }
          reply(200, issueObject(issue, repo, origin));
          return true;
        }
        if (method === 'PATCH') {
          if (issue === undefined) {
            notFound();
            return true;
          }
          if (bodyObj.state === 'closed') {
            store.closeIssue(repo, issueNumber);
          } else if (bodyObj.state === 'open') {
            issue.state = 'open';
            issue.closed_at = null;
            issue.updated_at = store.clock.now();
          }
          if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
          if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
          reply(200, issueObject(issue, repo, origin));
          return true;
        }
        notFound();
        return true;
      }
      if (segments.length === 8 && segments[7] === 'comments') {
        if (method === 'POST') {
          if (issue === undefined) {
            notFound();
            return true;
          }
          const commentBody =
            typeof bodyObj.body === 'string' ? bodyObj.body : '';
          const comment = store.addComment(repo, issueNumber, commentBody);
          reply(201, { id: comment.id, body: comment.body });
          return true;
        }
        if (method === 'GET') {
          if (issue === undefined) {
            notFound();
            return true;
          }
          reply(
            200,
            store
              .listComments(repo, issueNumber)
              .map((comment) => ({ id: comment.id, body: comment.body })),
          );
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }

    // ---- pulls ----
    if (sub === 'pulls') {
      // /pulls
      if (segments.length === 6) {
        if (method === 'GET') {
          const state = search.get('state');
          const perPage = parsePositiveInt(search.get('per_page'), 30);
          let list = [...repo.pulls];
          if (state !== 'all') {
            list = list.filter((pull) => pull.state === 'open');
          }
          reply(
            200,
            list
              .slice(0, perPage)
              .map((pull) => pullObject(pull, repo, origin)),
          );
          return true;
        }
        if (method === 'POST') {
          const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
          const base = typeof bodyObj.base === 'string' ? bodyObj.base : '';
          const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
          const pullBody =
            typeof bodyObj.body === 'string' ? bodyObj.body : '';
          const pull = store.createPull(repo, head, base, title, pullBody);
          reply(201, pullObject(pull, repo, origin));
          return true;
        }
        notFound();
        return true;
      }
      // /pulls/{n}[/files|/merge]
      const pullNumber = Number.parseInt(segments[6] ?? '', 10);
      if (!Number.isInteger(pullNumber)) {
        notFound();
        return true;
      }
      const pull = store.getPull(repo, pullNumber);
      if (segments.length === 7) {
        if (method === 'GET') {
          if (pull === undefined) {
            notFound();
            return true;
          }
          reply(200, pullObject(pull, repo, origin));
          return true;
        }
        notFound();
        return true;
      }
      if (segments.length === 8 && segments[7] === 'files') {
        if (method === 'GET') {
          if (pull === undefined) {
            notFound();
            return true;
          }
          const headFiles = store.filesOfCommit(repo, pull.head.sha);
          const baseFiles = store.filesOfCommit(repo, pull.base.sha);
          const allPaths = new Set<string>([
            ...headFiles.keys(),
            ...baseFiles.keys(),
          ]);
          const files: JsonObject[] = [];
          for (const path of allPaths) {
            const headSha = headFiles.get(path);
            const baseSha = baseFiles.get(path);
            if (headSha === baseSha) continue;
            let status: string;
            let additions = 0;
            let deletions = 0;
            if (headSha !== undefined && baseSha === undefined) {
              status = 'added';
              additions = lineCount(store.blobBytes(repo, headSha) ?? Buffer.alloc(0));
            } else if (headSha === undefined && baseSha !== undefined) {
              status = 'removed';
              deletions = lineCount(store.blobBytes(repo, baseSha) ?? Buffer.alloc(0));
            } else {
              status = 'modified';
              additions = lineCount(
                store.blobBytes(repo, headSha as string) ?? Buffer.alloc(0),
              );
              deletions = lineCount(
                store.blobBytes(repo, baseSha as string) ?? Buffer.alloc(0),
              );
              if (additions === 0) additions = 1;
            }
            files.push({
              filename: path,
              status,
              additions,
              deletions,
              changes: additions + deletions,
            });
          }
          reply(200, files);
          return true;
        }
        notFound();
        return true;
      }
      if (segments.length === 8 && segments[7] === 'merge') {
        if (method === 'PUT') {
          if (pull === undefined) {
            notFound();
            return true;
          }
          const mergeMethod =
            typeof bodyObj.merge_method === 'string'
              ? bodyObj.merge_method
              : 'squash';
          const result = store.mergePull(repo, pullNumber, mergeMethod);
          if (!result.ok) {
            reply(result.status, { message: result.message });
            return true;
          }
          reply(200, {
            merged: true,
            sha: result.sha,
            message: 'Pull request successfully merged.',
          });
          return true;
        }
        notFound();
        return true;
      }
      notFound();
      return true;
    }

    notFound();
    return true;
  }

  // Anything else under /api/v3 is an unknown route.
  notFound();
  return true;
}
