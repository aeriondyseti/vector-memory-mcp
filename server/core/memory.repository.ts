import type { Database } from "bun:sqlite";
import {
  serializeVector,
  deserializeVector,
  safeParseJsonObject,
  sanitizeFtsQuery,
  hybridRRFWithSignals,
  topByRRF,
  knnSearch,
  batchedQuery,
  SQLITE_BATCH_SIZE,
} from "./sqlite-utils";
import {
  type Memory,
  type HybridRow,
  DELETED_TOMBSTONE,
} from "./memory";

export class MemoryRepository {
  constructor(private db: Database) {}

  getDb(): Database {
    return this.db;
  }

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
      project: (row.project as string) ?? null,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      confidence: (row.confidence as Memory["confidence"]) ?? null,
      importance: (row.importance as Memory["importance"]) ?? null,
      expiresAt:
        row.expires_at != null ? new Date(row.expires_at as number) : null,
      qualityScore:
        row.quality_score != null ? (row.quality_score as number) : null,
      episodeId: (row.episode_id as string) ?? null,
      sequenceNumber:
        row.sequence_number != null ? (row.sequence_number as number) : null,
      precedingMemoryId: (row.preceding_memory_id as string) ?? null,
    };
  }

  /**
   * Fetch the embedding vector for a memory id.
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

  /** Column names for the memories table, in insert order. */
  private static readonly MEMORY_COLUMNS =
    "id, content, metadata, created_at, updated_at, superseded_by, usefulness, " +
    "access_count, last_accessed, project, pinned, archived, confidence, " +
    "importance, expires_at, quality_score, episode_id, sequence_number, " +
    "preceding_memory_id";

  private static readonly MEMORY_PLACEHOLDERS =
    MemoryRepository.MEMORY_COLUMNS.split(",").map(() => "?").join(", ");

  /** Bound values for the memories table, matching MEMORY_COLUMNS order. */
  private static memoryValues(memory: Memory): Array<string | number | null> {
    return [
      memory.id,
      memory.content,
      JSON.stringify(memory.metadata),
      memory.createdAt.getTime(),
      memory.updatedAt.getTime(),
      memory.supersededBy,
      memory.usefulness,
      memory.accessCount,
      memory.lastAccessed?.getTime() ?? null,
      memory.project,
      memory.pinned ? 1 : 0,
      memory.archived ? 1 : 0,
      memory.confidence ?? null,
      memory.importance ?? null,
      memory.expiresAt?.getTime() ?? null,
      memory.qualityScore ?? null,
      memory.episodeId ?? null,
      memory.sequenceNumber ?? null,
      memory.precedingMemoryId ?? null,
    ];
  }

  async insert(memory: Memory): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO memories (${MemoryRepository.MEMORY_COLUMNS})
           VALUES (${MemoryRepository.MEMORY_PLACEHOLDERS})`,
        )
        .run(...MemoryRepository.memoryValues(memory));

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
          `INSERT OR REPLACE INTO memories (${MemoryRepository.MEMORY_COLUMNS})
           VALUES (${MemoryRepository.MEMORY_PLACEHOLDERS})`,
        )
        .run(...MemoryRepository.memoryValues(memory));

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

    return batchedQuery(this.db, ids, (batch) => {
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
        .all(...batch) as Array<Record<string, unknown>>;

      return rows.map((row) => {
        const embedding = this.getEmbedding(row.id as string);
        return this.rowToMemory(row, embedding);
      });
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
   * Fetch memories matching optional filters, WITHOUT loading embeddings
   * (callers here — deletion planning, stale detection, tag search — don't
   * need vectors). Ordered by `created_at` descending.
   */
  queryMemories(opts?: {
    after?: Date;
    before?: Date;
    project?: string;
    includeDeleted?: boolean;
    includeArchived?: boolean;
    lastAccessedBefore?: Date;
    limit?: number;
    offset?: number;
  }): Memory[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (!opts?.includeDeleted) {
      conditions.push("superseded_by IS NOT ?");
      params.push(DELETED_TOMBSTONE);
    }
    if (!opts?.includeArchived) conditions.push("archived = 0");
    if (opts?.after) {
      conditions.push("created_at > ?");
      params.push(opts.after.getTime());
    }
    if (opts?.before) {
      conditions.push("created_at < ?");
      params.push(opts.before.getTime());
    }
    if (opts?.project) {
      conditions.push("project = ?");
      params.push(opts.project);
    }
    if (opts?.lastAccessedBefore) {
      // Treat never-accessed rows by created_at for staleness.
      conditions.push("COALESCE(last_accessed, created_at) < ?");
      params.push(opts.lastAccessedBefore.getTime());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit != null ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : "";
    const offset = opts?.offset != null ? ` OFFSET ${Math.max(0, Math.floor(opts.offset))}` : "";

    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC${limit}${offset}`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToMemory(row));
  }

  /** Mark multiple memories deleted in one transaction. Returns count changed. */
  markDeletedBulk(ids: string[]): number {
    if (ids.length === 0) return 0;
    const now = Date.now();
    let changed = 0;
    const stmt = this.db.prepare(
      "UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NOT ?",
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        changed += stmt.run(DELETED_TOMBSTONE, now, id, DELETED_TOMBSTONE).changes;
      }
    });
    tx();
    return changed;
  }

  /** Set the archived flag on multiple memories in one transaction. */
  setArchivedBulk(ids: string[], archived: boolean): number {
    if (ids.length === 0) return 0;
    const now = Date.now();
    let changed = 0;
    const stmt = this.db.prepare(
      "UPDATE memories SET archived = ?, updated_at = ? WHERE id = ? AND superseded_by IS NOT ?",
    );
    const tx = this.db.transaction(() => {
      for (const id of ids) {
        changed += stmt.run(archived ? 1 : 0, now, id, DELETED_TOMBSTONE).changes;
      }
    });
    tx();
    return changed;
  }

  /** IDs of live (non-deleted) memories whose TTL has passed as of `now`. */
  findExpiredIds(now: number = Date.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM memories
         WHERE expires_at IS NOT NULL AND expires_at <= ?
           AND superseded_by IS NOT ?`,
      )
      .all(now, DELETED_TOMBSTONE) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Aggregate health counters over the memories table. */
  healthStats(now: number = Date.now()): {
    total: number;
    live: number;
    deleted: number;
    archived: number;
    pinned: number;
    expired: number;
    avgUsefulness: number;
    totalAccessCount: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN superseded_by IS ? THEN 1 ELSE 0 END) AS deleted,
           SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
           SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned,
           SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
           AVG(usefulness) AS avg_usefulness,
           SUM(access_count) AS total_access
         FROM memories`,
      )
      .get(DELETED_TOMBSTONE, now) as {
      total: number;
      deleted: number | null;
      archived: number | null;
      pinned: number | null;
      expired: number | null;
      avg_usefulness: number | null;
      total_access: number | null;
    };

    const deleted = row.deleted ?? 0;
    return {
      total: row.total,
      live: row.total - deleted,
      deleted,
      archived: row.archived ?? 0,
      pinned: row.pinned ?? 0,
      expired: row.expired ?? 0,
      avgUsefulness: row.avg_usefulness ?? 0,
      totalAccessCount: row.total_access ?? 0,
    };
  }

  /**
   * Increment access_count and update last_accessed for multiple memories in batch.
   * Uses batched IN clauses to stay within SQLite parameter limits.
   */
  bulkUpdateAccess(ids: string[], now: Date): void {
    if (ids.length === 0) return;
    const ts = now.getTime();

    const runBatch = (batch: string[]) => {
      const placeholders = batch.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id IN (${placeholders})`
        )
        .run(ts, ...batch);
    };

    for (let i = 0; i < ids.length; i += SQLITE_BATCH_SIZE) {
      runBatch(ids.slice(i, i + SQLITE_BATCH_SIZE));
    }
  }

  /**
   * Hybrid search combining vector KNN and FTS5, fused with Reciprocal Rank Fusion.
   *
   * The project filter is applied PRE-candidate-selection (pushed into both
   * the KNN scan and the FTS query) so project-scoped searches rank within
   * the project's own corpus — post-filtering a global top-K would return
   * false-empty results for small projects in a large shared database.
   *
   * Date filters remain post-RRF on the final row fetch, so date-filtered
   * queries may return fewer than `limit` results. Archived and expired (TTL)
   * memories are excluded by the same post-RRF WHERE unless opted in.
   */
  async findHybrid(
    embedding: number[],
    query: string,
    limit: number,
    filters?: {
      after?: Date;
      before?: Date;
      project?: string;
      includeArchived?: boolean;
      includeExpired?: boolean;
      now?: number;
      /** "semantic" (default) / "hybrid" use vector+FTS; "exact" uses FTS only. */
      mode?: "semantic" | "exact" | "hybrid";
    },
  ): Promise<HybridRow[]> {
    const candidateLimit = limit * 5;
    const project = filters?.project;

    // Vector KNN search (brute-force cosine similarity in JS), pre-filtered
    // by project when scoped. Skipped entirely in "exact" mode (FTS-only).
    const vectorResults =
      filters?.mode === "exact"
        ? []
        : knnSearch(
            this.db,
            "memories_vec",
            embedding,
            candidateLimit,
            project !== undefined
              ? {
                  sql: `SELECT v.id, v.vector FROM memories_vec v
                  JOIN memories m ON v.id = m.id WHERE m.project = ?`,
                  params: [project],
                }
              : undefined,
          );

    // Full-text search, pre-filtered by project when scoped
    const ftsQuery = sanitizeFtsQuery(query);
    const ftsResults: Array<{ id: string }> = ftsQuery
      ? project !== undefined
        ? (this.db
            .prepare(
              `SELECT memories_fts.id FROM memories_fts
               JOIN memories m ON memories_fts.id = m.id
               WHERE memories_fts MATCH ? AND m.project = ? LIMIT ?`,
            )
            .all(ftsQuery, project, candidateLimit) as Array<{ id: string }>)
        : (this.db
            .prepare(
              "SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?",
            )
            .all(ftsQuery, candidateLimit) as Array<{ id: string }>)
      : [];

    // Compute RRF scores with search signals for confidence scoring
    const signalsMap = hybridRRFWithSignals(vectorResults, ftsResults);
    const rrfScores = new Map<string, number>();
    for (const [id, s] of signalsMap) rrfScores.set(id, s.rrfScore);
    const topIds = topByRRF(rrfScores, limit);

    if (topIds.length === 0) return [];

    // Fetch full rows for the winning ids, applying date filters if present
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    const placeholders = topIds.map(() => "?").join(", ");
    conditions.push(`id IN (${placeholders})`);
    params.push(...topIds);

    if (filters?.after) {
      conditions.push("created_at > ?");
      params.push(filters.after.getTime());
    }
    if (filters?.before) {
      conditions.push("created_at < ?");
      params.push(filters.before.getTime());
    }
    if (!filters?.includeArchived) {
      conditions.push("archived = 0");
    }
    if (!filters?.includeExpired) {
      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(filters?.now ?? Date.now());
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE ${conditions.join(" AND ")}`,
      )
      .all(...params) as Array<Record<string, unknown>>;

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
      const signals = signalsMap.get(id)!;
      results.push({
        ...memory,
        rrfScore: signals.rrfScore,
        signals: {
          cosineSimilarity: signals.cosineSimilarity,
          ftsMatch: signals.ftsMatch,
          knnRank: signals.knnRank,
          ftsRank: signals.ftsRank,
        },
      });
    }

    return results;
  }
}
