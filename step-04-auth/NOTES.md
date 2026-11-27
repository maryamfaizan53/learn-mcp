# Step 4 notes — auth with Better Auth + D1

## What this step does

The step 2/3 notes server now sits behind sign-in. A caller authenticates with
OAuth 2.1 (email + password, through Better Auth), gets an access token bound
to this server's `/mcp` resource, and every tool call is scoped to that
caller's company (organization) and role. Notes are no longer global — each
one is keyed `org:<orgId>:user:<userId>:note:<id>` in KV, derived only from
the verified token, never from anything the client sends.

## Architecture decisions

- **Better Auth, not `@cloudflare/workers-oauth-provider`.** `AGENTS.md` and
  the step README both call for Better Auth, so no hand-rolled OAuth
  authorization server. `@better-auth/mcp`'s `mcp()` plugin *is* the OAuth
  2.1/OIDC provider configured for MCP: it binds tokens to a `resource` URL
  (RFC 8707), serves RFC 9728 protected-resource metadata, and
  `requireMcpAuth()` protects `/mcp` with the right `401`/`403` challenges.
- **D1 for auth data, KV for notes.** Better Auth's own tables (user, session,
  account, organization, member, oauthClient, jwks, ...) live in a dedicated
  D1 database (`learn-mcp-step-04-auth`), kept completely separate from the
  `NOTES` KV namespace. Matches the "Notes store: KV, Auth database: D1" split
  in `AGENTS.md`'s tech stack table.
- **CIMD over DCR.** Client ID Metadata Documents (`@better-auth/cimd`) are
  the MCP-2026-07-28-preferred way for a client to register — it's just the
  client's own metadata served at an HTTPS URL that doubles as its `client_id`
  — instead of Dynamic Client Registration.
- **Email + password only, no SSO.** The step README's SSO prompt (linking a
  company's own identity provider via `@better-auth/sso`) is explicitly
  optional and was skipped for this pass. It's a reasonable "step 4b" to come
  back to, but every learner should get the required flow working first.
- **One company per user.** The `organization` plugin's `user.create.after`
  hook auto-creates a personal company for every new sign-up
  (`creatorRole: "admin"`), so no tool ever has to handle "user with no
  company yet." Every user in this step has exactly one company, which keeps
  the company lookup in `index.ts` unambiguous.
- **Identity bridged via `AsyncLocalStorage`, not a claim on the token.** The
  OAuth access token `mcp()` issues only carries the standard claims
  (`sub`, `aud`, `client_id`, `scope`, ...) — `definePayload` doesn't reach
  it. So the Worker's `fetch` looks up `{ orgId, role }` from D1 by the
  verified `sub` on every request and runs the rest of that request inside
  `identityStorage.run({ userId, orgId, role }, ...)`. Tool handlers read it
  back with `getIdentity()`. This is also why no tool, resource, or prompt
  takes a company or user ID as an argument — per `AGENTS.md`'s multi-tenancy
  rule, the company always comes from the verified token, re-checked against
  the database on every call.

## Bugs hit and how they were fixed

1. **`@better-auth/cli` is deprecated on npm.** Fixed by installing the
   renamed `auth` package instead.
2. **`auth generate` only supports a Kysely-backed database for migrations**,
   not a raw `D1Database`. Fixed by wrapping `env.DB` in `kysely-d1`'s
   `D1Dialect`.
3. **`auth generate`/`migrate` can't resolve real env vars.** Every `env.X`
   access during the CLI returns the literal string `"env.X"`. `getMcpBaseUrl()`
   detects that placeholder and falls back to a dummy URL, since the CLI only
   reads the plugins' schema and never serves real traffic.
4. **`auth generate` needs a real, introspectable DB connection**, not just
   schema knowledge. Solved with a CLI-only `auth.cli.ts` using Node's
   built-in `node:sqlite` (`DatabaseSync(":memory:")`) — never imported by the
   deployed Worker.
5. **Worker crashed at startup: `ZodLazy is not a constructor`.** Two causes,
   both confirmed with an isolated minimal reproduction:
   - `@modelcontextprotocol/server` imports zod via the `zod/v4` subpath,
     while Better Auth's packages import plain `zod`. Both resolve to the
     same file but as two different wrapper modules, so esbuild bundles two
     separate copies of zod's internals. Fixed with `wrangler.jsonc`'s
     `alias: { "zod/v4": "zod" }`.
   - Building the Better Auth instance eagerly at module scope crashes under
     workerd; the exact same plugin stack builds fine inside a request's
     execution context. Fixed with a lazy, per-isolate `getAuth()` singleton
     in `auth.ts`.
6. **OAuth access tokens carry no custom claims.** `definePayload` only
   shapes the separate `/token`/id_token endpoints, not the real OAuth access
   token minted through the authorize → token flow. Fixed by dropping that
   approach entirely and looking up `{ orgId, role }` from D1 by the verified
   `sub` in `index.ts` instead (see Architecture decisions above).
7. **`requireMcpAuth`'s default `resource` is just the base URL**, not
   `${baseURL}/mcp`, so it silently rejected every real access token as the
   wrong audience. Fixed by passing `{ resource: getMcpResource() }`
   explicitly — the exact same resource string `mcp()` was configured with.
8. **CIMD "Failed to fetch metadata document" blocked every real client**
   (Claude, ChatGPT) from connecting in production, with `invalid_client`.
   Diagnosed with `wrangler tail` (to see the real `client_id` being
   requested) and a temporary debug route that proved a plain `fetch()` to
   that same URL succeeded fine on its own. The fix was wrapping
   `fetchClientMetadataResource` in its own arrow function instead of passing
   the bare `fetch` reference, so `cimd()` invoking it as a callback can't
   change how `fetch` itself gets called. Confirmed fixed against ChatGPT in
   production; the debug route and temporary logging were removed afterwards.
