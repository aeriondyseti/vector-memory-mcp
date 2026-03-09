import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as lancedb from "@lancedb/lancedb";
import { connectToDatabase } from "../src/db/connection";
import { MemoryRepository } from "../src/db/memory.repository";
import { fakeEmbedding } from "./utils/test-helpers";
import type { Memory } from "../src/types/memory";

describe("MemoryRepository - Hybrid Search", () => {
  let db: lancedb.Connection;
  let repository: MemoryRepository;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-repo-test-"));
    const dbPath = join(tmpDir, "test.lancedb");
    db = await connectToDatabase(dbPath);
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  const createTestMemory = (id: string, content: string, embedding: number[]): Memory => ({
    id,
    content,
    embedding,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    supersededBy: null,
    usefulness: 0,
    accessCount: 0,
    lastAccessed: new Date(),
  });

  test("findHybrid returns results with rrfScore", async () => {
    const embedding = fakeEmbedding();
    const memory = createTestMemory("test-1", "TypeScript programming language", embedding);
    await repository.insert(memory);

    const results = await repository.findHybrid(embedding, "TypeScript", 10);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("test-1");
    expect(results[0].rrfScore).toBeDefined();
    expect(typeof results[0].rrfScore).toBe("number");
  });

  test("findHybrid returns full Memory data", async () => {
    const embedding = fakeEmbedding();
    const memory = createTestMemory("test-2", "JavaScript runtime", embedding);
    memory.usefulness = 5;
    memory.accessCount = 10;
    await repository.insert(memory);

    const results = await repository.findHybrid(embedding, "JavaScript", 10);

    expect(results[0].content).toBe("JavaScript runtime");
    expect(results[0].usefulness).toBe(5);
    expect(results[0].accessCount).toBe(10);
    expect(results[0].createdAt).toBeInstanceOf(Date);
  });

  test("findHybrid mutex prevents concurrent index creation", async () => {
    const embedding = fakeEmbedding();
    const memory = createTestMemory("test-3", "Concurrent test content", embedding);
    await repository.insert(memory);

    // Fire multiple concurrent searches - should not throw
    const promises = [
      repository.findHybrid(embedding, "concurrent", 10),
      repository.findHybrid(embedding, "test", 10),
      repository.findHybrid(embedding, "content", 10),
    ];

    const results = await Promise.all(promises);
    expect(results.every(r => Array.isArray(r))).toBe(true);
  });
});
