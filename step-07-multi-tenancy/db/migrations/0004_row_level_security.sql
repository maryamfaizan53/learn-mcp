-- Row-level security: a second guard behind the tool code, enforced by
-- Postgres itself. Every business table gets the same two rules:
--
--   USING      - which rows a query may even see (SELECT, and the rows
--                 an UPDATE/DELETE is allowed to touch)
--   WITH CHECK - which rows a write is allowed to create or leave behind
--
-- Both read current_setting('app.tenant_id', true) - the `true` makes a
-- missing setting return null instead of raising an error, so a query
-- that forgets to set the tenant sees NO rows (org_id = null is never
-- true) rather than every company's rows. Failing closed, not open.
--
-- FORCE ROW LEVEL SECURITY matters because neondb_owner (the role these
-- migrations run as) has BYPASSRLS - without FORCE, policies would only
-- ever apply to a role that owns nothing, which no real role here is.
-- FORCE still doesn't restrict neondb_owner, though: BYPASSRLS wins over
-- FORCE unconditionally, by design, which is exactly why the admin
-- scripts (migrate, seed, query) keep working unchanged. Only
-- learn_mcp_connector - the Worker's own role, with neither BYPASSRLS
-- nor table ownership - is actually restricted by these policies.

alter table categories enable row level security;
alter table categories force row level security;
create policy tenant_isolation on categories
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));

alter table customers enable row level security;
alter table customers force row level security;
create policy tenant_isolation on customers
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));

alter table products enable row level security;
alter table products force row level security;
create policy tenant_isolation on products
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));

alter table orders enable row level security;
alter table orders force row level security;
create policy tenant_isolation on orders
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));

alter table order_items enable row level security;
alter table order_items force row level security;
create policy tenant_isolation on order_items
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));
