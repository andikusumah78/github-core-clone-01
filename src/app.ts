// The HTTP server: one Store, four surfaces, one 404. Routing order matters —
// git paths first (they own /:owner/:repo.git/...), then REST, GraphQL and MCP.
// A request handler never throws out of the server: any unexpected error
// becomes a 500 JSON reply and the process stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sendJson, pathOf } from './util.ts';
import { Store, deriveLogin } from './store.ts';
import { handleGitRequest } from './git-proto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(deriveLogin(token), token);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res, store).catch((err: unknown) => {
      process.stderr.write(`[entry] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        sendJson(res, 500, { message: 'Internal Server Error' }, {
          'x-github-request-id': store.nextRequestId(),
        });
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';

  // The env's boot check calls this twice: 200 {"ok": true}. No auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (await handleGitRequest(store, req, res)) return;
  if (await handleRest(store, req, res)) return;
  if (await handleGraphQL(store, req, res)) return;
  if (await handleMcp(store, req, res)) return;

  // Everything else, every method: GitHub's 404 body, as JSON.
  sendJson(res, 404, { message: 'Not Found' }, {
    'x-github-request-id': store.nextRequestId(),
  });
}
