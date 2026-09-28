import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import type { ConversationRepository } from "./conversation.repository";
import type {
  ConversationChunk,
  ConversationHybridRow,
  HistoryFilters,
  IndexedSession,
  ParsedMessage,
  SessionFileInfo,
  SessionIndexDetail,
} from "./conversation";
import type { ConversationHistoryConfig } from "../config/index";
import { resolveSessionLogPath } from "../config/index";
import type { EmbeddingsService } from "./embeddings.service";
import type { SessionLogParser } from "./parsers/types";
import { ClaudeCodeSessionParser } from "./parsers/claude-code.parser";

/**
 * Generate a deterministic chunk ID from session ID and message indices.
 */
function chunkId(
  sessionId: string,
  startIdx: number,
  endIdx: number
): string {
  return createHash("sha256")
    .update(`${sessionId}:${startIdx}:${endIdx}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Group parsed messages into embeddable chunks.
 */
export function chunkMessages(
  messages: ParsedMessage[],
  maxChunkMessages: number,
  overlap: number
): ConversationChunk[] {
  if (messages.length === 0) return [];

  const chunks: ConversationChunk[] = [];
  let startIdx = 0;

  while (startIdx < messages.length) {
    const endIdx = Math.min(startIdx + maxChunkMessages, messages.length);
    const chunkMsgs = messages.slice(startIdx, endIdx);

    const firstRole = chunkMsgs[0].role;
    const role = chunkMsgs.every((m) => m.role === firstRole)
      ? firstRole
      : "mixed";

    const content = chunkMsgs
      .map(
        (m) =>
          `[${m.role} @ ${m.timestamp.toISOString()}]: ${m.content}`
      )
      .join("\n\n");

    const firstMsg = chunkMsgs[0];
    const lastMsg = chunkMsgs[chunkMsgs.length - 1];

    chunks.push({
      id: chunkId(
        firstMsg.sessionId,
        firstMsg.messageIndex,
        lastMsg.messageIndex
      ),
      content,
      sessionId: firstMsg.sessionId,
      timestamp: firstMsg.timestamp,
      endTimestamp: lastMsg.timestamp,
      role,
      messageIndexStart: firstMsg.messageIndex,
      messageIndexEnd: lastMsg.messageIndex,
      project: firstMsg.project,
      metadata: {
        timestamp: firstMsg.timestamp.toISOString(),
        git_branch: firstMsg.gitBranch,
        is_subagent: firstMsg.isSubagent,
        agent_id: firstMsg.agentId,
      },
    });

    // Advance by (chunkSize - overlap), but always advance at least 1
    const advance = Math.max(1, endIdx - startIdx - overlap);
    startIdx += advance;
  }

  return chunks;
}

/** Legacy JSON index state format (pre-table), imported on first run. */
interface LegacyIndexStateEntry {
  sessionId: string;
  filePath: string;
  project: string;
  lastModified: number;
  chunkCount: number;
  messageCount: number;
  indexedAt: string;
  firstMessageAt: string;
  lastMessageAt: string;
}

export class ConversationHistoryService {
  private legacyIndexStatePath: string;
  private legacyImportAttempted = false;

  constructor(
    private repository: ConversationRepository,
    private embeddings: EmbeddingsService,
    public readonly config: ConversationHistoryConfig,
    dbPath: string,
    private parser: SessionLogParser = new ClaudeCodeSessionParser()
  ) {
    this.legacyIndexStatePath = join(
      dirname(dbPath),
      "conversation_index_state.json"
    );
  }

  /**
   * Index state lives in the conversation_index_state table (shared by all
   * server processes) — read fresh each time, never cached per-process.
   * A pre-existing conversation_index_state.json is imported once.
   */
  private async loadIndexState(): Promise<Map<string, IndexedSession>> {
    if (!this.legacyImportAttempted) {
      this.legacyImportAttempted = true;
      if (this.repository.countIndexState() === 0) {
        await this.importLegacyIndexState();
      }
    }
    return this.repository.loadIndexState();
  }

  private async importLegacyIndexState(): Promise<void> {
    let entries: LegacyIndexStateEntry[];
    try {
      const raw = await readFile(this.legacyIndexStatePath, "utf-8");
      entries = JSON.parse(raw);
    } catch {
      return; // no legacy state — fine
    }

    this.repository.upsertIndexState(
      entries.map((e) => ({
        sessionId: e.sessionId,
        filePath: e.filePath,
        project: e.project,
        lastModified: e.lastModified,
        chunkCount: e.chunkCount,
        messageCount: e.messageCount,
        indexedAt: new Date(e.indexedAt),
        firstMessageAt: new Date(e.firstMessageAt),
        lastMessageAt: new Date(e.lastMessageAt),
      }))
    );
  }

  private saveIndexState(sessions: IndexedSession[]): void {
    this.repository.upsertIndexState(sessions);
  }

  async indexConversations(
    path?: string,
    since?: Date
  ): Promise<{
    indexed: number;
    skipped: number;
    errors: string[];
    details: SessionIndexDetail[];
  }> {
    if (!this.config.enabled) {
      return {
        indexed: 0,
        skipped: 0,
        errors: ["Conversation history indexing is not enabled"],
        details: [],
      };
    }

    const logPath = path ?? resolveSessionLogPath(this.config);
    if (!logPath) {
      return {
        indexed: 0,
        skipped: 0,
        errors: ["No session log path configured or detected"],
        details: [],
      };
    }

    const sessionFiles = await this.parser.findSessionFiles(
      logPath,
      since,
      this.config.indexSubagents
    );
    const indexState = await this.loadIndexState();

    let indexed = 0;
    let skipped = 0;
    const errors: string[] = [];
    const details: SessionIndexDetail[] = [];
    const updated: IndexedSession[] = [];

    for (const file of sessionFiles) {
      const existing = indexState.get(file.sessionId);
      if (existing && existing.lastModified >= file.lastModified.getTime()) {
        skipped++;
        details.push({ sessionId: file.sessionId, project: file.project, status: "skipped" });
        continue;
      }

      try {
        const state = await this.indexSession(file, indexState);
        updated.push(state);
        indexed++;
        details.push({
          sessionId: file.sessionId,
          project: file.project,
          status: "indexed",
          chunks: state.chunkCount,
          messages: state.messageCount,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${file.sessionId}: ${message}`);
        details.push({ sessionId: file.sessionId, project: file.project, status: "error", error: message });
      }
    }

    this.saveIndexState(updated);
    return { indexed, skipped, errors, details };
  }

  private async indexSession(
    file: SessionFileInfo,
    indexState: Map<string, IndexedSession>
  ): Promise<IndexedSession> {
    const messages = await this.parser.parse(
      file.filePath,
      this.config.indexSubagents
    );
    if (messages.length === 0) {
      // Still track it so we don't re-attempt
      const session: IndexedSession = {
        sessionId: file.sessionId,
        filePath: file.filePath,
        project: file.project,
        lastModified: file.lastModified.getTime(),
        chunkCount: 0,
        messageCount: 0,
        indexedAt: new Date(),
        firstMessageAt: file.lastModified,
        lastMessageAt: file.lastModified,
      };
      indexState.set(file.sessionId, session);
      return session;
    }

    const chunks = chunkMessages(
      messages,
      this.config.maxChunkMessages,
      this.config.chunkOverlap
    );

    // Embed all chunks FIRST (pure computation, no DB side effects)
    const embeddings = await this.embeddings.embedBatch(
      chunks.map((c) => c.content)
    );

    // Build rows
    const rows = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddings[i],
      content: chunk.content,
      metadata: JSON.stringify({
        ...chunk.metadata,
        session_id: chunk.sessionId,
        role: chunk.role,
        message_index_start: chunk.messageIndexStart,
        message_index_end: chunk.messageIndexEnd,
        project: chunk.project,
      }),
      created_at: chunk.timestamp.getTime(),
      session_id: chunk.sessionId,
      role: chunk.role,
      message_index_start: chunk.messageIndexStart,
      message_index_end: chunk.messageIndexEnd,
      project: chunk.project,
    }));

    // Atomically replace old chunks with new ones
    await this.repository.replaceSession(file.sessionId, rows);

    // Update index state. Prefer the parsed project (cwd-derived) over the
    // lossy directory-name decode carried by the file listing.
    const session: IndexedSession = {
      sessionId: file.sessionId,
      filePath: file.filePath,
      project: messages[0].project,
      lastModified: file.lastModified.getTime(),
      chunkCount: chunks.length,
      messageCount: messages.length,
      indexedAt: new Date(),
      firstMessageAt: messages[0].timestamp,
      lastMessageAt: messages[messages.length - 1].timestamp,
    };
    indexState.set(file.sessionId, session);
    return session;
  }

  async reindexSession(
    sessionId: string
  ): Promise<{ success: boolean; chunkCount: number; error?: string }> {
    if (!this.config.enabled) {
      return {
        success: false,
        chunkCount: 0,
        error: "Conversation history indexing is not enabled",
      };
    }

    const indexState = await this.loadIndexState();
    const existing = indexState.get(sessionId);
    if (!existing) {
      return {
        success: false,
        chunkCount: 0,
        error: "Session not found in index state",
      };
    }

    // Construct session info for re-indexing
    const file: SessionFileInfo = {
      filePath: existing.filePath,
      sessionId,
      project: existing.project,
      lastModified: new Date(),
    };

    const state = await this.indexSession(file, indexState);
    this.saveIndexState([state]);

    return { success: true, chunkCount: state.chunkCount };
  }

  async listIndexedSessions(
    limit: number = 20,
    offset: number = 0
  ): Promise<{ sessions: IndexedSession[]; total: number }> {
    const indexState = await this.loadIndexState();
    const sessions = [...indexState.values()].sort(
      (a, b) => b.indexedAt.getTime() - a.indexedAt.getTime()
    );
    return {
      sessions: sessions.slice(offset, offset + limit),
      total: sessions.length,
    };
  }

  async searchHistory(
    query: string,
    embedding: number[],
    limit: number,
    filters?: HistoryFilters
  ): Promise<ConversationHybridRow[]> {
    return this.repository.findHybrid(embedding, query, limit, filters);
  }
}
