import type { Database } from "bun:sqlite";

/** RRF constant matching the previous LanceDB reranker default */
export const RRF_K = 60;

/**
 * Serialize a number[] embedding to raw float32 bytes for BLOB storage.
 */
export function serializeVector(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Deserialize raw float32 bytes back to number[].
 */
export function deserializeVector(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

/**
 * Cosine similarity between two pre-normalized Float32Arrays.
 * Returns dot product (equivalent to cosine sim when vectors are unit-length).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Brute-force KNN search over a vector blob table.
 * Loads all vectors, computes cosine similarity, returns top-K results
 * sorted by descending similarity (ascending distance).
 */
type VecTable = "memories_vec" | "conversation_history_vec";

export function knnSearch(
  db: Database,
  table: VecTable,
  queryVec: number[],
  k: number,
): Array<{ id: string; distance: number }> {
  const rows = db
    .prepare(`SELECT id, vector FROM ${table}`)
    .all() as Array<{ id: string; vector: Buffer }>;

  const qv = new Float32Array(queryVec);
  const scored = rows.map((r) => {
    const vec = new Float32Array(
      r.vector.buffer,
      r.vector.byteOffset,
      r.vector.byteLength / 4,
    );
    const sim = cosineSimilarity(qv, vec);
    // Convert similarity to distance (1 - sim) for consistency with previous API
    return { id: r.id, distance: 1 - sim };
  });

  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
}

/**
 * Sanitize a user query for FTS5 by quoting each token as a literal.
 * Prevents FTS5 syntax errors from special characters like AND, OR, *, etc.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Compute hybrid RRF scores from two ranked result lists.
 * Returns a map of id -> combined RRF score.
 */
export function hybridRRF(
  vectorResults: Array<{ id: string }>,
  ftsResults: Array<{ id: string }>,
  k: number = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();

  vectorResults.forEach((r, i) => {
    const rank = i + 1;
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank));
  });

  ftsResults.forEach((r, i) => {
    const rank = i + 1;
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (k + rank));
  });

  return scores;
}

/**
 * Sort ids by RRF score descending and return top N.
 */
export function topByRRF(scores: Map<string, number>, limit: number): string[] {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

/**
 * Safely parse a JSON string, returning an empty object on failure.
 * Ported from lancedb-utils.ts.
 */
export function safeParseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}
