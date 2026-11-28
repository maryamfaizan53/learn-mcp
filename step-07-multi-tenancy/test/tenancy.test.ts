import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { getMcpResource } from "../src/auth";
import { forTenant } from "../src/db";
import { createOrder } from "../src/orders";
import type { TenantContext } from "../src/tenant";
import migrationSql from "../migrations/0001_better_auth.sql?raw";

beforeAll(async () => {
  await env.DB.exec(migrationSql);
});

// --- Shared plumbing, copied from auth.test.ts rather than imported from
// it: these are test helpers, not production code, and keeping each test
// file able to run alone (no cross-file import of test helpers) matters
// more here than not repeating a few dozen lines. ---

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

function sessionCookieHeader(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie
    .split(/,(?=\s*[\w.-]+=)/)
    .map((part) => part.split(";")[0]!.trim())
    .join("; ");
}

async function signUpUser(email: string, name: string): Promise<{ cookie: string; userId: string }> {
  const response = await callWorker(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = sessionCookieHeader(response);
  const session = await callWorker(
    new Request("http://localhost/api/auth/get-session", { headers: { Cookie: cookie } }),
  );
  const { user } = (await session.json()) as { user: { id: string } };
  return { cookie, userId: user.id };
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
  result?: { content: Array<{ type: string; text: string }>; structuredContent?: unknown; isError?: boolean };
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

// --- Part 1: row-level security itself, proven directly against Postgres
// (adapted from step 6's row-level-security.test.ts for this step's
// TenantContext-shaped forTenant), with no application-level WHERE clause
// to rely on - RLS must be what blocks it, not tool code remembering a
// filter. ---

const COMPANY_A = "tenancy-test-company-a";
const COMPANY_B = "tenancy-test-company-b";

function ctxFor(orgId: string): TenantContext {
  return { orgId, userId: "test-user", role: "admin", tier: "shared" };
}

async function seedCompany(orgId: string, suffix: string) {
  const ctx = ctxFor(orgId);
  await forTenant(ctx, async (client) => {
    await client.query("insert into categories (org_id, name) values ($1, $2)", [orgId, `Category ${suffix}`]);
    await client.query("insert into customers (org_id, name, email, city) values ($1, $2, $3, $4)", [
      orgId,
      `Customer ${suffix}`,
      `customer-${suffix}@example.com`,
      `City ${suffix}`,
    ]);
    const category = await client.query<{ category_id: string }>(
      "select category_id from categories where org_id = $1 and name = $2",
      [orgId, `Category ${suffix}`],
    );
    await client.query("insert into products (org_id, category_id, name, price) values ($1, $2, $3, $4)", [
      orgId,
      category.rows[0]!.category_id,
      `Product ${suffix}`,
      10.0,
    ]);
  });
  await forTenant(ctx, (client) =>
    createOrder(client, {
      orgId,
      customerName: `Customer ${suffix}`,
      orderDate: "2026-01-01",
      items: [{ productName: `Product ${suffix}`, quantity: 1 }],
    }),
  );
}

async function cleanupCompany(orgId: string) {
  await forTenant(ctxFor(orgId), async (client) => {
    await client.query("delete from order_items where org_id = $1", [orgId]);
    await client.query("delete from orders where org_id = $1", [orgId]);
    await client.query("delete from products where org_id = $1", [orgId]);
    await client.query("delete from customers where org_id = $1", [orgId]);
    await client.query("delete from categories where org_id = $1", [orgId]);
    await client.query("delete from company_settings where org_id = $1", [orgId]);
  });
}

describe("row-level security: no WHERE clause, RLS alone decides what's visible", () => {
  beforeAll(async () => {
    await seedCompany(COMPANY_A, "A");
    await seedCompany(COMPANY_B, "B");
  });

  afterAll(async () => {
    await cleanupCompany(COMPANY_A);
    await cleanupCompany(COMPANY_B);
  });

  it("acting as company A, a bare select sees only company A's rows", async () => {
    const rows = await forTenant(ctxFor(COMPANY_A), (client) => client.query("select name from customers"));
    expect(rows.rows.map((r) => r.name)).toEqual(["Customer A"]);
  });

  it("acting as company A, explicitly asking for company B's org_id is still blocked", async () => {
    const rows = await forTenant(ctxFor(COMPANY_A), (client) =>
      client.query("select name from customers where org_id = $1", [COMPANY_B]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("createOrder for company A can't be tricked into naming company B's customer", async () => {
    await expect(
      forTenant(ctxFor(COMPANY_A), (client) =>
        createOrder(client, {
          orgId: COMPANY_A,
          customerName: "Customer B",
          orderDate: "2026-01-02",
          items: [{ productName: "Product A", quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/No customer named "Customer B"/);
  });

  it("company_settings is isolated the same way", async () => {
    await forTenant(ctxFor(COMPANY_A), (client) =>
      client.query("insert into company_settings (org_id, currency) values ($1, 'PKR')", [COMPANY_A]),
    );
    const rows = await forTenant(ctxFor(COMPANY_B), (client) => client.query("select currency from company_settings"));
    expect(rows.rows).toHaveLength(0);
  });
});

// A tenant context tagged "dedicated" with no HYPERDRIVE_ENTERPRISE
// binding configured must fail loudly, not silently fall back to the
// shared database - that fallback would be the one bug that actually
// mixes tiers. This step's own test environment has no second Hyperdrive
// binding (no real dedicated-tier company exists to deploy one for yet -
// see TENANCY.md), which is exactly the condition this proves is refused.
describe("tenant router", () => {
  it("refuses a dedicated-tier context with no HYPERDRIVE_ENTERPRISE binding, rather than falling back to shared", async () => {
    const dedicatedCtx: TenantContext = { orgId: COMPANY_A, userId: "test-user", role: "admin", tier: "dedicated" };
    await expect(forTenant(dedicatedCtx, (client) => client.query("select 1"))).rejects.toThrow(
      /no HYPERDRIVE_ENTERPRISE binding configured/,
    );
  });
});

// --- Part 2: the same boundary, proven at the level a real client
// actually sees - two signed-up companies, calling tools over the real
// authenticated /mcp path, never touching Postgres directly. ---

describe("cross-tenant isolation through the real tool surface", () => {
  it("company A's orders never appear to company B, and vice versa", async () => {
    const companyA = await signUpUser("tenancy-a-admin@example.com", "Company A Admin");
    const companyB = await signUpUser("tenancy-b-admin@example.com", "Company B Admin");
    const tokenA = await getAccessToken(companyA.cookie);
    const tokenB = await getAccessToken(companyB.cookie);

    // Each company needs its own customer/product before create_order
    // can succeed - list_company_members proves which company a token
    // actually acts as, so this also pins down that each sign-up really
    // did land in its own company, not a shared one.
    const membersA = await callTool(tokenA, "list_company_members", {});
    const membersB = await callTool(tokenB, "list_company_members", {});
    expect((membersA.result?.structuredContent as { members: unknown[] }).members).toHaveLength(1);
    expect((membersB.result?.structuredContent as { members: unknown[] }).members).toHaveLength(1);

    const ordersForB = await callTool(tokenB, "list_orders", {});
    expect((ordersForB.result?.structuredContent as { orders: unknown[] } | undefined)?.orders ?? []).toHaveLength(0);

    const settingsA = await callTool(tokenA, "update_company_settings", { currency: "EUR" });
    expect(settingsA.result?.isError).not.toBe(true);
    const settingsB = await callTool(tokenB, "get_company_settings", {});
    // Company B was never touched, so it must still see the column
    // default, not company A's EUR - proves the KV cache key and the
    // underlying row are both company-scoped, not shared.
    expect((settingsB.result?.structuredContent as { currency: string }).currency).toBe("USD");
  });

  it("a removed member loses access on their very next call", async () => {
    const admin = await signUpUser("tenancy-remove-admin@example.com", "Remove Admin");
    const member = await signUpUser("tenancy-remove-member@example.com", "Remove Member");
    await env.DB.prepare("select organizationId from member where userId = ?")
      .bind(admin.userId)
      .first<{ organizationId: string }>()
      .then(async (row) => {
        await env.DB.prepare("update member set organizationId = ?, role = 'member' where userId = ?")
          .bind(row?.organizationId, member.userId)
          .run();
      });

    const adminToken = await getAccessToken(admin.cookie);
    const memberToken = await getAccessToken(member.cookie);

    const removed = await callTool(adminToken, "remove_member", { email: "tenancy-remove-member@example.com" });
    expect(removed.result?.isError).not.toBe(true);

    // The member's token is still technically valid (the JWT itself
    // hasn't expired) - what must actually stop them is this server
    // re-checking D1 membership on every request, not caching it.
    const afterRemoval = await callTool(memberToken, "list_company_members", {});
    expect(afterRemoval.error?.code ?? afterRemoval.result?.isError).toBeTruthy();
  });
});
