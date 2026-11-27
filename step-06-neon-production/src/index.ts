import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { getAuth, getMcpResource } from "./auth";
import { withClient } from "./db";
import { getIdentity, identityStorage } from "./identity";
import { consentPage, loginPage } from "./pages";
import {
  BUSINESS_QUESTIONS,
  COMPARE_QUESTIONS,
  answerBusinessQuestion,
  compareDesigns,
  describeSchema,
} from "./sales";
import { SUMMARY_GROUP_BY, getSalesSummary, listOrders } from "./orders";

const ROW_SCHEMA = z.record(z.string(), z.unknown());

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over. Business data lives in Neon (see
// db.ts once this step's own tools land), not here, so every copy of this
// Worker sees the same data.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-06",
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
      const { orgId, role } = getIdentity();
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
      const tables = await withClient((client) => describeSchema(client));
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
      const { orgId } = getIdentity();
      const rows = await withClient((client) => answerBusinessQuestion(client, question, orgId));
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
      const { flat, normalized, note } = await withClient((client) => compareDesigns(client, question));
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
      const { orgId } = getIdentity();
      const result = await withClient((client) =>
        listOrders(client, { orgId, fromDate, toDate, customerName, productName, cursor, limit }),
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
      const { orgId } = getIdentity();
      const rows = await withClient((client) => getSalesSummary(client, groupBy, orgId));
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
          return identityStorage.run(
            { userId, orgId: member.organizationId, role: member.role },
            () => handler(req as Parameters<typeof handler>[0], env, ctx),
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
