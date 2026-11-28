-- Per-company settings: currency, fiscal year start and the sales
-- threshold used elsewhere in this server. One row per company, same
-- row-level-security pattern as every other business table (0004), so a
-- bug in the tool code is still backstopped by Postgres itself.

create table company_settings (
  org_id text primary key,
  currency text not null default 'USD',
  fiscal_year_start date not null default '2026-01-01',
  sales_threshold numeric(12, 2) not null default 0,
  updated_at timestamptz not null default now()
);

alter table company_settings enable row level security;
alter table company_settings force row level security;
create policy tenant_isolation on company_settings
  using (org_id = current_setting('app.tenant_id', true))
  with check (org_id = current_setting('app.tenant_id', true));
