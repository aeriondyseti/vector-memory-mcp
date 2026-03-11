import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ConversationHistoryService, chunkMessages } from "../src/services/conversation.service";
import type { ConversationRepository } from "../src/db/conversation.repository";
import type { EmbeddingsService } from "../src/services/embeddings.service";
import type { SessionLogParser } from "../src/services/parsers/types";
import type { ConversationHistoryConfig } from "../src/config/index";
import type { ParsedMessage, SessionFileInfo, ConversationHybridRow } from "../src/types/conversation";

// --- Helpers ---

function makeMessage(
  index: number,
  sessionId = "session-1",
  role: "user" | "assistant" = index % 2 === 0 ? "user" : "assistant"
): ParsedMessage {
  return {
    uuid: `msg-${index}`,
    role,
    content: `Message ${index} content`,
    timestamp: new Date(`2026-03-03T${String(10 + index).padStart(2, "0")}:00:00Z`),
    messageIndex: index,
    sessionId,
    project: "test-project",
    isSubagent: false,
  };
}

function makeConfig(overrides: Partial<ConversationHistoryConfig> = {}): ConversationHistoryConfig {
  return {
    enabled: true,
    sessionLogPath: null,
    historyWeight: 0.75,
    chunkOverlap: 1,
    maxChunkMessages: 5,
    indexSubagents: false,
    ...overrides,
  };
}

function createMockRepository(): ConversationRepository {
  return {
    insertBatch: mock(() => Promise.resolve()),
    deleteBySessionId: mock(() => Promise.resolve()),
    findHybrid: mock(() => Promise.resolve([])),
  } as unknown as ConversationRepository;
}

function createMockEmbeddings(): EmbeddingsService {
  const fakeEmbedding = new Array(384).fill(0.1);
  return {
    embed: mock(() => Promise.resolve(fakeEmbedding)),
    embedBatch: mock((texts: string[]) =>
      Promise.resolve(texts.map(() => [...fakeEmbedding]))
    ),
    dimension: 384,
  } as unknown as EmbeddingsService;
}

function createMockParser(
  files: SessionFileInfo[] = [],
  messages: ParsedMessage[] = []
): SessionLogParser {
  return {
    findSessionFiles: mock(() => Promise.resolve(files)),
    parse: mock(() => Promise.resolve(messages)),
  };
}

// --- Tests ---

