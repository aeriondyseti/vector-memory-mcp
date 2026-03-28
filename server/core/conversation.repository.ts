import type { Database } from "bun:sqlite";
import type {
  ConversationHybridRow,
  HistoryFilters,
} from "./conversation";
import {
  serializeVector,
  safeParseJsonObject,
  sanitizeFtsQuery,
  hybridRRFWithSignals,
  topByRRF,
  knnSearch,
} from "./sqlite-utils";

export class ConversationRepository {
  constructor(private db: Database) {}

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

    const insertMain = this.db.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM conversation_history_vec WHERE id = ?`
    );
    const insertVec = this.db.prepare(
      `INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)`
    );
    const deleteFts = this.db.prepare(
      `DELETE FROM conversation_history_fts WHERE id = ?`
    );
    const insertFts = this.db.prepare(
      `INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const row of rows) {
        insertMain.run(
          row.id,
          row.content,
          row.metadata,
          row.created_at,
          row.session_id,
          row.role,
          row.message_index_start,
          row.message_index_end,
          row.project
        );
        deleteVec.run(row.id);
        insertVec.run(row.id, serializeVector(row.vector));
        deleteFts.run(row.id);
        insertFts.run(row.id, row.content);
      }
    });

    tx();
  }

  async deleteBySessionId(sessionId: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const idRows = this.db
        .prepare(
          `SELECT id FROM conversation_history WHERE session_id = ?`
        )
        .all(sessionId) as Array<{ id: string }>;

      if (idRows.length === 0) return;

      const ids = idRows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");

      this.db
        .prepare(
          `DELETE FROM conversation_history_vec WHERE id IN (${placeholders})`
        )
        .run(...ids);

      this.db
        .prepare(
          `DELETE FROM conversation_history_fts WHERE id IN (${placeholders})`
        )
        .run(...ids);

      this.db
        .prepare(`DELETE FROM conversation_history WHERE session_id = ?`)
        .run(sessionId);
    });

    tx();
  }

  async replaceSession(
    sessionId: string,
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
    const insertMain = this.db.prepare(
      `INSERT OR REPLACE INTO conversation_history
        (id, content, metadata, created_at, session_id, role, message_index_start, message_index_end, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const deleteVec = this.db.prepare(
      `DELETE FROM conversation_history_vec WHERE id = ?`
    );
    const insertVec = this.db.prepare(
      `INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)`
    );
    const deleteFts = this.db.prepare(
      `DELETE FROM conversation_history_fts WHERE id = ?`
    );
    const insertFts = this.db.prepare(
      `INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)`
    );

    const tx = this.db.transaction(() => {
      // Delete old chunks first
      const idRows = this.db
        .prepare(`SELECT id FROM conversation_history WHERE session_id = ?`)
        .all(sessionId) as Array<{ id: string }>;

      if (idRows.length > 0) {
        const ids = idRows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(", ");
        this.db
          .prepare(
            `DELETE FROM conversation_history_vec WHERE id IN (${placeholders})`
          )
          .run(...ids);
        this.db
          .prepare(
            `DELETE FROM conversation_history_fts WHERE id IN (${placeholders})`
          )
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_history WHERE session_id = ?`)
          .run(sessionId);
      }

      // Insert new chunks
      for (const row of rows) {
        insertMain.run(
          row.id,
          row.content,
          row.metadata,
          row.created_at,
          row.session_id,
          row.role,
          row.message_index_start,
          row.message_index_end,
          row.project
        );
        deleteVec.run(row.id);
        insertVec.run(row.id, serializeVector(row.vector));
        deleteFts.run(row.id);
        insertFts.run(row.id, row.content);
      }
    });

    tx();
  }

  /**
   * Hybrid search combining vector KNN and FTS5, fused with Reciprocal Rank Fusion.
   *
   * NOTE: Filters (session, role, project, date) are applied AFTER candidate selection
   * and RRF scoring, not pushed into the KNN/FTS queries. This is an intentional
   * performance tradeoff — KNN is brute-force JS-side (no SQL pre-filter possible),
   * and filtering post-RRF avoids duplicating filter logic across both retrieval paths.
   * The consequence is that filtered queries may return fewer than `limit` results.
   */
  async findHybrid(
    embedding: number[],
    query: string,
    limit: number,
    filters?: HistoryFilters
  ): Promise<ConversationHybridRow[]> {
    const candidateCount = limit * 5;

    // Vector KNN search (brute-force cosine similarity in JS)
    const vecResults = knnSearch(this.db, "conversation_history_vec", embedding, candidateCount);

    // FTS5 search
    const ftsQuery = sanitizeFtsQuery(query);
    const ftsResults = this.db
      .prepare(
        `SELECT id FROM conversation_history_fts
         WHERE conversation_history_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, candidateCount) as Array<{ id: string }>;

    // Compute RRF scores with search signals for confidence scoring
    const signalsMap = hybridRRFWithSignals(vecResults, ftsResults);
    const rrfScores = new Map<string, number>();
    for (const [id, s] of signalsMap) rrfScores.set(id, s.rrfScore);
    const topIds = topByRRF(rrfScores, limit);

    if (topIds.length === 0) return [];

    // Build filtered query for full rows
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // IN clause for top ids
    const placeholders = topIds.map(() => "?").join(", ");
    conditions.push(`id IN (${placeholders})`);
    params.push(...topIds);

    // Apply filters
    if (filters?.sessionId) {
      conditions.push("session_id = ?");
      params.push(filters.sessionId);
    }
    if (filters?.role) {
      conditions.push("role = ?");
      params.push(filters.role);
    }
    if (filters?.project) {
      conditions.push("project = ?");
      params.push(filters.project);
    }
    if (filters?.after) {
      conditions.push("created_at > ?");
      params.push(filters.after.getTime());
    }
    if (filters?.before) {
      conditions.push("created_at < ?");
      params.push(filters.before.getTime());
    }

    const whereClause = conditions.join(" AND ");

    const fullRows = this.db
      .prepare(
        `SELECT id, content, metadata, created_at, session_id, role,
                message_index_start, message_index_end, project
         FROM conversation_history
         WHERE ${whereClause}`
      )
      .all(...params) as Array<{
      id: string;
      content: string;
      metadata: string;
      created_at: number;
      session_id: string;
      role: string;
      message_index_start: number;
      message_index_end: number;
      project: string;
    }>;

    return fullRows
      .map((row) => {
        const signals = signalsMap.get(row.id)!;
        return {
          id: row.id,
          content: row.content,
          metadata: safeParseJsonObject(row.metadata),
          createdAt: new Date(row.created_at),
          rrfScore: signals.rrfScore,
          signals: {
            cosineSimilarity: signals.cosineSimilarity,
            ftsMatch: signals.ftsMatch,
            knnRank: signals.knnRank,
            ftsRank: signals.ftsRank,
          },
        };
      })
      .sort((a, b) => b.rrfScore - a.rrfScore);
  }
}
