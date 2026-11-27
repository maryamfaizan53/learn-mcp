import { env } from "cloudflare:workers";
import { neon } from "@neondatabase/serverless";

// Matches wrangler.jsonc's comment: DATABASE_URL is a secret, never a
// committed "vars" entry. Set it with `wrangler secret put DATABASE_URL`
// in production and in .dev.vars locally.
declare global {
  namespace Cloudflare {
    interface Env {
      DATABASE_URL: string;
    }
  }
}

// Neon's HTTP driver (`neon()`), not its WebSocket-based Pool/Client: every
// query here is a single fetch(), which fits this step's read-only tools -
// one query in, one result out, no connection to keep alive across a
// request. Neon's own docs say WebSocket connections can't outlive a
// single request on Workers and point to Cloudflare Hyperdrive instead
// once you need that (writes, transactions, connection pooling) - which is
// why this course introduces Hyperdrive at step 6, not here.
//
// Built lazily and cached per isolate, same reasoning as auth.ts's
// getAuth(): nothing here holds per-request state, so one instance per
// Worker isolate is correct, and building it at module scope (before a
// request exists to read env from) isn't reliable under workerd.
let cachedSql: ReturnType<typeof neon> | undefined;

export function getSql() {
  if (!cachedSql) {
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set. Run `wrangler secret put DATABASE_URL` " +
          "(production) or add it to .dev.vars (local) with your Neon branch's " +
          "pooled connection string.",
      );
    }
    cachedSql = neon(databaseUrl);
  }
  return cachedSql;
}
