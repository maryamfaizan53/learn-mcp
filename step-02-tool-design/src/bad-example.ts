// A deliberately badly designed tool, kept only to contrast with create_note
// in index.ts. NEVER registered on the real server — see NOTES.md for why
// each difference below makes the model call this tool worse than create_note.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createNote } from "./notes";

export function registerBadTool(server: McpServer): void {
  server.registerTool(
    // Vague name: gives the model no hint this is about notes at all.
    "do_thing",
    {
      // No description: the model has nothing to read but the name "do_thing".
      inputSchema: {
        // Loose schema: `z.any()` accepts literally anything — strings,
        // numbers, arrays, missing fields, wrong-shaped objects — so bad
        // calls aren't rejected at the protocol layer; they fail later,
        // deep inside the handler, in a way the model never sees coming.
        data: z.any(),
      },
      // No annotations: the host has no idea this changes data, so it can't
      // make a sensible confirmation decision.
    },
    async ({ data }) => {
      // `data.content` is unchecked: a call with `data: "just a string"` or
      // `data: {}` throws a raw TypeError here instead of a clear MCP error.
      const note = await createNote(data.content);
      // Opaque success message: no id, no content back — the model has no
      // way to use this note again without calling list_notes separately.
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
}
