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

/** `store_memories` arguments for one file memory read from `path`. */
export function fileMemoryArgs(memory: FileMemory, path: string): Record<string, unknown> {
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

export type FileMemorySyncMode = "on" | "off";

export function fileMemorySyncMode(value: unknown): FileMemorySyncMode {
  return value === "off" ? "off" : "on";
}
