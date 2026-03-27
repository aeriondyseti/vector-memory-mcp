import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../../server/core/connection";
import { MemoryRepository } from "../../server/core/memory.repository";
import { EmbeddingsService } from "../../server/core/embeddings.service";
import { MemoryService } from "../../server/core/memory.service";

describe("MemoryService - Scoring with Intents", () => {
  let db: Database;
  let repository: MemoryRepository;
  let embeddings: EmbeddingsService;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-test-scoring-"));
    const dbPath = join(tmpDir, "test.db");
    db = connectToDatabase(dbPath);
    repository = new MemoryRepository(db);
    embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    service = new MemoryService(repository, embeddings);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  test("search requires intent parameter", async () => {
    await service.store("test content");

    // Should work with intent
    const results = await service.search("test", "fact_check");
    expect(Array.isArray(results)).toBe(true);
  });

  test("continuity intent favors recent memories", async () => {
    const memoryOld = await service.store("project status update");
    const memoryNew = await service.store("project status update");

    // Age memoryOld by 100 hours
    const oldDate = new Date(Date.now() - 100 * 60 * 60 * 1000);
    const oldMem = await repository.findById(memoryOld.id);
    if (oldMem) {
      await repository.upsert({ ...oldMem, lastAccessed: oldDate });
    }

    // continuity favors recency (0.5 weight)
    const results = await service.search("project status", "continuity");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].id).toBe(memoryNew.id);
  });

  test("frequent intent favors high-utility memories", async () => {
    const memNormal = await service.store("coding patterns");
    const memFrequent = await service.store("coding patterns");

    // Boost memFrequent utility
    await service.vote(memFrequent.id, 5);

    // frequent favors utility (0.6 weight)
    const results = await service.search("coding", "frequent");
    expect(results[0].id).toBe(memFrequent.id);
  });

  test("fact_check intent favors relevance", async () => {
    // Test that fact_check with high relevance weight (0.6) prioritizes semantic match
    const memExact = await service.store("TypeScript compiler options and settings");
    const memUnrelated = await service.store("cooking recipes for dinner party");

    // Without any utility boost, the more relevant memory should rank first
    const results = await service.search("TypeScript compiler", "fact_check");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe(memExact.id);
  });

  test("explore intent has high jitter (results may vary)", async () => {
    // Store multiple similar memories
    for (let i = 0; i < 5; i++) {
      await service.store(`memory item ${i} about testing`);
    }

    // Run multiple searches - with 15% jitter, order should sometimes differ
    const results1 = await service.search("testing", "explore", 5);
    const results2 = await service.search("testing", "explore", 5);

    // Both should return results
    expect(results1.length).toBe(5);
    expect(results2.length).toBe(5);

    // Note: Can't reliably test randomness, just verify it doesn't crash
  });

  test("search is read-only (does not update access stats)", async () => {
    const memory = await service.store("read only test");
    const initialAccess = memory.accessCount;

    // Search multiple times
    await service.search("read only", "fact_check");
    await service.search("read only", "fact_check");

    // Check via repository (bypasses service tracking)
    const afterSearch = await repository.findById(memory.id);
    expect(afterSearch!.accessCount).toBe(initialAccess);
  });
});