describe("ConversationHistoryService", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "conv-service-test-"));
    dbPath = join(tmpDir, "test.lancedb");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("indexConversations", () => {
    test("returns early when not enabled", async () => {
      const config = makeConfig({ enabled: false });
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath
      );

      const result = await service.indexConversations();
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toContain("Conversation history indexing is not enabled");
    });

    test("returns zero counts when no session files found", async () => {
      const config = makeConfig({ sessionLogPath: null });
      const parser = createMockParser();
      // Override resolveSessionLogPath by providing a non-existent path
      // The parser will return no files
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath,
        parser
      );

      // The service uses resolveSessionLogPath which will return ~/.claude/projects
      // Our mock parser will return empty file list regardless
      const result = await service.indexConversations();
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    test("indexes new session files", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const messages = [makeMessage(0), makeMessage(1), makeMessage(2)];
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(files, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Verify embeddings were generated
      expect(mockEmbeddings.embedBatch).toHaveBeenCalled();
      // Verify chunks were inserted
      expect(mockRepo.insertBatch).toHaveBeenCalled();
    });

    test("skips unchanged session files", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const messages = [makeMessage(0), makeMessage(1)];
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(files, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      // First pass — indexes
      await service.indexConversations("/tmp");
      expect(mockRepo.insertBatch).toHaveBeenCalledTimes(1);

      // Second pass — same lastModified, should skip
      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockRepo.insertBatch).toHaveBeenCalledTimes(1); // No additional call
    });

    test("re-indexes when file lastModified changes", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const messages = [makeMessage(0)];
      const initialFiles: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(initialFiles, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      await service.indexConversations("/tmp");

      // Now return a newer lastModified
      const updatedFiles: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T13:00:00Z"), // 1hr later
        },
      ];
      (parser.findSessionFiles as ReturnType<typeof mock>).mockReturnValue(
        Promise.resolve(updatedFiles)
      );

      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(0);
      // Should have deleted old chunks first
      expect(mockRepo.deleteBySessionId).toHaveBeenCalledWith("session-1");
    });

    test("handles parse errors gracefully", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date(),
        },
      ];

      const parser: SessionLogParser = {
        findSessionFiles: mock(() => Promise.resolve(files)),
        parse: mock(() => Promise.reject(new Error("File corrupted"))),
      };

      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("File corrupted");
    });

    test("tracks empty sessions in index state", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/empty-session.jsonl",
          sessionId: "empty-session",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(files, []); // No messages
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(1);

      // Should still track — subsequent passes should skip it
      const result2 = await service.indexConversations("/tmp");
      expect(result2.skipped).toBe(1);
    });

    test("passes since parameter to parser", async () => {
      const config = makeConfig();
      const parser = createMockParser();
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath,
        parser
      );

      const since = new Date("2026-01-01");
      await service.indexConversations("/tmp", since);
      expect(parser.findSessionFiles).toHaveBeenCalledWith(
        "/tmp",
        since,
        false // indexSubagents
      );
    });

    test("indexes multiple session files", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const messages = [makeMessage(0)];
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/s1.jsonl",
          sessionId: "session-1",
          project: "p1",
          lastModified: new Date(),
        },
        {
          filePath: "/tmp/s2.jsonl",
          sessionId: "session-2",
          project: "p2",
          lastModified: new Date(),
        },
      ];

      const parser = createMockParser(files, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      const result = await service.indexConversations("/tmp");
      expect(result.indexed).toBe(2);
      expect(result.skipped).toBe(0);
    });
  });

  describe("reindexSession", () => {
    test("returns error when not enabled", async () => {
      const config = makeConfig({ enabled: false });
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath
      );

      const result = await service.reindexSession("session-1");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not enabled");
    });

    test("returns error when session not in index state", async () => {
      const config = makeConfig();
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath
      );

      const result = await service.reindexSession("unknown-session");
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("re-indexes a previously indexed session", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();
      const messages = [makeMessage(0), makeMessage(1)];
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date(),
        },
      ];

      const parser = createMockParser(files, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      // First index normally
      await service.indexConversations("/tmp");

      // Now reindex
      const result = await service.reindexSession("session-1");
      expect(result.success).toBe(true);
      expect(result.chunkCount).toBeGreaterThan(0);
      // Should have called deleteBySessionId again for re-index
      expect(mockRepo.deleteBySessionId).toHaveBeenCalledWith("session-1");
    });
  });

  describe("listIndexedSessions", () => {
    test("returns empty list when no sessions indexed", async () => {
      const config = makeConfig();
      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath
      );

      const result = await service.listIndexedSessions();
      expect(result.sessions).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    test("returns indexed sessions sorted by indexedAt descending", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();

      // Return different messages per call based on session
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/s1.jsonl",
          sessionId: "session-1",
          project: "p1",
          lastModified: new Date("2026-03-01"),
        },
        {
          filePath: "/tmp/s2.jsonl",
          sessionId: "session-2",
          project: "p2",
          lastModified: new Date("2026-03-02"),
        },
      ];

      const parser = createMockParser(files, [makeMessage(0)]);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      await service.indexConversations("/tmp");

      const result = await service.listIndexedSessions();
      expect(result.total).toBe(2);
      expect(result.sessions).toHaveLength(2);
      // Verify descending order by indexedAt
      expect(
        result.sessions[0].indexedAt.getTime()
      ).toBeGreaterThanOrEqual(
        result.sessions[1].indexedAt.getTime()
      );
    });

    test("respects limit and offset", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const mockEmbeddings = createMockEmbeddings();

      const files: SessionFileInfo[] = Array.from({ length: 5 }, (_, i) => ({
        filePath: `/tmp/s${i}.jsonl`,
        sessionId: `session-${i}`,
        project: "p",
        lastModified: new Date(),
      }));

      const parser = createMockParser(files, [makeMessage(0)]);
      const service = new ConversationHistoryService(
        mockRepo,
        mockEmbeddings,
        config,
        dbPath,
        parser
      );

      await service.indexConversations("/tmp");

      const page1 = await service.listIndexedSessions(2, 0);
      expect(page1.sessions).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = await service.listIndexedSessions(2, 2);
      expect(page2.sessions).toHaveLength(2);

      const page3 = await service.listIndexedSessions(2, 4);
      expect(page3.sessions).toHaveLength(1);
    });
  });

  describe("searchHistory", () => {
    test("delegates to repository findHybrid", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const expectedResults: ConversationHybridRow[] = [
        {
          id: "chunk-1",
          content: "test content",
          metadata: { session_id: "s1", role: "user" },
          createdAt: new Date(),
          rrfScore: 0.9,
        },
      ];
      (mockRepo.findHybrid as ReturnType<typeof mock>).mockReturnValue(
        Promise.resolve(expectedResults)
      );

      const service = new ConversationHistoryService(
        mockRepo,
        createMockEmbeddings(),
        config,
        dbPath
      );

      const results = await service.searchHistory(
        "test",
        new Array(384).fill(0.1),
        10
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("chunk-1");
      expect(mockRepo.findHybrid).toHaveBeenCalled();
    });

    test("passes filters to repository", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      (mockRepo.findHybrid as ReturnType<typeof mock>).mockReturnValue(
        Promise.resolve([])
      );

      const service = new ConversationHistoryService(
        mockRepo,
        createMockEmbeddings(),
        config,
        dbPath
      );

      const filters = {
        sessionId: "s1",
        role: "user" as const,
        after: new Date("2026-01-01"),
      };

      await service.searchHistory(
        "test",
        new Array(384).fill(0.1),
        10,
        filters
      );
      expect(mockRepo.findHybrid).toHaveBeenCalledWith(
        expect.any(Array),
        "test",
        10,
        filters
      );
    });
  });

  describe("index state persistence", () => {
    test("persists index state to JSON file", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const messages = [makeMessage(0)];
      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(files, messages);
      const service = new ConversationHistoryService(
        mockRepo,
        createMockEmbeddings(),
        config,
        dbPath,
        parser
      );

      await service.indexConversations("/tmp");

      // Verify state file was written
      const statePath = join(tmpDir, "conversation_index_state.json");
      expect(existsSync(statePath)).toBe(true);

      const stateContent = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(stateContent).toBeArray();
      expect(stateContent).toHaveLength(1);
      expect(stateContent[0].sessionId).toBe("session-1");
    });

    test("loads index state from existing file", async () => {
      const config = makeConfig();
      const mockRepo = createMockRepository();
      const messages = [makeMessage(0)];

      const files: SessionFileInfo[] = [
        {
          filePath: "/tmp/session.jsonl",
          sessionId: "session-1",
          project: "test-project",
          lastModified: new Date("2026-03-03T12:00:00Z"),
        },
      ];

      const parser = createMockParser(files, messages);

      // Create first service instance, index, then discard
      const service1 = new ConversationHistoryService(
        mockRepo,
        createMockEmbeddings(),
        config,
        dbPath,
        parser
      );
      await service1.indexConversations("/tmp");

      // Create new service instance — should load persisted state and skip
      const service2 = new ConversationHistoryService(
        mockRepo,
        createMockEmbeddings(),
        config,
        dbPath,
        parser
      );
      const result = await service2.indexConversations("/tmp");
      expect(result.skipped).toBe(1);
      expect(result.indexed).toBe(0);
    });

    test("handles corrupted state file gracefully", async () => {
      const config = makeConfig();
      const statePath = join(tmpDir, "conversation_index_state.json");
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(statePath, "not valid json {{{");

      const service = new ConversationHistoryService(
        createMockRepository(),
        createMockEmbeddings(),
        config,
        dbPath
      );

      // Should not throw; treats corrupted file as empty state
      const result = await service.listIndexedSessions();
      expect(result.total).toBe(0);
    });
  });
});
