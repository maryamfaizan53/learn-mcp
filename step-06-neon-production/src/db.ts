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
