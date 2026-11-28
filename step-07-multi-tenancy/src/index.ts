import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { getAuth, getMcpResource } from "./auth";
import { readCompanySettings, writeCompanySettings } from "./company";
import { forTenant, withSharedClient } from "./db";
import { getTenantContext, tenantStorage } from "./identity";
import { consentPage, loginPage } from "./pages";
import { tenantKey } from "./tenant";
import {
  BUSINESS_QUESTIONS,
  COMPARE_QUESTIONS,
  DEMO_ORG_ID,
  answerBusinessQuestion,
  compareDesigns,
  describeSchema,
} from "./sales";
import { OrderValidationError, SUMMARY_GROUP_BY, createOrder, getSalesSummary, listOrders } from "./orders";
import { resolveTier, type TenantContext } from "./tenant";

declare global {
  namespace Cloudflare {
    interface Env {
      SETTINGS_CACHE: KVNamespace;
    }
  }
}

const ROW_SCHEMA = z.record(z.string(), z.unknown());

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over. Business data lives in Neon (see
// db.ts once this step's own tools land), not here, so every copy of this
// Worker sees the same data.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-07",
    version: "0.1.0",
  });

  server.registerTool(
    "list_company_members",
    {
      description:
        "List every member of your company and their role. Admins only - a non-admin gets a clear error.",
      outputSchema: z.object({
        members: z.array(z.object({ userId: z.string(), email: z.string(), role: z.string() })),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { orgId, role } = getTenantContext();
      if (role !== "admin") {
        return {
          content: [
            { type: "text", text: "You must be an admin of this company to list its members." },
          ],
          isError: true,
        };
      }
      const { results } = await env.DB.prepare(
        "select member.userId as userId, user.email as email, member.role as role " +
          "from member join user on user.id = member.userId where member.organizationId = ?",
      )
        .bind(orgId)
        .all<{ userId: string; email: string; role: string }>();
      return {
        content: [
          {
            type: "text",
            text: results.map((m) => `${m.email} (${m.role})`).join("\n"),
          },
        ],
        structuredContent: { members: results },
      };
    },
  );

  server.registerTool(
    "list_my_companies",
    {
      description:
        "List every company you belong to, and which one this connection is currently acting as. " +
        "A connection speaks for exactly one company for its whole life - there is no switch-company " +
        "tool, by design (AGENTS.md's multi-tenancy rule: the company comes only from the verified " +
        "token, never from a tool argument). To act as a different company, disconnect and reconnect; " +
        "which one you land on next is whichever your account's membership lookup resolves to.",
      outputSchema: z.object({
        companies: z.array(z.object({ orgId: z.string(), name: z.string(), role: z.string(), active: z.boolean() })),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { orgId, userId } = getTenantContext();
      const { results } = await env.DB.prepare(
        "select organization.id as orgId, organization.name as name, member.role as role " +
          "from member join organization on organization.id = member.organizationId " +
          "where member.userId = ?",
      )
        .bind(userId)
        .all<{ orgId: string; name: string; role: string }>();
      const companies = results.map((c) => ({ ...c, active: c.orgId === orgId }));
      return {
        content: [
          {
            type: "text",
            text: companies.map((c) => `${c.name} (${c.role})${c.active ? " - current" : ""}`).join("\n"),
          },
        ],
        structuredContent: { companies },
      };
    },
  );

  server.registerTool(
    "get_company_settings",
    {
      description:
        "Read your company's settings: currency, fiscal year start and the sales threshold used " +
        "elsewhere in this server. Every company has settings, even if nobody has changed them yet - " +
        "unconfigured ones just read back the defaults.",
      outputSchema: z.object({
        currency: z.string(),
        fiscalYearStart: z.string(),
        salesThreshold: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ctx = getTenantContext();
      const cacheKey = tenantKey(ctx, "settings");
      const cached = await env.SETTINGS_CACHE.get(cacheKey);
      const settings = cached
        ? (JSON.parse(cached) as Awaited<ReturnType<typeof readCompanySettings>>)
        : await forTenant(ctx, async (client) => {
            const fresh = await readCompanySettings(client, ctx.orgId);
            await env.SETTINGS_CACHE.put(cacheKey, JSON.stringify(fresh), { expirationTtl: 300 });
            return fresh;
          });
      return {
        content: [
          {
            type: "text",
            text: `Currency: ${settings.currency}, fiscal year starts ${settings.fiscalYearStart}, sales threshold ${settings.salesThreshold}.`,
          },
        ],
        structuredContent: settings,
      };
    },
  );

  server.registerTool(
    "update_company_settings",
    {
      description:
        "Change your company's currency, fiscal year start or sales threshold. Admins only - a " +
        "non-admin gets a clear error. Only the fields you pass are changed; the rest keep their " +
        "current value.",
      inputSchema: {
        currency: z.string().length(3).optional().describe("ISO 4217 currency code, e.g. USD, EUR."),
        fiscalYearStart: z.iso.date().optional().describe("The date (YYYY-MM-DD) the fiscal year starts."),
        salesThreshold: z.number().min(0).optional().describe("Sales threshold used elsewhere in this server."),
      },
      outputSchema: z.object({
        currency: z.string(),
        fiscalYearStart: z.string(),
        salesThreshold: z.string(),
      }),
    },
    async ({ currency, fiscalYearStart, salesThreshold }) => {
      const ctx = getTenantContext();
      if (ctx.role !== "admin") {
        return {
          content: [{ type: "text", text: "You must be an admin of this company to change its settings." }],
          isError: true,
        };
      }
      const settings = await forTenant(ctx, (client) =>
        writeCompanySettings(client, ctx.orgId, { currency, fiscalYearStart, salesThreshold }),
      );
      // Cleared, not refreshed in place - the next read repopulates it, so
      // there's exactly one place settings are ever written into the cache.
      await env.SETTINGS_CACHE.delete(tenantKey(ctx, "settings"));
      return {
        content: [
          {
            type: "text",
            text: `Updated: currency ${settings.currency}, fiscal year starts ${settings.fiscalYearStart}, sales threshold ${settings.salesThreshold}.`,
          },
        ],
        structuredContent: settings,
      };
    },
  );

  server.registerTool(
    "invite_member",
    {
      description:
        "Add an existing user to your company by email, with a role of 'admin' or 'member'. Admins " +
        "only. The person must already have signed in to this server at least once (so they have an " +
        "account) - this doesn't create a new account for them, and it doesn't send an email.",
      inputSchema: {
        email: z.email().describe("The exact email address they signed in with."),
        role: z.enum(["admin", "member"]).describe("The role to give them in your company."),
      },
      outputSchema: z.object({ userId: z.string(), email: z.string(), role: z.string() }),
    },
    async ({ email, role }) => {
      const ctx = getTenantContext();
      if (ctx.role !== "admin") {
        return {
          content: [{ type: "text", text: "You must be an admin of this company to invite a member." }],
          isError: true,
        };
      }
      const user = await env.DB.prepare("select id from user where email = ?")
        .bind(email)
        .first<{ id: string }>();
      if (!user) {
        return {
          content: [
            {
              type: "text",
              text: `No account found for ${email}. They need to sign in to this server once before you can add them.`,
            },
          ],
          isError: true,
        };
      }
      try {
        // addMember is the one organization-plugin endpoint that doesn't
        // require a Better Auth session (confirmed by reading its source -
        // it only needs organizationId in the body, unlike removeMember
        // below) - this server authenticates MCP requests with an OAuth
        // bearer token, never a Better Auth session cookie, so any
        // endpoint that insists on one isn't callable from here at all.
        await getAuth().api.addMember({
          body: { userId: user.id, role, organizationId: ctx.orgId },
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Could not add that member." }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Added ${email} to your company as ${role}.` }],
        structuredContent: { userId: user.id, email, role },
      };
    },
  );

  server.registerTool(
    "remove_member",
    {
      description:
        "Remove a member from your company by email. Admins only, and you can't remove yourself. " +
        "They lose access on their very next call - membership is re-checked against the database on " +
        "every request, never cached.",
      inputSchema: {
        email: z.email().describe("The exact email address of the member to remove."),
      },
      outputSchema: z.object({ removed: z.boolean() }),
    },
    async ({ email }) => {
      const ctx = getTenantContext();
      if (ctx.role !== "admin") {
        return {
          content: [{ type: "text", text: "You must be an admin of this company to remove a member." }],
          isError: true,
        };
      }
      const target = await env.DB.prepare(
        "select member.userId as userId, member.role as role from member " +
          "join user on user.id = member.userId where user.email = ? and member.organizationId = ?",
      )
        .bind(email, ctx.orgId)
        .first<{ userId: string; role: string }>();
      if (!target) {
        return {
          content: [{ type: "text", text: `${email} is not a member of your company.` }],
          isError: true,
        };
      }
      if (target.userId === ctx.userId) {
        return {
          content: [{ type: "text", text: "You can't remove yourself. Have another admin do it." }],
          isError: true,
        };
      }
      // removeMember's own organization-plugin endpoint requires a real
      // Better Auth session (requireHeaders + orgSessionMiddleware,
      // confirmed by reading its source) - not available here, same reason
      // addMember above was chosen over it. This server already did its
      // own admin check above, same as the plugin endpoint would have.
      await env.DB.prepare("delete from member where userId = ? and organizationId = ?")
        .bind(target.userId, ctx.orgId)
        .run();
      return {
        content: [{ type: "text", text: `Removed ${email} from your company.` }],
        structuredContent: { removed: true },
      };
    },
  );

  server.registerTool(
    "describe_schema",
    {
      description:
        "Describe every table in the business database: its schema (staging or public), columns with " +
        "their types and nullability, and primary key. Call this before answer_business_question or " +
        "compare_designs if you need to explain the design, not just query it. Read directly from " +
        "Postgres's own catalog, so it's always accurate - never hand-maintained.",
      outputSchema: z.object({
        tables: z.array(
          z.object({
            schema: z.string(),
            name: z.string(),
            columns: z.array(z.object({ name: z.string(), type: z.string(), nullable: z.boolean() })),
            primaryKey: z.array(z.string()),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const tables = await withSharedClient((client) => describeSchema(client));
      return {
        content: [
          {
            type: "text",
            text: tables
              .map((t) => `${t.schema}.${t.name} (${t.columns.length} columns, key: ${t.primaryKey.join(", ")})`)
              .join("\n"),
          },
        ],
        structuredContent: { tables },
      };
    },
  );

  server.registerTool(
    "answer_business_question",
    {
      description:
        "Answer one of ten named business questions (monthly revenue, top products, best customers, and " +
        "so on) with a fixed, parameterized query scoped to your own signed-in company. Never runs " +
        "arbitrary SQL - pick the question that's closest to what was asked, and explain the result in " +
        "words, don't just dump the table.",
      inputSchema: {
        question: z.enum(BUSINESS_QUESTIONS).describe("Which named business question to answer."),
      },
      outputSchema: z.object({ question: z.string(), rows: z.array(ROW_SCHEMA) }),
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      const ctx = getTenantContext();
      const rows = await forTenant(ctx, (client) => answerBusinessQuestion(client, question, ctx.orgId));
      return {
        content: [
          {
            type: "text",
            text: rows.length === 0 ? "No data for this question yet." : JSON.stringify(rows, null, 2),
          },
        ],
        structuredContent: { question, rows },
      };
    },
  );

  server.registerTool(
    "compare_designs",
    {
      description:
        "Run one business question against both the original flat spreadsheet design and the normalized " +
        "design, using the same demo data for both, and explain the anomaly (if any) the flat design " +
        "causes for that question. Use this when asked why normalizing matters, not to answer a real " +
        "question about your own company's data - use answer_business_question for that.",
      inputSchema: {
        question: z.enum(COMPARE_QUESTIONS).describe("Which question to compare across both designs."),
      },
      outputSchema: z.object({
        question: z.string(),
        flat: z.array(ROW_SCHEMA),
        normalized: z.array(ROW_SCHEMA),
        note: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ question }) => {
      // Always scoped to the fixed demo company, never the caller's own
      // org: staging.flat_sales was never tenant-scoped in the first
      // place, and the normalized side of this comparison only ever
      // held the demo data on the shared tier - row-level security
      // needs the tenant set to demo-company specifically for that side
      // to return anything.
      const caller = getTenantContext();
      const demoCtx: TenantContext = { ...caller, orgId: DEMO_ORG_ID, tier: "shared" };
      const { flat, normalized, note } = await forTenant(demoCtx, (client) => compareDesigns(client, question));
      return {
        content: [
          {
            type: "text",
            text:
              `Flat design:\n${JSON.stringify(flat, null, 2)}\n\n` +
              `Normalized design:\n${JSON.stringify(normalized, null, 2)}\n\n${note}`,
          },
        ],
        structuredContent: { question, flat, normalized, note },
      };
    },
  );

  server.registerTool(
    "list_orders",
    {
      description:
        "List your company's orders, newest-filtered-first by order id, with optional filters (date " +
        "range, customer name, product name) and cursor pagination. Each row is one order's summary " +
        "(customer, item count, total) - call get_order_details-style questions through " +
        "answer_business_question for deeper analysis, not this tool. Pass the previous call's " +
        "nextCursor to get the next page; a null nextCursor means there are no more.",
      inputSchema: {
        fromDate: z.iso.date().optional().describe("Only orders on or after this date (YYYY-MM-DD)."),
        toDate: z.iso.date().optional().describe("Only orders on or before this date (YYYY-MM-DD)."),
        customerName: z.string().min(1).optional().describe("Only orders for customers whose name contains this text."),
        productName: z.string().min(1).optional().describe("Only orders containing a product whose name contains this text."),
        cursor: z.string().optional().describe("Pass the nextCursor from a previous call to get the next page."),
        limit: z.number().int().min(1).max(50).default(20).describe("Page size, 1 to 50."),
      },
      outputSchema: z.object({
        orders: z.array(
          z.object({
            orderId: z.string(),
            orderDate: z.string(),
            customerName: z.string(),
            itemCount: z.number(),
            orderTotal: z.string(),
          }),
        ),
        nextCursor: z.string().nullable(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ fromDate, toDate, customerName, productName, cursor, limit }) => {
      const ctx = getTenantContext();
      const result = await forTenant(ctx, (client) =>
        listOrders(client, { orgId: ctx.orgId, fromDate, toDate, customerName, productName, cursor, limit }),
      );
      return {
        content: [
          {
            type: "text",
            text:
              result.orders.length === 0
                ? "No orders match."
                : result.orders
                    .map((o) => `${o.orderId}: ${o.orderDate} - ${o.customerName} - ${o.itemCount} items - ${o.orderTotal}`)
                    .join("\n"),
          },
        ],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "get_sales_summary",
    {
      description:
        "Totals for your company's sales, grouped by month, product or customer. Use this for a quick " +
        "summary; use answer_business_question for one of the other named questions (averages, " +
        "largest order, revenue by city or category).",
      inputSchema: {
        groupBy: z.enum(SUMMARY_GROUP_BY).describe("How to group the totals."),
      },
      outputSchema: z.object({ groupBy: z.string(), rows: z.array(ROW_SCHEMA) }),
      annotations: { readOnlyHint: true },
    },
    async ({ groupBy }) => {
      const ctx = getTenantContext();
      const rows = await forTenant(ctx, (client) => getSalesSummary(client, groupBy, ctx.orgId));
      return {
        content: [
          {
            type: "text",
            text: rows.length === 0 ? "No data yet." : JSON.stringify(rows, null, 2),
          },
        ],
        structuredContent: { groupBy, rows },
      };
    },
  );

  server.registerTool(
    "create_order",
    {
      description:
        "Record a new order for an existing customer in your company, with one or more line items. " +
        "Looks up the customer and each product by name, copies the product's current catalog price " +
        "into the order line (so a later price change never rewrites a past sale), and inserts the " +
        "order and all its lines in one transaction - either the whole order is recorded, or none of " +
        "it is. Fails with a clear error naming exactly which customer or product name didn't match, " +
        "rather than guessing or creating a new one.",
      inputSchema: {
        customerName: z.string().min(1).describe("An existing customer's exact name."),
        orderDate: z.iso.date().optional().describe("The order's date (YYYY-MM-DD). Defaults to today."),
        items: z
          .array(
            z.object({
              productName: z.string().min(1).describe("An existing product's exact name."),
              quantity: z.number().int().min(1).describe("How many of this product, at least 1."),
            }),
          )
          .min(1)
          .describe("One or more line items. The same product listed twice becomes two separate lines."),
      },
      outputSchema: z.object({
        orderId: z.string(),
        orderDate: z.string(),
        customerName: z.string(),
        items: z.array(
          z.object({
            productName: z.string(),
            quantity: z.number(),
            unitPrice: z.string(),
            lineTotal: z.string(),
          }),
        ),
        orderTotal: z.string(),
      }),
    },
    async ({ customerName, orderDate, items }) => {
      const ctx = getTenantContext();
      try {
        const order = await forTenant(ctx, (client) =>
          createOrder(client, {
            orgId: ctx.orgId,
            customerName,
            orderDate: orderDate ?? new Date().toISOString().slice(0, 10),
            items,
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: `Created order ${order.orderId} for ${order.customerName}: ${order.orderTotal} total.`,
            },
          ],
          structuredContent: order,
        };
      } catch (error) {
        if (error instanceof OrderValidationError) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
        throw error;
      }
    },
  );

  return server;
}

// Built once, at module scope, when the Worker starts. The handler itself
// holds no per-request state — it just calls `createServer` fresh for every
// request and serves that instance over Streamable HTTP at /mcp.
const handler = createMcpHandler(createServer);

function jsonRpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      return loginPage(url.search.slice(1));
    }
    if (url.pathname === "/consent") {
      return consentPage(url.searchParams);
    }

    if (url.pathname === "/mcp") {
      const protectedMcp = requireMcpAuth(
        getAuth(),
        async (req, claims) => {
          const userId = typeof claims.sub === "string" ? claims.sub : undefined;
          if (!userId) {
            return jsonRpcError(403, "This token has no subject.");
          }
          // The OAuth access token carries only the standard claims (sub,
          // aud, client_id, scope, ...) - mcp()/oauth-provider doesn't let
          // a plugin add custom ones to it. So the caller's company and
          // role are both looked up here, fresh on every request, from
          // the verified userId alone - never cached, never baked into
          // the token, and never taken from a tool argument. Every user
          // has exactly one company (their personal one) in this step, so
          // this lookup is unambiguous.
          const member = await env.DB.prepare(
            "select organizationId, role from member where userId = ? limit 1",
          )
            .bind(userId)
            .first<{ organizationId: string; role: string }>();
          if (!member) {
            return jsonRpcError(403, "You are no longer a member of any company.");
          }
          // Tier comes from the shared registry, looked up by the
          // verified orgId alone - the one lookup every tier's request
          // starts with, before we know which binding the rest of this
          // request's queries should even use.
          const tier = await withSharedClient((client) => resolveTier(client, member.organizationId));
          const tenantContext: TenantContext = {
            userId,
            orgId: member.organizationId,
            role: member.role,
            tier,
          };
          return tenantStorage.run(tenantContext, () =>
            handler(req as Parameters<typeof handler>[0], env, ctx),
          );
        },
        // requireMcpAuth's own default resource is just the base URL, not
        // `${baseURL}/mcp` - without this override it rejects every real
        // access token mcp() issues as bound to the wrong audience.
        { resource: getMcpResource() },
      );
      return protectedMcp(request);
    }

    // Everything else (sign-in, sign-up, the OAuth authorize/token/consent
    // endpoints, discovery metadata) is Better Auth's own surface.
    return getAuth().handler(request);
  },
} satisfies ExportedHandler;
