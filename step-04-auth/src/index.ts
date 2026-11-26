import { env } from "cloudflare:workers";
import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { getAuth } from "./auth";
import { createNote, deleteNote, getNote, listNotes } from "./notes";
import { getIdentity, identityStorage } from "./identity";
import { consentPage, loginPage } from "./pages";

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
      const protectedMcp = requireMcpAuth(getAuth(), async (req, claims) => {
        const userId = typeof claims.sub === "string" ? claims.sub : undefined;
        const orgId = typeof claims.orgId === "string" ? claims.orgId : undefined;
        if (!userId || !orgId) {
          return jsonRpcError(403, "This token has no company. Sign in again to get one.");
        }
        // Looked up fresh on every request, never cached and never baked
        // into the token, so a role change or removal takes effect on the
        // very next call.
        const member = await env.DB.prepare(
          "select role from member where organizationId = ? and userId = ?",
        )
          .bind(orgId, userId)
          .first<{ role: string }>();
        if (!member) {
          return jsonRpcError(403, "You are no longer a member of this company.");
        }
        return identityStorage.run({ userId, orgId, role: member.role }, () =>
          handler(req as Parameters<typeof handler>[0], env, ctx),
        );
      });
      return protectedMcp(request);
    }

    // Everything else (sign-in, sign-up, the OAuth authorize/token/consent
    // endpoints, discovery metadata) is Better Auth's own surface.
    return getAuth().handler(request);
  },
} satisfies ExportedHandler;
