export const DELETED_TOMBSTONE = "DELETED";

export interface Memory {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  supersededBy: string | null;
  usefulness: number;
  accessCount: number;
  lastAccessed: Date | null;
}

export function isDeleted(memory: Memory): boolean {
  return memory.supersededBy === DELETED_TOMBSTONE;
}

export function memoryToDict(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    content: memory.content,
    metadata: memory.metadata,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
    supersededBy: memory.supersededBy,
    usefulness: memory.usefulness,
    accessCount: memory.accessCount,
    lastAccessed: memory.lastAccessed?.toISOString() ?? null,
  };
}

export type SearchIntent = 'continuity' | 'fact_check' | 'frequent' | 'associative' | 'explore';

export interface IntentProfile {
  weights: { relevance: number; recency: number; utility: number };
  jitter: number;
}

/** Signals preserved from the hybrid search pipeline for confidence scoring. */
export interface SearchSignals {
  cosineSimilarity: number | null;
  ftsMatch: boolean;
  knnRank: number | null;
  ftsRank: number | null;
}

/** Augments any entity type with an RRF score from hybrid search. */
export type WithRrfScore<T> = T & { rrfScore: number; signals: SearchSignals };

export type HybridRow = WithRrfScore<Memory>;

/**
 * Compute absolute confidence (0-1) from search signals.
 *
 * Based primarily on cosine similarity (the strongest absolute signal)
 * mapped through a sigmoid with an agreement bonus for dual-path matches.
 * The midpoint and steepness are calibrated for all-MiniLM-L6-v2 embeddings.
 */
const CONFIDENCE_STEEPNESS = 10;
const CONFIDENCE_MIDPOINT = 0.45;
const CONFIDENCE_AGREEMENT_BONUS = 0.10;

export function computeConfidence(signals: SearchSignals): number {
  const sim = signals.cosineSimilarity;

  if (sim === null) {
    // FTS-only result — keyword match but no semantic confirmation
    return signals.ftsMatch ? 0.45 : 0.0;
  }

  // Shifted sigmoid: maps cosine similarity to interpretable confidence
  let confidence = 1 / (1 + Math.exp(-CONFIDENCE_STEEPNESS * (sim - CONFIDENCE_MIDPOINT)));

  // Dual-path agreement bonus: found by both KNN and FTS
  if (signals.ftsMatch) {
    confidence = Math.min(1.0, confidence + CONFIDENCE_AGREEMENT_BONUS);
  }

  return confidence;
}
