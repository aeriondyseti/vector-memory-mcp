import type { Database } from "bun:sqlite";
import {
  serializeVector,
  deserializeVector,
  safeParseJsonObject,
  sanitizeFtsQuery,
  hybridRRF,
  topByRRF,
} from "./sqlite-utils.js";
import {
  type Memory,
  type HybridRow,
  DELETED_TOMBSTONE,
} from "../types/memory.js";

export class MemoryRepository {
  constructor(private db: Database) {}

  // ---------------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------------

  /**
   * Converts a raw SQLite row from the `memories` table to a Memory object.
   * Vector is fetched separately when needed; pass it in if available.
   */
  private rowToMemory(
    row: Record<string, unknown>,
    embedding: number[] = [],
  ): Memory {
    return {
      id: row.id as string,
      content: row.content as string,
      embedding,
      metadata: safeParseJsonObject(row.metadata),
      createdAt: new Date(row.created_at as number),
      updatedAt: new Date(row.updated_at as number),
      supersededBy: (row.superseded_by as string) ?? null,
      usefulness: (row.usefulness as number) ?? 0,
      accessCount: (row.access_count as number) ?? 0,
      lastAccessed:
        row.last_accessed != null
          ? new Date(row.last_accessed as number)
          : null,
    };
  }

  /**
   * Fetch the embedding vector for a memory id from the vec0 table.
   */
  private getEmbedding(id: string): number[] {
    const row = this.db
      .prepare("SELECT vector FROM memories_vec WHERE id = ?")
      .get(id) as { vector: Buffer } | null;
    return row ? deserializeVector(row.vector) : [];
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async insert(memory: Memory): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.content,
          JSON.stringify(memory.metadata),
          memory.createdAt.getTime(),
          memory.updatedAt.getTime(),
          memory.supersededBy,
          memory.usefulness,
          memory.accessCount,
          memory.lastAccessed?.getTime() ?? null,
        );

      this.db
        .prepare("INSERT INTO memories_vec (id, vector) VALUES (?, ?)")
        .run(memory.id, serializeVector(memory.embedding));

      this.db
        .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
        .run(memory.id, memory.content);
    });

    tx();
  }

  async upsert(memory: Memory): Promise<void> {
    const tx = this.db.transaction(() => {
      // Main table supports INSERT OR REPLACE
      this.db
        .prepare(
          `INSERT OR REPLACE INTO memories (id, content, metadata, created_at, updated_at, superseded_by, usefulness, access_count, last_accessed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.content,
          JSON.stringify(memory.metadata),
          memory.createdAt.getTime(),
          memory.updatedAt.getTime(),
          memory.supersededBy,
          memory.usefulness,
          memory.accessCount,
          memory.lastAccessed?.getTime() ?? null,
        );

      // vec0 virtual tables don't support REPLACE — delete then insert
      this.db.prepare("DELETE FROM memories_vec WHERE id = ?").run(memory.id);
      this.db
        .prepare("INSERT INTO memories_vec (id, vector) VALUES (?, ?)")
        .run(memory.id, serializeVector(memory.embedding));

      // fts5 virtual tables don't support REPLACE — delete then insert
      this.db.prepare("DELETE FROM memories_fts WHERE id = ?").run(memory.id);
      this.db
        .prepare("INSERT INTO memories_fts (id, content) VALUES (?, ?)")
        .run(memory.id, memory.content);
    });

    tx();
  }

  async findById(id: string): Promise<Memory | null> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as Record<string, unknown> | null;

    if (!row) return null;

    const embedding = this.getEmbedding(id);
    return this.rowToMemory(row, embedding);
  }

  async findByIds(ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const embedding = this.getEmbedding(row.id as string);
      return this.rowToMemory(row, embedding);
    });
  }

  async markDeleted(id: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?",
      )
      .run(DELETED_TOMBSTONE, Date.now(), id);

    return result.changes > 0;
  }

  /**
   * Hybrid search combining vector KNN and FTS5, fused with Reciprocal Rank Fusion.
   */
  async findHybrid(
    embedding: number[],
    query: string,
    limit: number,
  ): Promise<HybridRow[]> {
    const candidateLimit = limit * 3;
    const vecBuf = serializeVector(embedding);

    // Vector KNN search
    const vectorResults = this.db
      .prepare(
        "SELECT id, distance FROM memories_vec WHERE vector MATCH ? AND k = ? ORDER BY distance",
      )
      .all(vecBuf, candidateLimit) as Array<{ id: string; distance: number }>;

    // Full-text search
    const ftsQuery = sanitizeFtsQuery(query);
    const ftsResults = this.db
      .prepare(
        "SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?",
      )
      .all(ftsQuery, candidateLimit) as Array<{ id: string }>;

    // Compute RRF scores and pick top ids
    const rrfScores = hybridRRF(vectorResults, ftsResults);
    const topIds = topByRRF(rrfScores, limit);

    if (topIds.length === 0) return [];

    // Fetch full rows for the winning ids (service layer handles deleted filtering)
    const placeholders = topIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE id IN (${placeholders})`,
      )
      .all(...topIds) as Array<Record<string, unknown>>;

    // Build a lookup for quick access
    const rowMap = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      rowMap.set(row.id as string, row);
    }

    // Return results in RRF-ranked order, skipping any that were deleted
    const results: HybridRow[] = [];
    for (const id of topIds) {
      const row = rowMap.get(id);
      if (!row) continue; // deleted or missing

      const memEmbedding = this.getEmbedding(id);
      const memory = this.rowToMemory(row, memEmbedding);
      results.push({
        ...memory,
        rrfScore: rrfScores.get(id) ?? 0,
      });
    }

    return results;
  }
}
