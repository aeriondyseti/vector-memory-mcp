import { readdir, stat } from "fs/promises";
import { join } from "path";
import type { ConversationHistoryRepository } from "../db/conversation-history.repository.js";
import type { EmbeddingsService } from "./embeddings.service.js";
import {
  parseSessionFile,
  discoverSessionFiles,
  detectSessionPath,
  type ParsedMessage,
  type ParseResult,
  type SessionFileInfo,
} from "./session-parser.js";
import type {
  ConversationHistoryEntry,
  HistorySearchResult,
  IndexedSession,
  IndexedSessionSummary,
  IndexingSummary,
} from "../types/conversation-history.js";

const EMBED_BATCH_SIZE = 50;

export class ConversationHistoryService {
  constructor(
    private repository: ConversationHistoryRepository,
    private embeddings: EmbeddingsService,
    private sessionPath: string | null, // null = auto-detect
  ) {}

  /**
   * Index all conversation sessions found in the session directory.
   *
   * For each .jsonl file discovered:
   * - New (not tracked): full parse from byte 0
   * - Grown (fileSize increased): incremental parse from last-known size
   * - Shrunk (fileSize decreased — file replaced): delete + full reindex
   * - Unchanged (same fileSize): skip
   */
  async indexConversations(sessionDir?: string): Promise<IndexingSummary> {
    const allFiles = await this.discoverAllFiles(sessionDir);

    // Bulk-fetch all tracked sessions into a Map to avoid N+1 lookups
    const trackedSessions = await this.buildSessionIndex();

    const summary: IndexingSummary = {
      sessionsDiscovered: allFiles.length,
      sessionsIndexed: 0,
      sessionsSkipped: 0,
      messagesIndexed: 0,
    };

    for (const file of allFiles) {
      const indexed = trackedSessions.get(file.sessionId) ?? null;

      if (indexed && indexed.fileSize === file.fileSize) {
        // Unchanged — skip
        summary.sessionsSkipped++;
        continue;
      }

      if (indexed && file.fileSize < indexed.fileSize) {
        // Shrunk — file was replaced, full reindex
        await this.repository.deleteBySessionId(file.sessionId);
        await this.repository.deleteIndexedSession(file.sessionId);
        const count = await this.indexFile(file, 0, 0, null);
        summary.sessionsIndexed++;
        summary.messagesIndexed += count;
        continue;
      }

      if (indexed && file.fileSize > indexed.fileSize) {
        // Grown — incremental parse from where we left off
        const count = await this.indexFile(
          file,
          indexed.fileSize,
          indexed.messageCount,
          indexed,
        );
        summary.sessionsIndexed++;
        summary.messagesIndexed += count;
        continue;
      }

      // New — full parse
      const count = await this.indexFile(file, 0, 0, null);
      summary.sessionsIndexed++;
      summary.messagesIndexed += count;
    }

    return summary;
  }

  /**
   * Search conversation history using hybrid (vector + FTS) search.
   */
  async search(query: string, limit: number): Promise<HistorySearchResult[]> {
    const embedding = await this.embeddings.embed(query);
    const rows = await this.repository.findHybrid(embedding, query, limit);

    return rows.map((row) => ({
      source: "conversation_history" as const,
      id: row.id,
      content: row.content,
      metadata: row.metadata,
      score: row.rrfScore,
      sessionId: row.sessionId,
      role: row.role,
      messageIndex: row.messageIndex,
      timestamp: row.timestamp,
    }));
  }

  /**
   * List all indexed sessions (pass-through to repository).
   */
  async listIndexedSessions(): Promise<IndexedSessionSummary[]> {
    return this.repository.listIndexedSessions();
  }

  /**
   * Force a full reindex of a specific session.
   * Deletes all existing entries and tracking, then re-parses from byte 0.
   */
  async reindexSession(sessionId: string): Promise<IndexingSummary> {
    const indexed = await this.repository.getIndexedSession(sessionId);

    const summary: IndexingSummary = {
      sessionsDiscovered: 1,
      sessionsIndexed: 0,
      sessionsSkipped: 0,
      messagesIndexed: 0,
    };

    if (!indexed) {
      // Nothing to reindex — no tracking record means we don't know the file path
      summary.sessionsSkipped = 1;
      return summary;
    }

    // Delete existing data
    await this.repository.deleteBySessionId(sessionId);
    await this.repository.deleteIndexedSession(sessionId);

    // Get current file size (file may have changed since last index)
    let fileSize: number;
    try {
      const stats = await stat(indexed.filePath);
      fileSize = stats.size;
    } catch {
      // File no longer exists
      summary.sessionsSkipped = 1;
      return summary;
    }

    const fileInfo: SessionFileInfo = {
      sessionId,
      filePath: indexed.filePath,
      fileSize,
    };

    const count = await this.indexFile(fileInfo, 0, 0, null);
    summary.sessionsIndexed = 1;
    summary.messagesIndexed = count;
    return summary;
  }

