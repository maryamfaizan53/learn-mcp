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

## `list_orders`, `get_sales_summary`, `create_order`

All three built and deployed. `list_orders` paginates with a keyset
cursor on `order_id` (not `OFFSET`, which shifts under a concurrent
insert), plus optional date range, customer name and product name
filters - the product filter is an `EXISTS` against `order_items`/
`products`, not a join, so it can't multiply or drop rows. One real bug
found by testing with a live client rather than just locally: `pg`
parses Postgres `date` columns into native JS `Date` objects, which
broke `list_orders`' own `z.string()` output schema the first time a
real client called it - fixed with `to_char(order_date, 'YYYY-MM-DD')`
in the SQL, same pattern `sales.ts` already used for months.

`get_sales_summary` reuses `answer_business_question`'s own fixed
queries (`monthly_revenue`, `top_products`, `best_customers`) behind a
`groupBy` enum, rather than duplicating SQL.

`create_order` looks up the customer and each product by name
(org-scoped - the same query that would 404 on a nonexistent name
returns the identical nothing for an existing name in another company,
so the two cases are indistinguishable by design), copies the catalog
price into the order line, and inserts the order and every line in one
transaction.

## Row-level security

`FORCE ROW LEVEL SECURITY` plus a `USING`/`WITH CHECK` policy on every
business table, comparing `org_id` to `current_setting('app.tenant_id',
true)`. `db.ts`'s `forTenant(orgId, fn)` is the one place that sets it:
opens a transaction, `set_config('app.tenant_id', orgId, true)` -
`true` scopes it to that transaction only, so a connection Hyperdrive
later reuses for a different request can't inherit it (book lesson
19.9) - runs the tool's queries, commits. Every tool that touches a
tenant-scoped table goes through it now, not plain `withClient`.
`compare_designs` is the one exception worth noting: it always calls
`forTenant(DEMO_ORG_ID, ...)`, never the caller's own org, since the
normalized side of that comparison only ever held the demo company's
data.

### What testing the three "planted bugs" actually found

Tested directly against the real database (via the Neon MCP connector,
connecting as `learn_mcp_connector` itself) before trusting any of
this:

- **No tenant set at all** ("a query outside `forTenant`"): zero rows,
  every time - `current_setting(..., true)` returns null, and
  `org_id = null` is never true. Safe by construction.
- **No `WHERE` clause in the query itself**: also zero rows. This was
  the most useful thing to actually prove, not just assert - row-level
  security's whole point is that the database adds the filter whether
  or not the query remembered to. A tool that forgot a `WHERE org_id =
  $1` is still safe, just redundant to have added it (which every tool
  here still does, as the first line of defense, not the only one).
- **Missing `WITH CHECK`**: tried this first and it turned out *not* to
  be a bug - Postgres silently reuses the `USING` clause for
  `WITH CHECK` when none is given, confirmed by reading `pg_policies`.
  So this specific omission isn't exploitable, which was worth learning
  directly rather than assuming.
- **A genuinely permissive `WITH CHECK (true)`**, deliberately swapped
  in for `customers`' real policy: this *was* exploitable. Connected as
  `learn_mcp_connector`, tenant set to the real signed-in company, a
  plain `INSERT ... VALUES ('demo-company', ...)` succeeded - writing a
  row into another company's namespace, even though that company could
  still never read it back (`USING` was untouched and still correct).
  Reverting to the matching `WITH CHECK` blocked the exact same insert
  immediately. This is the real shape of the bug class lesson 19.10
  warns about: `USING` alone protects reads; only a correct
  `WITH CHECK` protects writes, and the two can drift independently.
- One implementation note from testing this: the first few attempts to
  reproduce the exploit, sent as separate statements through the Neon
  MCP connector's own "transaction" tool, didn't reproduce it - only
  wrapping `set_config` and the `INSERT` in a single `DO $$ ... $$`
  block (one genuinely single SQL statement) did. This doesn't affect
  the Worker's own code, which already uses one real `pg.Client`
  session for an entire `forTenant()` call - it's a quirk of how that
  particular admin tool batches multiple statements, not of Postgres
  session/transaction semantics in general.

### Other lesson 19.10 gaps, checked

- **No `SECURITY DEFINER` functions** exist in this database at all
  (confirmed against `pg_proc`), so there's nothing the connector role
  could reach to bypass RLS through.
- **No rows appear in logs or errors.** `OrderValidationError`'s
  messages echo back the caller's own input (the name they typed),
  never anything read from another row.
- **The company is in every key** already, from step 5's design.

### `test/row-level-security.test.ts`

Two throwaway companies (`rls-test-company-a`/`-b`), seeded and torn
down by the test itself, acting as company A through the same
`forTenant()`/`createOrder()` every real tool call uses - the real
tenant boundary, not a mock of it. Couldn't run this from the sandbox
used to build it (raw Postgres TCP is blocked there) - run for real
afterwards and all 6 passed.

Two things found and fixed getting there, both `@cloudflare/vitest-
plugin` quirks, not RLS bugs:

- `pg`'s CommonJS `require()`s (its own and transitively, `pgpass`'s
  and `split2`'s) aren't resolved by the plugin's default module
  loader. Fixed per Cloudflare's own known-issues page: pre-bundle `pg`
  via `test.deps.optimizer.ssr`. That alone wasn't quite enough - the
  pre-bundle step then tried to resolve the long tail of Node builtins
  `pg` touches (`tls`, `crypto`, `dns`, `fs`, ...) itself, outside the
  Workers runtime that actually supplies them via `nodejs_compat`, and
  failed on each one in turn. Excluding the whole `node:module`
  `builtinModules` list from the pre-bundle step fixed it completely.

## Confirmed working in production, end to end

`describe_schema`, `answer_business_question`, `list_orders` (paging
and the product-name filter both correct), `get_sales_summary`, and
`create_order` (order #73 - James Okafor, 2× Desk Lamp at the current
catalog price - verified both in the tool's own response and directly
against the database afterward) - all tested for real through a live
client, not just locally.

One real debugging detour along the way, worth recording: a
`debug_tenant_check` tool (since removed) showed `forTenant()` and row-
level security were correct the whole time - `activeTenant` matched
the real `orgId` and all 36 real orders were visible - when an earlier
test through a different client connection showed zero. The cause was
the same stale-connector-tool-list problem hit repeatedly in steps 5
and 6, not a server bug: reconnecting the connector fixed it, same as
every previous time.

## Not yet done

- SSO (carried over as optional from steps 4-5) - not attempted.
