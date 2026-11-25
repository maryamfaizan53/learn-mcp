import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-01",
    version: "0.1.0",
  });

  // Tools are registered on `server` here in the next prompt.

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
