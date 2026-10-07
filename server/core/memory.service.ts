import { randomUUID, createHash } from "crypto";
import { basename } from "path";
import type {
  Memory,
  SearchIntent,
  IntentProfile,
  HybridRow,
  MemoryAttributes,
  MemoryImportance,
  MemoryStatus,
} from "./memory";
import {
  indexedText,
  normalizeContext,
  isDeleted,
  isProtected,
  isResolved,
  isSuperseded,
  memoryKey,
  memoryStatus,
  withLifecycleDefaults,
  computeConfidence,
  computeQualityScore,
  CONFIDENCE_RANK,
  IMPORTANCE_RANK,
} from "./memory";
import type { SearchResult, SearchOptions, HistoryFilters } from "./conversation";
import type { MemoryRepository } from "./memory.repository";
import type { EmbeddingsService } from "./embeddings.service";
import type { ConversationHistoryService } from "./conversation.service";
import type { RerankerService } from "./reranker.service";
import { findTimeRange, parseTimeFocus } from "./time-range";
import { normalizeProject } from "./project";

// Jitter values halved from original (0.02/0.05/0.15) because RRF_K=10 produces
// ~6x more score spread than K=60, amplifying jitter's disruption effect.
const INTENT_PROFILES: Record<SearchIntent, IntentProfile> = {
  continuity: { weights: { relevance: 0.3, recency: 0.5, utility: 0.2 }, jitter: 0.01 },
  fact_check: { weights: { relevance: 0.6, recency: 0.1, utility: 0.3 }, jitter: 0.01 },
  frequent: { weights: { relevance: 0.2, recency: 0.2, utility: 0.6 }, jitter: 0.01 },
  associative: { weights: { relevance: 0.7, recency: 0.1, utility: 0.2 }, jitter: 0.025 },
  explore: { weights: { relevance: 0.4, recency: 0.3, utility: 0.3 }, jitter: 0.08 },
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Fused (RRF) scores as relevance on the 0–1 scale recency and utility use:
 * each divided by the best of the search. Raw RRF scores run ~0.03–0.18, so
 * added to recency and utility (0–1) they decided little — a fresh, weak
 * match outranked an older, exact one whatever the intent's weights said.
 */
function relativeTo(scores: number[]): number[] {
  const best = Math.max(0, ...scores);
  return scores.map((s) => (best > 0 ? s / best : 0));
}

/** Extract a memory's tag list from metadata.tags (tolerant of bad shapes). */
export function memoryTags(metadata: Record<string, unknown>): string[] {
  const raw = metadata.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string");
}

/**
 * Post-retrieval attribute filters that can't be expressed cheaply in SQL
 * (level rank comparisons, metadata.type, tag containment). Returns true when
 * the memory passes every active filter.
 */
function matchesAttributeFilters(
  m: Memory,
  options?: SearchOptions,
): boolean {
  if (!options) return true;

  if (options.minConfidence) {
    const rank = m.confidence ? CONFIDENCE_RANK[m.confidence] : -1;
    if (rank < CONFIDENCE_RANK[options.minConfidence]) return false;
  }
  if (options.minImportance) {
    const rank = m.importance ? IMPORTANCE_RANK[m.importance] : -1;
    if (rank < IMPORTANCE_RANK[options.minImportance]) return false;
  }
  if (options.type) {
    if ((m.metadata.type as string | undefined) !== options.type) return false;
  }
  if (options.tags && options.tags.length > 0) {
    const tags = new Set(memoryTags(m.metadata));
    const match = options.tagMatch ?? "any";
    const has =
      match === "all"
        ? options.tags.every((t) => tags.has(t))
        : options.tags.some((t) => tags.has(t));
    if (!has) return false;
  }
  return true;
}

// Modest same-project ranking boost for scope:"all" searches — same-repo
// memories win ties without hiding cross-project results.
const CURRENT_PROJECT_BOOST = 1.15;

// ── Write-time duplicate check ──────────────────────────────────────
/** Earlier versions shown with a current memory in search results. */
export const MAX_INLINE_HISTORY = 3;

/** Memory candidates the cross-encoder rescores per search (or the page size, if larger). */
export const RERANK_DEPTH = 30;
/**
 * Share of a reranked candidate's relevance from the cross-encoder; the rest
 * is its fused (vector + keyword) score, both spread to 0–1 over the
 * candidates. The cross-encoder alone ranked best on long notes but lost on
 * short conversational memories (it misreads implicit connections); an even
 * blend improved every benchmark set and no category lost.
 */
export const RERANK_BLEND = 0.5;

/**
 * Default confidence proactive_context surfaces a memory at. Confidence is a
 * calibrated probability (computeConfidence): at 0.5 a surfaced memory is
 * more likely relevant than not, and off-topic context surfaces nothing.
 */
export const PROACTIVE_CONFIDENCE_THRESHOLD = 0.5;

// A new memory is a duplicate of an existing one only when both signals
// agree: near-identical embeddings AND near-identical wording. Embeddings
// alone conflate different facts on the same subject ("chose X" / "chose
// Y"); requiring both keeps false positives — lost writes — rare.
export const WRITE_DUPLICATE_SIMILARITY = 0.95;
export const WRITE_DUPLICATE_JACCARD = 0.85;
const WRITE_DUPLICATE_CANDIDATES = 5;

/** Lowercased word tokens of 3+ characters, for lexical comparison. */
export function lexicalTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
}

