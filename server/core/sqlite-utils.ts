import type { Database } from "bun:sqlite";

/** RRF constant — lower K gives sharper top-rank discrimination in the 1/(K+rank) formula */
export const RRF_K = 10;

/**
 * Maximum parameters per SQLite query to stay within SQLITE_MAX_VARIABLE_NUMBER.
 */
export const SQLITE_BATCH_SIZE = 100;

/**
 * Execute a query in batches when the number of parameters exceeds SQLITE_BATCH_SIZE.
 * Splits the ids array and concatenates results.
 */
export function batchedQuery<T>(
  db: Database,
  ids: string[],
  queryFn: (batch: string[]) => T[]
): T[] {
  if (ids.length <= SQLITE_BATCH_SIZE) return queryFn(ids);
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += SQLITE_BATCH_SIZE) {
    results.push(...queryFn(ids.slice(i, i + SQLITE_BATCH_SIZE)));
  }
  return results;
}

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
 *
 * `candidates` overrides the candidate query — used to pre-filter the scan
 * (e.g. by project) so filtered searches rank within the filtered set instead
 * of post-filtering a global top-K (which can return false-empty results).
 * The SQL must select `id` and `vector` columns.
 */
type VecTable = "memories_vec" | "conversation_history_vec";

export function knnSearch(
  db: Database,
  table: VecTable,
  queryVec: number[],
  k: number,
  candidates?: { sql: string; params: Array<string | number> },
): Array<{ id: string; distance: number }> {
  const rows = (
    candidates
      ? db.prepare(candidates.sql).all(...candidates.params)
      : db.prepare(`SELECT id, vector FROM ${table}`).all()
  ) as Array<{ id: string; vector: Buffer }>;

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
 * Function and question words dropped from keyword queries: they carry no
 * topic, and as required terms they veto every memory that lacks them
 * ("who", "what do we know about"). Domain-neutral on purpose.
 */
const FTS_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "in", "on", "at", "to", "for",
  "from", "by", "with", "about", "into", "onto", "over", "under", "after", "before", "as", "than",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "doing",
  "have", "has", "had", "having", "i", "me", "my", "we", "us", "our", "you", "your", "he", "him",
  "his", "she", "her", "it", "its", "they", "them", "their", "this", "that", "these", "those",
  "there", "here", "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "can",
  "could", "would", "should", "will", "shall", "may", "might", "must", "not", "no", "any", "all",
  "some", "just", "also", "very", "too", "more", "most", "again", "ever", "know", "tell",
  "remind", "anything", "something", "get", "got",
]);

/**
 * How a keyword query combines its terms: "half" — at least half of the
 * content words, ranked by BM25 (the search lanes) — or "all" — every
 * content word (exact mode).
 *
 * Why half: AND over every word (the old behaviour) matched almost no
 * natural-language question; plain OR let a memory sharing one common word
 * cast a full keyword vote (general benchmark MRR 0.818 → 0.750). Requiring
 * half improved the general benchmark (0.818 → 0.840) and a larger
 * real-world corpus alike.
 */
export type FtsMatch = "half" | "all";

/** "half" spells out every combination of its terms; this bounds them (C(7,4) = 35). */
const MAX_HALF_MATCH_TERMS = 7;

/**
 * Build an FTS5 query from natural language: lowercase words (split on
 * anything that isn't a letter or digit, so "Valerica's" → "valerica"),
 * stop words and duplicates dropped, each term quoted as a literal (no FTS5
 * syntax gets through). A query of only stop words keeps its words rather
 * than matching nothing. Returns null when no term is left: skip the lane.
 *
 * "half" is written as an OR of AND-groups — FTS5 has no "at least k of n":
 * the longest (most specific) MAX_HALF_MATCH_TERMS terms are kept, and each
 * group holds ceil(n / 2) of them (n = all content words, capped at the
 * terms kept). One or two terms simply OR.
 */
export function buildFtsQuery(query: string, match: FtsMatch = "half"): string | null {
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter(
    (w) => w.length > 1 || /\p{N}/u.test(w),
  );
  const content = words.filter((w) => !FTS_STOP_WORDS.has(w));
  const terms = content.length > 0 ? content : words;
  if (terms.length === 0) return null;
  const quote = (t: string) => `"${t}"`;
  if (match === "all") return terms.map(quote).join(" ");
  if (terms.length <= 2) return terms.map(quote).join(" OR ");

  const kept = [...terms].sort((a, b) => b.length - a.length).slice(0, MAX_HALF_MATCH_TERMS);
  const need = Math.min(Math.ceil(terms.length / 2), kept.length);
  const groups: string[] = [];
  const choose = (start: number, chosen: string[]) => {
    if (chosen.length === need) {
      groups.push(`(${chosen.map(quote).join(" ")})`);
      return;
    }
    for (let i = start; i < kept.length; i++) choose(i + 1, [...chosen, kept[i]]);
  };
  choose(0, []);
  return groups.join(" OR ");
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

import type { SearchSignals } from "./memory";

/**
 * Compute hybrid RRF scores while preserving per-result search signals
 * (cosine similarity, FTS match, rank positions) for confidence scoring.
 */
export function hybridRRFWithSignals(
  vectorResults: Array<{ id: string; distance: number }>,
  ftsResults: Array<{ id: string }>,
  k: number = RRF_K
): Map<string, SearchSignals & { rrfScore: number }> {
  const knnMap = new Map<string, { similarity: number; rank: number }>();
  vectorResults.forEach((r, i) => {
    knnMap.set(r.id, { similarity: 1 - r.distance, rank: i + 1 });
  });

  const ftsMap = new Map<string, number>();
  ftsResults.forEach((r, i) => {
    ftsMap.set(r.id, i + 1);
  });

  const allIds = new Set([...knnMap.keys(), ...ftsMap.keys()]);
  const results = new Map<string, SearchSignals & { rrfScore: number }>();

  for (const id of allIds) {
    const knn = knnMap.get(id);
    const ftsRank = ftsMap.get(id) ?? null;
    let rrfScore = 0;
    if (knn) rrfScore += 1 / (k + knn.rank);
    if (ftsRank !== null) rrfScore += 1 / (k + ftsRank);

    results.set(id, {
      rrfScore,
      cosineSimilarity: knn?.similarity ?? null,
      ftsMatch: ftsRank !== null,
      knnRank: knn?.rank ?? null,
      ftsRank,
    });
  }

  return results;
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
