import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection.js";
import { MemoryRepository } from "../server/core/memory.repository.js";
import { EmbeddingsService } from "../server/core/embeddings.service.js";
import { MemoryService } from "../server/core/memory.service.js";

describe("MemoryService - Access Tracking", () => {
  let db: Database;
  let repository: MemoryRepository;
  let embeddings: EmbeddingsService;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-test-access-"));
    const dbPath = join(tmpDir, "test.db");
    db = connectToDatabase(dbPath);
    repository = new MemoryRepository(db);
    embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    service = new MemoryService(repository, embeddings);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("initial accessCount is 0, lastAccessed equals createdAt", async () => {
    const memory = await service.store("test content");
    expect(memory.accessCount).toBe(0);
    expect(memory.lastAccessed).not.toBeNull();
    expect(memory.lastAccessed!.getTime()).toBe(memory.createdAt.getTime());
  });

  test("get increments accessCount and updates lastAccessed", async () => {
    const memory = await service.store("test content");

    await new Promise((r) => setTimeout(r, 10));
    const retrieved1 = await service.get(memory.id);

    expect(retrieved1!.accessCount).toBe(1);
    expect(retrieved1!.lastAccessed!.getTime()).toBeGreaterThan(memory.createdAt.getTime());

    await new Promise((r) => setTimeout(r, 10));
    const retrieved2 = await service.get(memory.id);

    expect(retrieved2!.accessCount).toBe(2);
    expect(retrieved2!.lastAccessed!.getTime()).toBeGreaterThan(retrieved1!.lastAccessed!.getTime());
  });

  test("search does NOT increment accessCount (read-only)", async () => {
    const memory = await service.store("Python programming");

    await service.search("coding", "fact_check");
    await service.search("coding", "fact_check");

    // Check via repository to avoid service.get side effects
    const direct = await repository.findById(memory.id);
    expect(direct!.accessCount).toBe(0);
  });

  test("vote increments accessCount and updates lastAccessed", async () => {
    const memory = await service.store("useful content");

    await new Promise((r) => setTimeout(r, 10));
    await service.vote(memory.id, 1);

    const after = await repository.findById(memory.id);
    expect(after!.accessCount).toBe(1);
    expect(after!.lastAccessed!.getTime()).toBeGreaterThan(memory.createdAt.getTime());
  });

  test("trackAccess updates multiple memories", async () => {
    const mem1 = await service.store("memory one");
    const mem2 = await service.store("memory two");

    await new Promise((r) => setTimeout(r, 10));
    await service.trackAccess([mem1.id, mem2.id]);

    const after1 = await repository.findById(mem1.id);
    const after2 = await repository.findById(mem2.id);

    expect(after1!.accessCount).toBe(1);
    expect(after2!.accessCount).toBe(1);
  });

  test("setWaypoint tracks access for memory_ids", async () => {
    const mem1 = await service.store("decision about API design");
    const mem2 = await service.store("architecture notes");

    await new Promise((r) => setTimeout(r, 10));
    await service.setWaypoint({
      project: "test-project",
      summary: "Test waypoint",
      memory_ids: [mem1.id, mem2.id],
    });

    const after1 = await repository.findById(mem1.id);
    const after2 = await repository.findById(mem2.id);

    expect(after1!.accessCount).toBe(1);
    expect(after2!.accessCount).toBe(1);
  });
});