/** Jaccard similarity of two texts' token sets (1 when both are empty). */
export function tokenJaccard(a: string, b: string): number {
  const ta = lexicalTokens(a);
  const tb = lexicalTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * One near-duplicate cluster as cleanup sees it: the members safe to merge
 * into `keepId` automatically, and the rest with why they need review.
 */
export type DuplicatePlan = {
  keepId: string;
  mergeIds: string[];
  review: Array<{ id: string; reason: string }>;
};

/** What a checked write did: stored (maybe flagged), or skipped as a duplicate. */
export type StoreOutcome =
  | { status: "stored"; memory: Memory; possibleDuplicateOf: string[]; superseded: string[] }
  | { status: "duplicate"; existing: Memory; similarity: number };

export class MemoryService {
  private conversationService: ConversationHistoryService | null = null;
  private reranker: RerankerService | null = null;

  constructor(
    private repository: MemoryRepository,
    private embeddings: EmbeddingsService,
    private project: string | null = null
  ) {}

  getProject(): string | null {
    return this.project;
  }

  setConversationService(service: ConversationHistoryService): void {
    this.conversationService = service;
  }

  /** Rerank search's top memory candidates with this cross-encoder (null: don't). */
  setReranker(reranker: RerankerService | null): void {
    this.reranker = reranker;
  }

  getReranker(): RerankerService | null {
    return this.reranker;
  }

  getConversationService(): ConversationHistoryService | null {
    return this.conversationService;
  }

  getRepository(): MemoryRepository {
    return this.repository;
  }

  getEmbeddings(): EmbeddingsService {
    return this.embeddings;
  }

  async store(
    content: string,
    metadata: Record<string, unknown> = {},
    embeddingText?: string,
    project?: string,
    attributes?: MemoryAttributes
  ): Promise<Memory> {
    const context = normalizeContext(attributes?.context);
    const embedding = await this.embeddings.embed(indexedText(embeddingText ?? content, context));
    return (await this.insertNew(content, metadata, embedding, project, attributes)).memory;
  }

  /**
   * Store a memory unless it duplicates a live one in the same project.
   *
   * Exactly one duplicate (similar embedding AND wording): nothing is stored
   * and the existing memory comes back, so the caller can update it instead.
   * Several: ambiguous — stored, with `metadata.possible_duplicate_of`
   * naming them for review (find_duplicates), never merged on a guess.
   * `checkDuplicates: false` skips the check (store_memories' allow_duplicates).
   */
  async storeUnlessDuplicate(
    content: string,
    metadata: Record<string, unknown> = {},
    embeddingText?: string,
    project?: string,
    attributes?: MemoryAttributes,
    { checkDuplicates = true }: { checkDuplicates?: boolean } = {}
  ): Promise<StoreOutcome> {
    const context = normalizeContext(attributes?.context);
    const embedding = await this.embeddings.embed(indexedText(embeddingText ?? content, context));
    const targetProject = project !== undefined ? normalizeProject(project) : this.project;

    const nearest = !checkDuplicates
      ? []
      : this.repository
          .findNearestLive(embedding, targetProject, WRITE_DUPLICATE_CANDIDATES)
          .filter((n) => n.similarity >= WRITE_DUPLICATE_SIMILARITY);
    const candidates = await this.repository.findByIds(nearest.map((n) => n.id));
    const similarityOf = new Map(nearest.map((n) => [n.id, n.similarity]));
    const duplicates = candidates
      .filter((m) => tokenJaccard(m.content, content) >= WRITE_DUPLICATE_JACCARD)
      .sort((a, b) => (similarityOf.get(b.id) ?? 0) - (similarityOf.get(a.id) ?? 0));

    if (duplicates.length === 1) {
      const existing = duplicates[0];
      return { status: "duplicate", existing, similarity: similarityOf.get(existing.id) ?? 0 };
    }

    const possibleDuplicateOf = duplicates.map((m) => m.id);
    const { memory, superseded } = await this.insertNew(
      content,
      possibleDuplicateOf.length > 0
        ? { ...metadata, possible_duplicate_of: possibleDuplicateOf }
        : metadata,
      embedding,
      project,
      attributes,
    );
    return { status: "stored", memory, possibleDuplicateOf, superseded };
  }

  /**
   * Insert a new memory under its kind's lifecycle (withLifecycleDefaults):
   * a superseding `key` replaces the live memory with that key in the same
   * project, whose ids come back as `superseded`.
   */
  private async insertNew(
    content: string,
    metadata: Record<string, unknown>,
    embedding: number[],
    project?: string,
    attributes?: MemoryAttributes
  ): Promise<{ memory: Memory; superseded: string[] }> {
    const id = randomUUID();
    const now = new Date();

    const memory: Memory = {
      id,
      content,
      embedding,
      metadata: withLifecycleDefaults(metadata),
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      usefulness: 0,
      accessCount: 0,
      lastAccessed: now, // Initialize to createdAt for fair discovery
      project: project !== undefined ? normalizeProject(project) : this.project,
      pinned: attributes?.pinned ?? false,
      archived: attributes?.archived ?? false,
      confidence: attributes?.confidence ?? null,
      importance: attributes?.importance ?? null,
      expiresAt: attributes?.expiresAt ?? null,
      episodeId: attributes?.episodeId ?? null,
      sequenceNumber: attributes?.sequenceNumber ?? null,
      precedingMemoryId: attributes?.precedingMemoryId ?? null,
      context: normalizeContext(attributes?.context),
      occurredAt: attributes?.occurredAt ?? null,
    };
    memory.qualityScore = computeQualityScore(memory, now);

    await this.repository.insert(memory);
    const key = memoryKey(memory.metadata);
    const superseded = key === null ? [] : this.repository.supersedeByKey(memory.project, key, id);
    return { memory, superseded };
  }

  async get(id: string): Promise<Memory | null> {
    const memory = await this.repository.findById(id);
    if (!memory) {
      return null;
    }

    // Track access on explicit get
    const updatedMemory: Memory = {
      ...memory,
      accessCount: memory.accessCount + 1,
      lastAccessed: new Date(),
    };

    await this.repository.upsert(updatedMemory);
    return updatedMemory;
  }

  async getMultiple(ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const memories = await this.repository.findByIds(ids);
    const now = new Date();
    const liveIds = memories.filter((m) => !isDeleted(m)).map((m) => m.id);
    this.repository.bulkUpdateAccess(liveIds, now);
    return memories.filter((m) => !isDeleted(m));
  }

  async delete(id: string): Promise<boolean> {
    return await this.repository.markDeleted(id);
  }

  async update(
    id: string,
    updates: {
      content?: string;
      embeddingText?: string;
      metadata?: Record<string, unknown>;
      attributes?: MemoryAttributes;
      /** Open or resolve the memory (merged into its metadata). */
      status?: MemoryStatus;
    }
  ): Promise<Memory | null> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      return null;
    }

    const newContent = updates.content ?? existing.content;
    let newMetadata = withLifecycleDefaults(updates.metadata ?? existing.metadata);
    if (updates.status !== undefined) {
      newMetadata = { ...newMetadata, status: updates.status };
      if (updates.status === "resolved") newMetadata.resolved_at = new Date().toISOString();
      else delete newMetadata.resolved_at;
    }

    // Merge attributes: an omitted (undefined) field keeps the existing value;
    // an explicit null clears a nullable attribute.
    const attrs = updates.attributes ?? {};
    const pick = <T>(next: T | undefined, prev: T): T =>
      next !== undefined ? next : prev;
    const newContext =
      attrs.context !== undefined ? normalizeContext(attrs.context) : (existing.context ?? null);

    // Regenerate embedding if content, embeddingText or context changed
    let newEmbedding = existing.embedding;
    if (
      updates.content !== undefined ||
      updates.embeddingText !== undefined ||
      newContext !== (existing.context ?? null)
    ) {
      const textToEmbed = updates.embeddingText ?? newContent;
      newEmbedding = await this.embeddings.embed(indexedText(textToEmbed, newContext));
    }

    const updatedMemory: Memory = {
      ...existing,
      content: newContent,
      embedding: newEmbedding,
      metadata: newMetadata,
      updatedAt: new Date(),
      pinned: pick(attrs.pinned, existing.pinned ?? false),
      archived: pick(attrs.archived, existing.archived ?? false),
      confidence: pick(attrs.confidence, existing.confidence ?? null),
      importance: pick(attrs.importance, existing.importance ?? null),
      expiresAt: pick(attrs.expiresAt, existing.expiresAt ?? null),
      episodeId: pick(attrs.episodeId, existing.episodeId ?? null),
      sequenceNumber: pick(attrs.sequenceNumber, existing.sequenceNumber ?? null),
      precedingMemoryId: pick(
        attrs.precedingMemoryId,
        existing.precedingMemoryId ?? null,
      ),
      context: newContext,
      occurredAt: pick(attrs.occurredAt, existing.occurredAt ?? null),
    };

    await this.repository.upsert(updatedMemory);

    // A live memory given a new superseding key replaces the holder of that key.
    const key = memoryKey(newMetadata);
    if (key !== null && key !== memoryKey(existing.metadata) && existing.supersededBy === null) {
      this.repository.supersedeByKey(updatedMemory.project, key, id);
    }
    return updatedMemory;
  }

  async vote(id: string, value: number): Promise<Memory | null> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      return null;
    }

    // Vote also tracks access (explicit utilization signal)
    const now = new Date();
    const updatedMemory: Memory = {
      ...existing,
      usefulness: existing.usefulness + value,
      accessCount: existing.accessCount + 1,
      lastAccessed: now,
      updatedAt: now,
    };
    updatedMemory.qualityScore = computeQualityScore(updatedMemory, now);

    await this.repository.upsert(updatedMemory);
    return updatedMemory;
  }

  /**
   * Rescore the top `depth` candidates with the cross-encoder: blended with
   * their fused score (RERANK_BLEND), it becomes their relevance, re-weighted
   * by the intent like any relevance. Candidates past the depth keep their
   * order, below every reranked one.
   */
  private async rerankCandidates(
    query: string,
    scored: Array<{ candidate: HybridRow; score: number }>,
    depth: number,
    rescore: (candidate: HybridRow, relevance: number) => number,
  ): Promise<Array<{ candidate: HybridRow; score: number; rerankScore?: number }>> {
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    const head = sorted.slice(0, depth);
    if (head.length === 0) return sorted;
    const logits = await this.reranker!.score(
      query,
      head.map(({ candidate }) => indexedText(candidate.content, candidate.context)),
    );
    // Logits spread over the head to 0–1, keeping their order (a sigmoid
    // would flatten every confident match to ~1 and let tie-breaks decide).
    const spread = (xs: number[]) => {
      const lo = Math.min(...xs);
      const range = Math.max(...xs) - lo;
      return xs.map((x) => (range > 0 ? (x - lo) / range : 1));
    };
    const ce = spread(logits);
    const fused = spread(head.map(({ candidate }) => candidate.rrfScore));
    const reranked = head.map(({ candidate }, i) => ({
      candidate,
      score: rescore(candidate, RERANK_BLEND * ce[i]! + (1 - RERANK_BLEND) * fused[i]!),
      rerankScore: logits[i]!,
    }));
    const floor = Math.min(...reranked.map((r) => r.score));
    const below = sorted.slice(depth).map(({ candidate, score }, i) => ({
      candidate,
      score: Math.min(score, floor) * (1 - (i + 1) * 1e-6),
    }));
    return [...reranked, ...below];
  }

  private computeMemoryScore(
    candidate: HybridRow,
    profile: IntentProfile,
    now: Date,
    mode: "semantic" | "exact" | "hybrid",
    /** 0–1: the candidate's fused score relative to the search's best, or its reranked relevance. */
    relevance: number,
  ): number {
    const lastAccessed = candidate.lastAccessed ?? candidate.createdAt;
    const hoursSinceAccess = Math.max(
      0,
      (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60)
    );
    const recency = Math.pow(0.995, hoursSinceAccess);
    const utility = sigmoid(
      (candidate.usefulness + Math.log(candidate.accessCount + 1)) / 5
    );
    const { weights, jitter } = profile;
    let score =
      weights.relevance * relevance +
      weights.recency * recency +
      weights.utility * utility;

    // Hybrid mode blends the intent-based score with stored usefulness so
    // proven-useful memories rank higher than pure semantic similarity would.
    if (mode === "hybrid") {
      const QUALITY_BOOST = 0.4;
      score = score * (1 - QUALITY_BOOST) + utility * QUALITY_BOOST;
    }

    return score * (1 + (Math.random() * 2 - 1) * jitter);
  }

  async search(
    query: string,
    intent: SearchIntent,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const includeDeleted = options?.includeDeleted ?? false;
    // A model trained for retrieval embeds queries with its query prefix;
    // test doubles without embedQuery embed the query as plain text.
    const queryEmbedding = this.embeddings.embedQuery
      ? await this.embeddings.embedQuery(query)
      : await this.embeddings.embed(query);
    const profile = INTENT_PROFILES[intent];
    const now = new Date();
    const offset = Math.min(options?.offset ?? 0, 500);

    const hasConversationService = this.conversationService !== null;
    const historyOnly = (options?.historyOnly ?? false) && hasConversationService;
    const includeHistory =
      (options?.includeHistory ?? true) && hasConversationService;
    const historyWeight =
      options?.historyWeight ??
      this.conversationService?.config.historyWeight ??
      0.75;

    // Widen the candidate pool to account for offset
    const effectiveLimit = offset + limit;

    // Resolve project scope: "all" = no filter (with same-project ranking
    // boost), "project" = current project, anything else = explicit path.
    const scope = options?.scope ?? "all";
    const projectFilter: string | undefined =
      scope === "all"
        ? undefined
        : scope === "project"
          ? (this.project ?? undefined)
          : normalizeProject(scope);

    const hasDateFilters = options?.after || options?.before;
    const mode = options?.mode ?? "semantic";
    // The period the search is about: the caller's focus, else one named in the query.
    const timeRange = options?.during ? parseTimeFocus(options.during, now) : findTimeRange(query, now);
    const memoryFilters = {
      after: options?.after,
      before: options?.before,
      project: projectFilter,
      includeArchived: options?.includeArchived ?? false,
      includeExpired: options?.includeExpired ?? false,
      now: now.getTime(),
      mode,
      useGraph: options?.useGraph ?? false,
      graphWeights: options?.graphWeights,
      timeRange,
    };

    // Merge top-level date filters into history filters so after/before
    // apply uniformly. Explicit history_after/history_before take precedence,
    // as does an explicit historyFilters.project.
    const historyFilters = options?.historyFilters;
    const effectiveHistoryFilters: HistoryFilters | undefined =
      hasDateFilters || projectFilter !== undefined || historyFilters
        ? {
            ...historyFilters,
            after: historyFilters?.after ?? options?.after,
            before: historyFilters?.before ?? options?.before,
            project: historyFilters?.project ?? projectFilter,
          }
        : historyFilters;

    // Same-project boost only applies to unscoped searches
    const boost = (resultProject: string | null): number =>
      scope === "all" && this.project && resultProject === this.project
        ? CURRENT_PROJECT_BOOST
        : 1;

    // Rerank memory candidates with the cross-encoder, when one is set
    // (exact mode is keyword matching: left as ranked).
    const rerank = this.reranker !== null && (options?.rerank ?? true) && mode !== "exact";

    // Run memory + history queries in parallel
    const memoryPromise =
      !historyOnly
        ? this.repository
            .findHybrid(queryEmbedding, query, effectiveLimit * 5, memoryFilters)
            .then(async (candidates) => {
              const live = candidates
                .filter((m) => includeDeleted || !isDeleted(m))
                .filter((m) => includeDeleted || options?.includeSuperseded || !isSuperseded(m))
                .filter((m) => options?.includeResolved || options?.status === "resolved" || !isResolved(m))
                .filter((m) => !options?.status || memoryStatus(m.metadata) === options.status)
                .filter((m) => matchesAttributeFilters(m, options));
              const relevanceOf = relativeTo(live.map((m) => m.rrfScore));
              const kept = live.map((candidate, i) => ({
                candidate,
                score: this.computeMemoryScore(candidate, profile, now, mode, relevanceOf[i]!) * boost(candidate.project),
              }));
              const scored: Array<{ candidate: HybridRow; score: number; rerankScore?: number }> = rerank
                ? await this.rerankCandidates(query, kept, Math.max(RERANK_DEPTH, effectiveLimit), (c, relevance) =>
                    this.computeMemoryScore(c, profile, now, mode, relevance) * boost(c.project),
                  )
                : kept;
              return scored.map(({ candidate, score, rerankScore }) => ({
                  rerankScore,
                  id: candidate.id,
                  content: candidate.content,
                  metadata: candidate.metadata,
                  createdAt: candidate.createdAt,
                  updatedAt: candidate.updatedAt,
                  source: "memory" as const,
                  score,
                  confidence: computeConfidence(candidate.signals, rerankScore),
                  project: candidate.project,
                  supersededBy: candidate.supersededBy,
                  usefulness: candidate.usefulness,
                  accessCount: candidate.accessCount,
                  lastAccessed: candidate.lastAccessed,
                  pinned: candidate.pinned ?? false,
                  importance: candidate.importance ?? null,
                  context: candidate.context ?? null,
                  occurredAt: candidate.occurredAt ?? null,
                  graphDistance: candidate.signals.graphDistance ?? null,
                }));
            })
        : Promise.resolve([] as SearchResult[]);

    const historyPromise =
      includeHistory || historyOnly
        ? this.conversationService!
            .searchHistory(
              query,
              queryEmbedding,
              historyOnly ? effectiveLimit * 5 : effectiveLimit * 3,
              effectiveHistoryFilters
            )
            .then((historyRows) => {
              const relevanceOf = relativeTo(historyRows.map((row) => row.rrfScore));
              return historyRows.map((row, i) => {
                const rowProject = (row.metadata?.project as string) ?? null;
                return {
                  id: row.id,
                  content: row.content,
                  metadata: row.metadata,
                  createdAt: row.createdAt,
                  updatedAt: row.createdAt,
                  source: "conversation_history" as const,
                  score: relevanceOf[i]! * historyWeight * boost(rowProject),
                  confidence: computeConfidence(row.signals),
                  project: rowProject,
                  supersededBy: null,
                  sessionId: (row.metadata?.session_id as string) ?? "",
                  role: (row.metadata?.role as string) ?? "unknown",
                  messageIndexStart: (row.metadata?.message_index_start as number) ?? 0,
                  messageIndexEnd: (row.metadata?.message_index_end as number) ?? 0,
                };
              });
            })
        : Promise.resolve([] as SearchResult[]);

    const [memoryResults, historyResults] = await Promise.all([
      memoryPromise,
      historyPromise,
    ]);

    // Merge and sort by score descending
    const merged = [...memoryResults, ...historyResults];
    merged.sort((a, b) => b.score - a.score);

    const page = merged.slice(offset, offset + limit);
    this.attachHistory(page);
    await this.attachSources(page);
    return page;
  }

  /**
   * Give each synthesis on the page (a memory citing `metadata.sources`) its
   * source ids and how many have since been replaced or deleted — a stale
   * synthesis says so.
   */
  private async attachSources(page: SearchResult[]): Promise<void> {
    const citing = page.filter((r) => r.source === "memory" && Array.isArray(r.metadata?.sources));
    if (citing.length === 0) return;
    const ids = [...new Set(citing.flatMap((r) => (r.metadata.sources as unknown[]).filter((s): s is string => typeof s === "string")))];
    const live = new Set(
      (await this.repository.findByIds(ids)).filter((m) => m.supersededBy === null).map((m) => m.id),
    );
    for (const r of citing) {
      const sourceIds = (r.metadata.sources as unknown[]).filter((s): s is string => typeof s === "string");
      r.sources = { ids: sourceIds, outdated: sourceIds.filter((id) => !live.has(id)).length };
    }
  }

  /**
   * Give each current memory on the page the versions it replaced, newest
   * first (up to MAX_INLINE_HISTORY, following the supersede chain): an
   * agent sees what changed alongside the current value, instead of stale
   * versions competing as separate results. Versions worded like the
   * current one (merged duplicates) are left out.
   */
  private attachHistory(page: SearchResult[]): void {
    const current = page.filter((r) => r.source === "memory" && r.supersededBy === null);
    // Each step: the version replaced by the frontier memory → the result it belongs to.
    let frontier = new Map(current.map((r) => [r.id, r]));
    for (let depth = 0; depth < MAX_INLINE_HISTORY && frontier.size > 0; depth++) {
      const replaced = this.repository.findSupersededBy([...frontier.keys()]);
      const next = new Map<string, SearchResult>();
      for (const [id, result] of frontier) {
        const previous = (replaced.get(id) ?? []).find(
          (m) => tokenJaccard(m.content, result.content) < WRITE_DUPLICATE_JACCARD,
        );
        if (!previous) continue;
        (result.history ??= []).push({
          content: previous.content,
          createdAt: previous.createdAt,
          replacedAt: previous.updatedAt,
        });
        next.set(previous.id, result);
      }
      frontier = next;
    }
  }

  async trackAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.repository.bulkUpdateAccess(ids, new Date());
  }

  /**
   * Flexible deletion (Feature 2): select memories by explicit ids, tag match,
   * and/or creation-date range, then soft-delete them. Pinned and critical
   * memories are protected unless `force` is set. `dryRun` previews the plan
   * without writing. Requires at least one selector to avoid mass deletion.
   */
  async deleteMemories(criteria: {
    ids?: string[];
    tags?: string[];
    tagMatch?: "any" | "all";
    before?: Date;
    after?: Date;
    dryRun?: boolean;
    force?: boolean;
  }): Promise<{
    matched: number;
    deletedIds: string[];
    skippedProtected: string[];
    dryRun: boolean;
  }> {
    const hasSelector =
      (criteria.ids && criteria.ids.length > 0) ||
      (criteria.tags && criteria.tags.length > 0) ||
      criteria.before !== undefined ||
      criteria.after !== undefined;
    if (!hasSelector) {
      throw new Error(
        "delete requires at least one selector: ids, tags, before, or after",
      );
    }

    // Resolve the candidate set.
    let candidates: Memory[];
    if (criteria.ids && criteria.ids.length > 0) {
      candidates = (await this.repository.findByIds(criteria.ids)).filter(
        (m) => !isDeleted(m),
      );
      if (criteria.after)
        candidates = candidates.filter((m) => m.createdAt > criteria.after!);
      if (criteria.before)
        candidates = candidates.filter((m) => m.createdAt < criteria.before!);
    } else {
      candidates = this.repository.queryMemories({
        after: criteria.after,
        before: criteria.before,
        includeArchived: true, // deletion applies to archived too
      });
    }

    // Tag filter.
    if (criteria.tags && criteria.tags.length > 0) {
      const match = criteria.tagMatch ?? "any";
      const wanted = criteria.tags;
      candidates = candidates.filter((m) => {
        const tags = new Set(memoryTags(m.metadata));
        return match === "all"
          ? wanted.every((t) => tags.has(t))
          : wanted.some((t) => tags.has(t));
      });
    }

    // Protection.
    const skippedProtected: string[] = [];
    const toDelete: string[] = [];
    for (const m of candidates) {
      if (!criteria.force && isProtected(m)) {
        skippedProtected.push(m.id);
      } else {
        toDelete.push(m.id);
      }
    }

    if (criteria.dryRun) {
      return {
        matched: candidates.length,
        deletedIds: toDelete,
        skippedProtected,
        dryRun: true,
      };
    }

    this.repository.markDeletedBulk(toDelete);
    return {
      matched: candidates.length,
      deletedIds: toDelete,
      skippedProtected,
      dryRun: false,
    };
  }

  /**
   * Recompute quality_score for every live memory (Feature 15). Returns the
   * number of memories rescored and the resulting score distribution.
   */
  async scoreMemories(now: Date = new Date()): Promise<{
    scored: number;
    averageScore: number;
  }> {
    const memories = this.repository.queryMemories({ includeArchived: true });
    const entries = memories.map((m) => ({
      id: m.id,
      score: computeQualityScore(m, now),
    }));
    this.repository.setQualityScoreBulk(entries);
    const avg =
      entries.length > 0
        ? entries.reduce((s, e) => s + e.score, 0) / entries.length
        : 0;
    return { scored: entries.length, averageScore: avg };
  }

  /**
   * Archive or unarchive memories (Feature 8). Archived memories are excluded
   * from search unless include_archived is set. Returns the count changed.
   */
  async setArchived(ids: string[], archived: boolean): Promise<number> {
    if (ids.length === 0) return 0;
    return this.repository.setArchivedBulk(ids, archived);
  }

  /**
   * Expire memories on demand (Feature 10): soft-delete every live memory whose
   * TTL has passed. Returns the ids that were tombstoned.
   */
  async expireMemories(now: Date = new Date()): Promise<string[]> {
    const ids = this.repository.findExpiredIds(now.getTime());
    if (ids.length > 0) this.repository.markDeletedBulk(ids);
    return ids;
  }

  /**
   * Stale item detection (Feature 13): memories not accessed within
   * `staleDays`, excluding pinned and (optionally) high-importance memories.
   */
  async findStale(opts?: {
    staleDays?: number;
    excludePinned?: boolean;
    excludeImportance?: MemoryImportance[];
    limit?: number;
  }): Promise<Memory[]> {
    const days = opts?.staleDays ?? 90;
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let rows = this.repository.queryMemories({
      lastAccessedBefore: threshold,
      limit: opts?.limit ?? 100,
    });
    if (opts?.excludePinned ?? true) rows = rows.filter((m) => !m.pinned);
    const excl = opts?.excludeImportance;
    if (excl && excl.length > 0) {
      rows = rows.filter((m) => !m.importance || !excl.includes(m.importance));
    }
    return rows;
  }

  /**
   * Tag-based retrieval (Feature 12): memories carrying the given tags,
   * ordered by recency, without a semantic query.
   */
  async searchByTags(
    tags: string[],
    tagMatch: "any" | "all" = "any",
    limit = 20,
    offset = 0,
  ): Promise<Memory[]> {
    if (tags.length === 0) return [];
    const all = this.repository.queryMemories({});
    const matched = all.filter((m) => {
      const memTags = new Set(memoryTags(m.metadata));
      return tagMatch === "all"
        ? tags.every((t) => memTags.has(t))
        : tags.some((t) => memTags.has(t));
    });
    return matched.slice(offset, offset + limit);
  }

  // ── Episodic chains (Feature 23) ────────────────────────────────────

  /** All memories in an episode, ordered by sequence then creation. */
  getEpisode(episodeId: string): Memory[] {
    return this.repository.findByEpisode(episodeId);
  }

  /** Browse episodes by recency. */
  listEpisodes(limit = 20, offset = 0): Array<{
    episodeId: string;
    count: number;
    lastCreatedAt: Date;
  }> {
    return this.repository.listEpisodes(limit, offset);
  }

  // ── Proactive context (Feature 24) ──────────────────────────────────

  /**
   * Surface memories relevant to the current conversation context without an
   * explicit query. Returns results whose confidence meets `threshold`.
   * When `autoIngest` is set, the context itself is stored as an observation.
   */
  async proactiveContext(
    context: string,
    maxResults = 5,
    threshold = PROACTIVE_CONFIDENCE_THRESHOLD,
    autoIngest = false,
  ): Promise<SearchResult[]> {
    const results = await this.search(context, "associative", {
      limit: maxResults * 3,
      includeHistory: false,
    });
    const filtered = results
      .filter((r) => r.confidence >= threshold)
      .slice(0, maxResults);
    if (autoIngest) {
      await this.storeUnlessDuplicate(context, { type: "observation", auto_ingested: true });
    }
    return filtered;
  }

  // ── Tag management (Feature 16) ─────────────────────────────────────

  listTags(
    sortBy: "count" | "name" = "count",
    limit = 100,
    offset = 0,
  ): Array<{ tag: string; count: number }> {
    const entries = [...this.repository.tagCounts().entries()].map(
      ([tag, count]) => ({ tag, count }),
    );
    entries.sort((a, b) =>
      sortBy === "name" ? a.tag.localeCompare(b.tag) : b.count - a.count,
    );
    return entries.slice(offset, offset + limit);
  }

  /** Rewrite one tag to another across all memories; returns count changed. */
  async renameTag(oldTag: string, newTag: string): Promise<number> {
    return this.rewriteTags((tags) => {
      if (!tags.includes(oldTag)) return null;
      const next = tags.filter((t) => t !== oldTag);
      if (!next.includes(newTag)) next.push(newTag);
      return next;
    });
  }

  /** Merge several source tags into one target tag; returns count changed. */
  async mergeTags(sources: string[], target: string): Promise<number> {
    const srcSet = new Set(sources);
    return this.rewriteTags((tags) => {
      if (!tags.some((t) => srcSet.has(t))) return null;
      const next = tags.filter((t) => !srcSet.has(t));
      if (!next.includes(target)) next.push(target);
      return next;
    });
  }

  /** Remove a tag from all memories; returns count changed. */
  async deleteTag(tag: string): Promise<number> {
    return this.rewriteTags((tags) =>
      tags.includes(tag) ? tags.filter((t) => t !== tag) : null,
    );
  }

  /**
   * Apply a tag transform to every live memory carrying tags. The transform
   * returns the new tag list, or null to skip. Only metadata is rewritten
   * (vectors/content untouched).
   */
  private async rewriteTags(
    transform: (tags: string[]) => string[] | null,
  ): Promise<number> {
    const memories = this.repository.queryMemories({ includeArchived: true });
    const updates: Array<{ id: string; metadata: Record<string, unknown> }> = [];
    for (const m of memories) {
      const tags = memoryTags(m.metadata);
      if (tags.length === 0) continue;
      const next = transform(tags);
      if (next === null) continue;
      updates.push({ id: m.id, metadata: { ...m.metadata, tags: next } });
    }
    return this.repository.setMetadataBulk(updates);
  }

  // ── Memory consolidation (Feature 18) ──────────────────────────────

  /**
   * Periodic maintenance pass that prevents quality degradation (Feature 18):
   *  - decay:   re-score all memories (recency-aware quality)
   *  - cluster: find near-duplicate groups
   *  - compress: merge each cluster (keep newest)
   *  - forget:  archive unprotected memories below the quality threshold
   *
   * `action` selects the depth: "status" reports counts only; "recommend"
   * returns what a run would do without changing anything; "run" performs it.
   */
  async consolidateMemories(
    action: "run" | "status" | "recommend" = "recommend",
    timeHorizon: "daily" | "weekly" | "monthly" = "weekly",
  ): Promise<{
    action: string;
    timeHorizon: string;
    total: number;
    duplicateClusters: number;
    duplicatesForReview: number;
    forgetCandidates: number;
    rescored?: number;
    compressed?: number;
    forgotten?: number;
    averageQuality: number;
  }> {
    // Longer horizons prune more aggressively.
    const forgetThreshold =
      timeHorizon === "daily" ? 0.15 : timeHorizon === "monthly" ? 0.3 : 0.22;
    const now = new Date();

    const live = this.repository.queryMemories({ includeArchived: false });
    const scored = live.map((m) => computeQualityScore(m, now));
    const avgQuality =
      scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : 0;
    const forgetCandidates = live.filter(
      (m, i) => scored[i] < forgetThreshold && !isProtected(m),
    );
    // Compress merges only what the write-time rule calls a duplicate.
    const dupPlans = await this.planDuplicateCleanup(WRITE_DUPLICATE_SIMILARITY);
    const mergeable = dupPlans.filter((p) => p.mergeIds.length > 0);
    const duplicatesForReview = dupPlans.reduce((n, p) => n + p.review.length, 0);

    if (action === "status" || action === "recommend") {
      return {
        action,
        timeHorizon,
        total: live.length,
        duplicateClusters: mergeable.length,
        duplicatesForReview,
        forgetCandidates: forgetCandidates.length,
        averageQuality: avgQuality,
      };
    }

    // action === "run"
    const { scored: rescored } = await this.scoreMemories(now);
    let compressed = 0;
    for (const p of mergeable) {
      await this.mergeDuplicates(p.keepId, p.mergeIds, "keep_newest");
      compressed += p.mergeIds.length;
    }
    const forgotten = await this.setArchived(
      forgetCandidates.map((m) => m.id),
      true,
    );

    return {
      action,
      timeHorizon,
      total: live.length,
      duplicateClusters: mergeable.length,
      duplicatesForReview,
      forgetCandidates: forgetCandidates.length,
      rescored,
      compressed,
      forgotten,
      averageQuality: avgQuality,
    };
  }

  // ── Duplicate detection & merge (Feature 14) ────────────────────────

  /** Find near-duplicate clusters at the given cosine threshold (0.5–1.0). */
  findDuplicates(
    threshold = 0.92,
  ): Array<{ keepId: string; duplicateIds: string[] }> {
    return this.repository.findDuplicateClusters(threshold);
  }

  /**
   * Merge duplicate memories into `keepId`. Strategies:
   *  - keep_content: keep the survivor's content as-is
   *  - keep_newest:  adopt the newest member's content
   *  - combine_content: concatenate all distinct contents (re-embedded)
   * The merged-away memories are superseded by the survivor — kept as its
   * history, out of default search. Returns the survivor.
   */
  async mergeDuplicates(
    keepId: string,
    mergeIds: string[],
    strategy: "keep_content" | "keep_newest" | "combine_content" = "keep_newest",
  ): Promise<Memory | null> {
    const keep = await this.repository.findById(keepId);
    if (!keep) return null;
    const members = (await this.repository.findByIds([keepId, ...mergeIds])).filter(
      (m) => !isDeleted(m),
    );

    let content = keep.content;
    if (strategy === "keep_newest") {
      content = members.reduce((a, b) =>
        a.updatedAt >= b.updatedAt ? a : b,
      ).content;
    } else if (strategy === "combine_content") {
      const seen = new Set<string>();
      const parts: string[] = [];
      for (const m of members) {
        const c = m.content.trim();
        if (c && !seen.has(c)) {
          seen.add(c);
          parts.push(c);
        }
      }
      content = parts.join("\n\n");
    }

    const merged =
      content !== keep.content
        ? await this.update(keepId, { content })
        : keep;

    // The merged-away duplicates become the survivor's history (searchable
    // with include_superseded), not deletions.
    this.repository.supersede(mergeIds, keepId);
    return merged;
  }

  /**
   * Split each near-duplicate cluster into what is safe to merge automatically
   * and what needs a person's review, by the write-time rule: a member merges
   * into the survivor only when it is in the survivor's project, matches the
   * survivor directly (cosine >= `threshold` — not merely through another
   * member of the chain) AND in wording (Jaccard >= WRITE_DUPLICATE_JACCARD),
   * and is not protected (pinned / critical).
   */
  async planDuplicateCleanup(threshold = WRITE_DUPLICATE_SIMILARITY): Promise<DuplicatePlan[]> {
    const plans: DuplicatePlan[] = [];
    for (const c of this.repository.findDuplicateClusters(threshold)) {
      const members = await this.repository.findByIds([c.keepId, ...c.duplicateIds]);
      const keep = members.find((m) => m.id === c.keepId);
      if (!keep) continue;
      const similarity = this.repository.similaritiesTo(c.keepId, c.duplicateIds);

      const plan: DuplicatePlan = { keepId: c.keepId, mergeIds: [], review: [] };
      for (const m of members) {
        if (m.id === keep.id) continue;
        const reason =
          m.project !== keep.project
            ? "different project"
            : isProtected(m)
              ? "pinned or critical"
              : memoryStatus(m.metadata) !== memoryStatus(keep.metadata)
                ? "different status"
              : (similarity.get(m.id) ?? 0) < threshold
                ? "similar only through other members"
                : tokenJaccard(m.content, keep.content) < WRITE_DUPLICATE_JACCARD
                  ? "worded differently"
                  : null;
        if (reason === null) plan.mergeIds.push(m.id);
        else plan.review.push({ id: m.id, reason });
      }
      plans.push(plan);
    }
    return plans;
  }

  /**
   * Merge what planDuplicateCleanup deems safe (keep_newest) and leave the
   * rest for review; `dryRun` only plans. `clusters` counts clusters merged.
   * Defaults to the write-time similarity (0.95); find_duplicates, being
   * read-only, lists candidates from the lower 0.92.
   */
  async cleanupDuplicates(
    threshold = WRITE_DUPLICATE_SIMILARITY,
    dryRun = false,
  ): Promise<{ clusters: number; deleted: number; review: number; plans: DuplicatePlan[] }> {
    const plans = await this.planDuplicateCleanup(threshold);
    let clusters = 0;
    let deleted = 0;
    for (const p of plans) {
      if (p.mergeIds.length === 0) continue;
      if (!dryRun) await this.mergeDuplicates(p.keepId, p.mergeIds, "keep_newest");
      clusters++;
      deleted += p.mergeIds.length;
    }
    const review = plans.reduce((n, p) => n + p.review.length, 0);
    return { clusters, deleted, review, plans };
  }

  /**
   * Session-context menu (Feature 28): the always-relevant memories (pinned or
   * critical) for a project, ordered by importance then recency, capped to a
   * character budget so it can be injected at session start without bloat.
   */
  async getSessionContext(opts?: {
    project?: string;
    scope?: "project" | "all";
    maxChars?: number;
  }): Promise<{ memories: Memory[]; text: string; truncated: boolean }> {
    const maxChars = opts?.maxChars ?? 4000;
    const project =
      opts?.scope === "all"
        ? undefined
        : opts?.project
          ? normalizeProject(opts.project)
          : (this.project ?? undefined);

    const live = this.repository.queryMemories({ project }).filter((m) => !isSuperseded(m));
    const rows = live.filter((m) => isProtected(m));
    // Open items (tasks, next steps, blockers) follow, newest first.
    const open = live
      .filter((m) => !isProtected(m) && memoryStatus(m.metadata) === "open")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    rows.sort((a, b) => {
      const ra = a.importance ? IMPORTANCE_RANK[a.importance] : 1;
      const rb = b.importance ? IMPORTANCE_RANK[b.importance] : 1;
      if (rb !== ra) return rb - ra;
      const la = (a.lastAccessed ?? a.createdAt).getTime();
      const lb = (b.lastAccessed ?? b.createdAt).getTime();
      return lb - la;
    });

    const included: Memory[] = [];
    const parts: string[] = [];
    let used = 0;
    let truncated = false;
    for (const m of [...rows, ...open]) {
      const label = isProtected(m)
        ? m.importance === "critical"
          ? "critical"
          : "pinned"
        : `open ${(m.metadata.type as string | undefined) ?? "item"}`;
      const block = `- [${label}] ${m.content}`;
      if (used + block.length + 1 > maxChars && included.length > 0) {
        truncated = true;
        break;
      }
      included.push(m);
      parts.push(block);
      used += block.length + 1;
    }

    return { memories: included, text: parts.join("\n"), truncated };
  }

  private static readonly UUID_ZERO =
    "00000000-0000-0000-0000-000000000000";

  private static waypointId(project?: string): string {
    if (!project?.length) return MemoryService.UUID_ZERO;
    const normalized = project.trim().toLowerCase();
    const hex = createHash("sha256").update(`waypoint:${normalized}`).digest("hex");
    return `wp:${hex.slice(0, 32)}`;
  }

  /** Legacy UUID-formatted waypoint ID for migration fallback reads. */
  private static legacyWaypointId(project?: string): string | null {
    if (!project?.length) return null; // UUID_ZERO is still current for no-project
    const normalized = project.trim().toLowerCase();
    const hex = createHash("sha256").update(`waypoint:${normalized}`).digest("hex");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  /**
   * Resolve a caller-supplied project (possibly a legacy display name or
   * relative value) or fall back to the server's configured project.
   */
  private resolveProject(project?: string): string | undefined {
    if (project && project.trim().length > 0) return normalizeProject(project);
    return this.project ?? undefined;
  }

  async setWaypoint(args: {
    project?: string;
    branch?: string;
    summary: string;
    completed?: string[];
    in_progress_blocked?: string[];
    key_decisions?: string[];
    next_steps?: string[];
    memory_ids?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Memory> {
    // Track access for utilized memories
    if (args.memory_ids && args.memory_ids.length > 0) {
      await this.trackAccess(args.memory_ids);
    }

    const project = this.resolveProject(args.project);
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);

    const list = (items: string[] | undefined) => {
      if (!items || items.length === 0) {
        return "- (none)";
      }
      return items.map((i) => `- ${i}`).join("\n");
    };

    const content = `# Waypoint - ${project ?? "unknown project"}
**Date:** ${date} ${time} | **Branch:** ${args.branch ?? "unknown"}

## Summary
${args.summary}

## Completed
${list(args.completed)}

## In Progress / Blocked
${list(args.in_progress_blocked)}

## Key Decisions
${list(args.key_decisions)}

## Next Steps
${list(args.next_steps)}

## Memory IDs
${list(args.memory_ids)}`;

    const metadata: Record<string, unknown> = {
      ...(args.metadata ?? {}),
      type: "waypoint",
      project: project ?? null,
      date,
      branch: args.branch ?? "unknown",
      memory_ids: args.memory_ids ?? [],
    };

    const memory: Memory = {
      id: MemoryService.waypointId(project),
      content,
      embedding: new Array(this.embeddings.dimension).fill(0),
      metadata,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      usefulness: 0,
      accessCount: 0,
      lastAccessed: now, // Initialize to now for consistency
      project: project ?? null,
    };

    // NOTE: deliberately no UUID_ZERO "global latest" copy — in a shared
    // database that becomes last-writer-wins across projects. Readers that
    // don't know their project resolve it from cwd instead.
    await this.repository.upsert(memory);

    return memory;
  }

  /**
   * Find the latest waypoint for a project, trying legacy ID schemes in
   * order and migrating hits to the canonical ID:
   *  1. canonical: waypointId(normalized absolute path)
   *  2. legacy skill-supplied display name: waypointId(basename)
   *  3. legacy UUID-formatted IDs for both of the above
   *  4. UUID_ZERO "global latest" — only when its metadata.project matches,
   *     so one project's pre-migration waypoint never leaks into another
   */
  async getLatestWaypoint(project?: string): Promise<Memory | null> {
    const resolved = this.resolveProject(project);
    const canonicalId = MemoryService.waypointId(resolved);

    const waypoint = await this.get(canonicalId);
    if (waypoint && !isDeleted(waypoint)) return waypoint;

    const candidateIds: string[] = [];
    if (resolved) {
      const display = basename(resolved);
      candidateIds.push(MemoryService.waypointId(display));
      const legacyPath = MemoryService.legacyWaypointId(resolved);
      if (legacyPath) candidateIds.push(legacyPath);
      const legacyDisplay = MemoryService.legacyWaypointId(display);
      if (legacyDisplay) candidateIds.push(legacyDisplay);
    } else {
      const legacyId = MemoryService.legacyWaypointId(resolved);
      if (legacyId) candidateIds.push(legacyId);
    }

    for (const id of candidateIds) {
      if (id === canonicalId) continue;
      const legacy = await this.repository.findById(id);
      if (!legacy || isDeleted(legacy)) continue;

      // Migrate: write under canonical ID, delete old
      await this.repository.upsert({
        ...legacy,
        id: canonicalId,
        project: resolved ?? legacy.project,
      });
      await this.repository.markDeleted(id);
      return { ...legacy, id: canonicalId, project: resolved ?? legacy.project };
    }

    // Last resort: the pre-migration UUID_ZERO copy, guarded by project match
    if (resolved && canonicalId !== MemoryService.UUID_ZERO) {
      const global = await this.repository.findById(MemoryService.UUID_ZERO);
      if (global && !isDeleted(global)) {
        const metaProject = (global.metadata.project as string | undefined) ?? "";
        const matches =
          metaProject.length > 0 &&
          (normalizeProject(metaProject) === resolved ||
            metaProject.trim().toLowerCase() ===
              basename(resolved).toLowerCase());
        if (matches) {
          await this.repository.upsert({
            ...global,
            id: canonicalId,
            project: resolved,
          });
          await this.repository.markDeleted(MemoryService.UUID_ZERO);
          return { ...global, id: canonicalId, project: resolved };
        }
      }
    }

    return null;
  }
}
