/**
 * Pure helpers for mirroring Claude Code's file-based memories
 * (`<config dir>/projects/<slug>/memory/<name>.md`) into vector memory.
 * Everything that calls the engine lives in index.ts.
 */

/** A memory file: `…/projects/<slug>/memory/<name>.md`; not the `MEMORY.md` index. */
const MEMORY_FILE = /[\\/]projects[\\/][^\\/]+[\\/]memory[\\/]([^\\/]+)\.md$/;

export function isFileMemoryPath(path: string): boolean {
  const match = MEMORY_FILE.exec(path);
  return match !== null && match[1] !== "MEMORY";
}

export interface FileMemory {
  name: string;
  description?: string;
  /** The file's own type: user, feedback, project or reference. */
  type?: string;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] as string) : trimmed;
}

/**
 * The memory a file holds: its frontmatter's `name`, `description` and
 * `metadata.type` (or a top-level `type`), and the body. Null without
 * frontmatter, a name, or a body.
 */
export function parseFileMemory(text: string): FileMemory | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;

  const fields: Record<string, string> = {};
  let section = "";
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const field = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    const [, indent, key, value] = field as unknown as [string, string, string, string];
    if (indent === "") section = value === "" ? key : "";
    const path = indent !== "" && section ? `${section}.${key}` : key;
    if (value !== "") fields[path] = unquote(value);
  }

  const name = fields.name;
  const body = (match[2] as string).trim();
  if (!name || body === "") return null;
  const type = fields["metadata.type"] ?? fields.type;
  return {
    name,
    ...(fields.description ? { description: fields.description } : {}),
    ...(type ? { type } : {}),
    body,
  };
}

/** The `key` a file memory is stored under: a new version replaces the last. */
export function fileMemoryKey(name: string): string {
  return `file-memory:${name}`;
}

/** Past this many characters, content gets an `embedding_text` summary, as `store_memories` asks. */
export const LONG_CONTENT_CHARS = 1000;

/**
 * `store_memories` arguments for one file memory read from `path`, filed
 * under `project` when given (the main repository's root, which a worktree
 * shares, so its key replaces across worktrees); else the server's own.
 */
export function fileMemoryArgs(memory: FileMemory, path: string, project?: string): Record<string, unknown> {
  const content = memory.description ? `${memory.description}\n\n${memory.body}` : memory.body;
  const embeddingText =
    content.length <= LONG_CONTENT_CHARS
      ? undefined
      : memory.description
        ? `${memory.name}: ${memory.description}`
        : content.slice(0, LONG_CONTENT_CHARS);
  return {
    memories: [
      {
        content,
        ...(embeddingText ? { embedding_text: embeddingText } : {}),
        key: fileMemoryKey(memory.name),
        ...(project ? { project } : {}),
        context: `File memory > ${memory.name}`,
        metadata: {
          type: "context",
          source: "file-memory",
          ...(memory.type ? { file_memory_type: memory.type } : {}),
          file_path: path,
          tags: ["file-memory", ...(memory.type ? [memory.type] : [])],
        },
      },
    ],
  };
}

/** A memory file's name within the memory folder; not the `MEMORY.md` index. */
export function isFileMemoryName(name: string): boolean {
  return name.endsWith(".md") && name !== "MEMORY.md";
}

/** A backticked memory folder path, as the system prompt's `memory` section names it. */
const MEMORY_DIR = /`([^`\n]*[\\/]projects[\\/][^`\\/\n]+[\\/]memory)[\\/]?`/;

/**
 * The file-based memory folder the system prompt tells the model to write
 * to: from the `memory` section, else any section; null when none names one
 * (file-based memory off, or an engine that words it differently).
 */
export function memoryDirFromPrompt(sections: ReadonlyArray<{ id: string; text: string }>): string | null {
  const ordered = [...sections.filter((s) => s.id === "memory"), ...sections.filter((s) => s.id !== "memory")];
  for (const section of ordered) {
    const match = MEMORY_DIR.exec(section.text);
    if (match) return match[1] as string;
  }
  return null;
}

/** A memory folder's files: name → `size:mtimeMs`. */
export type MemoryListing = Map<string, string>;

export function memoryListing(
  entries: ReadonlyArray<{ name: string; kind: string; size: number; mtimeMs: number }>
): MemoryListing {
  const listing: MemoryListing = new Map();
  for (const entry of entries) {
    if (entry.kind === "file" && isFileMemoryName(entry.name)) listing.set(entry.name, `${entry.size}:${entry.mtimeMs}`);
  }
  return listing;
}

/** Files added or changed between two listings of a memory folder; removed ones are left out. */
export function changedMemoryFiles(before: MemoryListing, after: MemoryListing): string[] {
  return [...after].filter(([name, stamp]) => before.get(name) !== stamp).map(([name]) => name);
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The toast once a sync completes: the memory's name, or how many; null when nothing was stored. */
export function syncedToast(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `Vector Memory: synced file memory "${names[0]}"`;
  return `Vector Memory: synced ${names.length} file memories`;
}

export type FileMemorySyncMode = "on" | "off";

export function fileMemorySyncMode(value: unknown): FileMemorySyncMode {
  return value === "off" ? "off" : "on";
}
