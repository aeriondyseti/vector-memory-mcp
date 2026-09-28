import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { handleToolCall } from "../server/transports/mcp/handlers";
import { createMockEmbeddings, removeDir } from "./utils/test-helpers";

describe("Phase 2 — archiving, TTL, search modes", () => {
  let db: Database;
  let repository: MemoryRepository;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "phase2-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    service = new MemoryService(repository, createMockEmbeddings(), "/proj/test");
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  const idsInSearch = async (
    query: string,
    opts: Record<string, unknown> = {},
  ): Promise<string[]> => {
    const results = await service.search(query, "fact_check", {
      includeHistory: false,
      ...opts,
    });
    return results.map((r) => r.id);
  };

  describe("archiving (Feature 8)", () => {
    test("archived memories are excluded from search, restored on unarchive", async () => {
      const m = await service.store("archivable widget content");

      expect(await idsInSearch("archivable widget")).toContain(m.id);

      const changed = await service.setArchived([m.id], true);
      expect(changed).toBe(1);
      expect(await idsInSearch("archivable widget")).not.toContain(m.id);

      // include_archived surfaces it again
      expect(
        await idsInSearch("archivable widget", { includeArchived: true }),
      ).toContain(m.id);

      await service.setArchived([m.id], false);
      expect(await idsInSearch("archivable widget")).toContain(m.id);
    });

    test("archive_memory / unarchive_memory tools round-trip", async () => {
      const m = await service.store("tooled archive content");

      const archived = await handleToolCall(
        "archive_memory",
        { ids: [m.id] },
        service,
      );
      expect(archived.content[0].text).toContain("Archived 1");
      expect((await repository.findById(m.id))!.archived).toBe(true);

      const restored = await handleToolCall(
        "unarchive_memory",
        { ids: [m.id] },
        service,
      );
      expect(restored.content[0].text).toContain("Unarchived 1");
      expect((await repository.findById(m.id))!.archived).toBe(false);
    });
  });

  describe("TTL expiry (Feature 10)", () => {
    test("expired memories are excluded and can be tombstoned on demand", async () => {
      const past = new Date(Date.now() - 60_000);
      const expired = await service.store("perishable content", {}, undefined, undefined, {
        expiresAt: past,
      });
      const fresh = await service.store("durable content");

      // Expired excluded by default; visible with include_expired
      expect(await idsInSearch("perishable")).not.toContain(expired.id);
      expect(
        await idsInSearch("perishable", { includeExpired: true }),
      ).toContain(expired.id);

      const tombstoned = await service.expireMemories();
      expect(tombstoned).toContain(expired.id);
      expect(tombstoned).not.toContain(fresh.id);
      expect((await repository.findById(expired.id))!.supersededBy).toBe("DELETED");
      expect((await repository.findById(fresh.id))!.supersededBy).toBeNull();
    });

    test("expire_memories tool reports when nothing is expired", async () => {
      await service.store("still valid");
      const res = await handleToolCall("expire_memories", {}, service);
      expect(res.content[0].text).toContain("No expired memories");
    });
  });

  describe("search modes (Feature 11)", () => {
    test("exact mode returns only keyword (FTS) matches", async () => {
      const hit = await service.store("the quantum flux capacitor spec");
      const miss = await service.store("an unrelated grocery list");

      const ids = await idsInSearch("quantum", { mode: "exact" });
      expect(ids).toContain(hit.id);
      expect(ids).not.toContain(miss.id);
    });

    test("exact mode with no keyword match returns nothing", async () => {
      await service.store("alpha beta gamma");
      const ids = await idsInSearch("zzzznomatch", { mode: "exact" });
      expect(ids.length).toBe(0);
    });

    test("hybrid mode returns results without error", async () => {
      const m = await service.store("hybrid ranked content");
      await service.vote(m.id, 1);
      const ids = await idsInSearch("hybrid ranked", { mode: "hybrid" });
      expect(ids).toContain(m.id);
    });
  });
});
