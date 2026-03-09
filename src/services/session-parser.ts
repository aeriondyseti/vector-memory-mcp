import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { createInterface } from "readline";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import type { MessageRole } from "../types/conversation-history.js";

/**
 * A parsed message extracted from a Claude Code JSONL session file.
 * Does not include embedding — that's added by the service layer.
 */
export interface ParsedMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  messageIndex: number;
  content: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}

/**
 * Info about a discovered session file (before parsing).
 */
export interface SessionFileInfo {
  sessionId: string;
  filePath: string;
  fileSize: number;
}

/**
 * Result of parsing a single session file.
 * Structurally mirrors IndexedSession but with nullable timestamps/metadata
 * (a file with 0 messages has no timestamps). The service layer maps this to
 * IndexedSession at write time, supplying messageCount and indexedAt.
 */
export interface ParseResult {
  sessionId: string;
  filePath: string;
  fileSize: number;
  messages: ParsedMessage[];
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
  gitBranch: string | null;
  project: string | null;
}

// -- JSONL line shapes (only the fields we need) --

interface JournalLine {
  type: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Extract the text content from a JSONL message line.
 * - User messages: content is string OR array (skip tool_result blocks)
 * - Assistant messages: content is array of blocks (keep only type=text)
 * Returns null if no usable text content.
 */
function extractTextContent(line: JournalLine): string | null {
  const content = line.message?.content;
  if (content == null) return null;

  // User messages can be a plain string
  if (typeof content === "string") {
    return content.trim() || null;
  }

  // Array of content blocks — extract text blocks only
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    }
  }

  const joined = textParts.join("\n").trim();
  return joined || null;
}

/**
 * Parse a single Claude Code JSONL session file.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param fromByte - Byte offset to start reading from (for incremental parsing).
 *                   When non-zero, messageIndex starts from startIndex.
 * @param startIndex - Starting message index (for incremental parsing).
 * @param knownFileSize - If already known (e.g. from discoverSessionFiles), avoids a redundant stat().
 */
export async function parseSessionFile(
  filePath: string,
  fromByte: number = 0,
  startIndex: number = 0,
  knownFileSize?: number,
): Promise<ParseResult> {
  const fileSize = knownFileSize ?? (await stat(filePath)).size;

  // Extract session ID from filename (e.g. "abc-123.jsonl" → "abc-123")
  const sessionId = basename(filePath, ".jsonl");

  const messages: ParsedMessage[] = [];
  let messageIndex = startIndex;
  let firstMessageAt: Date | null = null;
  let lastMessageAt: Date | null = null;
  let gitBranch: string | null = null;
  let project: string | null = null;

  const stream = createReadStream(filePath, {
    encoding: "utf-8",
    start: fromByte,
  });

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    if (!rawLine.trim()) continue;

    let line: JournalLine;
    try {
      line = JSON.parse(rawLine);
    } catch {
      // Skip malformed lines
      continue;
    }

    // Only process user and assistant messages
    if (line.type !== "user" && line.type !== "assistant") continue;

    // Capture metadata from first line that has it
    if (gitBranch == null && line.gitBranch) gitBranch = line.gitBranch;
    if (project == null && line.cwd) project = line.cwd;

    const role: MessageRole = line.type === "user" ? "user" : "assistant";
    const text = extractTextContent(line);
    if (!text) continue;

    const timestamp = line.timestamp ? new Date(line.timestamp) : new Date();

    if (firstMessageAt == null) firstMessageAt = timestamp;
    lastMessageAt = timestamp;

    messages.push({
      id: randomUUID(),
      sessionId,
      role,
      messageIndex,
      content: text,
      timestamp,
      metadata: {
        ...(line.gitBranch ? { gitBranch: line.gitBranch } : {}),
        ...(line.cwd ? { cwd: line.cwd } : {}),
      },
    });

    messageIndex++;
  }

  return {
    sessionId,
    filePath,
    fileSize,
    messages,
    firstMessageAt,
    lastMessageAt,
    gitBranch,
    project,
  };
}

/**
 * Discover all .jsonl session files in a directory.
 * Stat calls are parallelized for efficiency.
 */
export async function discoverSessionFiles(
  sessionDir: string,
): Promise<SessionFileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir);
  } catch {
    return [];
  }

  const jsonlEntries = entries.filter((e) => e.endsWith(".jsonl"));

  const settled = await Promise.allSettled(
    jsonlEntries.map(async (entry) => {
      const filePath = join(sessionDir, entry);
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) return null;
      return {
        sessionId: entry.replace(/\.jsonl$/, ""),
        filePath,
        fileSize: fileStats.size,
      } satisfies SessionFileInfo;
    }),
  );

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<SessionFileInfo | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((v): v is SessionFileInfo => v != null);
}

/**
 * Auto-detect the Claude Code sessions directory.
 * Returns null if not found.
 */
export function detectSessionPath(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;

  // Claude Code stores sessions at ~/.claude/projects/<project-slug>/<session-id>.jsonl
  // We return the projects dir — the caller iterates project subdirs
  return join(home, ".claude", "projects");
}
