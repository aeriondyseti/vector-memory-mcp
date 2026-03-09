import {
  Schema,
  Field,
  Utf8,
  Int32,
  Float64,
} from "apache-arrow";
import { vectorField, timestampField } from "./schema.js";

export const CONVERSATION_HISTORY_TABLE = "conversation_history";

/**
 * Tracks which sessions have been indexed and their file sizes,
 * enabling idempotent incremental indexing.
 */
export const INDEXED_SESSIONS_TABLE = "indexed_sessions";

export const conversationHistorySchema = new Schema([
  new Field("id", new Utf8(), false),
  vectorField(),
  new Field("content", new Utf8(), false),
  new Field("session_id", new Utf8(), false),
  new Field("role", new Utf8(), false), // "user" | "assistant"
  new Field("message_index", new Int32(), false),
  timestampField("timestamp"),
  new Field("metadata", new Utf8(), false), // JSON string
  timestampField("created_at"),
]);

export const indexedSessionsSchema = new Schema([
  new Field("session_id", new Utf8(), false),
  new Field("file_path", new Utf8(), false),
  new Field("file_size", new Float64(), false), // Float64 avoids Int32 overflow and BigInt handling
  new Field("message_count", new Int32(), false),
  timestampField("first_message_at"),
  timestampField("last_message_at"),
  timestampField("indexed_at"),
  new Field("project", new Utf8(), true), // Nullable
  new Field("git_branch", new Utf8(), true), // Nullable
]);
