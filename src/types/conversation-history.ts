import type { WithRrfScore } from "./memory.js";

/**
 * A single indexed message from a conversation session log.
 * One entry per user/assistant text message — tool calls and results are excluded.
 */
export interface ConversationHistoryEntry {
  id: string;
  content: string;
  embedding: number[];
  sessionId: string;
  role: "user" | "assistant";
  messageIndex: number;
  timestamp: Date;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export type ConversationHistoryHybridRow = WithRrfScore<ConversationHistoryEntry>;

/**
 * Summary of an indexed session for list_indexed_sessions.
 */
export interface IndexedSessionSummary {
  sessionId: string;
  messageCount: number;
  firstMessageAt: Date;
  lastMessageAt: Date;
  indexedAt: Date;
  project?: string;
  gitBranch?: string;
}

/**
 * Full indexed session record including storage-level fields (file path, size).
 * Used by the repository for upsert operations and by the parser for tracking.
 */
export interface IndexedSession extends IndexedSessionSummary {
  filePath: string;
  fileSize: number;
}

/**
 * Discriminated union for merged search results.
 * Narrow on `source` to access type-specific fields.
 */
export interface MemorySearchResult {
  source: "memory";
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  createdAt: Date;
  updatedAt: Date;
  supersededBy: string | null;
}

export interface HistorySearchResult {
  source: "conversation_history";
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  sessionId: string;
  role: "user" | "assistant";
  messageIndex: number;
  timestamp: Date;
}

export type SearchResult = MemorySearchResult | HistorySearchResult;
