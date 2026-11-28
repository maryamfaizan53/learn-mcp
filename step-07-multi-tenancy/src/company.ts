import type { Client } from "pg";

export interface CompanySettings {
  currency: string;
  fiscalYearStart: string;
  salesThreshold: string;
}

const DEFAULT_SETTINGS: CompanySettings = {
  currency: "USD",
  fiscalYearStart: "2026-01-01",
  salesThreshold: "0.00",
};

// Called inside forTenant, so app.tenant_id is already set and row-level
// security (0006_company_settings.sql) is the real backstop - this SQL
// would return another company's row if RLS ever lapsed, nothing else
// stops it. A company with no row yet (never configured) gets the
// column defaults without needing a provisioning step.
export async function readCompanySettings(client: Client, orgId: string): Promise<CompanySettings> {
  const result = await client.query<{ currency: string; fiscal_year_start: string; sales_threshold: string }>(
    "select currency, to_char(fiscal_year_start, 'YYYY-MM-DD') as fiscal_year_start, sales_threshold " +
      "from company_settings where org_id = $1",
    [orgId],
  );
  const row = result.rows[0];
  return row
    ? { currency: row.currency, fiscalYearStart: row.fiscal_year_start, salesThreshold: row.sales_threshold }
    : DEFAULT_SETTINGS;
}

export interface CompanySettingsPatch {
  currency?: string;
  fiscalYearStart?: string;
  salesThreshold?: number;
}

// Upserts rather than requiring update_company_settings to be called
// after some separate "create settings" step - a company configuring
// itself for the first time and one changing an existing value look
// identical to the caller.
export async function writeCompanySettings(
  client: Client,
  orgId: string,
  patch: CompanySettingsPatch,
): Promise<CompanySettings> {
  const result = await client.query<{ currency: string; fiscal_year_start: string; sales_threshold: string }>(
    `insert into company_settings (org_id, currency, fiscal_year_start, sales_threshold, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (org_id) do update set
       currency = coalesce($2, company_settings.currency),
       fiscal_year_start = coalesce($3, company_settings.fiscal_year_start),
       sales_threshold = coalesce($4, company_settings.sales_threshold),
       updated_at = now()
     returning currency, to_char(fiscal_year_start, 'YYYY-MM-DD') as fiscal_year_start, sales_threshold`,
    [
      orgId,
      patch.currency ?? DEFAULT_SETTINGS.currency,
      patch.fiscalYearStart ?? DEFAULT_SETTINGS.fiscalYearStart,
      patch.salesThreshold ?? Number(DEFAULT_SETTINGS.salesThreshold),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("company_settings upsert returned no row.");
  return { currency: row.currency, fiscalYearStart: row.fiscal_year_start, salesThreshold: row.sales_threshold };
}
