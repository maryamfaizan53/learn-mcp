import type { Client } from "pg";

export type Tier = "shared" | "dedicated";

// Resolved once per request, from the verified token and the tenants
// registry - never from a tool argument. Every tool, resource and
// prompt handler reads this, never orgId/userId/role directly off the
// request, so there's exactly one place a bug in resolving it could
// hide, not one per tool.
export interface TenantContext {
  orgId: string;
  userId: string;
  role: string;
  tier: Tier;
}

// Looked up with the SHARED connection, before we know which database
// a dedicated-tier company's own data lives in - this table is the one
// thing every tier's lookup starts from. New companies default to
// "shared" (the table's own column default) without needing a row at
// all: COALESCE falls back to that when none exists yet, so creating a
// company never requires a provisioning step just to use it.
export async function resolveTier(sharedClient: Client, orgId: string): Promise<Tier> {
  const result = await sharedClient.query<{ tier: Tier }>("select tier from tenants where org_id = $1", [
    orgId,
  ]);
  return result.rows[0]?.tier ?? "shared";
}

// A name that starts with the company, so two companies can never
// collide in the same KV namespace by accident - "org:<orgId>:..." for
// company-wide entries (settings, caches), or pass userId too for
// something scoped to one person within that company.
export function tenantKey(ctx: TenantContext, ...parts: string[]): string {
  return `org:${ctx.orgId}:${parts.join(":")}`;
}

// A name for a Durable Object instance scoped to this company and user
// - never the company alone for anything holding one person's state,
// and never built from anything but the verified context.
export function tenantObjectName(ctx: TenantContext): string {
  return `org:${ctx.orgId}:user:${ctx.userId}`;
}

// Carried with every queue message, Workflow run, task and event from
// step 12 onward - whatever handles it re-checks membership against
// this orgId/userId before touching anything, the same way every tool
// call does, rather than trusting that the envelope alone is enough.
export interface TenantEnvelope {
  orgId: string;
  userId: string;
  requestId: string;
}

export function buildEnvelope(ctx: TenantContext): TenantEnvelope {
  return { orgId: ctx.orgId, userId: ctx.userId, requestId: crypto.randomUUID() };
}
