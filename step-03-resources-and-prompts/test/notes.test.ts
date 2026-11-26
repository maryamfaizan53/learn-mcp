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

type RpcResult = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

// resources/read and prompts/get both need an Mcp-Name header matching the
// resource's uri / the prompt's name, same as tools/call needs one matching
// params.name — confirmed against the running server, not guessed from docs.
function rpcRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  mcpName?: string,
): Request {
  const headers: Record<string, string> = {
    Host: "localhost",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
  };
  if (mcpName !== undefined) headers["Mcp-Name"] = mcpName;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function callRpc(
  id: number,
  method: string,
  params: Record<string, unknown>,
  mcpName?: string,
): Promise<RpcResult> {
  const ctx = createExecutionContext();
  const request = rpcRequest(id, method, params, mcpName) as Parameters<typeof worker.fetch>[0];
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return (await response.json()) as RpcResult;
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

describe("notes as resources", () => {
  it("lists a created note as a note:// resource and reads its content", async () => {
    const created = await callTool(1, "create_note", { content: "Resource content" });
    const { id } = created.result?.structuredContent as { id: string };
    const uri = `note://${id}`;

    const list = await callRpc(2, "resources/list", {});
    const resources = list.result?.resources as Array<{ uri: string }>;
    expect(resources.map((r) => r.uri)).toContain(uri);

    const read = await callRpc(3, "resources/read", { uri }, uri);
    const contents = read.result?.contents as Array<{ text: string }>;
    expect(contents[0]?.text).toBe("Resource content");
  });

  it("reading an unknown note:// uri returns a protocol error, not a crash", async () => {
    const uri = "note://does-not-exist";
    const read = await callRpc(1, "resources/read", { uri }, uri);
    expect(read.error?.message).toContain(uri);
  });
});

describe("summarize_notes prompt", () => {
  it("lists the prompt with its optional tag argument", async () => {
    const list = await callRpc(1, "prompts/list", {});
    const prompts = list.result?.prompts as Array<{ name: string; arguments: Array<{ name: string; required: boolean }> }>;
    const prompt = prompts.find((p) => p.name === "summarize_notes");
    expect(prompt?.arguments).toEqual([{ name: "tag", description: expect.any(String), required: false }]);
  });

  it("builds a message that mentions the tag when one is given", async () => {
    const withTag = await callRpc(
      1,
      "prompts/get",
      { name: "summarize_notes", arguments: { tag: "groceries" } },
      "summarize_notes",
    );
    const messages = withTag.result?.messages as Array<{ content: { text: string } }>;
    expect(messages[0]?.content.text).toContain("groceries");

    const withoutTag = await callRpc(
      2,
      "prompts/get",
      { name: "summarize_notes", arguments: {} },
      "summarize_notes",
    );
    const noTagMessages = withoutTag.result?.messages as Array<{ content: { text: string } }>;
    expect(noTagMessages[0]?.content.text).not.toContain("groceries");
  });
});
