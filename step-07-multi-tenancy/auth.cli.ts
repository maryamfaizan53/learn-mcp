// CLI-only config for `npx auth generate` / `npx auth migrate`.
//
// Schema generation introspects the real database to diff against existing
// tables - something the Workers `env` stub this CLI loads src/auth.ts
// through can't provide (confirmed by testing: every env.* access there
// returns a placeholder string, and the D1 binding behind it isn't a real
// connection outside the Workers runtime). An in-memory SQLite database,
// via Node's built-in node:sqlite, gives the CLI a real connection to
// introspect instead. The deployed Worker never imports this file - it
// uses src/auth.ts's real D1-backed config.
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";

export const auth = betterAuth({
  baseURL: "https://placeholder.invalid",
  database: new DatabaseSync(":memory:"),
  emailAndPassword: { enabled: true },
  plugins: [
    jwt(),
    organization(),
    mcp({
      resource: "https://placeholder.invalid/mcp",
      loginPage: "/login",
      consentPage: "/consent",
    }),
    cimd({ fetchClientMetadataResource: fetch, metadataProfile: "mcp-2026-07-28" }),
  ],
});
