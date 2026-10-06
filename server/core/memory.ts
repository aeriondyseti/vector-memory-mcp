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

// ── Lifecycle per kind of memory ────────────────────────────────────
//
//  - cumulative (default): every entry is kept; repeats are caught at write.
//  - superseding: a memory carrying `metadata.key` (a short slot name such as
//    "current-goal" or "preferred-editor") replaces the live memory with the
//    same key in the same project, which stays as history (superseded_by).
//  - open until resolved: the kinds below carry `metadata.status` "open"
//    (the default) or "resolved"; resolved ones are kept as history but drop
//    out of default recall.

/** Memory types that stay open until resolved. */
export const OPEN_UNTIL_RESOLVED_TYPES: ReadonlySet<string> = new Set(["task", "next-step", "blocker"]);

export const MEMORY_STATUSES = ["open", "resolved"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Whether memories of this metadata's type are open until resolved. */
export function isOpenUntilResolvedType(metadata: Record<string, unknown>): boolean {
  return typeof metadata.type === "string" && OPEN_UNTIL_RESOLVED_TYPES.has(metadata.type);
}

/** The memory's status, or null for kinds without one. */
export function memoryStatus(metadata: Record<string, unknown>): MemoryStatus | null {
  if (metadata.status === "open" || metadata.status === "resolved") return metadata.status;
  return isOpenUntilResolvedType(metadata) ? "open" : null;
}

export function isResolved(memory: Pick<Memory, "metadata">): boolean {
  return memoryStatus(memory.metadata) === "resolved";
}

/** The memory's superseding key (trimmed), or null when it has none. */
export function memoryKey(metadata: Record<string, unknown>): string | null {
  return typeof metadata.key === "string" && metadata.key.trim() !== "" ? metadata.key.trim() : null;
}

/** Replaced by a newer memory (not deleted: that is the tombstone). */
export function isSuperseded(memory: Pick<Memory, "supersededBy">): boolean {
  return memory.supersededBy !== null && memory.supersededBy !== DELETED_TOMBSTONE;
}

/** Validate a caller-supplied status. */
export function coerceStatus(value: unknown): MemoryStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (MEMORY_STATUSES as readonly string[]).includes(value)) {
    return value as MemoryStatus;
  }
  throw new Error(`status must be one of: ${MEMORY_STATUSES.join(", ")}`);
}

/**
 * Metadata as a write stores it: an open-until-resolved kind without a
 * status starts "open"; a key is trimmed.
 */
export function withLifecycleDefaults(metadata: Record<string, unknown>): Record<string, unknown> {
  const key = memoryKey(metadata);
  const next = { ...metadata };
  if (key !== null) next.key = key;
  else delete next.key;
  if (isOpenUntilResolvedType(next) && next.status === undefined) next.status = "open";
  return next;
}

/** Rank map for importance level comparisons (higher = more important). */
export const IMPORTANCE_RANK: Record<MemoryImportance, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/** Rank map for confidence level comparisons (higher = more confident). */
export const CONFIDENCE_RANK: Record<MemoryConfidence, number> = {
  uncertain: 0,
  likely: 1,
  confirmed: 2,
  verified: 3,
};

/**
 * Settable extended attributes for a memory. Every field is optional; an
 * omitted field leaves the existing value unchanged on update, or the column
 * default on store. `null` explicitly clears a nullable attribute.
 */
export interface MemoryAttributes {
  pinned?: boolean;
  archived?: boolean;
  confidence?: MemoryConfidence | null;
  importance?: MemoryImportance | null;
  expiresAt?: Date | null;
  episodeId?: string | null;
  sequenceNumber?: number | null;
  precedingMemoryId?: string | null;
}

/**
 * Validate and coerce a caller-supplied confidence level. Throws on an
 * unrecognized non-null value so bad input surfaces at the tool boundary.
 */
export function coerceConfidence(value: unknown): MemoryConfidence | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && (MEMORY_CONFIDENCE_LEVELS as readonly string[]).includes(value)) {
    return value as MemoryConfidence;
  }
  throw new Error(
    `confidence must be one of: ${MEMORY_CONFIDENCE_LEVELS.join(", ")}`,
  );
}

/** Validate and coerce a caller-supplied importance level. */
export function coerceImportance(value: unknown): MemoryImportance | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && (MEMORY_IMPORTANCE_LEVELS as readonly string[]).includes(value)) {
    return value as MemoryImportance;
  }
  throw new Error(
    `importance must be one of: ${MEMORY_IMPORTANCE_LEVELS.join(", ")}`,
  );
}

/** True when a memory is expired as of `now` (has a TTL that has passed). */
export function isExpired(memory: Memory, now: Date = new Date()): boolean {
  return memory.expiresAt != null && memory.expiresAt.getTime() <= now.getTime();
}

/**
 * True when a memory is protected from deletion/cleanup: pinned, or of
 * `critical` importance (which implies pin-protection per roadmap Feature 9).
 */
export function isProtected(memory: Memory): boolean {
  return Boolean(memory.pinned) || memory.importance === "critical";
}

const sigmoid01 = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Derive a 0.0–1.0 quality score (Feature 15) from a memory's signals:
 * usefulness feedback, access frequency relative to age, recency decay, and
 * bonuses for its formal type (Feature 21) and importance. Pure and
 * deterministic given `now`, so it can be recomputed on demand.
 */
export function computeQualityScore(memory: Memory, now: Date = new Date()): number {
  const created = memory.createdAt.getTime();
  const ageDays = Math.max(1, (now.getTime() - created) / (24 * 60 * 60 * 1000));

  // Usefulness feedback (votes), squashed to [0,1].
  const usefulnessSignal = sigmoid01(memory.usefulness / 3);

  // Access frequency normalized by age (accesses per day).
  const accessesPerDay = memory.accessCount / ageDays;
  const frequencySignal = sigmoid01(accessesPerDay - 1);

  // Recency: decays with time since last access.
  const lastAccessed = (memory.lastAccessed ?? memory.createdAt).getTime();
  const daysSinceAccess = Math.max(0, (now.getTime() - lastAccessed) / (24 * 60 * 60 * 1000));
  const recencySignal = Math.pow(0.98, daysSinceAccess);

  const typeBonus = MEMORY_TYPE_BONUS[(memory.metadata.type as string) ?? ""] ?? 0;
  const importanceBonus = memory.importance
    ? (IMPORTANCE_RANK[memory.importance] / 3) * 0.2
    : 0.05;

  const base =
    0.4 * usefulnessSignal + 0.25 * frequencySignal + 0.15 * recencySignal;
  return Math.max(0, Math.min(1, base + typeBonus * 0.5 + importanceBonus));
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
