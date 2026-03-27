import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { EmbeddingsService } from "../server/core/embeddings.service";
import { MemoryService } from "../server/core/memory.service";

describe("Retrieval - semantically relevant memories appear in results", () => {
  let db: Database;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-test-retrieval-"));
    const dbPath = join(tmpDir, "test.db");
    db = connectToDatabase(dbPath);
    const repository = new MemoryRepository(db);
    const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    service = new MemoryService(repository, embeddings);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true });
  });

  test("exact-topic memory is retrieved among unrelated content", async () => {
    const target = await service.store("TypeScript compiler options and settings");
    await service.store("cooking recipes for dinner party");
    await service.store("vacation planning for summer trip");

    const results = await service.search("TypeScript compiler", "fact_check");
    const ids = results.map((r) => r.id);
    expect(ids).toContain(target.id);
  });

  test("each intent retrieves the relevant memory", async () => {
    const target = await service.store("database migration strategy for PostgreSQL");
    await service.store("gardening tips for spring flowers");
    await service.store("movie recommendations for weekend");

    const intents = ["fact_check", "continuity", "frequent", "associative", "explore"] as const;
    for (const intent of intents) {
      const results = await service.search("database migration PostgreSQL", intent);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(target.id);
    }
  });

  test("multiple relevant memories are all retrieved", async () => {
    const mem1 = await service.store("React component lifecycle and hooks");
    const mem2 = await service.store("React useState and useEffect patterns");
    await service.store("Italian pasta recipes from grandma");

    const results = await service.search("React hooks", "fact_check", { limit: 10 });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(mem1.id);
    expect(ids).toContain(mem2.id);
  });
});
