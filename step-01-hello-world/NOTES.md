# NOTES

Learner write-up for step 1. (Course-owned `README.md` is left alone, per `AGENTS.md`.)

## Run it locally

```bash
npm install
npm run dev
```

This starts `wrangler dev`, serving the MCP endpoint at `http://localhost:8787/mcp`. Point the
[MCP Inspector](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector) at it:

```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

That opens a browser UI where you can list and call `greet` and `get_time` interactively. (Headless
check with the same package: `npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --method tools/list`.)

## Test

```bash
npm test
```

Runs `vitest run` under `@cloudflare/vitest-plugin`, which executes the suite inside the real
Workers runtime (Miniflare), not Node. `test/greet-concurrency.test.ts` fires 20 concurrent
`tools/call` requests to `greet` with different names and checks each response only ever contains
its own name — proof that building a fresh `McpServer` per request in `createServer()` (the factory
passed to `createMcpHandler`) keeps concurrent callers from seeing each other's data. If the server
were built once at module scope instead of inside the factory, a single `McpServer` instance would
be shared across every concurrent request hitting that Worker isolate, and the SDK's own
request/response bookkeeping — not our tool logic, which has no shared state — could cross-wire
responses between unrelated calls. This test is the thing that would catch that regression if someone
"simplified" the factory away later.

## Deploy

```bash
npx wrangler login     # once, opens a browser to authorize Wrangler
npm run deploy          # wrangler deploy
```

Deploying needs a browser for the login step, so it has to run on a machine that has one — this
can't be done from a browser-less environment. `wrangler deploy` prints the live URL; the MCP
endpoint for clients is that URL plus `/mcp`:

```
https://learn-mcp-step-01.<your-subdomain>.workers.dev/mcp
```

Add that as a custom connector (no auth) in claude.ai / Claude Desktop / ChatGPT developer mode to
test it against a real client.

## Gotcha worth remembering

The 2026-07-28 MCP spec dropped the `initialize` handshake and protocol sessions in favor of a
per-request envelope. Testing this by hand with raw `curl` needs headers and body to agree exactly:
`MCP-Protocol-Version`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name` headers, plus a matching
`_meta` block in the JSON body (`io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientCapabilities`). The Inspector and real MCP clients handle this
automatically — it only bites you writing raw requests yourself (see the test file for a worked
example).
