/**
 * Information Retrieval Metrics
 *
 * Standard metrics for evaluating search quality:
 * - Precision@k: Fraction of top-k results that are relevant
 * - Recall@k: Fraction of relevant items found in top-k
 * - MRR: Mean Reciprocal Rank - average 1/rank of first relevant result
 * - NDCG: Normalized Discounted Cumulative Gain - ranking quality metric
 * - AP: Average Precision - average of precision@k at each relevant hit position
 */

/**
 * Precision@k: What fraction of top-k results are relevant?
 *
 * @param retrieved - IDs of retrieved items in ranked order
 * @param relevant - Set of relevant item IDs
 * @param k - Number of top results to consider
 * @returns Precision value between 0 and 1
 */
export function precisionAtK(
  retrieved: string[],
  relevant: Set<string>,
  k: number
): number {
  if (k <= 0) return 0;
  const topK = retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const relevantInTopK = topK.filter((id) => relevant.has(id)).length;
  return relevantInTopK / topK.length;
}

/**
 * Recall@k: What fraction of relevant items appear in top-k?
 *
 * @param retrieved - IDs of retrieved items in ranked order
 * @param relevant - Set of relevant item IDs
 * @param k - Number of top results to consider
 * @returns Recall value between 0 and 1
 */
export function recallAtK(
  retrieved: string[],
  relevant: Set<string>,
  k: number
): number {
  if (relevant.size === 0) return 1.0; // No relevant items = perfect recall
  if (k <= 0) return 0;
  const topK = retrieved.slice(0, k);
  const relevantInTopK = topK.filter((id) => relevant.has(id)).length;
  return relevantInTopK / relevant.size;
}

/**
 * Reciprocal Rank: 1 / position of first relevant result.
 *
 * @param retrieved - IDs of retrieved items in ranked order
 * @param relevant - Set of relevant item IDs
 * @returns RR value between 0 and 1 (0 if no relevant item found)
 */
export function reciprocalRank(
  retrieved: string[],
  relevant: Set<string>
): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Discounted Cumulative Gain calculation.
 *
 * @param ranked - IDs in ranked order
 * @param relevanceScores - Map of ID to relevance score (higher = more relevant)
 * @returns DCG value
 */
function computeDCG(
  ranked: string[],
  relevanceScores: Map<string, number>
): number {
  return ranked.reduce((sum, id, i) => {
    const rel = relevanceScores.get(id) ?? 0;
    // DCG formula: sum of (2^rel - 1) / log2(i + 2)
    return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
  }, 0);
}

/**
 * Normalized Discounted Cumulative Gain@k.
 *
 * Measures ranking quality considering position - higher relevance items
 * should appear earlier in results.
 *
 * @param retrieved - IDs of retrieved items in ranked order
 * @param relevanceScores - Map of ID to relevance score (e.g., 2=highly relevant, 1=partial)
 * @param k - Number of top results to consider
 * @returns NDCG value between 0 and 1
 */
export function ndcgAtK(
  retrieved: string[],
  relevanceScores: Map<string, number>,
  k: number
): number {
  if (k <= 0) return 0;

  const dcg = computeDCG(retrieved.slice(0, k), relevanceScores);

  // Ideal DCG: sort by relevance and compute
  const idealOrder = [...relevanceScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);
  const idcg = computeDCG(idealOrder, relevanceScores);

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Average Precision: Mean of precision@k at each position where a relevant result appears.
 * Captures ranking quality across the ENTIRE result list, not just the first hit (like MRR).
 *
 * @param retrieved - IDs of retrieved items in ranked order
 * @param relevant - Set of relevant item IDs
 * @param k - Number of top results to consider
 * @returns AP value between 0 and 1
 */
export function averagePrecision(
  retrieved: string[],
  relevant: Set<string>,
  k: number
): number {
  if (relevant.size === 0) return 1.0;
  if (k <= 0) return 0;
  const topK = retrieved.slice(0, k);
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relevant.has(topK[i])) {
      hits++;
      sumPrecision += hits / (i + 1);
    }
  }
  return relevant.size === 0 ? 0 : sumPrecision / relevant.size;
}

/**
 * Build relevance scores map from relevant and partially relevant IDs.
 *
 * @param relevantIds - Primary relevant IDs (score = 2)
 * @param partialIds - Partially relevant IDs (score = 1)
 * @returns Map of ID to relevance score
 */
export function buildRelevanceScores(
  relevantIds: string[],
  partialIds: string[] = []
): Map<string, number> {
  const scores = new Map<string, number>();
  relevantIds.forEach((id) => scores.set(id, 2));
  partialIds.forEach((id) => scores.set(id, 1));
  return scores;
}
