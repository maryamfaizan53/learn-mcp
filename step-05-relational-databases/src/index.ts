import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { getAuth, getMcpResource } from "./auth";
import { getIdentity, identityStorage } from "./identity";
import { consentPage, loginPage } from "./pages";

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over. Business data lives in Neon (see
// db.ts once this step's own tools land), not here, so every copy of this
// Worker sees the same data.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-05",
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
