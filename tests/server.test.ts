import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { tools } from "../src/mcp/tools";
import {
  handleToolCall,
  handleStoreMemories,
  handleUpdateMemories,
  handleDeleteMemories,
  handleSearchMemories,
  handleGetMemories,
  handleStoreCheckpoint,
  handleGetCheckpoint,
  handleIndexConversations,
  handleListIndexedSessions,
  handleReindexSession,
  handleReportMemoryUsefulness,
} from "../src/mcp/handlers";
import { createServer } from "../src/mcp/server";
import { connectToDatabase } from "../src/db/connection";
import { MemoryRepository } from "../src/db/memory.repository";
import { EmbeddingsService } from "../src/services/embeddings.service";
import { MemoryService } from "../src/services/memory.service";
import type { ConversationHistoryService } from "../src/services/conversation.service";
import type { IndexedSession, ConversationHybridRow } from "../src/types/conversation";

describe("mcp", () => {
  let db: lancedb.Connection;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-test-"));
    const dbPath = join(tmpDir, "test.lancedb");
    db = await connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    service = new MemoryService(repository, embeddings);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  describe("tools", () => {
    test("exports 11 tools", () => {
      expect(tools).toBeArray();
      expect(tools.length).toBe(11);
    });

    test("has store_memories tool", () => {
      const tool = tools.find((t) => t.name === "store_memories");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("memories");
    });

    test("has delete_memories tool", () => {
      const tool = tools.find((t) => t.name === "delete_memories");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("ids");
    });

    test("has update_memories tool", () => {
      const tool = tools.find((t) => t.name === "update_memories");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("updates");
    });

    test("has search_memories tool", () => {
      const tool = tools.find((t) => t.name === "search_memories");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("query");
    });

    test("has get_memories tool", () => {
      const tool = tools.find((t) => t.name === "get_memories");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("ids");
    });

    test("has store_checkpoint tool", () => {
      const tool = tools.find((t) => t.name === "store_checkpoint");
      expect(tool).toBeDefined();
    });

    test("has get_checkpoint tool", () => {
      const tool = tools.find((t) => t.name === "get_checkpoint");
      expect(tool).toBeDefined();
    });

    test("has index_conversations tool", () => {
      const tool = tools.find((t) => t.name === "index_conversations");
      expect(tool).toBeDefined();
    });

    test("has list_indexed_sessions tool", () => {
      const tool = tools.find((t) => t.name === "list_indexed_sessions");
      expect(tool).toBeDefined();
    });

    test("has reindex_session tool", () => {
      const tool = tools.find((t) => t.name === "reindex_session");
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain("session_id");
    });

    test("search_memories has history params", () => {
      const tool = tools.find((t) => t.name === "search_memories");
      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, unknown>;
      expect(props.include_history).toBeDefined();
      expect(props.history_only).toBeDefined();
      expect(props.session_id).toBeDefined();
    });
  });

  describe("handleStoreMemories", () => {
    test("stores memory and returns ID", async () => {
      const response = await handleStoreMemories(
        { memories: [{ content: "test content" }] },
        service
      );

      expect(response.content).toBeArray();
      expect(response.content[0].type).toBe("text");
      expect(response.content[0].text).toMatch(/Memory stored with ID: .+/);
    });

    test("stores memory with metadata", async () => {
      const response = await handleStoreMemories(
        { memories: [{ content: "test", metadata: { key: "value" } }] },
        service
      );

      expect(response.content[0].text).toMatch(/Memory stored with ID:/);

      const idMatch = response.content[0].text.match(/Memory stored with ID: (.+)/);
      const memory = await service.get(idMatch![1]);
      expect(memory!.metadata).toEqual({ key: "value" });
    });

    test("stores multiple memories", async () => {
      const response = await handleStoreMemories(
        { memories: [{ content: "a" }, { content: "b" }] },
        service
      );
      expect(response.content[0].text).toContain("Stored 2 memories");
    });
  });

  describe("handleDeleteMemories", () => {
    test("deletes existing memory", async () => {
      const mem = await service.store("test");

      const response = await handleDeleteMemories({ ids: [mem.id] }, service);

      expect(response.content[0].text).toBe(`Memory ${mem.id} deleted successfully`);
    });

    test("returns not found for non-existent ID", async () => {
      const response = await handleDeleteMemories({ ids: ["non-existent"] }, service);

      expect(response.content[0].text).toBe("Memory non-existent not found");
    });

    test("deletes multiple memories", async () => {
      const a = await service.store("a");
      const b = await service.store("b");

      const response = await handleDeleteMemories({ ids: [a.id, b.id] }, service);

      expect(response.content[0].text).toContain(`Memory ${a.id} deleted successfully`);
      expect(response.content[0].text).toContain(`Memory ${b.id} deleted successfully`);
    });
  });

  describe("handleUpdateMemories", () => {
    test("updates memory content", async () => {
      const mem = await service.store("original content");

      const response = await handleUpdateMemories(
        { updates: [{ id: mem.id, content: "updated content" }] },
        service
      );

      expect(response.content[0].text).toBe(`Memory ${mem.id} updated successfully`);

      const updated = await service.get(mem.id);
      expect(updated!.content).toBe("updated content");
    });

    test("updates memory metadata", async () => {
      const mem = await service.store("test", { old: "value" });

      await handleUpdateMemories(
        { updates: [{ id: mem.id, metadata: { new: "data" } }] },
        service
      );

      const updated = await service.get(mem.id);
      expect(updated!.metadata).toEqual({ new: "data" });
    });

    test("returns not found for non-existent ID", async () => {
      const response = await handleUpdateMemories(
        { updates: [{ id: "non-existent", content: "test" }] },
        service
      );

      expect(response.content[0].text).toBe("Memory non-existent not found");
    });

    test("updates multiple memories", async () => {
      const a = await service.store("a");
      const b = await service.store("b");

      const response = await handleUpdateMemories(
        {
          updates: [
            { id: a.id, content: "updated a" },
            { id: b.id, content: "updated b" },
          ],
        },
        service
      );

      expect(response.content[0].text).toContain(`Memory ${a.id} updated successfully`);
      expect(response.content[0].text).toContain(`Memory ${b.id} updated successfully`);
    });
  });

  describe("handleSearchMemories", () => {
    test("returns matching memories", async () => {
      await service.store("Python programming language");
      await service.store("JavaScript web development");

      const response = await handleSearchMemories({ query: "programming", intent: "fact_check", reason_for_search: "test" }, service);

      expect(response.content[0].text).toContain("Python");
    });

    test("returns no memories message when empty", async () => {
      const response = await handleSearchMemories({ query: "nonexistent", intent: "fact_check", reason_for_search: "test" }, service);

      expect(response.content[0].text).toBe("No results found matching your query.");
    });

    test("respects limit parameter", async () => {
      await service.store("Memory 1");
      await service.store("Memory 2");
      await service.store("Memory 3");

      const response = await handleSearchMemories(
        { query: "memory", intent: "fact_check", reason_for_search: "test", limit: 1 },
        service
      );

      expect(response.content[0].text).not.toContain("---");
    });

    test("includes metadata in results", async () => {
      await service.store("Test memory", { tag: "important" });

      const response = await handleSearchMemories({ query: "test", intent: "fact_check", reason_for_search: "test" }, service);

      expect(response.content[0].text).toContain("Metadata:");
      expect(response.content[0].text).toContain("important");
    });

    test("separates multiple results with ---", async () => {
      await service.store("First memory");
      await service.store("Second memory");

      const response = await handleSearchMemories(
        { query: "memory", intent: "fact_check", reason_for_search: "test", limit: 2 },
        service
      );

      expect(response.content[0].text).toContain("---");
    });

    test("excludes deleted memories by default", async () => {
      const mem = await service.store("deleted memory content");
      await service.delete(mem.id);

      const response = await handleSearchMemories(
        { query: "deleted memory", intent: "fact_check", reason_for_search: "test" },
        service
      );

      expect(response.content[0].text).toBe("No results found matching your query.");
    });

    test("search results include source field", async () => {
      await service.store("test content for source check");

      const response = await handleSearchMemories(
        { query: "source check", intent: "fact_check", reason_for_search: "test" },
        service
      );

      expect(response.content[0].text).toContain("[memory]");
    });

    test("includes deleted memories when include_deleted is true", async () => {
      const mem = await service.store("deleted memory content");
      await service.delete(mem.id);

      const response = await handleSearchMemories(
        { query: "deleted memory", intent: "fact_check", reason_for_search: "test", include_deleted: true },
        service
      );

      expect(response.content[0].text).toContain("deleted memory content");
      expect(response.content[0].text).toContain("[DELETED]");
    });
  });

  describe("handleGetMemories", () => {
    test("returns memory details", async () => {
      const mem = await service.store("test content", { key: "value" });

      const response = await handleGetMemories({ ids: [mem.id] }, service);

      const text = response.content[0].text;
      expect(text).toContain(`ID: ${mem.id}`);
      expect(text).toContain("Content: test content");
      expect(text).toContain("Metadata:");
      expect(text).toContain("Created:");
      expect(text).toContain("Updated:");
    });

    test("returns not found for non-existent ID", async () => {
      const response = await handleGetMemories({ ids: ["non-existent"] }, service);

      expect(response.content[0].text).toBe("Memory non-existent not found");
    });

    test("includes supersededBy when set", async () => {
      const mem = await service.store("test");
      await service.delete(mem.id);

      const response = await handleGetMemories({ ids: [mem.id] }, service);

      expect(response.content[0].text).toContain("Superseded by: DELETED");
    });

    test("omits metadata line when empty", async () => {
      const mem = await service.store("test");

      const response = await handleGetMemories({ ids: [mem.id] }, service);

      expect(response.content[0].text).not.toContain("Metadata:");
    });

    test("retrieves multiple memories", async () => {
      const a = await service.store("a");
      const b = await service.store("b");

      const response = await handleGetMemories({ ids: [a.id, b.id] }, service);

      expect(response.content[0].text).toContain(a.id);
      expect(response.content[0].text).toContain(b.id);
      expect(response.content[0].text).toContain("---");
    });
  });

  describe("checkpoint handlers", () => {
    test("store_checkpoint and get_checkpoint work", async () => {
      await handleStoreCheckpoint(
        {
          project: "Resonance",
          branch: "main",
          summary: "S",
          completed: ["Did X"],
          in_progress_blocked: ["Doing Y"],
          key_decisions: ["Chose Z"],
          next_steps: ["Do W"],
          memory_ids: ["123"],
        },
        service
      );
      const response = await handleGetCheckpoint({}, service);
      expect(response.content[0].text).toContain("# Checkpoint - Resonance");
      expect(response.content[0].text).toContain("## Memory IDs");
    });
  });

  describe("handleToolCall", () => {
    test("routes to store_memories", async () => {
      const response = await handleToolCall(
        "store_memories",
        { memories: [{ content: "test" }] },
        service
      );
      expect(response.content[0].text).toMatch(/Memory stored with ID:/);
    });

    test("routes to delete_memories", async () => {
      const mem = await service.store("test");
      const response = await handleToolCall(
        "delete_memories",
        { ids: [mem.id] },
        service
      );
      expect(response.content[0].text).toContain("deleted successfully");
    });

    test("routes to update_memories", async () => {
      const mem = await service.store("original");
      const response = await handleToolCall(
        "update_memories",
        { updates: [{ id: mem.id, content: "updated" }] },
        service
      );
      expect(response.content[0].text).toContain("updated successfully");
    });

    test("routes to search_memories", async () => {
      await service.store("test content");
      const response = await handleToolCall(
        "search_memories",
        { query: "test", intent: "fact_check", reason_for_search: "test" },
        service
      );
      expect(response.content[0].text).toContain("test content");
    });

    test("routes to get_memories", async () => {
      const mem = await service.store("test");
      const response = await handleToolCall(
        "get_memories",
        { ids: [mem.id] },
        service
      );
      expect(response.content[0].text).toContain(mem.id);
    });

    test("routes to store_checkpoint and get_checkpoint", async () => {
      const storeRes = await handleToolCall(
        "store_checkpoint",
        { project: "Resonance", summary: "Summary" },
        service
      );
      expect(storeRes.content[0].text).toContain("Checkpoint stored");

      const getRes = await handleToolCall("get_checkpoint", {}, service);
      expect(getRes.content[0].text).toContain("# Checkpoint - Resonance");
    });

    test("routes to index_conversations (returns error when disabled)", async () => {
      const response = await handleToolCall(
        "index_conversations",
        {},
        service
      );
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("not enabled");
    });

    test("routes to list_indexed_sessions (returns error when disabled)", async () => {
      const response = await handleToolCall(
        "list_indexed_sessions",
        {},
        service
      );
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("not enabled");
    });

    test("routes to reindex_session (returns error when disabled)", async () => {
      const response = await handleToolCall(
        "reindex_session",
        { session_id: "test-id" },
        service
      );
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("not enabled");
    });

    test("returns error for unknown tool", async () => {
      const response = await handleToolCall("unknown_tool", {}, service);

      expect(response.content[0].text).toBe("Unknown tool: unknown_tool");
      expect(response.isError).toBe(true);
    });
  });

  describe("createServer", () => {
    test("creates server instance", () => {
      const server = createServer(service);
      expect(server).toBeDefined();
    });
  });

  describe("handleReportMemoryUsefulness", () => {
    test("marks memory as useful", async () => {
      const mem = await service.store("test");
      const response = await handleReportMemoryUsefulness(
        { memory_id: mem.id, useful: true },
        service
      );
      expect(response.content[0].text).toContain("useful");
      expect(response.content[0].text).toContain("usefulness score: 1");
    });

    test("marks memory as not useful", async () => {
      const mem = await service.store("test");
      const response = await handleReportMemoryUsefulness(
        { memory_id: mem.id, useful: false },
        service
      );
      expect(response.content[0].text).toContain("not useful");
      expect(response.content[0].text).toContain("usefulness score: -1");
    });

    test("returns error for non-existent memory", async () => {
      const response = await handleReportMemoryUsefulness(
        { memory_id: "non-existent", useful: true },
        service
      );
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("not found");
    });
  });

  describe("conversation handlers with service enabled", () => {
    function createMockConversationService(
      overrides: Partial<ConversationHistoryService> = {}
    ): ConversationHistoryService {
      return {
        config: {
          enabled: true,
          sessionLogPath: null,
          historyWeight: 0.3,
          chunkOverlap: 1,
          maxChunkMessages: 10,
          indexSubagents: false,
        },
        indexConversations: mock(() =>
          Promise.resolve({ indexed: 3, skipped: 2, errors: [] })
        ),
        listIndexedSessions: mock(() =>
          Promise.resolve({
            sessions: [
              {
                sessionId: "s1",
                filePath: "/tmp/s1.jsonl",
                project: "test-project",
                lastModified: Date.now(),
                chunkCount: 5,
                messageCount: 10,
                indexedAt: new Date("2026-03-03T12:00:00Z"),
                firstMessageAt: new Date("2026-03-03T10:00:00Z"),
                lastMessageAt: new Date("2026-03-03T11:00:00Z"),
              } satisfies IndexedSession,
            ],
            total: 1,
          })
        ),
        reindexSession: mock(() =>
          Promise.resolve({ success: true, chunkCount: 5 })
        ),
        searchHistory: mock(() => Promise.resolve([])),
        ...overrides,
      } as unknown as ConversationHistoryService;
    }

    test("handleIndexConversations returns indexed count", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      const response = await handleIndexConversations({}, service);
      expect(response.content[0].text).toContain("Indexed: 3 sessions");
      expect(response.content[0].text).toContain("Skipped: 2 sessions");
      expect(response.content[0].text).toContain("No errors");
    });

    test("handleIndexConversations passes path and since params", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      await handleIndexConversations(
        { path: "/custom/path", since: "2026-01-01" },
        service
      );
      expect(convService.indexConversations).toHaveBeenCalledWith(
        "/custom/path",
        expect.any(Date)
      );
    });

    test("handleIndexConversations reports errors", async () => {
      const convService = createMockConversationService({
        indexConversations: mock(() =>
          Promise.resolve({
            indexed: 1,
            skipped: 0,
            errors: ["session-x: parse failure"],
          })
        ),
      });
      service.setConversationService(convService);

      const response = await handleIndexConversations({}, service);
      expect(response.content[0].text).toContain("Errors: 1");
      expect(response.content[0].text).toContain("parse failure");
    });

    test("handleListIndexedSessions formats session list", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      const response = await handleListIndexedSessions({}, service);
      expect(response.content[0].text).toContain("Session: s1");
      expect(response.content[0].text).toContain("Project: test-project");
      expect(response.content[0].text).toContain("Messages: 10");
      expect(response.content[0].text).toContain("Chunks: 5");
    });

    test("handleListIndexedSessions passes limit and offset", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      await handleListIndexedSessions({ limit: 5, offset: 10 }, service);
      expect(convService.listIndexedSessions).toHaveBeenCalledWith(5, 10);
    });

    test("handleListIndexedSessions handles empty results", async () => {
      const convService = createMockConversationService({
        listIndexedSessions: mock(() =>
          Promise.resolve({ sessions: [], total: 0 })
        ),
      });
      service.setConversationService(convService);

      const response = await handleListIndexedSessions({}, service);
      expect(response.content[0].text).toContain("No indexed sessions");
    });

    test("handleReindexSession returns success", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      const response = await handleReindexSession(
        { session_id: "s1" },
        service
      );
      expect(response.content[0].text).toContain("reindexed successfully");
      expect(response.content[0].text).toContain("5 chunks");
    });

    test("handleReindexSession returns error on failure", async () => {
      const convService = createMockConversationService({
        reindexSession: mock(() =>
          Promise.resolve({
            success: false,
            chunkCount: 0,
            error: "Session not found in index state",
          })
        ),
      });
      service.setConversationService(convService);

      const response = await handleReindexSession(
        { session_id: "unknown" },
        service
      );
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("not found");
    });

    test("handleSearchMemories includes conversation history results", async () => {
      await service.store("memory about TypeScript");

      const convService = createMockConversationService({
        searchHistory: mock(() =>
          Promise.resolve([
            {
              id: "conv-1",
              content: "Discussion about TypeScript generics",
              metadata: {
                session_id: "s1",
                role: "assistant",
                message_index_start: 0,
                message_index_end: 2,
              },
              createdAt: new Date(),
              rrfScore: 0.8,
            } satisfies ConversationHybridRow,
          ])
        ),
      });
      service.setConversationService(convService);

      const response = await handleSearchMemories(
        { query: "TypeScript", intent: "fact_check", reason_for_search: "test" },
        service
      );

      const text = response.content[0].text;
      expect(text).toContain("[memory]");
      expect(text).toContain("[conversation_history]");
      expect(text).toContain("Session: s1");
    });

    test("handleSearchMemories respects history_only flag", async () => {
      await service.store("explicit memory");

      const convService = createMockConversationService({
        searchHistory: mock(() =>
          Promise.resolve([
            {
              id: "conv-1",
              content: "conversation content",
              metadata: { session_id: "s1", role: "user" },
              createdAt: new Date(),
              rrfScore: 0.9,
            } satisfies ConversationHybridRow,
          ])
        ),
      });
      service.setConversationService(convService);

      const response = await handleSearchMemories(
        {
          query: "content",
          intent: "fact_check",
          reason_for_search: "test",
          history_only: true,
        },
        service
      );

      const text = response.content[0].text;
      // Should only have conversation_history results
      expect(text).toContain("[conversation_history]");
      expect(text).not.toContain("[memory]");
    });

    test("handleSearchMemories passes filter params to history search", async () => {
      const convService = createMockConversationService();
      service.setConversationService(convService);

      await handleSearchMemories(
        {
          query: "test",
          intent: "fact_check",
          reason_for_search: "test",
          session_id: "s1",
          role_filter: "user",
          history_after: "2026-01-01",
          history_before: "2026-12-31",
        },
        service
      );

      // The convService.searchHistory should have been called with filters
      expect(convService.searchHistory).toHaveBeenCalled();
    });
  });
});
