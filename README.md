# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/andikusumah78/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/andikusumah78/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process: git smart HTTP, REST v3, GraphQL v4 and MCP. No dependencies, no git binary, no outside service — only the Node 22 standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=69w7r9cr&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

From its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2,
  receive-pack v0, with real packfiles built and parsed by hand
  (node:zlib, node:crypto).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  issues, comments, labels, pull requests and merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, with introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP: initialize,
  tools/list, tools/call, acting on the same store as REST.

The process binds an ephemeral port, registers it with the trial env at
`$MAKEFUN_ENV_URL/register`, serves until the env answers
`{"done": true}` on `$MAKEFUN_ENV_URL/done`, then exits 0.

## Layout

- `main.ts` — entry ↔ env lifecycle (bind, register, poll done, exit).
- `src/app.ts` — HTTP server and routing.
- `src/util.ts` — JSON replies, body reading, deterministic logical clock.
- `src/store.ts` — the store: repos, issues, pull requests, labels, and the
  per-repo git object database.
- `src/git-objects.ts` — git objects (commit/tree/blob/tag), packfiles, deltas.
- `src/git-proto.ts` — pkt-line framing, upload-pack v2/v0, receive-pack v0.
- `src/rest.ts` — REST v3 handlers.
- `src/graphql.ts` — GraphQL executor and schema.
- `src/mcp.ts` — MCP endpoint.

## Determinism

Every timestamp the forge emits comes from a logical clock (one second per
tick from the competition opening), never the wall clock, so two runs of the
same trial leave byte-identical state.

## License

MIT — see [LICENSE](LICENSE).