9. **Wrangler's interactive "add binding" prompts kept choosing the wrong
   binding name** (e.g. `NOTES_STEP04` instead of `NOTES`). Fixed each time
   by hand-editing `wrangler.jsonc` to keep the binding name matching the
   code (the *title* on Cloudflare's side can be anything; the binding name
   cannot).

## Known caveat

`wrangler.jsonc`'s `MCP_BASE_URL` is set to the production URL
(`https://learn-mcp-step-04.maryamfaizan-mcp.workers.dev`) for deploying.
Local `wrangler dev` testing needs it swapped back to `http://localhost:8787`
temporarily — there's no per-environment override configured yet, so don't
forget to swap it back before deploying again.

## Testing status

- `npx tsc --noEmit`: clean.
- `npm test` (vitest, Workers runtime): 8/8 passing — covers sign-up, the
  real PKCE authorize → token flow against a pre-registered test OAuth
  client, and `tools/call` through the authenticated server.
- Production: a full sign-up → `/login` → `/consent` → token → `create_note`/
  `list_notes` round trip confirmed working from ChatGPT (developer mode).

## Not yet done

- Claude (claude.ai) connector: blocked by an account-side "a connector with
  this URL already exists in your organization" issue that doesn't show the
  connector anywhere in the UI. This looks like a claude.ai account-state
  inconsistency, not a bug in this server — ChatGPT was used as the proof of
  concept instead. Worth retrying later or asking Anthropic support.
- SSO (the step's optional last prompt) — not attempted.

## Security review

Reviewed by reading the actual shipped code in `node_modules` for
`better-auth`, `@better-auth/mcp`, `@better-auth/oauth-provider` and
`@better-auth/cimd` (not just their docs), against the four areas the step
asks for: token validation, redirect URIs, secret handling, CORS.

### Found and fixed: missing `BETTER_AUTH_SECRET` (severe)

Without an explicit `secret` passed to `betterAuth()`, the library signs
session and OAuth-state cookies — and encrypts the JWKS private key it
stores in D1 for signing this server's own MCP access tokens — with a
hardcoded fallback value, `"better-auth-secret-12345678901234567890"`,
baked into the package and identical for every Better Auth deployment that
doesn't set one.

Better Auth does refuse to start on that fallback, but only when
`NODE_ENV === "production"` (`@better-auth/core/env`'s `isProduction`). A
Cloudflare Worker never sets `NODE_ENV` unless a step explicitly adds it as
a `vars` entry, which this one didn't — so the safety check silently never
fired, and the real deployed server was signing cookies and encrypting its
signing key with a secret anyone can read out of the `better-auth` npm
package. That's a session-forgery and signing-key-compromise risk, not a
theoretical one.

Fixed in `src/auth.ts`: `getBetterAuthSecret()` reads `env.BETTER_AUTH_SECRET`
and throws a clear error on first request if it's missing, instead of
falling through to the library default. `secret: getBetterAuthSecret()` is
now passed explicitly to `betterAuth()`. `wrangler.jsonc` documents (in a
comment, not a value — it's a secret) that it must be set with
`wrangler secret put BETTER_AUTH_SECRET` in production and in `.dev.vars`
locally; `.dev.vars.example` was also stale (still said "no secrets needed,"
left over from the step-1 copy prompt) and now shows the real variable
name with instructions to generate one via `openssl rand -base64 32`.

### Checked, no gap found

- **Token validation.** `requireMcpAuth()` verifies every access token's
  signature against the server's own JWKS, and — because `index.ts` passes
  `{ resource: getMcpResource() }` explicitly — rejects any token not bound
  to this exact `/mcp` resource (RFC 8707). `index.ts` then re-derives the
  caller's company and role from D1 by the verified `sub` on every single
  request; nothing about identity is cached or trusted from the token's
  other claims or from any tool argument.
- **Redirect URIs.** `@better-auth/oauth-provider`'s authorize endpoint only
  resolves a `redirect_uri` that's in the connecting client's own registered
  list (`resolveTrustedRedirectUri` → `findRegisteredRedirectUri`), and the
  token endpoint re-checks the exact same `redirect_uri` was supplied again
  at the code exchange (`checkVerificationValue`), rejecting any mismatch
  with `invalid_grant`. This is enforced by the library on every flow,
  including the CIMD one our tests and the ChatGPT connection both exercise.
- **CORS.** `/mcp` serves `Access-Control-Allow-Origin: *` by default (from
  `agents/mcp/server`'s `createMcpHandler`). That's intentional, not a gap —
  this endpoint is protected by a bearer token a caller must supply
  explicitly, never an ambient credential like a cookie that a browser would
  attach automatically, so a wildcard origin doesn't expose anything to a
  malicious page. Better Auth's own `/api/auth/*` routes, and our hand-rolled
  `/login`/`/consent` pages, emit no `Access-Control-Allow-Origin` header at
  all, so a cross-origin page can't read their responses either way; the
  whole sign-in/consent flow only ever makes same-origin requests by design.
- **Secret-adjacent code review.** `/login`'s and `/consent`'s HTML templates
  escape every value taken from the query string (`escapeHtml`) or pass it
  through `JSON.stringify`/`encodeURIComponent` before embedding it in a
  script or URL — no reflected-XSS path found. The one D1 query keyed by
  caller input (`list_company_members`) uses a parameterized `.bind()` call,
  not string interpolation.
