# NOTES

Learner write-up for step 2. (Course-owned `README.md` is left alone, per `AGENTS.md`.)

## What I built

Replaced step 1's `greet`/`get_time` demo tools with a notes toolset backed by Cloudflare Workers
KV (binding `NOTES`): `list_notes`, `get_note`, `create_note`, `delete_note`. Notes live in KV, not
the Worker's memory — if they were kept in memory, a later request hitting a different copy of the
Worker (Cloudflare can run many at once) would see an empty notes list, or a deleted note would
reappear, because each copy's memory is separate and nothing shared it between them.

## Design choices

- **Names and descriptions are written for the model, not for me.** Each description says *when*
  to call the tool, not just what it does (e.g. `get_note`'s description tells the model to call
  `list_notes` first to find an id).
- **Tight input schemas.** `create_note`'s `content` is `min(1).max(2000)` — rejected at the
  protocol layer, before my code ever runs, rather than failing deep inside a handler.
- **Structured output + text.** Every tool returns `structuredContent` (so the model or a future
  widget can read fields directly) alongside a short human-readable summary.
- **Annotations.** `list_notes`/`get_note` are `readOnlyHint: true`; `delete_note` is
  `destructiveHint: true`, so a host can decide whether to confirm before calling it.
- **Recoverable errors.** A missing note returns `isError: true` with a message that tells the
  model what to do next (call `list_notes`), instead of throwing.

## Bad vs. good: `do_thing` vs. `create_note`

`src/bad-example.ts` has a deliberately badly designed tool, **never registered on the real
server** — it exists only for this comparison, not as a live endpoint.

| | `create_note` (good) | `do_thing` (bad) |
|---|---|---|
| Name | Says what it does | Tells the model nothing |
| Description | Explains what it returns and when to use it | None |
| Input schema | `content: string, 1–2000 chars` | `data: any` — accepts anything |
| Failure mode | Rejected at the schema layer with a clear message | Throws a raw `TypeError` deep in the handler if `data.content` is missing |
| Output | `{ id, content, createdAt }` + a one-line summary | A bare `"ok"` — no id, nothing usable |
| Annotations | None needed (not destructive) | None at all (can't tell host this isn't read-only) |

The practical effect: with a vague name and no description, the model has nothing to match
against a user's actual request, so it either picks `do_thing` for the wrong reason, picks a
different tool entirely, or asks the user to clarify when it shouldn't have to. A loose `any`
schema means the model can — and does — pass a shape that looks plausible but isn't what the
handler expects, so failures surface as confusing stack traces instead of a message it can act on
and retry. None of that is hypothetical: I can trigger the `TypeError` just by calling `do_thing`
with `{ "data": "some string" }` instead of `{ "data": { "content": "..." } }` — a mistake `zod`
would have caught instantly on `create_note`.

## Run, test, deploy

Same commands as step 1, run from `step-02-tool-design/`:

```bash
npm install
npm run dev     # wrangler dev, local MCP endpoint at http://localhost:8787/mcp
npm test        # vitest run, inside the real Workers runtime (Miniflare)
npm run deploy  # wrangler deploy — needs your own NOTES KV namespace id first
```

Before the first deploy, create the KV namespace on your own Cloudflare account and put its id in
`wrangler.jsonc`'s `kv_namespaces` entry:

```bash
npx wrangler kv namespace create NOTES
```

Deployed URL for clients: `https://learn-mcp-step-02.<your-subdomain>.workers.dev/mcp`.

## Five prompts to check tool selection in Claude and ChatGPT

1. "Create a note that says 'buy groceries'."  → should call `create_note`.
2. "What notes do I have?"  → should call `list_notes`.
3. "Show me the full text of my groceries note."  → should call `list_notes` (to find the id) then
   `get_note`.
4. "Delete my groceries note."  → should call `delete_note`, and a host that respects
   `destructiveHint` may ask you to confirm first.
5. "Get the note with id `not-a-real-id`."  → should call `get_note` and come back with the clear
   "no note with id ... exists" message, not a crash.
