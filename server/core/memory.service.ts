import { randomUUID, createHash } from "crypto";
import type { Memory, SearchIntent, IntentProfile, HybridRow } from "./memory";
import { isDeleted } from "./memory";
import type { SearchResult, SearchOptions } from "./conversation";
import type { MemoryRepository } from "./memory.repository";
import type { EmbeddingsService } from "./embeddings.service";
import type { ConversationHistoryService } from "./conversation.service";

const INTENT_PROFILES: Record<SearchIntent, IntentProfile> = {
  continuity: { weights: { relevance: 0.3, recency: 0.5, utility: 0.2 }, jitter: 0.02 },
  fact_check: { weights: { relevance: 0.6, recency: 0.1, utility: 0.3 }, jitter: 0.02 },
  frequent: { weights: { relevance: 0.2, recency: 0.2, utility: 0.6 }, jitter: 0.02 },
  associative: { weights: { relevance: 0.7, recency: 0.1, utility: 0.2 }, jitter: 0.05 },
  explore: { weights: { relevance: 0.4, recency: 0.3, utility: 0.3 }, jitter: 0.15 },
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export class MemoryService {
  private conversationService: ConversationHistoryService | null = null;

  constructor(
    private repository: MemoryRepository,
    private embeddings: EmbeddingsService
  ) {}

  setConversationService(service: ConversationHistoryService): void {
    this.conversationService = service;
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
    embeddingText?: string
  ): Promise<Memory> {
    const id = randomUUID();
    const now = new Date();
    const textToEmbed = embeddingText ?? content;
    const embedding = await this.embeddings.embed(textToEmbed);

    const memory: Memory = {
      id,
      content,
      embedding,
      metadata,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      usefulness: 0,
      accessCount: 0,
      lastAccessed: now, // Initialize to createdAt for fair discovery
    };

    await this.repository.insert(memory);
    return memory;
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
    }
  ): Promise<Memory | null> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      return null;
    }

    const newContent = updates.content ?? existing.content;
    const newMetadata = updates.metadata ?? existing.metadata;

    // Regenerate embedding if content or embeddingText changed
    let newEmbedding = existing.embedding;
    if (updates.content !== undefined || updates.embeddingText !== undefined) {
      const textToEmbed = updates.embeddingText ?? newContent;
      newEmbedding = await this.embeddings.embed(textToEmbed);
    }

    const updatedMemory: Memory = {
      ...existing,
      content: newContent,
      embedding: newEmbedding,
      metadata: newMetadata,
      updatedAt: new Date(),
    };

    await this.repository.upsert(updatedMemory);
    return updatedMemory;
  }

  async vote(id: string, value: number): Promise<Memory | null> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      return null;
    }

    // Vote also tracks access (explicit utilization signal)
    const updatedMemory: Memory = {
      ...existing,
      usefulness: existing.usefulness + value,
      accessCount: existing.accessCount + 1,
      lastAccessed: new Date(),
      updatedAt: new Date(),
    };

    await this.repository.upsert(updatedMemory);
    return updatedMemory;
  }

  private computeMemoryScore(
    candidate: HybridRow,
    profile: IntentProfile,
    now: Date
  ): number {
    const relevance = candidate.rrfScore;
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
    const score =
      weights.relevance * relevance +
      weights.recency * recency +
      weights.utility * utility;
    return score * (1 + (Math.random() * 2 - 1) * jitter);
  }

  async search(
    query: string,
    intent: SearchIntent,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 10;
    const includeDeleted = options?.includeDeleted ?? false;
    const queryEmbedding = await this.embeddings.embed(query);
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

    // Run memory + history queries in parallel
    const memoryPromise =
      !historyOnly
        ? this.repository
            .findHybrid(queryEmbedding, query, effectiveLimit * 5)
            .then((candidates) =>
              candidates
                .filter((m) => includeDeleted || !isDeleted(m))
                .map((candidate) => ({
                  id: candidate.id,
                  content: candidate.content,
                  metadata: candidate.metadata,
                  createdAt: candidate.createdAt,
                  updatedAt: candidate.updatedAt,
                  source: "memory" as const,
                  score: this.computeMemoryScore(candidate, profile, now),
                  supersededBy: candidate.supersededBy,
                  usefulness: candidate.usefulness,
                  accessCount: candidate.accessCount,
                  lastAccessed: candidate.lastAccessed,
                }))
            )
        : Promise.resolve([] as SearchResult[]);

    const historyPromise =
      includeHistory || historyOnly
        ? this.conversationService!
            .searchHistory(
              query,
              queryEmbedding,
              historyOnly ? effectiveLimit * 5 : effectiveLimit * 3,
              options?.historyFilters
            )
            .then((historyRows) =>
              historyRows.map((row) => ({
                id: row.id,
                content: row.content,
                metadata: row.metadata,
                createdAt: row.createdAt,
                updatedAt: row.createdAt,
                source: "conversation_history" as const,
                score: row.rrfScore * historyWeight,
                supersededBy: null,
                sessionId: (row.metadata?.session_id as string) ?? "",
                role: (row.metadata?.role as string) ?? "unknown",
                messageIndexStart: (row.metadata?.message_index_start as number) ?? 0,
                messageIndexEnd: (row.metadata?.message_index_end as number) ?? 0,
              }))
            )
        : Promise.resolve([] as SearchResult[]);

    const [memoryResults, historyResults] = await Promise.all([
      memoryPromise,
      historyPromise,
    ]);

    // Merge and sort by score descending
    const merged = [...memoryResults, ...historyResults];
    merged.sort((a, b) => b.score - a.score);

    return merged.slice(offset, offset + limit);
  }

  async trackAccess(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.repository.bulkUpdateAccess(ids, new Date());
  }

  private static readonly UUID_ZERO =
    "00000000-0000-0000-0000-000000000000";

  private static waypointId(project?: string): string {
    if (!project?.length) return MemoryService.UUID_ZERO;
    const normalized = project.trim().toLowerCase();
    const hex = createHash("sha256").update(`waypoint:${normalized}`).digest("hex");
    // Format as UUID: 8-4-4-4-12
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  async setWaypoint(args: {
    project: string;
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

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);

    const list = (items: string[] | undefined) => {
      if (!items || items.length === 0) {
        return "- (none)";
      }
      return items.map((i) => `- ${i}`).join("\n");
    };

    const content = `# Waypoint - ${args.project}
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
      project: args.project,
      date,
      branch: args.branch ?? "unknown",
      memory_ids: args.memory_ids ?? [],
    };

    const memory: Memory = {
      id: MemoryService.waypointId(args.project),
      content,
      embedding: new Array(this.embeddings.dimension).fill(0),
      metadata,
      createdAt: now,
      updatedAt: now,
      supersededBy: null,
      usefulness: 0,
      accessCount: 0,
      lastAccessed: now, // Initialize to now for consistency
    };

    await this.repository.upsert(memory);

    // Always update the global (no-project) waypoint so the session-start
    // hook can find the most recent waypoint without knowing the project name.
    const globalId = MemoryService.UUID_ZERO;
    if (memory.id !== globalId) {
      await this.repository.upsert({ ...memory, id: globalId });
    }

    return memory;
  }

  async getLatestWaypoint(project?: string): Promise<Memory | null> {
    return await this.get(MemoryService.waypointId(project));
  }
}
