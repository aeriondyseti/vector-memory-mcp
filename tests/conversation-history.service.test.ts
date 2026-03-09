import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir, truncate, appendFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { connectToDatabase } from "../src/db/connection.js";
import { ConversationHistoryRepository } from "../src/db/conversation-history.repository.js";
import { ConversationHistoryService } from "../src/services/conversation-history.service.js";
import type { EmbeddingsService } from "../src/services/embeddings.service.js";

const EMBEDDING_DIM = 384;
const fakeEmbedding = () => new Array(EMBEDDING_DIM).fill(0).map(() => Math.random());

/**
 * Stub EmbeddingsService that returns deterministic random embeddings.
 * Avoids loading the real model in tests.
 */
function createMockEmbeddings(): EmbeddingsService {
  return {
    dimension: EMBEDDING_DIM,
    embed: vi.fn(async () => fakeEmbedding()),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => fakeEmbedding())),
  } as unknown as EmbeddingsService;
}

// -- JSONL helpers (reused from session-parser.test.ts pattern) --

function userLine(content: string, opts: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: opts.sessionId ?? "test-session",
    timestamp: opts.timestamp ?? "2026-03-09T10:00:00Z",
    gitBranch: opts.gitBranch ?? "main",
    cwd: opts.cwd ?? "/project",
    message: { role: "user", content },
    uuid: "u-1",
    ...opts,
  });
}

function assistantLine(
  blocks: Array<{ type: string; text?: string }>,
  opts: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: opts.sessionId ?? "test-session",
    timestamp: opts.timestamp ?? "2026-03-09T10:01:00Z",
    gitBranch: opts.gitBranch ?? "main",
    cwd: opts.cwd ?? "/project",
    message: { role: "assistant", content: blocks },
    uuid: "a-1",
    ...opts,
  });
}

