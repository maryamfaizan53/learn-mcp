-- The tenant registry: which tier each company is on, and - for a
-- dedicated-tier company - which Hyperdrive binding reaches its own
-- database. Lives only in the shared database (every tier's control
-- plane is here; a dedicated company's business tables are the only
-- thing that moves to its own database, never this registry row).
--
-- Deliberately NOT row-level-secured: the one query against this table
-- (`select tier, hyperdrive_binding from tenants where org_id = $1`)
-- is how a request's tenant context gets resolved in the first place,
-- before app.tenant_id can be set - so RLS here would be circular. It's
-- still safe without RLS: the filter is always the caller's own
-- verified org_id (never a tool argument), and the row it returns names
-- nothing about any other company.
create table tenants (
  org_id text primary key,
  tier text not null default 'shared' check (tier in ('shared', 'dedicated')),
  hyperdrive_binding text,
  created_at timestamptz not null default now()
);
