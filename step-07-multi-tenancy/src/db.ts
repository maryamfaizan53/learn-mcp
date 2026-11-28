import { env } from "cloudflare:workers";
import { Client } from "pg";
import type { TenantContext } from "./tenant";

declare global {
  namespace Cloudflare {
    interface Env {
      HYPERDRIVE: Hyperdrive;
      // Added once this step's first dedicated-tier company exists.
      // Optional because most deployments (and every test run before
      // that point) never need it - a dedicated-tier lookup with this
      // binding missing is a configuration error, not a silent
      // fallback to the shared database.
      HYPERDRIVE_ENTERPRISE?: Hyperdrive;
    }
  }
}

// One Client per request, connected, used and closed before the request
// ends - never cached across requests, same reasoning as step 6: a raw
// TCP connection kept open across requests risks the isolate holding a
// dead or reused socket, and Hyperdrive is what makes connecting fresh
// every time affordable despite that.
async function withClient<T>(binding: Hyperdrive, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: binding.connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// The shared database's binding, used directly (not through forTenant)
// for the one thing every tier's request starts with: resolving which
// tier a company is actually on, before we know which binding its own
// data lives behind.
export function withSharedClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(env.HYPERDRIVE, fn);
}

// The one place that turns a tenant context into the right database
// connection - no tool code picks a binding itself, so no tool code can
// get that choice wrong. Shared-tier companies go through the same
// Hyperdrive config (and the same row-level security from step 6) as
// every other shared-tier company; a dedicated-tier company's own
// binding has no other company's rows in it at all, so the choice of
// binding is itself a second, independent layer of isolation on top of
// RLS, not a replacement for it - every table still has its policies,
// even on the dedicated database, in case a future company ever shares
// it with another (not planned, but never assumed impossible either).
function bindingFor(ctx: TenantContext): Hyperdrive {
  if (ctx.tier === "shared") return env.HYPERDRIVE;
  const binding = env.HYPERDRIVE_ENTERPRISE;
  if (!binding) {
    throw new Error(
      `Company ${ctx.orgId} is on the dedicated tier, but this Worker has no ` +
        "HYPERDRIVE_ENTERPRISE binding configured.",
    );
  }
  return binding;
}

// Sets the company for *this transaction only* (set_config's third
// argument, is_local = true) - never the whole connection - so a
// connection Hyperdrive later hands to a different request can't
// inherit a stale tenant setting left over from this one (book lesson
// 19.9). The row-level security policies on every business table read
// this same setting; this is the one place that sets it.
export async function forTenant<T>(ctx: TenantContext, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(bindingFor(ctx), async (client) => {
    await client.query("begin");
    try {
      await client.query("select set_config('app.tenant_id', $1, true)", [ctx.orgId]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
