import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

type ToolResult = {
  id: number;
  result?: { content: Array<{ type: string; text: string }>; structuredContent?: unknown };
  error?: { message: string };
};

function toolCallRequest(id: number, name: string, args: Record<string, unknown>): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Host: "localhost",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
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
  });
}

async function callTool(id: number, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const ctx = createExecutionContext();
  const request = toolCallRequest(id, name, args) as Parameters<typeof worker.fetch>[0];
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return (await response.json()) as ToolResult;
}

// Fixed-width, zero-padded content so none is ever a substring of another
// (unpadded "Note 1" would be a substring of "Note 12", hiding a leak).
const CONTENTS = Array.from({ length: 20 }, (_, i) => `Note content ${String(i).padStart(2, "0")}`);

describe("notes toolset", () => {
  it("keeps 20 concurrent create_note calls isolated to their own content", async () => {
    const creates = await Promise.all(
      CONTENTS.map((content, id) => callTool(id, "create_note", { content })),
    );

    const ids = new Set<string>();
    creates.forEach((response, id) => {
      const structured = response.result?.structuredContent as { id: string; content: string } | undefined;
      expect(structured?.content).toBe(CONTENTS[id]);
      // No other call's content leaked into this one's result.
      for (const otherContent of CONTENTS) {
        if (otherContent !== CONTENTS[id]) expect(structured?.content).not.toBe(otherContent);
      }
      expect(structured?.id).toBeTypeOf("string");
      ids.add(structured!.id);
    });
    // Every created note got its own id — no id was reused across calls.
    expect(ids.size).toBe(CONTENTS.length);

    const list = await callTool(100, "list_notes", {});
    const notes = (list.result?.structuredContent as { notes: Array<{ id: string }> }).notes;
    expect(notes).toHaveLength(CONTENTS.length);
  });

  it("get_note and delete_note report a clear error for an unknown id", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";

    const got = await callTool(1, "get_note", { id: missing });
    expect(got.result?.content[0]?.text).toContain(missing);

    const deleted = await callTool(2, "delete_note", { id: missing });
    expect(deleted.result?.content[0]?.text).toContain(missing);
  });

  it("create_note then get_note then delete_note round-trips one note", async () => {
    const created = await callTool(1, "create_note", { content: "Round trip" });
    const { id } = created.result?.structuredContent as { id: string };

    const got = await callTool(2, "get_note", { id });
    expect((got.result?.structuredContent as { content: string }).content).toBe("Round trip");

    const deleted = await callTool(3, "delete_note", { id });
    expect((deleted.result?.structuredContent as { deleted: boolean }).deleted).toBe(true);

    // Deleting it again now reports it as missing, not as a second success.
    const redelete = await callTool(4, "delete_note", { id });
    expect(redelete.result?.content[0]?.text).toContain(id);
  });
});
