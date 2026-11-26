import { env } from "cloudflare:workers";

// The binding this file reads, matching wrangler.jsonc's kv_namespaces entry.
// `Cloudflare.Env` is the interface `cloudflare:workers`' own `env` export is
// typed against, so merging into it (rather than casting) keeps `env.NOTES`
// genuinely typed everywhere, including outside this file.
declare global {
  namespace Cloudflare {
    interface Env {
      NOTES: KVNamespace;
    }
  }
}

export interface Note {
  id: string;
  content: string;
  createdAt: string;
}

// Metadata kept alongside each KV value so list_notes can show a preview
// without reading every note's full value back from KV.
interface NoteMetadata {
  preview: string;
  createdAt: string;
}

const KEY_PREFIX = "note:";
const PREVIEW_LENGTH = 80;

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function preview(content: string): string {
  return content.length > PREVIEW_LENGTH ? `${content.slice(0, PREVIEW_LENGTH)}…` : content;
}

export async function listNotes(): Promise<Array<{ id: string } & NoteMetadata>> {
  const { NOTES } = env;
  const { keys } = await NOTES.list<NoteMetadata>({ prefix: KEY_PREFIX });
  return keys.map((key) => ({
    id: key.name.slice(KEY_PREFIX.length),
    preview: key.metadata?.preview ?? "",
    createdAt: key.metadata?.createdAt ?? "",
  }));
}

export async function getNote(id: string): Promise<Note | null> {
  const { NOTES } = env;
  const value = await NOTES.get(keyFor(id), "json");
  return (value as Note | null) ?? null;
}

export async function createNote(content: string): Promise<Note> {
  const { NOTES } = env;
  const note: Note = {
    id: crypto.randomUUID(),
    content,
    createdAt: new Date().toISOString(),
  };
  await NOTES.put(keyFor(note.id), JSON.stringify(note), {
    metadata: { preview: preview(content), createdAt: note.createdAt } satisfies NoteMetadata,
  });
  return note;
}

// Returns false when the note never existed, so the tool can report that
// clearly instead of claiming success for a no-op delete.
export async function deleteNote(id: string): Promise<boolean> {
  const { NOTES } = env;
  const existing = await NOTES.get(keyFor(id));
  if (existing === null) return false;
  await NOTES.delete(keyFor(id));
  return true;
}
