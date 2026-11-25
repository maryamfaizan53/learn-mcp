import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createNote, deleteNote, getNote, listNotes } from "./notes";

const NOTE_ID_DESCRIPTION = "The note's id, as returned by list_notes or create_note.";

function noteNotFoundError(id: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `No note with id "${id}" exists. Call list_notes to see which ids are valid.`,
      },
    ],
    isError: true,
  };
}

// Called once per request by createMcpHandler, never reused across requests:
// nothing about one caller's request may leak into another's through this
// function or anything it closes over. The notes themselves live in the
// NOTES KV namespace (see notes.ts), not here, so every copy of this Worker
// sees the same notes.
function createServer(): McpServer {
  const server = new McpServer({
    name: "learn-mcp-step-02",
    version: "0.1.0",
  });

  server.registerTool(
    "list_notes",
    {
      description:
        "List every saved note as its id, a short preview of its content, and when it was created. " +
        "Call this first to find a note's id before using get_note or delete_note.",
      outputSchema: z.object({
        notes: z.array(
          z.object({
            id: z.string(),
            preview: z.string(),
            createdAt: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const notes = await listNotes();
      return {
        content: [
          {
            type: "text",
            text:
              notes.length === 0
                ? "No notes yet. Use create_note to add one."
                : notes.map((n) => `${n.id}: ${n.preview}`).join("\n"),
          },
        ],
        structuredContent: { notes },
      };
    },
  );

  server.registerTool(
    "get_note",
    {
      description: "Get one note's full content by id.",
      inputSchema: {
        id: z.string().min(1).describe(NOTE_ID_DESCRIPTION),
      },
      outputSchema: z.object({
        id: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const note = await getNote(id);
      if (note === null) return noteNotFoundError(id);
      return {
        content: [{ type: "text", text: note.content }],
        structuredContent: note,
      };
    },
  );

  server.registerTool(
    "create_note",
    {
      description: "Save a new note and return its id, which later calls need to read or delete it.",
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(2000)
          .describe("The note's text, 1 to 2000 characters."),
      },
      outputSchema: z.object({
        id: z.string(),
        content: z.string(),
        createdAt: z.string(),
      }),
    },
    async ({ content }) => {
      const note = await createNote(content);
      return {
        content: [{ type: "text", text: `Saved note ${note.id}.` }],
        structuredContent: note,
      };
    },
  );

  server.registerTool(
    "delete_note",
    {
      description: "Permanently delete a note by id. This cannot be undone.",
      inputSchema: {
        id: z.string().min(1).describe(NOTE_ID_DESCRIPTION),
      },
      outputSchema: z.object({
        id: z.string(),
        deleted: z.literal(true),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      const existed = await deleteNote(id);
      if (!existed) return noteNotFoundError(id);
      return {
        content: [{ type: "text", text: `Deleted note ${id}.` }],
        structuredContent: { id, deleted: true },
      };
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