  // --- Private helpers ---

  /**
   * Bulk-fetch all tracked sessions into a Map for O(1) lookups.
   * Uses listIndexedSessions() which returns summaries, but we need full
   * IndexedSession records. We call getIndexedSession() is avoided by using
   * a repository method that returns all sessions with full details.
   *
   * Note: listIndexedSessions returns IndexedSessionSummary (no filePath/fileSize),
   * so we use getIndexedSession per unique session. However, we batch this via
   * the list + individual fetches only when needed. For now, we fetch all as
   * summaries and promote to full records via individual lookups grouped upfront.
   */
  private async buildSessionIndex(): Promise<Map<string, IndexedSession>> {
    const summaries = await this.repository.listIndexedSessions();
    const sessionMap = new Map<string, IndexedSession>();

    // Fetch full records in parallel for all known sessions
    const fullRecords = await Promise.all(
      summaries.map((s) => this.repository.getIndexedSession(s.sessionId)),
    );

    for (const record of fullRecords) {
      if (record) {
        sessionMap.set(record.sessionId, record);
      }
    }

    return sessionMap;
  }

  /**
   * Discover all .jsonl files across resolved session directories.
   * Resolves dirs and discovers files in one pass to avoid double-scanning.
   */
  private async discoverAllFiles(sessionDir?: string): Promise<SessionFileInfo[]> {
    const base = sessionDir ?? this.sessionPath ?? detectSessionPath();
    if (!base) return [];

    // Check if base dir itself has .jsonl files
    const rootFiles = await discoverSessionFiles(base);
    if (rootFiles.length > 0) return rootFiles;

    // Otherwise enumerate subdirectories and discover files in each
    const dirs = await this.listSubdirectories(base);
    const nested = await Promise.all(dirs.map((d) => discoverSessionFiles(d)));
    return nested.flat();
  }

  /**
   * List immediate subdirectories of a path. Stat calls are parallelized.
   */
  private async listSubdirectories(base: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return [];
    }

    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const fullPath = join(base, entry);
        const stats = await stat(fullPath);
        return stats.isDirectory() ? fullPath : null;
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is string => v != null);
  }

  /**
   * Parse a session file, embed messages in batches, insert into repository,
   * and upsert the tracking record. Returns count of messages indexed.
   */
  private async indexFile(
    file: SessionFileInfo,
    fromByte: number,
    startIndex: number,
    existing: IndexedSession | null,
  ): Promise<number> {
    const parseResult = await parseSessionFile(
      file.filePath,
      fromByte,
      startIndex,
      file.fileSize,
    );

    if (parseResult.messages.length === 0) {
      // Still upsert tracking so we don't re-parse an empty/no-new-content file
      await this.upsertTracking(file, parseResult.messages, startIndex, parseResult, existing);
      return 0;
    }

    // Embed and insert in batches
    for (let i = 0; i < parseResult.messages.length; i += EMBED_BATCH_SIZE) {
      const batch = parseResult.messages.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((m) => m.content);
      const embeddings = await this.embeddings.embedBatch(texts);

      const entries: ConversationHistoryEntry[] = batch.map((msg, idx) => ({
        id: msg.id,
        content: msg.content,
        embedding: embeddings[idx],
        sessionId: msg.sessionId,
        role: msg.role,
        messageIndex: msg.messageIndex,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
        createdAt: new Date(),
      }));

      await this.repository.insert(entries);
    }

    await this.upsertTracking(file, parseResult.messages, startIndex, parseResult, existing);
    return parseResult.messages.length;
  }

  /**
   * Upsert the indexed session tracking record.
   * For incremental indexing, merges timestamps with the existing record.
   */
  private async upsertTracking(
    file: SessionFileInfo,
    newMessages: ParsedMessage[],
    startIndex: number,
    parseResult: ParseResult,
    existing: IndexedSession | null,
  ): Promise<void> {
    const totalMessageCount = startIndex + newMessages.length;
    const firstMessageAt =
      existing?.firstMessageAt ?? parseResult.firstMessageAt ?? new Date();
    const lastMessageAt =
      parseResult.lastMessageAt ?? existing?.lastMessageAt ?? new Date();

    const session: IndexedSession = {
      sessionId: file.sessionId,
      filePath: file.filePath,
      fileSize: file.fileSize,
      messageCount: totalMessageCount,
      firstMessageAt,
      lastMessageAt,
      indexedAt: new Date(),
      ...(parseResult.project ? { project: parseResult.project } : existing?.project ? { project: existing.project } : {}),
      ...(parseResult.gitBranch ? { gitBranch: parseResult.gitBranch } : existing?.gitBranch ? { gitBranch: existing.gitBranch } : {}),
    };

    await this.repository.upsertIndexedSession(session);
  }
}
