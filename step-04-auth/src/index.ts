import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
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
    name: "learn-mcp-step-04",
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
      // `handler` (below) isn't assigned until the module finishes loading,
      // but this closure only runs later, per request, by which time it is —
      // same reason `env` works in notes.ts despite being imported at the
      // top. Only reaches a client with an open subscriptions/listen stream
      // on this same Worker isolate; fine for a teaching step, not a promise
      // that every client sees it immediately.
      handler.notify.resourcesChanged();
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
      handler.notify.resourcesChanged();
      return {
        content: [{ type: "text", text: `Deleted note ${id}.` }],
        structuredContent: { id, deleted: true },
      };
    },
  );

  const noteResourceTemplate = new ResourceTemplate("note://{id}", {
    list: async () => ({
      resources: (await listNotes()).map((note) => ({
        uri: `note://${note.id}`,
        name: note.preview,
        mimeType: "text/plain",
      })),
    }),
  });

  server.registerResource(
    "note",
    noteResourceTemplate,
    {
      title: "Note",
      description: "A saved note's full text, attachable directly to a conversation.",
      mimeType: "text/plain",
    },
    async (uri, { id }) => {
      const note = await getNote(String(id));
      if (note === null) throw new ResourceNotFoundError(uri.href);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: note.content }] };
    },
  );

  server.registerPrompt(
    "summarize_notes",
    {
      title: "Summarize my notes",
      description:
        "Ask the model to gather saved notes (via list_notes/get_note, or any note:// resources " +
        "already attached) and write a short summary, optionally limited to one tag or topic.",
      argsSchema: { tag: z.string().optional().describe("Only summarize notes mentioning this tag or topic. Omit to summarize everything.") },
    },
    ({ tag }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: tag
              ? `If any notes are already attached as note:// resources in this conversation, use ` +
                `them directly; otherwise call list_notes and then get_note for each note that ` +
                `looks related to "${tag}". Write a short summary of just those notes.`
              : `If any notes are already attached as note:// resources in this conversation, use ` +
                `them directly; otherwise call list_notes and then get_note for each note. Write a ` +
                `short summary of all of them.`,
          },
        },
      ],
    }),
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
