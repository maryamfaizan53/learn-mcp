import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// Fixed-width names (all the same length) so no name is ever a substring of
// another — "Name_01" would otherwise be contained in "Name_010".
const NAMES = Array.from({ length: 20 }, (_, i) => `Name_${String(i).padStart(2, "0")}`);

function greetRequest(id: number, name: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Host: "localhost",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "greet",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "greet",
        arguments: { name },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("greet", () => {
  it("keeps 20 concurrent calls isolated to their own name", async () => {
    const responses = await Promise.all(
      NAMES.map(async (name, id) => {
        const ctx = createExecutionContext();
        // Cast to the exact Request type `fetch` expects: the Workers
        // runtime type for an incoming request's `cf` properties differs
        // from the `Request` constructor's own, even though both describe
        // the same object at runtime.
        const request = greetRequest(id, name) as Parameters<typeof worker.fetch>[0];
        const response = await worker.fetch(request, env, ctx);
        await waitOnExecutionContext(ctx);
        return (await response.json()) as {
          id: number;
          result: { content: Array<{ type: string; text: string }> };
        };
      }),
    );

    responses.forEach((response, id) => {
      const text = response.result.content[0]?.text ?? "";
      // The one request-call this response belongs to.
      expect(response.id).toBe(id);
      expect(text).toContain(NAMES[id]);
      // No other request's name leaked into this response — proof the
      // factory built a fresh McpServer for this call alone.
      for (const otherName of NAMES) {
        if (otherName !== NAMES[id]) expect(text).not.toContain(otherName);
      }
    });
  });
});
