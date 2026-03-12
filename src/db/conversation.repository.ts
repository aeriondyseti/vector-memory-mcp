import * as lancedb from "@lancedb/lancedb";
import { type Table } from "@lancedb/lancedb";
import {
  CONVERSATION_TABLE_NAME,
  conversationSchema,
} from "./conversation.schema.js";
import { arrowTimestampToDate } from "./lancedb-utils.js";
import type {
  ConversationHybridRow,
  HistoryFilters,
} from "../types/conversation.js";
import {
  getOrCreateTable,
  createFtsMutex,
  createRerankerMutex,
  escapeSql,
  safeParseJsonObject,
} from "./lancedb-utils.js";

export class ConversationRepository {
  private tablePromise: Promise<Table> | null = null;

  // FTS index mutex — recreated after data mutations to force re-check
  private ensureFtsIndex = createFtsMutex(() => this.getTable());

  // Cached reranker — k=60 is constant, no need to recreate per search
  private getReranker = createRerankerMutex();

  constructor(private db: lancedb.Connection) {}

  private async getTable(): Promise<Table> {
    if (!this.tablePromise) {
      this.tablePromise = getOrCreateTable(
        this.db,
        CONVERSATION_TABLE_NAME,
        conversationSchema,
      ).catch((err) => {
        this.tablePromise = null;
        throw err;
      });
    }
    const table = await this.tablePromise;
    // Refresh to see writes from other processes sharing this DB
    await table.checkoutLatest();
    return table;
  }

  private rowToConversationHybridRow(
    row: Record<string, unknown>
  ): ConversationHybridRow {
    const metadata = safeParseJsonObject(row.metadata as string);
    return {
      id: row.id as string,
      content: row.content as string,
      metadata,
      createdAt: arrowTimestampToDate(row.created_at),
      rrfScore: (row._relevance_score as number) ?? 0,
    };
  }

  async insertBatch(
    rows: Array<{
      id: string;
      vector: number[];
      content: string;
      metadata: string;
      created_at: number;
      session_id: string;
      role: string;
      message_index_start: number;
      message_index_end: number;
      project: string;
    }>
  ): Promise<void> {
    if (rows.length === 0) return;
    const table = await this.getTable();
    await table.add(rows);
    // Reset FTS mutex so index existence is re-verified after new data
    this.ensureFtsIndex = createFtsMutex(() => this.getTable());
  }

  async deleteBySessionId(sessionId: string): Promise<void> {
    const table = await this.getTable();
    await table.delete(`session_id = '${escapeSql(sessionId)}'`);
    this.ensureFtsIndex = createFtsMutex(() => this.getTable());
  }

  async findHybrid(
    embedding: number[],
    query: string,
    limit: number,
    filters?: HistoryFilters
  ): Promise<ConversationHybridRow[]> {
    await this.ensureFtsIndex();
    const table = await this.getTable();
    const reranker = await this.getReranker();

    let queryBuilder = table
      .query()
      .nearestTo(embedding)
      .fullTextSearch(query)
      .rerank(reranker);

    const conditions: string[] = [];
    if (filters?.sessionId)
      conditions.push(`session_id = '${escapeSql(filters.sessionId)}'`);
    if (filters?.role) conditions.push(`role = '${escapeSql(filters.role)}'`);
    if (filters?.project)
      conditions.push(`project = '${escapeSql(filters.project)}'`);
    if (filters?.after)
      conditions.push(`created_at > ${filters.after.getTime()}`);
    if (filters?.before)
      conditions.push(`created_at < ${filters.before.getTime()}`);

    if (conditions.length > 0) {
      queryBuilder = queryBuilder.where(conditions.join(" AND "));
    }

    const results = await queryBuilder.limit(limit).toArray();
    return results.map((row) =>
      this.rowToConversationHybridRow(row as Record<string, unknown>)
    );
  }
}
