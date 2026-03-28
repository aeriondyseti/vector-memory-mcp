import { describe, it, expect, mock } from "bun:test";
import {
  handleSearchMemories,
  handleIndexConversations,
  handleListIndexedSessions,
  handleReindexSession,
} from "../server/transports/mcp/handlers";
import type { MemoryService } from "../server/core/memory.service";
import type { ConversationHistoryService } from "../server/core/conversation.service";
import type { SearchResult, IndexedSession } from "../server/core/conversation";

function createMockService(conversationService: ConversationHistoryService | null = null): MemoryService {
  return {
    search: mock(async (): Promise<SearchResult[]> => []),
    getConversationService: mock(() => conversationService),
  } as unknown as MemoryService;
}

function createMockConversationService(overrides: Partial<ConversationHistoryService> = {}): ConversationHistoryService {
  return {
    indexConversations: mock(async () => ({
      indexed: 2,
      skipped: 1,
      errors: [] as string[],
    })),
    searchHistory: mock(async () => []),
    listIndexedSessions: mock(async () => ({
      sessions: [] as IndexedSession[],
      total: 0,
    })),
    reindexSession: mock(async () => ({
      success: true,
      chunkCount: 5,
    })),
    config: {
      enabled: true,
      sessionLogPath: null,
      historyWeight: 0.75,
      chunkOverlap: 1,
      maxChunkMessages: 10,
      indexSubagents: false,
    },
    ...overrides,
  } as unknown as ConversationHistoryService;
}

// -- search_memories --

describe("handleSearchMemories", () => {
  it("calls search with options including history flags", async () => {
    const service = createMockService(null);
    await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test", history_only: true },
      service,
    );

    expect(service.search).toHaveBeenCalledWith("test", "fact_check", {
      limit: 10,
      includeDeleted: false,
      includeHistory: true,
      historyOnly: true,
      historyFilters: {
        sessionId: undefined,
        role: undefined,
        after: undefined,
        before: undefined,
      },
      offset: 0,
    });
  });

  it("passes include_history and filters through to search", async () => {
    const service = createMockService(null);
    await handleSearchMemories(
      {
        query: "test",
        intent: "continuity",
        reason_for_search: "test",
        include_history: true,
        session_id: "sess-1",
        role_filter: "user",
      },
      service,
    );

    expect(service.search).toHaveBeenCalledWith("test", "continuity", {
      limit: 10,
      includeDeleted: false,
      includeHistory: true,
      historyOnly: false,
      historyFilters: {
        sessionId: "sess-1",
        role: "user",
        after: undefined,
        before: undefined,
      },
      offset: 0,
    });
  });

  it("returns formatted results with source labels", async () => {
    const results: SearchResult[] = [
      {
        source: "memory",
        id: "m-1",
        content: "A memory",
        metadata: { type: "decision" },
        score: 0.8,
        confidence: 0.92,
        createdAt: new Date(),
        updatedAt: new Date(),
        supersededBy: null,
      },
      {
        source: "conversation_history",
        id: "h-1",
        content: "A conversation chunk",
        metadata: {},
        score: 0.6,
        confidence: 0.75,
        createdAt: new Date(),
        updatedAt: new Date(),
        supersededBy: null,
        sessionId: "sess-1",
      },
    ];
    const service = createMockService(null);
    (service.search as ReturnType<typeof mock>).mockResolvedValue(results);

    const result = await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test" },
      service,
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("[memory] ID: m-1");
    expect(text).toContain("[conversation_history] ID: h-1");
    expect(text).toContain("Session: sess-1");
  });

  it("returns no results message when empty", async () => {
    const service = createMockService(null);
    const result = await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test" },
      service,
    );
    expect(result.content[0]).toHaveProperty("text", "No results found matching your query.");
  });
});

// -- index_conversations --

describe("handleIndexConversations", () => {
  it("returns error when history not enabled", async () => {
    const service = createMockService(null);
    const result = await handleIndexConversations({}, service);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("not enabled"));
  });

  it("calls indexConversations and returns summary", async () => {
    const convService = createMockConversationService();
    const service = createMockService(convService);

    const result = await handleIndexConversations({}, service);

    expect(convService.indexConversations).toHaveBeenCalledWith(undefined, undefined);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Indexed: 2");
    expect(text).toContain("Skipped: 1");
    expect(text).toContain("No errors");
  });

  it("passes path and since arguments through", async () => {
    const convService = createMockConversationService();
    const service = createMockService(convService);

    await handleIndexConversations({ path: "/custom/path", since: "2026-03-01" }, service);

    expect(convService.indexConversations).toHaveBeenCalledWith(
      "/custom/path",
      new Date("2026-03-01"),
    );
  });

  it("reports errors in summary", async () => {
    const convService = createMockConversationService({
      indexConversations: mock(async () => ({
        indexed: 0,
        skipped: 0,
        errors: ["sess-1: file not found"],
      })),
    });
    const service = createMockService(convService);

    const result = await handleIndexConversations({}, service);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Errors: 1");
    expect(text).toContain("sess-1: file not found");
  });
});

// -- list_indexed_sessions --

describe("handleListIndexedSessions", () => {
  it("returns error when history not enabled", async () => {
    const service = createMockService(null);
    const result = await handleListIndexedSessions({}, service);
    expect(result.isError).toBe(true);
  });

  it("returns empty message when no sessions", async () => {
    const convService = createMockConversationService();
    const service = createMockService(convService);

    const result = await handleListIndexedSessions({}, service);

    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("No indexed sessions"));
  });

  it("formats session list with pagination info", async () => {
    const sessions: IndexedSession[] = [{
      sessionId: "sess-1",
      filePath: "/tmp/sess-1.jsonl",
      project: "my-project",
      lastModified: Date.now(),
      chunkCount: 8,
      messageCount: 25,
      indexedAt: new Date("2026-03-09T12:00:00Z"),
      firstMessageAt: new Date("2026-03-09T10:00:00Z"),
      lastMessageAt: new Date("2026-03-09T11:00:00Z"),
    }];
    const convService = createMockConversationService({
      listIndexedSessions: mock(async () => ({ sessions, total: 1 })),
    });
    const service = createMockService(convService);

    const result = await handleListIndexedSessions({}, service);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("sess-1");
    expect(text).toContain("Messages: 25");
    expect(text).toContain("Chunks: 8");
    expect(text).toContain("Showing 1-1 of 1");
  });

  it("passes limit and offset through", async () => {
    const convService = createMockConversationService();
    const service = createMockService(convService);

    await handleListIndexedSessions({ limit: 5, offset: 10 }, service);

    expect(convService.listIndexedSessions).toHaveBeenCalledWith(5, 10);
  });
});

// -- reindex_session --

describe("handleReindexSession", () => {
  it("returns error when history not enabled", async () => {
    const service = createMockService(null);
    const result = await handleReindexSession({ session_id: "s-1" }, service);
    expect(result.isError).toBe(true);
  });

  it("calls reindexSession and returns success", async () => {
    const convService = createMockConversationService();
    const service = createMockService(convService);

    const result = await handleReindexSession({ session_id: "sess-1" }, service);

    expect(convService.reindexSession).toHaveBeenCalledWith("sess-1");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("sess-1");
    expect(text).toContain("5 chunks");
  });

  it("returns error on reindex failure", async () => {
    const convService = createMockConversationService({
      reindexSession: mock(async () => ({
        success: false,
        chunkCount: 0,
        error: "Session not found",
      })),
    });
    const service = createMockService(convService);

    const result = await handleReindexSession({ session_id: "bad-id" }, service);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Session not found"));
  });
});
