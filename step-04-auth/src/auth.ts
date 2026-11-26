import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";
import { jwt, organization } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";

// Matches wrangler.jsonc's d1_databases binding and the MCP_BASE_URL var set
// there (or overridden with `wrangler secret put` style vars per environment).
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MCP_BASE_URL: string;
    }
  }
}

function buildAuth() {
  // The URL clients connect to. Tokens are bound to this exact resource
  // (RFC 8707), so it must match the deployed /mcp URL precisely - no
  // trailing slash, no query string.
  // `npx auth generate`/`migrate` load this file through a stub `env` whose
  // every property access returns a literal "env.<NAME>" placeholder string
  // (confirmed by testing - not documented), so it can't give us a real
  // MCP_BASE_URL to build a resource URL from. Detect that exact placeholder
  // and fall back to a dummy absolute URL: the CLI only reads the schema
  // these plugins declare, never serves real traffic with it.
  const rawMcpBaseUrl = env.MCP_BASE_URL;
  const MCP_BASE_URL =
    typeof rawMcpBaseUrl === "string" && !rawMcpBaseUrl.startsWith("env.")
      ? rawMcpBaseUrl
      : "https://placeholder.invalid";
  const MCP_RESOURCE = `${MCP_BASE_URL}/mcp`;

  // A Client ID Metadata Document is just the client's own metadata, served
  // by the client itself at an HTTPS URL that doubles as its client_id. cimd()
  // wants the same signature as the global `fetch` and does its own parsing
  // and spec validation on the Response - we don't need to do either.
  const fetchClientMetadataResource = fetch;

  const auth = betterAuth({
    // Without this, Better Auth tries to derive the base URL from the
    // incoming request, which doesn't exist yet during `auth generate` and
    // isn't reliable enough for OAuth callbacks/redirects anyway.
    baseURL: MCP_BASE_URL,
    // Better Auth's own data (users, sessions, OAuth clients) lives in D1 -
    // never in the same KV namespace as the notes. See wrangler.jsonc's
    // d1_databases entry. Wrapped in a Kysely dialect (rather than passed as
    // a raw D1Database) because `auth generate`/`migrate` only produce SQL
    // migration files for a Kysely-backed database - confirmed by testing,
    // not documented.
    database: { dialect: new D1Dialect({ database: env.DB }), type: "sqlite" },
    // Plain email + password for this step. SSO (signing in with a client
    // company's own identity provider) is step 4's explicitly optional last
    // prompt, not this one.
    emailAndPassword: {
      enabled: true,
    },
    plugins: [
      // Signs the access tokens mcp() issues. definePayload adds the user's
      // active company to the token itself, so tool handlers read it from the
      // verified token - never from a tool argument the caller could fake.
      // Role is deliberately NOT baked in here: it's looked up fresh from the
      // membership table on every request (see index.ts), so a role change or
      // removal takes effect on the next call instead of waiting for the
      // token to expire.
      jwt({
        jwt: {
          // Looked up directly rather than from session.activeOrganizationId:
          // this step gives every user exactly one company (their personal
          // one, created below) and has no company-switching tool, so "the
          // membership row for this user" is unambiguous.
          definePayload: async ({ user }) => {
            const member = await env.DB.prepare(
              "select organizationId from member where userId = ? limit 1",
            )
              .bind(user.id)
              .first<{ organizationId: string }>();
            return { orgId: member?.organizationId };
          },
        },
      }),
      // Every user belongs to a company (tenant) with a role. A personal
      // company is created on first sign-in - see the user.create.after
      // hook below. creatorRole: "admin" keeps this step's two roles (member,
      // admin) exactly as planned, instead of Better Auth's default "owner"
      // for whoever creates a company.
      organization({ creatorRole: "admin" }),
      // The actual OAuth 2.1 / OIDC authorization server, configured for
      // MCP: binds tokens to MCP_RESOURCE, serves RFC 9728 protected-resource
      // metadata, and protects /mcp via requireMcpAuth (see index.ts).
      mcp({
        resource: MCP_RESOURCE,
        loginPage: "/login",
        consentPage: "/consent",
      }),
      // Client ID Metadata Documents: the MCP 2026-07-28-preferred way for a
      // client (Claude, ChatGPT) to register, instead of Dynamic Client
      // Registration. mcp() only turns on client registration when something
      // actually implements it - this is that something.
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          // Runs once, right after a brand-new user row is created. Gives
          // every user a company to belong to from their very first sign-in,
          // so no tool ever has to handle "user with no organization yet".
          async after(user) {
            await auth.api.createOrganization({
              body: {
                name: `${user.name || user.email}'s company`,
                slug: `user-${user.id}`,
                userId: user.id,
              },
            });
          },
        },
      },
    },
  });

  return auth;
}

let cachedAuth: ReturnType<typeof buildAuth> | undefined;

// Building the Better Auth instance at module scope crashes under workerd:
// `new ZodLazy(...)` (deep inside zod's own code, triggered by this plugin
// stack) throws "ZodLazy is not a constructor" specifically during the
// Worker's global-scope module evaluation. The exact same plugins build
// fine when constructed inside a request's execution context instead -
// confirmed with a minimal reproduction that isolated just this plugin
// stack. So this is built lazily, on first use inside an actual request,
// and cached per isolate (not per request - nothing here holds
// request-specific state, same as the McpServer factory in index.ts holds
// no module-scope request state despite being built once at import time).
export function getAuth() {
  if (!cachedAuth) cachedAuth = buildAuth();
  return cachedAuth;
}
