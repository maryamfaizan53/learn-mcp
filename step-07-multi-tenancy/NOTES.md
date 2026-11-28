# Step 7 notes — multi-tenancy

## What this step does

Turns step 6's single-company-shaped server into one that genuinely
serves many companies: a tenant context resolved once per request from
the verified token (never from a tool argument), a router that sends a
shared-tier company through the same Hyperdrive/RLS setup step 6 already
built and a dedicated-tier company through its own Neon database,
per-company settings cached in KV, and admin-only member management.

## Architecture decisions

- **One `TenantContext` (`src/tenant.ts`), resolved once per request
  in `index.ts`'s `fetch` handler, carried through `AsyncLocalStorage`
  (`src/identity.ts`, renamed from step 6's `RequestIdentity`/
  `identityStorage` now that it carries a full tenant context, not just
  an identity).** Every tool calls `getTenantContext()` - never reads
  `orgId`/`userId`/`role` off a token claim or a tool argument directly.
  This is the one place a bug in resolving the tenant could hide,
  instead of one per tool.
- **Tier is resolved with an extra Neon round trip on every request**
  (`resolveTier()` against the shared database, inside the fetch
  handler, before any tool runs) - even for D1-only tools like
  `list_company_members`. The alternative (caching tier somewhere) risks
  serving a stale tier after a company is moved between tiers; a company
  changing tiers is rare enough that paying this cost on every request,
  always correct, beats caching it and occasionally being wrong.
- **`forTenant(ctx, fn)`'s signature changed** from step 6's
  `forTenant(orgId: string, fn)` to `forTenant(ctx: TenantContext, fn)` -
  every call site in `index.ts` was rewritten, and step 6's own
  `test/row-level-security.test.ts` (written against the old signature)
  was deleted rather than patched, since this step's `test/tenancy.test.ts`
  supersedes it with a broader suite anyway.
- **The tenant router lives in `bindingFor()` inside `src/db.ts`**, not a
  separate file (an earlier draft of `TENANCY.md` said
  `src/tenant-router.ts`; fixed once the code existed to say where the
  logic actually ended up). It's the one place that turns a
  `TenantContext.tier` into a Hyperdrive binding - `forTenant()` always
  goes through it, so no tool code picks a binding itself.
- **A real second database for the dedicated tier**: `enterprise_acme`,
  a second Neon database on this step's own branch (not a separate Neon
  project - see TENANCY.md for why), with the exact same migrations
  (including row-level security) applied as the shared database.
  `HYPERDRIVE_ENTERPRISE` is a second, optional Hyperdrive binding;
  `bindingFor()` throws a clear configuration error for a dedicated-tier
  context if it's ever missing, rather than silently falling back to the
  shared binding - that fallback would be the one bug that actually
  mixes tiers.
- **`company_settings`** (`db/migrations/0006_company_settings.sql`):
  one row per company, same RLS pattern as every other business table.
  Read through `get_company_settings`, cached in Workers KV
  (`SETTINGS_CACHE` binding) under `tenantKey(ctx, "settings")` with a
  5-minute TTL; `update_company_settings` (admin-only) upserts and then
  *clears* the cache key rather than refreshing it in place, so there's
  exactly one place settings are ever written into the cache - the next
  read repopulates it.
- **`invite_member` uses the organization plugin's `addMember`;
  `remove_member` goes straight to D1.** Read both endpoints' actual
  source in `better-auth`'s own package rather than guessing: `addMember`
  only needs `organizationId` in its body and works with no session at
  all, but `removeMember` is built around a real Better Auth session
  (`requireHeaders: true`, `orgSessionMiddleware`) - something this
  server structurally never has, since it authenticates `/mcp` with an
  OAuth bearer token, not a session cookie. Rather than fabricate a fake
  session to satisfy an endpoint that assumes one, `remove_member` does
  the same admin check the plugin endpoint would have, then deletes the
  membership row directly - consistent with `list_company_members`,
  which already reads D1 directly for the same structural reason.
- **`list_my_companies` doesn't switch anything.** It lists every company
  the caller belongs to and which one the current connection is acting
  as, and its own description explains why there's no switch-company
  tool: a connection speaks for one company for its whole life (the
  company is chosen when the user connects, never by a tool argument),
  so acting as a different company means disconnecting and reconnecting.

## Neon branches and databases

- `step-07`, branched from `step-06`. `step-07-dev`, branched from
  `step-07`, for local experimentation (this is where this step's own
  testing ran from, same pattern as steps 5-6).
- `learn_mcp_connector` exists on both branches independently (inherited
  from the parent branch's state *at branch-creation time* - a quirk
  worth remembering: data written to a parent branch *after* a child
  branches off doesn't propagate, but roles/grants that already existed
  at that moment do. A table created *after* branching needs its own
  grants, which `tenants` and `company_settings` both did).
- `enterprise_acme` exists on **both** branches too (`step-07`'s and
  `step-07-dev`'s), with the full migration set applied to each
  independently - a dedicated-tier company's database isn't something
  migrations reach automatically; `db/migrate.ts` was changed to accept
  `TENANT_DATABASE_URLS` (comma-separated) so one `npm run migrate` run
  reaches every tenant database, not just the shared one.

## What's still a placeholder

`wrangler.jsonc`'s `HYPERDRIVE`, `HYPERDRIVE_ENTERPRISE` and
`SETTINGS_CACHE` ids are placeholders until the real Hyperdrive configs
and KV namespace are created from your own machine (this sandbox can't
run authenticated `wrangler` commands against Cloudflare - confirmed by
`wrangler whoami` failing here, not guessed). No real company has been
assigned `tier = 'dedicated'` in the `tenants` table yet either - that's
real-world verification, done once there's a second real company to
assign it to (see the submission checklist and TENANCY.md).

## Sandbox limitation, same as steps 5 and 6

Every test that touches Neon (`test/tenancy.test.ts`'s row-level-security
and dedicated-tier groups, `test/auth.test.ts`'s `list_company_members`
tests, now via the tier-resolution lookup every request does) fails here
with "Connection terminated unexpectedly" - this sandbox can't open a raw
Postgres TCP connection, a known limitation from steps 5-6, not a bug in
this step's code. Run for real once deployed.

## Not yet done

- Per-company SSO (step 7's prompt 6, explicitly optional) - not
  attempted, given this step's deadline.
- Deployment and cross-client testing (Claude and ChatGPT, two companies)
  - pending the real Hyperdrive/KV ids above.
