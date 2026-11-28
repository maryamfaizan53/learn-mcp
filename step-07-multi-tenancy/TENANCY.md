# Tenancy decision record

## The three isolation models

| Model | Isolation | Cost | Migrations | Noisy neighbours | Compliance |
| --- | --- | --- | --- | --- | --- |
| **Shared schema + RLS** (pool) | Enforced by Postgres policies on every query, not by separate storage. A policy bug is the only way across. | One database for every tenant - cheapest by far. | Run once, apply to everyone instantly. | One tenant's heavy query load is felt by all; needs per-tenant limits to contain. | Hardest to satisfy a customer who needs physically separate storage, their own backup/restore, or to leave taking their data cleanly. |
| **Schema per tenant** (bridge) | Stronger: a cross-tenant query needs the wrong schema name, not just a missing `WHERE`. | More database objects to manage, but still one compute/connection pool. | Must run once *per schema* - N tenants means N migration runs. | Still shares the same compute, so still contends for it. | A tenant's schema can be dumped/restored independently, but it's still the same physical database. |
| **Database (or Neon project) per tenant** (silo) | Strongest: nothing to misconfigure at the query level: a different connection, a different set of credentials entirely. | Most expensive: a Hyperdrive config and connection pool per tenant, scaling cost with tenant count, not usage. | Must run once *per database*. | Fully isolated compute (on Neon, a dedicated project/branch can have its own autoscaling limits). | Easiest to satisfy: separate storage, separate backups, trivially closeable/exportable. |

## This server's decision

**Shared schema with row-level security (from step 6) for most companies, and a
dedicated Neon database for an "enterprise" tier.**

Almost every company this server will ever serve is a small team that wants
low cost and zero setup friction - the shared tier, already fully built in
step 6, is exactly right for them: one migration run reaches everyone, and
RLS (`FORCE ROW LEVEL SECURITY`, `USING`/`WITH CHECK` on `app.tenant_id`)
is a real, Postgres-enforced boundary, not just application discipline.

A dedicated tier exists for the minority of companies who need it for a
specific reason: a compliance requirement for physically separate storage,
a contract with its own backup/export clause, or heavy enough usage that
sharing a connection pool with everyone else would be a real noisy-neighbour
risk. Schema-per-tenant was considered and rejected: it's real work (a
migration run per schema) for isolation that's only incrementally stronger
than RLS, while still sharing the same compute - it doesn't actually solve
either of the two real reasons a company would ask to leave the shared
tier.

No tool, resource or prompt ever knows which tier it's running against:
`bindingFor()` in `src/db.ts` is the one place that decides, based on the
verified tenant context's `tier`, which Hyperdrive binding to use. Both
tiers run the exact same migrations, the exact same tool code, and the
exact same row-level security policies - the dedicated database just
happens to have exactly one company's rows in it.

## Cross-tenant test results

See `test/tenancy.test.ts`. Run with `npm test`.

- **Row-level security, no WHERE clause** - two throwaway companies
  seeded directly through `forTenant`, then read back with queries that
  have no `org_id` filter of their own. Acting as company A never sees
  company B's categories, customers, products, orders or settings;
  explicitly asking for company B's `org_id` is still refused;
  `createOrder` for company A can't be tricked into naming company B's
  customer. RLS itself is what blocks every one of these, not
  application code remembering a filter.
- **Tenant router fail-closed check** - a tenant context tagged
  `tier: "dedicated"` with no `HYPERDRIVE_ENTERPRISE` binding configured
  throws a clear configuration error. It never silently falls back to
  the shared binding, which is the one bug that would actually mix
  tiers.
- **Cross-tenant isolation through the real `/mcp` path** - two
  companies signed up for real, each getting its own token the normal
  way (sign-up -> OAuth authorize -> token exchange, never a
  hand-crafted JWT). Company B's `list_orders` never sees company A's
  order; `update_company_settings` on company A never changes what
  company B's `get_company_settings` (and its KV cache, keyed by
  `tenantKey(ctx, "settings")`) reads back.
- **Removal revokes access immediately** - an admin's `remove_member`
  deletes a teammate's D1 membership row; that teammate's very next
  tool call (with the same still-unexpired access token) is refused,
  because membership is re-checked against the database on every
  request and never cached.

This step's sandbox can't open a raw Postgres connection to Neon (every
Hyperdrive-backed query fails with "Connection terminated unexpectedly" -
the same limitation steps 5 and 6 ran into, not a bug in this code), so
only the one test above with no network dependency (the tenant router
check) actually ran there. The full suite needs to be run for real once
deployed - see the submission checklist.

**Not yet verified for real:** this step hasn't created an actual second,
dedicated-tier company with its own Neon database and `HYPERDRIVE_ENTERPRISE`
binding - every company so far is on the shared tier, which is this
server's default. The tenant router's dedicated-tier *code path* is
exercised by the fail-closed test above, but genuine dedicated-tier
isolation (a second real database, reachable through its own binding)
still needs that company to exist before it can be proven end to end.
