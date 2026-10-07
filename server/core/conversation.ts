/** A single parsed message from a session log */
export interface ParsedMessage {
  uuid: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  messageIndex: number;
  sessionId: string;
  project: string;
  gitBranch?: string;
  isSubagent: boolean;
  agentId?: string;
}

/** Metadata stored per conversation chunk in the database */
export interface ConversationChunkMetadata {
  timestamp: string;
  git_branch?: string;
  is_subagent: boolean;
  agent_id?: string;
}

/** A chunk of conversation ready for indexing */
export interface ConversationChunk {
  id: string;
  content: string;
  sessionId: string;
  timestamp: Date;
  endTimestamp: Date;
  role: string;
  messageIndexStart: number;
  messageIndexEnd: number;
  project: string;
  metadata: ConversationChunkMetadata;
}

/** Tracking record for an indexed session */
export interface IndexedSession {
  sessionId: string;
  filePath: string;
  project: string;
  lastModified: number;
  chunkCount: number;
  messageCount: number;
  indexedAt: Date;
  firstMessageAt: Date;
  lastMessageAt: Date;
}

import type { SearchSignals } from "./memory";

/** Raw row from conversation_history table with RRF score */
export interface ConversationHybridRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  rrfScore: number;
  signals: SearchSignals;
}

/** Unified search result with source provenance */
export interface SearchResult {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  source: "memory" | "conversation_history";
  score: number;
  /** Absolute relevance confidence (0.0-1.0). Based on cosine similarity + retrieval agreement. */
  confidence: number;
  /** Canonical project path this result belongs to (null = untagged/legacy). */
  project: string | null;
  // Memory-specific fields
  supersededBy: string | null;
  usefulness?: number;
  accessCount?: number;
  lastAccessed?: Date | null;
  pinned?: boolean;
  importance?: import("./memory").MemoryImportance | null;
  /** Where the memory belongs (document, section), when it has a context. */
  context?: string | null;
  /** When what the memory describes happened, if recorded apart from when it was stored. */
  occurredAt?: Date | null;
  /** Versions this memory replaced (same key, or merged into it), newest first. */
  history?: Array<{ content: string; createdAt: Date; replacedAt: Date }>;
  /** For a synthesis: the memories it cites, and how many have since been replaced or deleted. */
  sources?: { ids: string[]; outdated: number };
  /** The cross-encoder's score (logit), when this result was reranked. */
  rerankScore?: number;
  /** Links from a top match or named entity, when the graph lane reached it. */
  graphDistance?: number | null;
  // History-specific fields
  sessionId?: string;
  role?: string;
  messageIndexStart?: number;
  messageIndexEnd?: number;
}

/** Session file info returned by the parser's file discovery */
export interface SessionFileInfo {
  filePath: string;
  sessionId: string;
  project: string;
  lastModified: Date;
}

/** Outcome status for a single session during indexing */
export type IndexStatus = "indexed" | "skipped" | "error";

/** Per-session detail returned from indexConversations */
export interface SessionIndexDetail {
  sessionId: string;
  project: string;
  status: IndexStatus;
  chunks?: number;
  messages?: number;
  error?: string;
}

/** Search filter options for conversation history */
export interface HistoryFilters {
  sessionId?: string;
  role?: string;
  project?: string;
  after?: Date;
  before?: Date;
}

/** Options for the integrated search across both sources */
export interface SearchOptions {
  limit?: number;
  /**
   * Project scope: "all" (default) searches every project with a ranking
   * boost for the current one; "project" restricts to the current project;
   * any other string is an explicit canonical project path to restrict to.
   */
  scope?: string;
  includeDeleted?: boolean;
  includeHistory?: boolean;
  historyOnly?: boolean;
  historyWeight?: number;
  historyFilters?: HistoryFilters;
  offset?: number;
  /** Filter both memories and history created after this date. Merged into historyFilters; explicit historyFilters.after takes precedence. */
  after?: Date;
  /** Filter both memories and history created before this date. Merged into historyFilters; explicit historyFilters.before takes precedence. */
  before?: Date;
  /** Include archived memories in results (default false). */
  includeArchived?: boolean;
  /** Include memories replaced by a newer one with the same key (default false). */
  includeSuperseded?: boolean;
  /** Include open-until-resolved memories already resolved (default false). */
  includeResolved?: boolean;
  /** Rerank memory results with the cross-encoder when one is configured (default true). */
  rerank?: boolean;
  /** Only memories with this status (task, next-step and blocker memories, or any given one). */
  status?: import("./memory").MemoryStatus;
  /**
   * The period the search is about ("last week", "March", "2023-05-01..2023-05-31"):
   * memories from it are ranked up, not filtered. Default: a period named in the query.
   */
  during?: string;
  /** Rank in memories linked through the knowledge graph (opt-in, default false). */
  useGraph?: boolean;
  /** Graph lane weights — a tuning knob for benchmarks, not exposed by the MCP tools. */
  graphWeights?: { named?: number; neighbor?: number };
  /** Include expired (TTL-passed) memories in results (default false). */
  includeExpired?: boolean;
  /** Minimum confidence level to include (memories below this rank are dropped). */
  minConfidence?: import("./memory").MemoryConfidence;
  /** Minimum importance level to include. */
  minImportance?: import("./memory").MemoryImportance;
  /** Restrict to memories whose metadata.type equals this value. */
  type?: string;
  /** Restrict to memories carrying these tags (metadata.tags). */
  tags?: string[];
  /** Tag match mode: "any" (default) or "all". */
  tagMatch?: "any" | "all";
  /**
   * Ranking mode: "semantic" (default, vector+FTS), "exact" (FTS keyword only),
   * or "hybrid" (semantic blended with stored usefulness).
   */
  mode?: "semantic" | "exact" | "hybrid";
}
