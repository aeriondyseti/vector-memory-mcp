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

// Shared field helpers — used by both memory and conversation history schemas
export const EMBEDDING_DIMENSION = 384;

export const vectorField = () =>
  new Field(
    "vector",
    new FixedSizeList(EMBEDDING_DIMENSION, new Field("item", new Float32())),
    false
  );

export const timestampField = (name: string, nullable = false) =>
  new Field(name, new Timestamp(TimeUnit.MILLISECOND, "UTC"), nullable);

export const TABLE_NAME = "memories";

export const memorySchema = new Schema([
  new Field("id", new Utf8(), false),
  vectorField(),
  new Field("content", new Utf8(), false),
  new Field("metadata", new Utf8(), false), // JSON string
  timestampField("created_at"),
  timestampField("updated_at"),
  new Field("superseded_by", new Utf8(), true), // Nullable
  new Field("usefulness", new Float32(), false),
  new Field("access_count", new Int32(), false),
  timestampField("last_accessed", true),
]);
