import type { Database } from "bun:sqlite";
import {
  serializeVector,
  deserializeVector,
  safeParseJsonObject,
  sanitizeFtsQuery,
  hybridRRFWithSignals,
  topByRRF,
  knnSearch,
  cosineSimilarity,
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

  /**
   * Update ONLY the metadata JSON for many memories in one transaction,
   * leaving content, vectors, and FTS untouched. Used by tag management where
   * only metadata.tags changes (re-embedding would be wasteful and lossy given
   * callers here don't carry the embedding).
   */
  setMetadataBulk(entries: Array<{ id: string; metadata: Record<string, unknown> }>): number {
    if (entries.length === 0) return 0;
    const now = Date.now();
    let changed = 0;
    const stmt = this.db.prepare(
      "UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const e of entries) {
        changed += stmt.run(JSON.stringify(e.metadata), now, e.id).changes;
      }
    });
    tx();
    return changed;
  }

  /** Set quality_score for many memories in one transaction. */
  setQualityScoreBulk(entries: Array<{ id: string; score: number }>): number {
    if (entries.length === 0) return 0;
    let changed = 0;
    const stmt = this.db.prepare(
      "UPDATE memories SET quality_score = ? WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const e of entries) changed += stmt.run(e.score, e.id).changes;
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

  /** Memories in an episode, ordered by sequence_number then created_at. */
  findByEpisode(episodeId: string): Memory[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE episode_id = ? AND superseded_by IS NOT ?
         ORDER BY COALESCE(sequence_number, 0) ASC, created_at ASC`,
      )
      .all(episodeId, DELETED_TOMBSTONE) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMemory(row));
  }

  /** Distinct episode ids with member counts, most-recent first. */
  listEpisodes(limit: number, offset: number): Array<{
    episodeId: string;
    count: number;
    lastCreatedAt: Date;
  }> {
    const rows = this.db
      .prepare(
        `SELECT episode_id AS id, COUNT(*) AS count, MAX(created_at) AS last
         FROM memories
         WHERE episode_id IS NOT NULL AND superseded_by IS NOT ?
         GROUP BY episode_id
         ORDER BY last DESC
         LIMIT ? OFFSET ?`,
      )
      .all(DELETED_TOMBSTONE, limit, offset) as Array<{
      id: string;
      count: number;
      last: number;
    }>;
    return rows.map((r) => ({
      episodeId: r.id,
      count: r.count,
      lastCreatedAt: new Date(r.last),
    }));
  }

  /**
   * Cosine similarity of each of `otherIds` to memory `id`, from the stored
   * vectors; an id without a vector is left out.
   */
  similaritiesTo(id: string, otherIds: string[]): Map<string, number> {
    const base = this.getEmbedding(id);
    const result = new Map<string, number>();
    if (base.length === 0) return result;
    const bv = new Float32Array(base);
    for (const other of otherIds) {
      const v = this.getEmbedding(other);
      if (v.length > 0) result.set(other, cosineSimilarity(bv, new Float32Array(v)));
    }
    return result;
  }

  /**
   * The `k` live memories of `project` most similar to `embedding`, for the
   * write-time duplicate check: not superseded or deleted, not archived, not
   * waypoints. `project` null matches memories filed under no project.
   */
  findNearestLive(
    embedding: number[],
    project: string | null,
    k: number,
  ): Array<{ id: string; similarity: number }> {
    return knnSearch(this.db, "memories_vec", embedding, k, {
      sql: `SELECT v.id, v.vector FROM memories_vec v JOIN memories m ON v.id = m.id
            WHERE ${project === null ? "m.project IS NULL" : "m.project = ?"}
              AND m.superseded_by IS NULL AND m.archived = 0
              AND json_extract(m.metadata, '$.type') IS NOT 'waypoint'
              AND json_extract(m.metadata, '$.status') IS NOT 'resolved'`,
      params: project === null ? [] : [project],
    }).map((r) => ({ id: r.id, similarity: 1 - r.distance }));
  }

  /**
   * Mark every live memory of `project` carrying superseding `key` — other
   * than `newId` — as superseded by `newId`. Returns the ids replaced.
   */
  supersedeByKey(project: string | null, key: string, newId: string): string[] {
    const projectCondition = project === null ? "project IS NULL" : "project = ?";
    const params = project === null ? [key, newId] : [project, key, newId];
    const ids = (
      this.db
        .prepare(
          `SELECT id FROM memories
           WHERE ${projectCondition} AND json_extract(metadata, '$.key') = ?
             AND superseded_by IS NULL AND id != ?`,
        )
        .all(...params) as Array<{ id: string }>
    ).map((r) => r.id);

    const stmt = this.db.prepare(
      "UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?",
    );
    const now = Date.now();
    for (const id of ids) stmt.run(newId, now, id);
    return ids;
  }

  /**
   * Find near-duplicate clusters via pairwise cosine similarity over the
   * vector table (Feature 14). Brute-force O(n²) — acceptable for a personal
   * store (<10K rows); larger stores should sample or use ANN. Returns groups
   * of ≥2 memory ids whose vectors exceed `threshold`, keeping the newest as
   * the suggested survivor. Live memories only: superseded versions are
   * history, not duplicates.
   */
  findDuplicateClusters(threshold: number): Array<{ keepId: string; duplicateIds: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT v.id AS id, v.vector AS vector, m.created_at AS created_at
         FROM memories_vec v JOIN memories m ON v.id = m.id
         WHERE m.superseded_by IS NULL AND m.archived = 0
           AND json_extract(m.metadata, '$.type') IS NOT 'waypoint'`,
      )
      .all() as Array<{
      id: string;
      vector: Buffer;
      created_at: number;
    }>;

    const vecs = rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      vec: new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4),
    }));

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== undefined && parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      return root;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const v of vecs) parent.set(v.id, v.id);

    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        let dot = 0;
        const a = vecs[i].vec;
        const b = vecs[j].vec;
        const n = Math.min(a.length, b.length);
        for (let k = 0; k < n; k++) dot += a[k] * b[k];
        if (dot >= threshold) union(vecs[i].id, vecs[j].id);
      }
    }

    const groups = new Map<string, Array<{ id: string; createdAt: number }>>();
    for (const v of vecs) {
      const root = find(v.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push({ id: v.id, createdAt: v.createdAt });
    }

    const clusters: Array<{ keepId: string; duplicateIds: string[] }> = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => b.createdAt - a.createdAt); // newest first
      clusters.push({
        keepId: members[0].id,
        duplicateIds: members.slice(1).map((m) => m.id),
      });
    }
    return clusters;
  }

  /** All distinct tags (from metadata.tags) with usage counts, over live rows. */
  tagCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT metadata FROM memories WHERE superseded_by IS NOT ?`,
      )
      .all(DELETED_TOMBSTONE) as Array<{ metadata: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) {
      const meta = safeParseJsonObject(row.metadata);
      const tags = meta.tags;
      if (!Array.isArray(tags)) continue;
      for (const t of tags) {
        if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return counts;
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
