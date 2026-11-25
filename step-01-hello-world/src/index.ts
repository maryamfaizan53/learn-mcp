import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-01",
    version: "0.1.0",
  });

  server.registerTool(
    "greet",
    {
      description:
        "Greet a person by name. Returns a short, friendly one-line greeting that includes the given name.",
      inputSchema: {
        name: z.string().min(1).describe("The person's name to greet."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Hello, ${name}! Welcome to learn-mcp-step-01.` }],
    }),
  );

  server.registerTool(
    "get_time",
    {
      description:
        "Get the current date and time. Pass an IANA timezone name (e.g. 'America/New_York', 'Asia/Karachi') " +
        "to get the time in that zone; omit it to get the time in UTC.",
      inputSchema: {
        timezone: z
          .string()
          .optional()
          .describe(
            "An IANA timezone name, e.g. 'Asia/Karachi' or 'Europe/London'. Defaults to UTC when omitted.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ timezone }) => {
      const zone = timezone ?? "UTC";
      let formatted: string;
      try {
        // Intl.DateTimeFormat throws a RangeError for a timeZone string it
        // doesn't recognize as a valid IANA name.
        formatted = new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(new Date());
      } catch {
        return {
          content: [
            {
              type: "text",
              text:
                `"${zone}" isn't a valid IANA timezone name. Try one like "America/New_York" ` +
                `or "Asia/Karachi", or omit timezone for UTC.`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Current time in ${zone}: ${formatted}` }] };
    },
  );

  return server;
}

// Built once, at module scope, when the Worker starts. The handler itself
// holds no per-request state — it just calls `createServer` fresh for every
// request and serves that instance over Streamable HTTP at /mcp.
const handler = createMcpHandler(createServer);

export default {
  fetch(request, env, ctx) {
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler;
