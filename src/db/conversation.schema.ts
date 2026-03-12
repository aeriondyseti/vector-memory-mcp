import {
  Schema,
  Field,
  FixedSizeList,
  Float32,
  Utf8,
  Timestamp,
  TimeUnit,
  Int32,
} from "apache-arrow";

export const CONVERSATION_TABLE_NAME = "conversation_history";

export const conversationSchema = new Schema([
  new Field("id", new Utf8(), false),
  new Field(
    "vector",
    new FixedSizeList(384, new Field("item", new Float32(), false)),
    false
  ),
  new Field("content", new Utf8(), false),
  new Field("metadata", new Utf8(), false), // JSON string
  new Field(
    "created_at",
    new Timestamp(TimeUnit.MILLISECOND, "UTC"),
    false
  ),
  new Field("session_id", new Utf8(), false),
  new Field("role", new Utf8(), false),
  new Field("message_index_start", new Int32(), false),
  new Field("message_index_end", new Int32(), false),
  new Field("project", new Utf8(), false),
]);
