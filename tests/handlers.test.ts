import { describe, it, expect, mock } from "bun:test";
import {
  handleSearchMemories,
  handleIndexConversations,
  handleListIndexedSessions,
  handleReindexSession,
} from "../src/mcp/handlers.js";
import type { MemoryService } from "../src/services/memory.service.js";
import type { ConversationHistoryService } from "../src/services/conversation-history.service.js";
import type { HistorySearchResult, IndexedSessionSummary, IndexingSummary, SearchResult } from "../src/types/conversation-history.js";

function createMockService(historyService: ConversationHistoryService | null = null): MemoryService {
  return {
    search: mock(async () => []),
    searchUnified: mock(async () => []),
    getConversationHistory: mock(() => historyService),
  } as unknown as MemoryService;
}

function createMockHistoryService(overrides: Partial<ConversationHistoryService> = {}): ConversationHistoryService {
  return {
    indexConversations: mock(async (): Promise<IndexingSummary> => ({
      sessionsDiscovered: 3,
      sessionsIndexed: 2,
      sessionsSkipped: 1,
      messagesIndexed: 42,
    })),
    search: mock(async (): Promise<HistorySearchResult[]> => []),
    listIndexedSessions: mock(async (): Promise<IndexedSessionSummary[]> => []),
    reindexSession: mock(async (): Promise<IndexingSummary> => ({
      sessionsDiscovered: 1,
      sessionsIndexed: 1,
      sessionsSkipped: 0,
      messagesIndexed: 15,
    })),
    ...overrides,
  } as unknown as ConversationHistoryService;
}

// -- search_memories with include_history / history_only --

describe("handleSearchMemories", () => {
  it("returns error when history_only but history not enabled", async () => {
    const service = createMockService(null);
    const result = await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test", history_only: true },
      service,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("not enabled"));
  });

  it("calls historyService.search when history_only is true", async () => {
    const historySearch = mock(async (): Promise<HistorySearchResult[]> => [
      {
        source: "conversation_history",
        id: "h-1",
        content: "Hello world",
        metadata: {},
        score: 0.9,
        sessionId: "sess-1",
        role: "user",
        messageIndex: 0,
        timestamp: new Date("2026-03-09T10:00:00Z"),
      },
    ]);
    const historyService = createMockHistoryService({ search: historySearch });
    const service = createMockService(historyService);

    const result = await handleSearchMemories(
      { query: "hello", intent: "fact_check", reason_for_search: "test", history_only: true },
      service,
    );

    expect(historySearch).toHaveBeenCalledWith("hello", 10);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("conversation_history"));
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("sess-1"));
  });

  it("calls searchUnified when include_history is true", async () => {
    const unifiedResults: SearchResult[] = [
      {
        source: "memory",
        id: "m-1",
        content: "A memory",
        metadata: { type: "decision" },
        score: 0.8,
        createdAt: new Date(),
        updatedAt: new Date(),
        supersededBy: null,
      },
    ];
    const service = createMockService(null);
    (service.searchUnified as ReturnType<typeof mock>).mockResolvedValue(unifiedResults);

    const result = await handleSearchMemories(
      { query: "test", intent: "continuity", reason_for_search: "test", include_history: true },
      service,
    );

    expect(service.searchUnified).toHaveBeenCalledWith("test", "continuity", 10, false);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Source: memory"));
  });

  it("returns error when both include_history and history_only are true", async () => {
    const service = createMockService(null);
    const result = await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test", include_history: true, history_only: true },
      service,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Cannot set both"));
  });

  it("falls back to memory-only search by default", async () => {
    const service = createMockService(null);
    await handleSearchMemories(
      { query: "test", intent: "fact_check", reason_for_search: "test" },
      service,
    );
    expect(service.search).toHaveBeenCalledWith("test", "fact_check", 10, false);
    expect(service.searchUnified).not.toHaveBeenCalled();
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
    const historyService = createMockHistoryService();
    const service = createMockService(historyService);

    const result = await handleIndexConversations({}, service);

    expect(historyService.indexConversations).toHaveBeenCalledWith(undefined);
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Sessions discovered: 3"));
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Messages indexed: 42"));
  });

  it("passes path argument through", async () => {
    const historyService = createMockHistoryService();
    const service = createMockService(historyService);

    await handleIndexConversations({ path: "/custom/path" }, service);

    expect(historyService.indexConversations).toHaveBeenCalledWith("/custom/path");
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
    const historyService = createMockHistoryService();
    const service = createMockService(historyService);

    const result = await handleListIndexedSessions({}, service);

    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("No indexed sessions"));
  });

  it("formats session list with metadata", async () => {
    const sessions: IndexedSessionSummary[] = [{
      sessionId: "sess-1",
      messageCount: 25,
      firstMessageAt: new Date("2026-03-09T10:00:00Z"),
      lastMessageAt: new Date("2026-03-09T11:00:00Z"),
      indexedAt: new Date("2026-03-09T12:00:00Z"),
      project: "my-project",
      gitBranch: "dev",
    }];
    const historyService = createMockHistoryService({
      listIndexedSessions: mock(async () => sessions),
    });
    const service = createMockService(historyService);

    const result = await handleListIndexedSessions({}, service);
    const text = (result.content[0] as { text: string }).text;

    expect(text).toContain("sess-1");
    expect(text).toContain("Messages: 25");
    expect(text).toContain("Project: my-project");
    expect(text).toContain("Branch: dev");
  });
});

// -- reindex_session --

describe("handleReindexSession", () => {
  it("returns error when history not enabled", async () => {
    const service = createMockService(null);
    const result = await handleReindexSession({ session_id: "s-1" }, service);
    expect(result.isError).toBe(true);
  });

  it("calls reindexSession and returns summary", async () => {
    const historyService = createMockHistoryService();
    const service = createMockService(historyService);

    const result = await handleReindexSession({ session_id: "sess-1" }, service);

    expect(historyService.reindexSession).toHaveBeenCalledWith("sess-1");
    expect(result.content[0]).toHaveProperty("text", expect.stringContaining("Messages indexed: 15"));
  });
});
