import * as lancedb from "@lancedb/lancedb";
import { rerankers, type Table } from "@lancedb/lancedb";
import {
  CONVERSATION_HISTORY_TABLE,
  INDEXED_SESSIONS_TABLE,
  conversationHistorySchema,
  indexedSessionsSchema,
} from "./conversation-history.schema.js";
import {
  arrowVectorToArray,
  getOrCreateTable,
  createFtsMutex,
} from "./lancedb-utils.js";
import type {
  ConversationHistoryEntry,
  ConversationHistoryHybridRow,
  IndexedSession,
  IndexedSessionSummary,
} from "../types/conversation-history.js";

export class ConversationHistoryRepository {
  // Cached table handles — initialized once, retained for instance lifetime
  private tablePromise: Promise<Table> | null = null;
  private sessionsTablePromise: Promise<Table> | null = null;

  // Cached reranker — k=60 is constant, no need to recreate per search
  private rerankerPromise: Promise<rerankers.RRFReranker> | null = null;

  // FTS index mutex — once created, the promise is never cleared (index persists in LanceDB)
  private ensureFtsIndex: () => Promise<void>;

  constructor(private db: lancedb.Connection) {
    this.ensureFtsIndex = createFtsMutex(() => this.getTable());
  }

  private getTable(): Promise<Table> {
    if (!this.tablePromise) {
      this.tablePromise = getOrCreateTable(
        this.db,
        CONVERSATION_HISTORY_TABLE,
        conversationHistorySchema
      ).catch((e) => {
        this.tablePromise = null;
        throw e;
      });
    }
    return this.tablePromise;
  }

  private getSessionsTable(): Promise<Table> {
    if (!this.sessionsTablePromise) {
      this.sessionsTablePromise = getOrCreateTable(
        this.db,
        INDEXED_SESSIONS_TABLE,
        indexedSessionsSchema
      ).catch((e) => {
        this.sessionsTablePromise = null;
        throw e;
      });
    }
    return this.sessionsTablePromise;
  }

  private getReranker(): Promise<rerankers.RRFReranker> {
    if (!this.rerankerPromise) {
      this.rerankerPromise = rerankers.RRFReranker.create(60).catch((e) => {
        this.rerankerPromise = null;
        throw e;
      });
    }
    return this.rerankerPromise;
  }

  private rowToEntry(row: Record<string, unknown>): ConversationHistoryEntry {
    return {
      id: row.id as string,
      content: row.content as string,
      embedding: arrowVectorToArray(row.vector),
      sessionId: row.session_id as string,
      role: row.role as "user" | "assistant",
      messageIndex: row.message_index as number,
      timestamp: new Date(row.timestamp as number),
      metadata: JSON.parse(row.metadata as string),
      createdAt: new Date(row.created_at as number),
    };
  }

  private rowToSessionSummary(
    row: Record<string, unknown>
  ): IndexedSessionSummary {
    return {
      sessionId: row.session_id as string,
      messageCount: row.message_count as number,
      firstMessageAt: new Date(row.first_message_at as number),
      lastMessageAt: new Date(row.last_message_at as number),
      indexedAt: new Date(row.indexed_at as number),
      // Use null check (not truthiness) — empty string is a valid value distinct from null
      ...(row.project != null ? { project: row.project as string } : {}),
      ...(row.git_branch != null ? { gitBranch: row.git_branch as string } : {}),
    };
  }

  // --- Conversation History Operations ---

  async insert(entries: ConversationHistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const table = await this.getTable();
    await table.add(
      entries.map((entry) => ({
        id: entry.id,
        vector: entry.embedding,
        content: entry.content,
        session_id: entry.sessionId,
        role: entry.role,
        message_index: entry.messageIndex,
        timestamp: entry.timestamp.getTime(),
        metadata: JSON.stringify(entry.metadata),
        created_at: entry.createdAt.getTime(),
      }))
    );
  }

  async findHybrid(
    embedding: number[],
    query: string,
    limit: number
  ): Promise<ConversationHistoryHybridRow[]> {
    await this.ensureFtsIndex();

    const table = await this.getTable();
    const reranker = await this.getReranker();

    const results = await table
      .query()
      .nearestTo(embedding)
      .fullTextSearch(query)
      .rerank(reranker)
      .limit(limit)
      .toArray();

    return results.map((row) => {
      const entry = this.rowToEntry(row as Record<string, unknown>);
      return {
        ...entry,
        rrfScore: (row._relevance_score as number) ?? 0,
      };
    });
  }

  async findBySessionId(sessionId: string): Promise<ConversationHistoryEntry[]> {
    const table = await this.getTable();
    const results = await table
      .query()
      .where(`session_id = '${sessionId}'`)
      .toArray();

    return results.map((row) =>
      this.rowToEntry(row as Record<string, unknown>)
    );
  }

  async deleteBySessionId(sessionId: string): Promise<number> {
    const table = await this.getTable();

    // Select only id — avoids deserializing embedding vectors just for a count
    const existing = await table
      .query()
      .where(`session_id = '${sessionId}'`)
      .select(["id"])
      .toArray();
    const count = existing.length;

    if (count > 0) {
      await table.delete(`session_id = '${sessionId}'`);
    }

    return count;
  }

  // --- Indexed Sessions Tracking ---

  async getIndexedSession(
    sessionId: string
  ): Promise<IndexedSessionSummary | null> {
    const table = await this.getSessionsTable();
    const results = await table
      .query()
      .where(`session_id = '${sessionId}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) {
      return null;
    }

    return this.rowToSessionSummary(results[0] as Record<string, unknown>);
  }

  async upsertIndexedSession(session: IndexedSession): Promise<void> {
    const table = await this.getSessionsTable();
    const existing = await table
      .query()
      .where(`session_id = '${session.sessionId}'`)
      .limit(1)
      .toArray();

    const row = {
      session_id: session.sessionId,
      file_path: session.filePath,
      file_size: session.fileSize,
      message_count: session.messageCount,
      first_message_at: session.firstMessageAt.getTime(),
      last_message_at: session.lastMessageAt.getTime(),
      indexed_at: session.indexedAt.getTime(),
      project: session.project ?? null,
      git_branch: session.gitBranch ?? null,
    };

    if (existing.length === 0) {
      await table.add([row]);
    } else {
      await table.update({
        where: `session_id = '${session.sessionId}'`,
        values: row,
      });
    }
  }

  async listIndexedSessions(): Promise<IndexedSessionSummary[]> {
    const table = await this.getSessionsTable();
    const results = await table.query().toArray();

    return results.map((row) =>
      this.rowToSessionSummary(row as Record<string, unknown>)
    );
  }

  async deleteIndexedSession(sessionId: string): Promise<boolean> {
    const table = await this.getSessionsTable();
    const existing = await table
      .query()
      .where(`session_id = '${sessionId}'`)
      .limit(1)
      .toArray();

    if (existing.length === 0) {
      return false;
    }

    await table.delete(`session_id = '${sessionId}'`);
    return true;
  }
}
