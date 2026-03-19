import type { Database } from "bun:sqlite";

/** RRF constant matching the previous LanceDB reranker default */
export const RRF_K = 60;

/**
 * Serialize a number[] embedding to the raw float32 bytes sqlite-vec expects.
 */
export function serializeVector(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/**
 * Deserialize raw float32 bytes from sqlite-vec back to number[].
 */
export function deserializeVector(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
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
