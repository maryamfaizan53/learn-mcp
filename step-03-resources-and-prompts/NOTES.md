# NOTES

Learner write-up for step 3. (Course-owned `README.md` is left alone, per `AGENTS.md`.)

## What I built

The step 2 notes server, unchanged in its tools, plus:

- A `note://{id}` **resource** (a `ResourceTemplate`) so a note can be attached directly to a
  conversation instead of only fetched via `get_note`. `resources/list` enumerates every note
  (reusing `listNotes()` from `notes.ts`); `resources/read` returns one note's text, or throws
  `ResourceNotFoundError` for an unknown id — a real MCP protocol error, not a crash.
- A `summarize_notes` **prompt** with one optional `tag` argument. It tells the model to use any
  `note://` resources already attached, or fall back to `list_notes`/`get_note`, then summarize
  (optionally only notes matching `tag`). The handler only builds a message string — no side
  effects, per the spec's own rule for prompts.
- `create_note` and `delete_note` now call `handler.notify.resourcesChanged()` after a successful
  write, so a client with an open `subscriptions/listen` stream learns the resource list changed.

## Why the notification is "good enough", not complete

`handler.notify` publishes to an in-process `ServerEventBus` that only this Worker *isolate* holds
— it is **not** shared across every copy of the Worker that Cloudflare may be running at once. A
`subscriptions/listen` stream opened against a different isolate never sees this notification. For
a teaching step with a single notes server and no fan-out of listen streams across isolates, that's
fine; a production server that actually depended on every subscriber seeing every change would
need a shared event bus (the `bus` option `createMcpHandler` accepts, backed by something like a
Durable Object or Queue) instead of the default in-memory one.

## Why MCP prompts are rarely used today, and how skills (step 10) differ

A prompt is a static message template: fixed arguments (string-only in the original spec), no
side effects, and the *user* has to notice it exists and pick it from a menu that not every host
even renders the same way (claude.ai, Claude Desktop and ChatGPT each show "prompts" differently,
if at all). It can't fetch data, branch on conditions, or call anything — `summarize_notes` only
ever produces one of two fixed strings.

A **skill served over MCP** (step 10) is different in exactly the ways that matter for a server
like this one:

- **Who picks it.** A prompt is user-picked, up front, before the model has any context on whether
  it's relevant. A skill is **model-picked**, mid-conversation, the same way a tool is — the model
  loads it when it decides the task needs it, without the user having to know the skill exists or
  dig for it in a menu.
- **When it loads.** A prompt's messages are fixed text, generated once per `prompts/get` call. A
  skill is a resource (`skill://...`) the model reads on demand, so it can be real instructions,
  reference material, even runnable code the model is told to execute — far more than a template
  string can hold.
- **Cross-client support.** Prompt-menu UX varies a lot client to client. A skill is read with the
  same `resources/read` call every MCP client already has to support, so it works identically
  everywhere a resource works, with no separate "does this host show prompts" question.

This step keeps `summarize_notes` as a prompt because it's small and the course wants one concrete
example of the primitive while it's still in the spec — not because it's the better choice for a
real "summarize my notes" feature. In a server I was actually shipping to a client today, I'd skip
the prompt and give the model a `summarize-notes` skill instead.

## Tool, resource, or prompt? Reviewing the whole server

| Feature | Primitive | Why |
|---|---|---|
| `list_notes` | Tool | The model decides when it needs the list (e.g. to find an id before calling `get_note`) — that's exactly what model-controlled means. |
| `get_note` | Tool | Takes a parameter the model chooses (`id`); a resource can't take model-chosen parameters the way a tool's schema can. |
| `create_note` | Tool | Has a side effect (writes to KV) — resources and prompts must not. |
| `delete_note` | Tool | Same reason, and it's destructive, which only a tool's `destructiveHint` can signal to a host. |
| A single note's content | Resource (`note://{id}`) | Reference data with a fixed address that a user or host may want to *attach*, independent of whether the model decides to call anything. This is genuinely better as a resource than as another tool — `get_note` already covers the model-initiated case; the resource covers the user-initiated one. |
| "Summarize my notes" | Prompt (for now) | User-picked one-click workflow, which is what prompts are for — but see above: a skill (step 10) would serve this job better once that primitive is available. |

Nothing here should move. The one thing I'd flag for a real deployment: if this server ever needs
reliable list-changed notifications across multiple Worker isolates, the event bus needs to move
off the default in-memory one (see above) — that's a step-11/Durable-Objects-shaped problem, not a
step-3 one.

## Testing targets today

Deployed at `https://learn-mcp-step-03.maryamfaizan-mcp.workers.dev/mcp` and verified three ways:
raw `curl` against the live server (protocol-level correctness: `resources/list`, `resources/read`
including the `ResourceNotFoundError` path, `prompts/list`, `prompts/get` with and without `tag`
all behave exactly as designed), and two real clients:

- **Tools — work everywhere tested.** `create_note`/`get_note`/`list_notes`/`delete_note` all work
  through claude.ai's connector UI and in ChatGPT developer mode. Both show a visible tool-call
  card before the reply.
- **Resources — work in Claude, but not through the chat UI.** claude.ai's connector *settings*
  page only lists tools, and the chat compose box has no resource-attach picker today. Claude
  Code's own harness, though, has a generic MCP resource mechanism outside any one server's own
  UI (`ListMcpResourcesTool`/`ReadMcpResourceTool`), and that successfully listed the `note://`
  resource and read its content back correctly. So the server's resource support is confirmed
  working; which surface shows it depends entirely on the client, not on this server.
- **Prompts — correct on the server, no client UI found yet.** Neither claude.ai's chat box (no
  `/` slash-menu entry for `summarize_notes`) nor Claude Code's harness (no generic "list/get MCP
  prompts" tool exists there either) surfaces this primitive right now. This matches this step's
  own `README.md`: prompts are the least-supported MCP primitive across clients today, which is
  exactly the gap step 10's skills-over-MCP are meant to close. Proven correct instead via the MCP
  Inspector and direct `curl` calls against the deployed server (see the Inspector output / raw
  JSON responses captured during development).
- **ChatGPT (developer mode):** tools confirmed working the same way as Claude. No resource-attach
  or prompt slash-menu was found in this pass either — treated the same as Claude's gap above,
  not as a server defect.

## Run, test, deploy

Same as steps 1–2, from `step-03-resources-and-prompts/`:

```bash
npm install
npm run dev     # wrangler dev, local MCP endpoint at http://localhost:8787/mcp
npm test        # vitest run, inside the real Workers runtime (Miniflare)
npm run deploy  # wrangler deploy
```

This step uses its **own** KV namespace (not step 2's), so testing here never touches
already-graded data:

```bash
npx wrangler kv namespace create NOTES
```

Put the printed id in `wrangler.jsonc`'s `kv_namespaces` entry before deploying. Deployed URL for
clients: `https://learn-mcp-step-03.<your-subdomain>.workers.dev/mcp`.
