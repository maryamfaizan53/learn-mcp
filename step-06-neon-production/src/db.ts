import { env } from "cloudflare:workers";
import { Client } from "pg";

declare global {
  namespace Cloudflare {
    interface Env {
      HYPERDRIVE: Hyperdrive;
    }
  }
}

// Hyperdrive proxies a real Postgres TCP connection, which is why this
// step switches drivers from step 5's @neondatabase/serverless (an HTTP
// driver - fast for one-shot queries, but not something Hyperdrive pools
// or speeds up at all, since there's no TCP connection for it to pool).
// `pg` (node-postgres) is Cloudflare's own documented driver for this.
//
// `env.HYPERDRIVE` is a binding Cloudflare injects, typed by
// @cloudflare/workers-types - no local declaration needed, unlike
// DATABASE_URL in step 5.

// One Client per request, connected, used and closed before the request
// ends - never cached across requests. This matches both Neon's and
// Cloudflare's guidance: a Worker isolate can outlive a single request,
// but a raw TCP connection kept open across requests would eventually
// get the isolate stuck holding a dead or reused socket. Hyperdrive is
// what makes this affordable despite connecting fresh every time - the
// expensive part (the real connection to Neon) is pooled on Cloudflare's
// side, not reopened per request.
export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Every tool that touches a tenant-scoped table goes through this, not
// withClient directly. Sets the company for *this transaction only*
// (set_config's third argument, is_local = true) - never the whole
// connection - so a connection Hyperdrive later hands to a different
// request can't inherit a stale tenant setting left over from this one
// (book lesson 19.9). The row-level security policies on every business
// table read this same setting; this is the one place that sets it.
export async function forTenant<T>(orgId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      await client.query("select set_config('app.tenant_id', $1, true)", [orgId]);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