let tmpDir: string;
let dbDir: string;
let db: lancedb.Connection;
let repo: ConversationHistoryRepository;
let embeddings: EmbeddingsService;
let service: ConversationHistoryService;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ch-service-test-"));
  dbDir = join(tmpDir, "db");
  await mkdir(dbDir);
  db = await connectToDatabase(join(dbDir, "test.lancedb"));
  repo = new ConversationHistoryRepository(db);
  embeddings = createMockEmbeddings();
  // sessionPath = tmpDir (contains .jsonl files directly)
  service = new ConversationHistoryService(repo, embeddings, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ConversationHistoryService", () => {
  describe("indexConversations — fresh sessions", () => {
    it("indexes new JSONL files and creates tracking records", async () => {
      const lines = [
        userLine("Hello there"),
        assistantLine([{ type: "text", text: "Hi! How can I help?" }]),
      ];
      await writeFile(join(tmpDir, "sess-1.jsonl"), lines.join("\n") + "\n");

      const summary = await service.indexConversations();

      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsIndexed).toBe(1);
      expect(summary.sessionsSkipped).toBe(0);
      expect(summary.messagesIndexed).toBe(2);

      // Verify tracking record
      const sessions = await repo.listIndexedSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe("sess-1");
      expect(sessions[0].messageCount).toBe(2);

      // Verify entries were inserted
      const entries = await repo.findBySessionId("sess-1");
      expect(entries).toHaveLength(2);
    });

    it("indexes multiple sessions in one call", async () => {
      await writeFile(
        join(tmpDir, "sess-a.jsonl"),
        userLine("Session A") + "\n",
      );
      await writeFile(
        join(tmpDir, "sess-b.jsonl"),
        userLine("Session B") + "\n",
      );

      const summary = await service.indexConversations();

      expect(summary.sessionsDiscovered).toBe(2);
      expect(summary.sessionsIndexed).toBe(2);
      expect(summary.messagesIndexed).toBe(2);
    });
  });

  describe("indexConversations — incremental", () => {
    it("only indexes new messages when a file has grown", async () => {
      const filePath = join(tmpDir, "sess-inc.jsonl");
      const line1 = userLine("First message");
      await writeFile(filePath, line1 + "\n");

      // First index
      await service.indexConversations();

      // Append a new line
      const line2 = userLine("Second message", { timestamp: "2026-03-09T11:00:00Z" });
      await appendFile(filePath, line2 + "\n");

      // Second index — should be incremental
      const summary = await service.indexConversations();

      expect(summary.sessionsIndexed).toBe(1);
      expect(summary.messagesIndexed).toBe(1); // Only the new message

      // Tracking should show total count
      const sessions = await repo.listIndexedSessions();
      expect(sessions[0].messageCount).toBe(2);

      // Total entries in DB
      const entries = await repo.findBySessionId("sess-inc");
      expect(entries).toHaveLength(2);
    });
  });

  describe("indexConversations — skip unchanged", () => {
    it("skips files with unchanged size on re-index", async () => {
      await writeFile(
        join(tmpDir, "sess-skip.jsonl"),
        userLine("Static content") + "\n",
      );

      await service.indexConversations();
      const summary = await service.indexConversations();

      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsSkipped).toBe(1);
      expect(summary.sessionsIndexed).toBe(0);
      expect(summary.messagesIndexed).toBe(0);
    });
  });

  describe("indexConversations — shrunk file", () => {
    it("does full reindex when file size decreases", async () => {
      const filePath = join(tmpDir, "sess-shrunk.jsonl");
      const longContent = [
        userLine("Message one"),
        userLine("Message two"),
        userLine("Message three"),
      ].join("\n") + "\n";
      await writeFile(filePath, longContent);

      await service.indexConversations();

      // Verify initial state
      let entries = await repo.findBySessionId("sess-shrunk");
      expect(entries).toHaveLength(3);

      // Truncate and rewrite with less content
      const shortContent = userLine("Only message") + "\n";
      await writeFile(filePath, shortContent);

      const summary = await service.indexConversations();

      expect(summary.sessionsIndexed).toBe(1);
      expect(summary.messagesIndexed).toBe(1);

      // Old entries should be gone, replaced with new
      entries = await repo.findBySessionId("sess-shrunk");
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("Only message");
    });
  });

  describe("reindexSession", () => {
    it("clears and re-parses a session from scratch", async () => {
      const filePath = join(tmpDir, "sess-reindex.jsonl");
      await writeFile(filePath, userLine("Original") + "\n");
      await service.indexConversations();

      // Overwrite with new content (same size or different)
      await writeFile(filePath, userLine("Replaced") + "\n");

      const summary = await service.reindexSession("sess-reindex");

      expect(summary.sessionsIndexed).toBe(1);
      expect(summary.messagesIndexed).toBe(1);

      const entries = await repo.findBySessionId("sess-reindex");
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe("Replaced");
    });

    it("returns skip summary for unknown session ID", async () => {
      const summary = await service.reindexSession("nonexistent");

      expect(summary.sessionsSkipped).toBe(1);
      expect(summary.sessionsIndexed).toBe(0);
    });
  });

  describe("search", () => {
    it("returns HistorySearchResult with source field", async () => {
      await writeFile(
        join(tmpDir, "sess-search.jsonl"),
        userLine("TypeScript programming language") + "\n",
      );
      await service.indexConversations();

      const results = await service.search("TypeScript", 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].source).toBe("conversation_history");
      expect(results[0].sessionId).toBe("sess-search");
      expect(typeof results[0].score).toBe("number");
    });
  });

  describe("listIndexedSessions", () => {
    it("returns all tracked sessions via pass-through", async () => {
      await writeFile(join(tmpDir, "sess-x.jsonl"), userLine("X") + "\n");
      await writeFile(join(tmpDir, "sess-y.jsonl"), userLine("Y") + "\n");
      await service.indexConversations();

      const sessions = await service.listIndexedSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["sess-x", "sess-y"]);
    });
  });

  describe("resolveSessionDirs", () => {
    it("scans subdirectories when base has no .jsonl files", async () => {
      // Create a project-style directory structure
      const projectDir = join(tmpDir, "projects");
      await mkdir(projectDir);
      const subDir = join(projectDir, "my-project");
      await mkdir(subDir);
      await writeFile(join(subDir, "sess-sub.jsonl"), userLine("In subdirectory") + "\n");

      // Service pointed at the projects dir (no .jsonl at root)
      const subService = new ConversationHistoryService(repo, embeddings, projectDir);
      const summary = await subService.indexConversations();

      expect(summary.sessionsDiscovered).toBe(1);
      expect(summary.sessionsIndexed).toBe(1);
    });
  });
});
