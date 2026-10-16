/**
 * Pure helpers for mirroring Claude Code's file-based memories
 * (`<config dir>/projects/<slug>/memory/<name>.md`) into vector memory.
 * Everything that calls the engine lives in index.ts.
 */

/**
 * A file memory's name when `path` is directly inside the memory folder
 * `dir` (not the `MEMORY.md` index); null for any other path, so a repo's
 * own `…/projects/x/memory/*.md` is never mistaken for one.
 */
export function memoryFileName(path: string, dir: string): string | null {
  const folder = dir.replace(/[\\/]+$/, "");
  if (!path.startsWith(folder) || !/^[\\/]/.test(path.slice(folder.length))) return null;
  const name = path.slice(folder.length + 1);
  return /[\\/]/.test(name) || !isFileMemoryName(name) ? null : name;
}

export interface FileMemory {
  name: string;
  description?: string;
  /** The file's own type: user, feedback, project or reference. */
  type?: string;
  body: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** A scalar's value: quotes removed, or a trailing ` # comment` dropped when unquoted. */
function scalar(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] as string) : trimmed.replace(/\s+#.*$/, "");
}

/** A block scalar's lines (`>` folded into one line, `|` kept as lines). */
function blockScalar(indicator: string, lines: readonly string[]): string {
  const indent = Math.min(...lines.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length));
  const text = lines.map((l) => l.slice(indent).trimEnd());
  return (indicator.startsWith(">") ? text.join(" ").replace(/\s+/g, " ") : text.join("\n")).trim();
}

/**
 * The memory a file holds: its frontmatter's `name`, `description` and
 * `metadata.type` (or a top-level `type`), and the body. Reads the YAML
 * Claude Code's memory files use: top-level scalars, block scalars (`>`,
 * `|`), and one level of nesting. Null without frontmatter, a name, or a body.
 */
export function parseFileMemory(text: string): FileMemory | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;

  const fields: Record<string, string> = {};
  const lines = (match[1] as string).split(/\r?\n/);
  let section = "";
  let sectionIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const field = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] as string);
    if (!field) continue;
    const [, indent, key, value] = field as unknown as [string, string, string, string];

    let path: string | null = key;
    if (indent === "") {
      section = value === "" ? key : "";
      sectionIndent = -1;
    } else if (section && (sectionIndent === -1 || indent.length === sectionIndent)) {
      sectionIndent = indent.length;
      path = `${section}.${key}`;
    } else {
      path = null; // deeper nesting: not a field this reads
    }

    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1] as string) || (lines[i + 1] as string).trim() === "")) {
        block.push(lines[++i] as string);
      }
      if (path !== null) fields[path] = blockScalar(value, block);
    } else if (path !== null && value !== "") {
      fields[path] = scalar(value);
    }
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

/**
 * The `key` a file memory is stored under, by its path: a new version of
 * the file replaces the last, and two files sharing a frontmatter `name`
 * never replace each other.
 */
export function fileMemoryKey(path: string): string {
  return `file-memory:${path}`;
}

/** Past this many characters, content gets an `embedding_text` summary, as `store_memories` asks. */
export const LONG_CONTENT_CHARS = 1000;

/**
 * `store_memories` arguments for one file memory read from `path`. No
 * project: the server files it under its own, which resolves a worktree to
 * its main repository, so the key replaces across worktrees.
 */
export function fileMemoryArgs(memory: FileMemory, path: string): Record<string, unknown> {
  const content = memory.description ? `${memory.description}\n\n${memory.body}` : memory.body;
  // A summary headed by the name and description, then as much of the body as fits.
  const head = memory.description ? `${memory.name}: ${memory.description}\n\n` : "";
  const embeddingText =
    content.length <= LONG_CONTENT_CHARS
      ? undefined
      : `${head}${memory.body}`.slice(0, Math.max(LONG_CONTENT_CHARS, head.length));
  return {
    // The key already replaces the file's last version; the duplicate check
    // would instead keep that stale version whenever an edit is small.
    allow_duplicates: true,
    memories: [
      {
        content,
        ...(embeddingText ? { embedding_text: embeddingText } : {}),
        key: fileMemoryKey(path),
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
 * to, from its `memory` section only (other sections carry CLAUDE.md and
 * skill text, whose paths are not the memory folder); null when it names
 * none (file-based memory off, or an engine that words it differently).
 */
export function memoryDirFromPrompt(sections: ReadonlyArray<{ id: string; text: string }>): string | null {
  for (const section of sections) {
    if (section.id !== "memory") continue;
    const match = MEMORY_DIR.exec(section.text);
    if (match) return match[1] as string;
  }
  return null;
}

/** `store_memories` stored the memory (not "Not stored: duplicate of …"). */
export function isStoredReply(text: string): boolean {
  return /^Memory stored with ID: /m.test(text);
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
