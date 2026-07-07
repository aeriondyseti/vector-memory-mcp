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
  /** Canonical project path this memory belongs to (null = untagged/legacy). */
  project: string | null;
  /**
   * Extended attributes (schema v2). Optional at construction — the repository
   * defaults them on write and `rowToMemory` always populates them on read, so
   * a value fetched from the store has these fully resolved.
   */
  /** Pinned memories are protected from deletion/cleanup unless forced. */
  pinned?: boolean;
  /** Archived memories are excluded from search by default. */
  archived?: boolean;
  /** Confidence level: uncertain | likely | confirmed | verified (null = unset). */
  confidence?: MemoryConfidence | null;
  /** Importance level: low | normal | high | critical (null = unset). */
  importance?: MemoryImportance | null;
  /** Auto-expiry timestamp; null = never expires. */
  expiresAt?: Date | null;
  /** Derived quality score (0.0–1.0); null = not yet scored. */
  qualityScore?: number | null;
  /** Episode grouping id for episodic memory chains (null = ungrouped). */
  episodeId?: string | null;
  /** Ordering within an episode (null = unordered). */
  sequenceNumber?: number | null;
  /** Explicit temporal predecessor within an episode (null = none). */
  precedingMemoryId?: string | null;
}

export const MEMORY_CONFIDENCE_LEVELS = [
  "uncertain",
  "likely",
  "confirmed",
  "verified",
] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCE_LEVELS)[number];

export const MEMORY_IMPORTANCE_LEVELS = [
  "low",
  "normal",
  "high",
  "critical",
] as const;
export type MemoryImportance = (typeof MEMORY_IMPORTANCE_LEVELS)[number];

/**
 * Domain-agnostic memory type taxonomy (Feature 21). `metadata.type` is
 * validated against this set on write; the bonus feeds quality scoring.
 */
export const MEMORY_TYPE_BONUS: Record<string, number> = {
  decision: 0.3,
  error: 0.25,
  learning: 0.25,
  discovery: 0.2,
  pattern: 0.2,
  task: 0.15,
  context: 0.1,
  observation: 0.0,
};

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
    project: memory.project,
    pinned: memory.pinned ?? false,
    archived: memory.archived ?? false,
    confidence: memory.confidence ?? null,
    importance: memory.importance ?? null,
    expiresAt: memory.expiresAt?.toISOString() ?? null,
    qualityScore: memory.qualityScore ?? null,
    episodeId: memory.episodeId ?? null,
    sequenceNumber: memory.sequenceNumber ?? null,
    precedingMemoryId: memory.precedingMemoryId ?? null,
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
// Calibrated against all-MiniLM-L6-v2: noise ceiling ~0.25, weak-relevant floor ~0.30
const CONFIDENCE_STEEPNESS = 14;
const CONFIDENCE_MIDPOINT = 0.35;
const CONFIDENCE_AGREEMENT_BONUS = 0.08;

export function computeConfidence(signals: SearchSignals): number {
  const sim = signals.cosineSimilarity;

  if (sim === null) {
    // FTS-only result — keyword match but no semantic confirmation
    return signals.ftsMatch ? 0.40 : 0.0;
  }

  // Shifted sigmoid: maps cosine similarity to interpretable confidence
  let confidence = 1 / (1 + Math.exp(-CONFIDENCE_STEEPNESS * (sim - CONFIDENCE_MIDPOINT)));

  // Dual-path agreement bonus: found by both KNN and FTS
  if (signals.ftsMatch) {
    confidence = Math.min(1.0, confidence + CONFIDENCE_AGREEMENT_BONUS);
  }

  return confidence;
}
