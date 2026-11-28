import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getMcpResource } from "../src/auth";
// `?raw` (a Vite/Vitest build-time feature, not a runtime file read - this
// test runs inside the Workers sandbox, which has no filesystem) inlines
// the migration file's text so it can be applied to the test pool's own
// fresh D1 instance, separate from `wrangler dev`'s local D1 state.
import migrationSql from "../migrations/0001_better_auth.sql?raw";

beforeAll(async () => {
  await env.DB.exec(migrationSql);
});

// A pre-registered OAuth client, inserted directly into D1 rather than
// discovered via CIMD (which needs a real HTTPS metadata URL - what
// Claude/ChatGPT provide once deployed, not something a test can fake).
// skipConsent lets the test go straight from a signed-in session to an
// authorization code, the same way a trusted first-party client would,
// without needing to drive the /consent page's own UI.
const TEST_CLIENT_ID = "test-client";
const REDIRECT_URI = "http://localhost:9999/callback";

async function ensureTestClient(): Promise<void> {
  const resource = getMcpResource();
  await env.DB.prepare(
    `insert into oauthResource (id, identifier, name, createdAt, updatedAt)
     values (?, ?, 'Test MCP resource', datetime('now'), datetime('now'))
     on conflict(identifier) do nothing`,
  )
    .bind(crypto.randomUUID(), resource)
    .run();

  await env.DB.prepare(
    `insert into oauthClient
       (id, clientId, disabled, skipConsent, scopes, redirectUris, tokenEndpointAuthMethod, grantTypes, responseTypes, requirePKCE, createdAt, updatedAt)
     values (?, ?, 0, 1, ?, ?, 'none', ?, ?, 1, datetime('now'), datetime('now'))
     on conflict(clientId) do nothing`,
  )
    .bind(
      crypto.randomUUID(),
      TEST_CLIENT_ID,
      JSON.stringify(["openid"]),
      JSON.stringify([REDIRECT_URI]),
      JSON.stringify(["authorization_code"]),
      JSON.stringify(["code"]),
    )
    .run();

  const linked = await env.DB.prepare(
    "select 1 from oauthClientResource where clientId = ? and resourceId = ?",
  )
    .bind(TEST_CLIENT_ID, resource)
    .first();
  if (!linked) {
    await env.DB.prepare(
      "insert into oauthClientResource (id, clientId, resourceId, createdAt) values (?, ?, ?, datetime('now'))",
    )
      .bind(crypto.randomUUID(), TEST_CLIENT_ID, resource)
      .run();
  }
}

async function callWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// Better Auth sets the session as a cookie; a Response's "set-cookie" may
// come back as several headers folded into one by fetch's Headers class,
// separated by commas at top level - but each cookie itself can also
// legally contain commas (e.g. in an Expires date), so split only on the
// boundary this server's own cookies use: ", <name>=" between entries.
function sessionCookieHeader(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[\w.-]+=)/)
    .map((part) => part.split(";")[0]!.trim())
    .join("; ");
}

async function signUpUser(email: string, name: string): Promise<string> {
  const response = await callWorker(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name }),
    }),
  );
  expect(response.status).toBe(200);
  return sessionCookieHeader(response);
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const verifier = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, 128);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

// Drives the real authorize -> token exchange (the same one proven by hand
// against a live server: skipConsent means no /consent page interaction is
// needed), so the resulting access token is the exact audience-bound JWT
// mcp() actually issues - not a hand-crafted stand-in.
async function getAccessToken(sessionCookie: string): Promise<string> {
  await ensureTestClient();
  const { verifier, challenge } = await pkcePair();
  const resource = getMcpResource();

  const authorizeUrl =
    `http://localhost/api/auth/oauth2/authorize?response_type=code&client_id=${TEST_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid` +
    `&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`;
  const authorizeResponse = await callWorker(
    new Request(authorizeUrl, { headers: { Cookie: sessionCookie }, redirect: "manual" }),
  );
  expect(authorizeResponse.status).toBe(302);
  const location = authorizeResponse.headers.get("location");
  if (!location) throw new Error("authorize did not redirect");
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`authorize redirect had no code: ${location}`);

  const tokenResponse = await callWorker(
    new Request("http://localhost/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: TEST_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!tokenBody.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tokenBody)}`);
  }
  return tokenBody.access_token;
}

type ToolResult = {
  result?: { content: Array<{ type: string; text: string }>; structuredContent?: unknown };
  error?: { code: number; message: string };
};

async function callTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const response = await callWorker(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Host: "localhost",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  return (await response.json()) as ToolResult;
}

async function createSignedInUser(email: string, name: string): Promise<string> {
  const cookie = await signUpUser(email, name);
  return getAccessToken(cookie);
}

describe("authentication", () => {
  it("rejects an unauthenticated /mcp request with a spec-correct 401 challenge", async () => {
    const response = await callWorker(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { Host: "localhost", "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("gives every new sign-up their own company with the admin role", async () => {
    const cookie = await signUpUser("admin-check@example.com", "Admin Check");
    const session = await callWorker(
      new Request("http://localhost/api/auth/get-session", { headers: { Cookie: cookie } }),
    );
    const { user } = (await session.json()) as { user: { id: string } };
    const member = await env.DB.prepare("select role from member where userId = ?")
      .bind(user.id)
      .first<{ role: string }>();
    expect(member?.role).toBe("admin");
  });
});

describe("list_company_members", () => {
  it("lets an admin list their company's members", async () => {
    const token = await createSignedInUser("own-admin@example.com", "Own Admin");
    const result = await callTool(token, "list_company_members", {});
    const members = (result.result?.structuredContent as { members: Array<{ email: string }> }).members;
    expect(members).toHaveLength(1);
    expect(members[0]?.email).toBe("own-admin@example.com");
  });

  it("refuses a non-admin member with a clear error, not a crash", async () => {
    const adminCookie = await signUpUser("member-test-admin@example.com", "Admin");
    const adminSession = await callWorker(
      new Request("http://localhost/api/auth/get-session", { headers: { Cookie: adminCookie } }),
    );
    const { user: admin } = (await adminSession.json()) as { user: { id: string } };
    const orgId = (
      await env.DB.prepare("select organizationId from member where userId = ?").bind(admin.id).first<{
        organizationId: string;
      }>()
    )?.organizationId;

    // Added as a plain member of the admin's company, the way an admin
    // inviting a teammate would end up, rather than signing up (which
    // always creates a brand-new personal company for the signer).
    const memberCookie = await signUpUser("member-test-member@example.com", "Member");
    const memberSession = await callWorker(
      new Request("http://localhost/api/auth/get-session", { headers: { Cookie: memberCookie } }),
    );
    const { user: member } = (await memberSession.json()) as { user: { id: string } };
    await env.DB.prepare(
      "update member set organizationId = ?, role = 'member' where userId = ?",
    )
      .bind(orgId, member.id)
      .run();

    const memberToken = await getAccessToken(memberCookie);
    const result = await callTool(memberToken, "list_company_members", {});
    expect((result.result as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect(result.result?.content[0]?.text).toContain("admin");
  });
});
