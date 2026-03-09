import { randomUUID } from "crypto";
import type { Memory, SearchIntent, IntentProfile } from "../types/memory.js";
import { isDeleted } from "../types/memory.js";
import type { MemoryRepository } from "../db/memory.repository.js";
import type { EmbeddingsService } from "./embeddings.service.js";
import type { ConversationHistoryService } from "./conversation-history.service.js";
import type { SearchResult, MemorySearchResult } from "../types/conversation-history.js";

const INTENT_PROFILES: Record<SearchIntent, IntentProfile> = {
  continuity: { weights: { relevance: 0.3, recency: 0.5, utility: 0.2 }, jitter: 0.02 },
  fact_check: { weights: { relevance: 0.6, recency: 0.1, utility: 0.3 }, jitter: 0.02 },
  frequent: { weights: { relevance: 0.2, recency: 0.2, utility: 0.6 }, jitter: 0.02 },
  associative: { weights: { relevance: 0.7, recency: 0.1, utility: 0.2 }, jitter: 0.05 },
  explore: { weights: { relevance: 0.4, recency: 0.3, utility: 0.3 }, jitter: 0.15 },
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export class MemoryService {
  private historyService: ConversationHistoryService | null = null;
  private historyWeight: number = 0.5;

  constructor(
    private repository: MemoryRepository,
    private embeddings: EmbeddingsService
  ) { }

  /**
   * Optionally wire conversation history for unified search.
   * Called from index.ts when conversationHistory.enabled is true.
   */
  setConversationHistory(service: ConversationHistoryService, weight: number): void {
    this.historyService = service;
    this.historyWeight = weight;
  }

  /**
   * Access the conversation history service (if wired).
   * Used by MCP handlers for index/list/reindex tools.
   */
  getConversationHistory(): ConversationHistoryService | null {
    return this.historyService;
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

  async search(
    query: string,
    intent: SearchIntent,
    limit: number = 10,
    includeDeleted: boolean = false
  ): Promise<Memory[]> {
    const queryEmbedding = await this.embeddings.embed(query);
    const fetchLimit = limit * 5; // Fetch more for re-ranking

    const candidates = await this.repository.findHybrid(queryEmbedding, query, fetchLimit);
    const profile = INTENT_PROFILES[intent];
    const now = new Date();

    const scored = candidates
      .filter((m) => includeDeleted || !isDeleted(m))
      .map((candidate) => {
        // Relevance: RRF score (already normalized ~0-1)
        const relevance = candidate.rrfScore;

        // Recency: exponential decay
        const lastAccessed = candidate.lastAccessed ?? candidate.createdAt;
        const hoursSinceAccess = Math.max(0, (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60));
        const recency = Math.pow(0.995, hoursSinceAccess);

        // Utility: sigmoid of usefulness + log(accessCount)
        const utility = sigmoid((candidate.usefulness + Math.log(candidate.accessCount + 1)) / 5);

        // Weighted score
        const { weights, jitter } = profile;
        const score =
          weights.relevance * relevance +
          weights.recency * recency +
          weights.utility * utility;

        // Apply jitter
        const finalScore = score * (1 + (Math.random() * 2 - 1) * jitter);

        return { memory: candidate as Memory, finalScore };
      });

    // Sort by final score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Return top N (read-only - no access tracking)
    return scored.slice(0, limit).map((s) => s.memory);
  }

  /**
   * Search across both memories and conversation history (if enabled).
   * Returns a merged, score-normalized list sorted by relevance.
   *
   * If no history service is configured, falls back to memory-only search
   * wrapped as MemorySearchResult[].
   */
  async searchUnified(
    query: string,
    intent: SearchIntent,
    limit: number = 10,
    includeDeleted: boolean = false,
  ): Promise<SearchResult[]> {
    if (!this.historyService) {
      const memories = await this.search(query, intent, limit, includeDeleted);
      return this.toMemoryResults(memories, limit);
    }

    // Run both searches in parallel
    const [memories, historyResults] = await Promise.all([
      this.search(query, intent, limit, includeDeleted),
      this.historyService.search(query, limit),
    ]);

    const memoryResults = this.toMemoryResults(memories, limit);

    // Apply history weight to RRF scores
    const weightedHistory: SearchResult[] = historyResults.map((h) => ({
      ...h,
      score: h.score * this.historyWeight,
    }));

    // Merge, sort by score descending, take top N
    const merged = [...memoryResults, ...weightedHistory];
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  /** Convert pre-sorted Memory[] to MemorySearchResult[] with positional scores. */
  private toMemoryResults(memories: Memory[], limit: number): MemorySearchResult[] {
    return memories.map((m, rank) => ({
      source: "memory" as const,
      id: m.id,
      content: m.content,
      metadata: m.metadata,
      score: (limit - rank) / limit,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      supersededBy: m.supersededBy,
    }));
  }

  async trackAccess(ids: string[]): Promise<void> {
    const now = new Date();
    for (const id of ids) {
      const memory = await this.repository.findById(id);
      if (memory && !isDeleted(memory)) {
        await this.repository.upsert({
          ...memory,
          accessCount: memory.accessCount + 1,
          lastAccessed: now,
        });
      }
    }
  }

  private static readonly UUID_ZERO =
    "00000000-0000-0000-0000-000000000000";

  async storeCheckpoint(args: {
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

    const content = `# Checkpoint - ${args.project}
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
      type: "checkpoint",
      project: args.project,
      date,
      branch: args.branch ?? "unknown",
      memory_ids: args.memory_ids ?? [],
    };

    const memory: Memory = {
      id: MemoryService.UUID_ZERO,
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
    return memory;
  }

  async getLatestCheckpoint(): Promise<Memory | null> {
    return await this.get(MemoryService.UUID_ZERO);
  }
}
