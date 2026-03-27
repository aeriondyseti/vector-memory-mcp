import { describe, test, expect } from "bun:test";
import { chunkMessages } from "../server/core/conversation.service";
import type { ParsedMessage } from "../server/core/conversation";

function makeMessage(
  index: number,
  role: "user" | "assistant" = index % 2 === 0 ? "user" : "assistant"
): ParsedMessage {
  return {
    uuid: `msg-${index}`,
    role,
    content: `Message ${index} content`,
    timestamp: new Date(`2026-03-03T${String(10 + index).padStart(2, "0")}:00:00Z`),
    messageIndex: index,
    sessionId: "session-1",
    project: "test-project",
    isSubagent: false,
  };
}

describe("chunkMessages", () => {
  test("returns empty array for no messages", () => {
    const chunks = chunkMessages([], 5, 1);
    expect(chunks).toHaveLength(0);
  });

  test("creates single chunk for messages within limit", () => {
    const messages = [makeMessage(0), makeMessage(1), makeMessage(2)];
    const chunks = chunkMessages(messages, 5, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messageIndexStart).toBe(0);
    expect(chunks[0].messageIndexEnd).toBe(2);
  });

  test("splits messages into multiple chunks", () => {
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(i));
    const chunks = chunkMessages(messages, 3, 0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].messageIndexStart).toBe(0);
    expect(chunks[0].messageIndexEnd).toBe(2);
    expect(chunks[1].messageIndexStart).toBe(3);
    expect(chunks[1].messageIndexEnd).toBe(5);
  });

  test("applies overlap between chunks", () => {
    const messages = Array.from({ length: 6 }, (_, i) => makeMessage(i));
    const chunks = chunkMessages(messages, 3, 1);
    // With overlap=1: chunks at [0,1,2], [2,3,4], [4,5]
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Each chunk except the last should overlap with the next
    expect(chunks[0].messageIndexEnd).toBe(2);
    expect(chunks[1].messageIndexStart).toBe(2);
  });

  test("generates deterministic chunk IDs", () => {
    const messages = [makeMessage(0), makeMessage(1)];
    const chunks1 = chunkMessages(messages, 5, 0);
    const chunks2 = chunkMessages(messages, 5, 0);
    expect(chunks1[0].id).toBe(chunks2[0].id);
  });

  test("assigns role 'mixed' when chunk has both user and assistant", () => {
    const messages = [makeMessage(0, "user"), makeMessage(1, "assistant")];
    const chunks = chunkMessages(messages, 5, 0);
    expect(chunks[0].role).toBe("mixed");
  });

  test("assigns homogeneous role when all messages are same role", () => {
    const messages = [makeMessage(0, "user"), makeMessage(1, "user")];
    const chunks = chunkMessages(messages, 5, 0);
    expect(chunks[0].role).toBe("user");
  });

  test("formats content with role and timestamp prefixes", () => {
    const messages = [makeMessage(0, "user")];
    const chunks = chunkMessages(messages, 5, 0);
    expect(chunks[0].content).toContain("[user @");
    expect(chunks[0].content).toContain("Message 0 content");
  });

  test("sets metadata correctly", () => {
    const messages = [makeMessage(0), makeMessage(1)];
    const chunks = chunkMessages(messages, 5, 0);
    const chunk = chunks[0];
    // Top-level fields are source of truth
    expect(chunk.sessionId).toBe("session-1");
    expect(chunk.project).toBe("test-project");
    expect(chunk.messageIndexStart).toBe(0);
    expect(chunk.messageIndexEnd).toBe(1);
    // Metadata-only fields
    expect(chunk.metadata.is_subagent).toBe(false);
    expect(chunk.metadata.timestamp).toBe(messages[0].timestamp.toISOString());
  });

  test("always advances at least 1 message to prevent infinite loops", () => {
    const messages = [makeMessage(0)];
    // Overlap > chunk size would normally cause infinite loop
    const chunks = chunkMessages(messages, 1, 5);
    expect(chunks).toHaveLength(1);
  });
});
