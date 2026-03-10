import { describe, expect, test, beforeEach, afterEach } from "bun:test";
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
} from "../src/mcp/handlers";
import { createServer } from "../src/mcp/server";
import { connectToDatabase } from "../src/db/connection";
import { MemoryRepository } from "../src/db/memory.repository";
import { EmbeddingsService } from "../src/services/embeddings.service";
import { MemoryService } from "../src/services/memory.service";

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

      expect(response.content[0].text).toBe("No memories found matching your query.");
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

      expect(response.content[0].text).toBe("No memories found matching your query.");
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
});
