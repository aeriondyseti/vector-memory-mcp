import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type { ConversationRepository } from "../db/conversation.repository.js";
import type {
  ConversationChunk,
  ConversationHybridRow,
  HistoryFilters,
  IndexedSession,
  ParsedMessage,
  SessionFileInfo,
} from "../types/conversation.js";
import type { ConversationHistoryConfig } from "../config/index.js";
import { resolveSessionLogPath } from "../config/index.js";
import type { EmbeddingsService } from "./embeddings.service.js";
import type { SessionLogParser } from "./parsers/types.js";
import { ClaudeCodeSessionParser } from "./parsers/claude-code.parser.js";

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
        session_id: firstMsg.sessionId,
        timestamp: firstMsg.timestamp.toISOString(),
        role,
        message_index_start: firstMsg.messageIndex,
        message_index_end: lastMsg.messageIndex,
        project: firstMsg.project,
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

/** Serializable index state format */
interface IndexStateEntry {
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
  private indexStatePath: string;
  private indexStateCache: Map<string, IndexedSession> | null = null;

  constructor(
    private repository: ConversationRepository,
    private embeddings: EmbeddingsService,
    public readonly config: ConversationHistoryConfig,
    private dbPath: string,
    private parser: SessionLogParser = new ClaudeCodeSessionParser()
  ) {
    this.indexStatePath = join(
      dirname(dbPath),
      "conversation_index_state.json"
    );
  }

  private loadIndexState(): Map<string, IndexedSession> {
    if (this.indexStateCache) return this.indexStateCache;
    try {
      const raw = readFileSync(this.indexStatePath, "utf-8");
      const entries: IndexStateEntry[] = JSON.parse(raw);
      const map = new Map<string, IndexedSession>();
      for (const e of entries) {
        map.set(e.sessionId, {
          sessionId: e.sessionId,
          filePath: e.filePath,
          project: e.project,
          lastModified: e.lastModified,
          chunkCount: e.chunkCount,
          messageCount: e.messageCount,
          indexedAt: new Date(e.indexedAt),
          firstMessageAt: new Date(e.firstMessageAt),
          lastMessageAt: new Date(e.lastMessageAt),
        });
      }
      this.indexStateCache = map;
      return map;
    } catch {
      const map = new Map<string, IndexedSession>();
      this.indexStateCache = map;
      return map;
    }
  }

  private saveIndexState(state: Map<string, IndexedSession>): void {
    const entries: IndexStateEntry[] = [...state.values()].map((s) => ({
      sessionId: s.sessionId,
      filePath: s.filePath,
      project: s.project,
      lastModified: s.lastModified,
      chunkCount: s.chunkCount,
      messageCount: s.messageCount,
      indexedAt: s.indexedAt.toISOString(),
      firstMessageAt: s.firstMessageAt.toISOString(),
      lastMessageAt: s.lastMessageAt.toISOString(),
    }));
    mkdirSync(dirname(this.indexStatePath), { recursive: true });
    writeFileSync(this.indexStatePath, JSON.stringify(entries, null, 2));
    this.indexStateCache = state;
  }

  async indexConversations(
    path?: string,
    since?: Date
  ): Promise<{ indexed: number; skipped: number; errors: string[] }> {
    if (!this.config.enabled) {
      return {
        indexed: 0,
        skipped: 0,
        errors: ["Conversation history indexing is not enabled"],
      };
    }

    const logPath = path ?? resolveSessionLogPath(this.config);
    if (!logPath) {
      return {
        indexed: 0,
        skipped: 0,
        errors: ["No session log path configured or detected"],
      };
    }

    const sessionFiles = await this.parser.findSessionFiles(
      logPath,
      since,
      this.config.indexSubagents
    );
    const indexState = this.loadIndexState();

    let indexed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const file of sessionFiles) {
      const existing = indexState.get(file.sessionId);
      if (existing && existing.lastModified >= file.lastModified.getTime()) {
        skipped++;
        continue;
      }

      try {
        await this.indexSession(file, indexState);
        indexed++;
      } catch (err) {
        errors.push(
          `${file.sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.saveIndexState(indexState);
    return { indexed, skipped, errors };
  }

  private async indexSession(
    file: SessionFileInfo,
    indexState: Map<string, IndexedSession>
  ): Promise<void> {
    const messages = await this.parser.parse(
      file.filePath,
      this.config.indexSubagents
    );
    if (messages.length === 0) {
      // Still track it so we don't re-attempt
      indexState.set(file.sessionId, {
        sessionId: file.sessionId,
        filePath: file.filePath,
        project: file.project,
        lastModified: file.lastModified.getTime(),
        chunkCount: 0,
        messageCount: 0,
        indexedAt: new Date(),
        firstMessageAt: new Date(),
        lastMessageAt: new Date(),
      });
      return;
    }

    const chunks = chunkMessages(
      messages,
      this.config.maxChunkMessages,
      this.config.chunkOverlap
    );

    // Delete existing chunks for re-indexing
    await this.repository.deleteBySessionId(file.sessionId);

    // Embed all chunks
    const embeddings = await this.embeddings.embedBatch(
      chunks.map((c) => c.content)
    );

    // Insert all chunks
    const rows = chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddings[i],
      content: chunk.content,
      metadata: JSON.stringify(chunk.metadata),
      created_at: chunk.timestamp.getTime(),
      session_id: chunk.sessionId,
      role: chunk.role,
      message_index_start: chunk.messageIndexStart,
      message_index_end: chunk.messageIndexEnd,
      project: chunk.project,
    }));

    await this.repository.insertBatch(rows);

    // Update index state
    indexState.set(file.sessionId, {
      sessionId: file.sessionId,
      filePath: file.filePath,
      project: file.project,
      lastModified: file.lastModified.getTime(),
      chunkCount: chunks.length,
      messageCount: messages.length,
      indexedAt: new Date(),
      firstMessageAt: messages[0].timestamp,
      lastMessageAt: messages[messages.length - 1].timestamp,
    });
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

    const indexState = this.loadIndexState();
    const existing = indexState.get(sessionId);
    if (!existing) {
      return {
        success: false,
        chunkCount: 0,
        error: "Session not found in index state",
      };
    }

    // Force re-index by setting lastModified to 0
    const file: SessionFileInfo = {
      filePath: existing.filePath,
      sessionId,
      project: existing.project,
      lastModified: new Date(),
    };

    await this.indexSession(file, indexState);
    this.saveIndexState(indexState);

    const updated = indexState.get(sessionId)!;
    return { success: true, chunkCount: updated.chunkCount };
  }

  async listIndexedSessions(
    limit: number = 20,
    offset: number = 0
  ): Promise<{ sessions: IndexedSession[]; total: number }> {
    const indexState = this.loadIndexState();
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
