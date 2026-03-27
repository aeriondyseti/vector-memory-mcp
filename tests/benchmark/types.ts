/**
 * Search Quality Benchmark Types
 *
 * Defines the ground truth dataset structure and result types for
 * measuring vector search retrieval quality.
 */

/**
 * A memory in the ground truth dataset with a stable ID for reference.
 */
export interface GroundTruthMemory {
  /** Stable ID for referencing in queries (e.g., "lore-001") */
  id: string;
  /** The memory content to store */
  content: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Domain category for grouping (e.g., "lore", "design", "factual") */
  domain?: string;
}

/**
 * Query categories for organizing test cases by semantic challenge type.
 */
export type QueryCategory =
  | "exact_match" // Query contains exact key terms from memory
  | "semantic" // Paraphrased/synonymous queries
  | "related_concept" // Related domain concepts
  | "negative" // Should NOT match corpus (out-of-domain)
  | "edge_case"; // Special chars, very short/long, etc.

/**
 * A query with expected relevant results for benchmarking.
 */
export interface GroundTruthQuery {
  /** Unique query ID (e.g., "q-001") */
  id: string;
  /** The search query text */
  query: string;
  /** IDs of relevant memories, ordered by expected relevance (most relevant first) */
  relevantMemoryIds: string[];
  /** IDs of partially relevant memories (acceptable but not ideal) */
  partiallyRelevantIds?: string[];
  /** Test category for grouping results */
  category: QueryCategory;
}

/**
 * Complete benchmark dataset with memories and queries.
 */
export interface BenchmarkDataset {
  /** Dataset name */
  name: string;
  /** Description of the dataset */
  description: string;
  /** Ground truth memories to store */
  memories: GroundTruthMemory[];
  /** Queries with expected results */
  queries: GroundTruthQuery[];
}

/**
 * Metrics for a single query result.
 */
export interface QueryResult {
  /** Query ID from dataset */
  queryId: string;
  /** Original query text */
  query: string;
  /** Query category */
  category: QueryCategory;
  /** IDs of memories retrieved (in ranked order) */
  retrievedIds: string[];
  /** Expected relevant memory IDs */
  expectedIds: string[];
  /** Precision at k=1 */
  precision1: number;
  /** Precision at k=5 */
  precision5: number;
  /** Recall at k=5 */
  recall5: number;
  /** Reciprocal rank (1/position of first relevant result) */
  reciprocalRank: number;
  /** Normalized Discounted Cumulative Gain at k=5 */
  ndcg5: number;
  /** Average Precision at k=10 (full result list quality) */
  ap10: number;
  /** Whether this query met its category threshold */
  passed: boolean;
}

/**
 * Aggregated metrics for a category or overall.
 */
export interface CategoryMetrics {
  /** Mean Precision@1 */
  meanPrecisionAt1: number;
  /** Mean Precision@5 */
  meanPrecisionAt5: number;
  /** Mean Recall@5 */
  meanRecallAt5: number;
  /** Mean Reciprocal Rank */
  meanReciprocalRank: number;
  /** Mean NDCG@5 */
  meanNDCGAt5: number;
  /** Mean Average Precision@10 */
  meanAP10: number;
  /** Number of queries in this category */
  queryCount: number;
}

/**
 * Complete benchmark results.
 */
export interface BenchmarkResults {
  /** Metrics grouped by query category */
  byCategory: Map<QueryCategory, CategoryMetrics>;
  /** Overall aggregated metrics */
  overall: CategoryMetrics;
  /** Individual query results for debugging */
  queryResults: QueryResult[];
}
