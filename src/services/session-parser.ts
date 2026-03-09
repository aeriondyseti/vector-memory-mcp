import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { createInterface } from "readline";
import { join } from "path";
import { randomUUID } from "crypto";

/**
 * A parsed message extracted from a Claude Code JSONL session file.
 * Does not include embedding — that's added by the service layer.
 */
export interface ParsedMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
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
 */
export async function parseSessionFile(
  filePath: string,
  fromByte: number = 0,
  startIndex: number = 0,
): Promise<ParseResult> {
  const fileStats = await stat(filePath);
  const fileSize = fileStats.size;

  // Extract session ID from filename (e.g. "abc-123.jsonl" → "abc-123")
  const fileName = filePath.split("/").pop() ?? "";
  const sessionId = fileName.replace(/\.jsonl$/, "");

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

    const role = line.type as "user" | "assistant";
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
 * Returns file info sorted by modification time (newest first).
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

  const results: SessionFileInfo[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;

    const filePath = join(sessionDir, entry);
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) continue;
      results.push({
        sessionId: entry.replace(/\.jsonl$/, ""),
        filePath,
        fileSize: fileStats.size,
      });
    } catch {
      // Skip files we can't stat
      continue;
    }
  }

  // Sort newest first by modification time
  // (we already have the stats, but sort by name as proxy since
  // session IDs are UUIDs and we'd need to store mtime separately)
  return results;
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
