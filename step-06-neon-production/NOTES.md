# Step 6 notes — Hyperdrive, writes and row-level security

## What this step does

Step 5's sales server, made production-ready: connections through
Cloudflare Hyperdrive instead of Neon's HTTP driver, a least-privilege
database role, and (coming next) paginated list/summary tools, a
transactional write tool, and row-level security.

## Architecture decisions

- **Driver switch: `pg` (node-postgres), not `@neondatabase/serverless`.**
  Confirmed against Cloudflare's current Hyperdrive docs rather than
  guessed: Hyperdrive proxies a real Postgres **TCP** connection, and
  step 5's `neon()` function is an **HTTP** driver — there's nothing for
  Hyperdrive to pool or speed up without switching to a driver that
  actually opens a TCP connection. Cloudflare's own tutorial uses
  `node-postgres (pg)` as its primary example.
- **One `Client` per request** (`src/db.ts`'s `withClient()`), connected,
  used and closed before the request ends — never cached across
  requests. This is affordable specifically *because* Hyperdrive pools
  the expensive part (the real connection to Neon) on Cloudflare's side;
  the Worker just opens a cheap local connection to Hyperdrive each time.
- **Two Neon roles, not one.** `neondb_owner` (the one steps 5's
  migrations already used) runs `db/migrate.ts`/`db/seed-my-company.ts`
  and can change the schema. A new role, **`learn_mcp_connector`**,
  created directly through the Neon MCP connector's `create_postgres_role`
  (`access: "read_write"`, scoped to the `public` schema) plus one manual
  `grant select` on `staging` for `compare_designs` — is what the
  deployed Worker actually connects as, via Hyperdrive. Verified against
  `pg_roles`: not superuser, no `BYPASSRLS`, can't create databases or
  roles. This is the role row-level security (later in this step) will
  actually apply to.
- **Query caching is off** (`wrangler hyperdrive create ... --caching-disabled`).
  Hyperdrive caches eligible read results by default, and a cache that
  doesn't know about the per-request tenant setting `set_config
  ('app.tenant_id', ...)` (coming with row-level security) could hand one
  company another's cached rows — book lesson 19.9's exact warning.
- **The admin scripts (`migrate.ts`, `query.ts`, `seed-my-company.ts`)
  were rewritten to use `pg` too**, rather than keep two different
  Postgres drivers in one project for no reason.

## Neon branches

- `step-06`, branched from `step-05` (inherits all its data: the demo
  company and the signed-in account's own seeded company).
- `step-06-dev`, branched from `step-06`, for local experimentation.
- `learn_mcp_connector` exists on both, independently (Neon branches
  don't share role state going forward - each needed its own
  `create_postgres_role` call).

## Hyperdrive and local dev - two things that aren't obvious

- **`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`** (the
  documented way to give local dev/tests a direct connection instead of
  going through the real Hyperdrive) is read from **real `process.env`**,
  not from `.dev.vars`'s usual Worker-binding injection - confirmed by
  testing. Fixed two ways: `vitest.config.ts` now calls
  `process.loadEnvFile(".dev.vars")` itself before
  `@cloudflare/vitest-plugin` reads it, and the `dev` npm script uses
  `wrangler dev`'s own `--env-file=.dev.vars` flag. Neither needs a
  manual `export` anymore.
- **`wrangler dev`'s local D1 is a separate, empty database** from the
  real deployed one - it's per-project-folder state, not something that
  carries over when you copy a step's code into the next step's folder.
  First local `wrangler dev` run in a new step needs:
  ```
  npx wrangler d1 migrations apply learn-mcp-step-04-auth --local
  ```
  before Better Auth's own schema check stops failing with
  `BetterAuthError: Database schema mismatch`.

## Deployment gotchas (same root causes as step 5, hit again here)

- **Sharing D1 still means sharing `BETTER_AUTH_SECRET`.** Hit the exact
  same `Failed to decrypt private key` error as step 5, for the exact
  same reason (a different Worker, different secret, same database's
  encrypted JWKS key). Same fix: same secret value on every Worker
  sharing the database, `delete from jwks`, redeploy all of them.
- **Hyperdrive config mix-ups are easy and look like database errors,
  not config errors.** `password authentication failed for user
  'neondb_owner'` turned out to mean the Hyperdrive config had been
  created pointing at the *owner* role's credentials on the *wrong*
  branch, not the connector role's on `step-06` - the error names
  whichever role's credentials are actually stored in the Hyperdrive
  config, which may not be the one you meant to use. `wrangler hyperdrive
  update <id> --connection-string="..."` fixes it in place - note it
  needs the Hyperdrive's hex **id**, not the name you gave it at create
  time, if `--name` based lookup isn't accepted.

## Verified in production

`describe_schema` and `answer_business_question("monthly_revenue")` both
confirmed working through Claude, hitting Hyperdrive and the
`learn_mcp_connector` role for the first time: total revenue $4,983.83,
matching exactly what step 5 already verified for this same seeded
company - proof the new connection path returns the same, correct,
company-scoped data as step 5's HTTP-driver path did.

## Not yet done

- `list_orders` (filters + cursor pagination) and `get_sales_summary`.
- `create_order` (validated, transactional write tool).
- Row-level security on every business table (`FORCE ROW LEVEL
  SECURITY`, `USING`/`WITH CHECK`, `forTenant(ctx, fn)` helper).
- Closing the gaps row-level security doesn't cover on its own (book
  lesson 19.10): identical "not found" errors, no `SECURITY DEFINER`
  functions reachable by the connector role, no rows in logs.
- The data matrix test (book lesson 19.12) with three planted bugs to
  catch and then remove.
- SSO (carried over as optional from steps 4-5) - not attempted.
