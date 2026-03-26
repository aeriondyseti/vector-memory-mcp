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
  session_id: string;
  timestamp: string;
  role: string;
  message_index_start: number;
  message_index_end: number;
  project: string;
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

/** Raw row from conversation_history table with RRF score */
export interface ConversationHybridRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  rrfScore: number;
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
  // Memory-specific fields
  supersededBy: string | null;
  usefulness?: number;
  accessCount?: number;
  lastAccessed?: Date | null;
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
  includeHistory?: boolean;
  historyOnly?: boolean;
  historyWeight?: number;
  historyFilters?: HistoryFilters;
  offset?: number;
}
