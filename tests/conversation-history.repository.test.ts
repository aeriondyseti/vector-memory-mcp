import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { connectToDatabase } from "../src/db/connection";
import { ConversationHistoryRepository } from "../src/db/conversation-history.repository";
import type { ConversationHistoryEntry, IndexedSession } from "../src/types/conversation-history";

const EMBEDDING_DIM = 384;
const randomEmbedding = () => new Array(EMBEDDING_DIM).fill(0).map(() => Math.random());

const createTestEntry = (
  id: string,
  content: string,
  sessionId: string,
  overrides?: Partial<ConversationHistoryEntry>
): ConversationHistoryEntry => ({
  id,
  content,
  embedding: randomEmbedding(),
  sessionId,
  role: "user",
  messageIndex: 0,
  timestamp: new Date(),
  metadata: {},
  createdAt: new Date(),
  ...overrides,
});

describe("ConversationHistoryRepository", () => {
  let db: lancedb.Connection;
  let repo: ConversationHistoryRepository;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-ch-test-"));
    const dbPath = join(tmpDir, "test.lancedb");
    db = await connectToDatabase(dbPath);
    repo = new ConversationHistoryRepository(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  describe("insert and findBySessionId", () => {
    test("inserts entries and retrieves by session ID", async () => {
      const entries = [
        createTestEntry("e1", "Hello, how are you?", "session-1", { messageIndex: 0 }),
        createTestEntry("e2", "I need help with TypeScript", "session-1", {
          messageIndex: 1,
          role: "assistant",
        }),
      ];
      await repo.insert(entries);

      const results = await repo.findBySessionId("session-1");

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id).sort()).toEqual(["e1", "e2"]);
      expect(results.find((r) => r.id === "e2")?.role).toBe("assistant");
    });

    test("insert with empty array is a no-op", async () => {
      await repo.insert([]);
      const results = await repo.findBySessionId("nonexistent");
      expect(results).toHaveLength(0);
    });

    test("entries from different sessions are isolated", async () => {
      await repo.insert([
        createTestEntry("e1", "Session one content", "session-1"),
        createTestEntry("e2", "Session two content", "session-2"),
      ]);

      const s1 = await repo.findBySessionId("session-1");
      const s2 = await repo.findBySessionId("session-2");

      expect(s1).toHaveLength(1);
      expect(s1[0].id).toBe("e1");
      expect(s2).toHaveLength(1);
      expect(s2[0].id).toBe("e2");
    });
  });

  describe("deleteBySessionId", () => {
    test("deletes all entries for a session and returns count", async () => {
      await repo.insert([
        createTestEntry("e1", "Message one", "session-1", { messageIndex: 0 }),
        createTestEntry("e2", "Message two", "session-1", { messageIndex: 1 }),
        createTestEntry("e3", "Other session", "session-2"),
      ]);

      const deleted = await repo.deleteBySessionId("session-1");
      expect(deleted).toBe(2);

      const remaining = await repo.findBySessionId("session-1");
      expect(remaining).toHaveLength(0);

      // session-2 untouched
      const other = await repo.findBySessionId("session-2");
      expect(other).toHaveLength(1);
    });

    test("returns 0 for nonexistent session", async () => {
      const deleted = await repo.deleteBySessionId("nonexistent");
      expect(deleted).toBe(0);
    });
  });

  describe("findHybrid", () => {
    test("returns results with rrfScore", async () => {
      const embedding = randomEmbedding();
      await repo.insert([
        createTestEntry("e1", "TypeScript programming language", "session-1", { embedding }),
      ]);

      const results = await repo.findHybrid(embedding, "TypeScript", 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe("e1");
      expect(results[0].rrfScore).toBeDefined();
      expect(typeof results[0].rrfScore).toBe("number");
    });

    test("returns full entry data", async () => {
      const embedding = randomEmbedding();
      const ts = new Date("2026-01-15T10:00:00Z");
      await repo.insert([
        createTestEntry("e1", "Debugging async race conditions", "session-42", {
          embedding,
          role: "assistant",
          messageIndex: 5,
          timestamp: ts,
          metadata: { topic: "debugging" },
        }),
      ]);

      const results = await repo.findHybrid(embedding, "debugging async", 10);

      expect(results[0].sessionId).toBe("session-42");
      expect(results[0].role).toBe("assistant");
      expect(results[0].messageIndex).toBe(5);
      expect(results[0].metadata).toEqual({ topic: "debugging" });
    });

    test("FTS mutex prevents concurrent index creation errors", async () => {
      const embedding = randomEmbedding();
      await repo.insert([
        createTestEntry("e1", "Concurrent search test", "session-1", { embedding }),
      ]);

      const promises = [
        repo.findHybrid(embedding, "concurrent", 10),
        repo.findHybrid(embedding, "search", 10),
        repo.findHybrid(embedding, "test", 10),
      ];

      const results = await Promise.all(promises);
      expect(results.every((r) => Array.isArray(r))).toBe(true);
    });
  });

  describe("Indexed Sessions Tracking", () => {
    const createSessionSummary = (
      sessionId: string,
      overrides?: Partial<IndexedSession>
    ) => ({
      sessionId,
      filePath: `/sessions/${sessionId}.jsonl`,
      fileSize: 1024,
      messageCount: 10,
      firstMessageAt: new Date("2026-01-01T00:00:00Z"),
      lastMessageAt: new Date("2026-01-01T01:00:00Z"),
      indexedAt: new Date(),
      ...overrides,
    });

    test("upsert creates and get retrieves a session", async () => {
      const summary = createSessionSummary("sess-1", {
        project: "my-project",
        gitBranch: "main",
      });
      await repo.upsertIndexedSession(summary);

      const result = await repo.getIndexedSession("sess-1");

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sess-1");
      expect(result!.messageCount).toBe(10);
      expect(result!.project).toBe("my-project");
      expect(result!.gitBranch).toBe("main");
    });

    test("upsert updates existing session", async () => {
      await repo.upsertIndexedSession(createSessionSummary("sess-1", { messageCount: 5 }));
      await repo.upsertIndexedSession(createSessionSummary("sess-1", { messageCount: 20 }));

      const result = await repo.getIndexedSession("sess-1");
      expect(result!.messageCount).toBe(20);
    });

    test("get returns null for nonexistent session", async () => {
      const result = await repo.getIndexedSession("nonexistent");
      expect(result).toBeNull();
    });

    test("listIndexedSessions returns all sessions", async () => {
      await repo.upsertIndexedSession(createSessionSummary("sess-1"));
      await repo.upsertIndexedSession(createSessionSummary("sess-2"));

      const sessions = await repo.listIndexedSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-1", "sess-2"]);
    });

    test("deleteIndexedSession removes tracking record", async () => {
      await repo.upsertIndexedSession(createSessionSummary("sess-1"));

      const deleted = await repo.deleteIndexedSession("sess-1");
      expect(deleted).toBe(true);

      const result = await repo.getIndexedSession("sess-1");
      expect(result).toBeNull();
    });

    test("deleteIndexedSession returns false for nonexistent", async () => {
      const deleted = await repo.deleteIndexedSession("nonexistent");
      expect(deleted).toBe(false);
    });

    test("nullable fields default correctly", async () => {
      // No project or gitBranch
      await repo.upsertIndexedSession(createSessionSummary("sess-1"));

      const result = await repo.getIndexedSession("sess-1");
      expect(result!.project).toBeUndefined();
      expect(result!.gitBranch).toBeUndefined();
    });
  });
});
