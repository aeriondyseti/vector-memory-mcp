import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { MaintenanceService } from "../server/core/maintenance.service";
import { createMockEmbeddings, removeDir } from "./utils/test-helpers";
import {
  handleDeleteMemories,
  handleSearchMemories,
  handleMemoryHealth,
  handleStorageStats,
  handleOptimizeDatabase,
  handleCleanupOrphans,
  handleFindStaleMemories,
  handleSearchByTags,
  handleGetSessionContext,
  handleStoreMemories,
} from "../server/transports/mcp/handlers";

describe("Phase 1 features", () => {
  let tmpDir: string;
  let db: Database;
  let repository: MemoryRepository;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "phase1-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    service = new MemoryService(repository, createMockEmbeddings(), "/proj/test");
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  describe("MemoryAttributes store/update round-trip", () => {
    test("store persists attributes and round-trips via findById", async () => {
      const expires = new Date(Date.now() + 100000);
      const mem = await service.store(
        "attributed content",
        {},
        undefined,
        undefined,
        {
          pinned: true,
          archived: false,
          confidence: "confirmed",
          importance: "high",
          expiresAt: expires,
          episodeId: "ep-1",
          sequenceNumber: 3,
          precedingMemoryId: "pred-1",
        },
      );

      expect(mem.pinned).toBe(true);
      expect(mem.confidence).toBe("confirmed");
      expect(mem.importance).toBe("high");
      expect(mem.episodeId).toBe("ep-1");
      expect(mem.sequenceNumber).toBe(3);
      expect(mem.precedingMemoryId).toBe("pred-1");

      const fetched = await repository.findById(mem.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.pinned).toBe(true);
      expect(fetched!.archived).toBe(false);
      expect(fetched!.confidence).toBe("confirmed");
      expect(fetched!.importance).toBe("high");
      expect(fetched!.expiresAt?.getTime()).toBe(expires.getTime());
      expect(fetched!.episodeId).toBe("ep-1");
      expect(fetched!.sequenceNumber).toBe(3);
      expect(fetched!.precedingMemoryId).toBe("pred-1");
    });

    test("store defaults attributes when omitted", async () => {
      const mem = await service.store("plain content");
      expect(mem.pinned).toBe(false);
      expect(mem.archived).toBe(false);
      expect(mem.confidence).toBeNull();
      expect(mem.importance).toBeNull();
      expect(mem.expiresAt).toBeNull();
    });

    test("update merges attributes: omitted fields keep existing value", async () => {
      const mem = await service.store("c", {}, undefined, undefined, {
        pinned: true,
        importance: "high",
      });

      const updated = await service.update(mem.id, {
        attributes: { confidence: "verified" },
      });

      expect(updated!.pinned).toBe(true); // kept
      expect(updated!.importance).toBe("high"); // kept
      expect(updated!.confidence).toBe("verified"); // newly set
    });

    test("update with explicit null clears a nullable attribute", async () => {
      const mem = await service.store("c", {}, undefined, undefined, {
        importance: "high",
        episodeId: "ep-1",
      });

      const updated = await service.update(mem.id, {
        attributes: { importance: null, episodeId: null },
      });

      expect(updated!.importance).toBeNull();
      expect(updated!.episodeId).toBeNull();

      const fetched = await repository.findById(mem.id);
      expect(fetched!.importance).toBeNull();
      expect(fetched!.episodeId).toBeNull();
    });
  });

  describe("search exclusions and filters", () => {
    test("archived memories excluded by default, included with includeArchived", async () => {
      const mem = await service.store("archived xylophone content", {}, undefined, undefined, {
        archived: true,
      });

      const excluded = await service.search("xylophone", "fact_check", {
        includeHistory: false,
        limit: 50,
      });
      expect(excluded.some((r) => r.id === mem.id)).toBe(false);

      const included = await service.search("xylophone", "fact_check", {
        includeHistory: false,
        includeArchived: true,
        limit: 50,
      });
      expect(included.some((r) => r.id === mem.id)).toBe(true);
    });

    test("expired memories excluded by default, included with includeExpired", async () => {
      const mem = await service.store("expired quokka content", {}, undefined, undefined, {
        expiresAt: new Date(Date.now() - 1000),
      });

      const excluded = await service.search("quokka", "fact_check", {
        includeHistory: false,
        limit: 50,
      });
      expect(excluded.some((r) => r.id === mem.id)).toBe(false);

      const included = await service.search("quokka", "fact_check", {
        includeHistory: false,
        includeExpired: true,
        limit: 50,
      });
      expect(included.some((r) => r.id === mem.id)).toBe(true);
    });

    test("minImportance filters out lower-ranked memories", async () => {
      const normalMem = await service.store("importance filtered normal wombat", {}, undefined, undefined, {
        importance: "normal",
      });
      const highMem = await service.store("importance filtered high wombat", {}, undefined, undefined, {
        importance: "high",
      });

      const results = await service.search("wombat", "fact_check", {
        includeHistory: false,
        minImportance: "high",
        limit: 50,
      });

      expect(results.some((r) => r.id === highMem.id)).toBe(true);
      expect(results.some((r) => r.id === normalMem.id)).toBe(false);
    });

    test("minConfidence filters out lower-ranked memories", async () => {
      const uncertainMem = await service.store("confidence filtered uncertain narwhal", {}, undefined, undefined, {
        confidence: "uncertain",
      });
      const verifiedMem = await service.store("confidence filtered verified narwhal", {}, undefined, undefined, {
        confidence: "verified",
      });

      const results = await service.search("narwhal", "fact_check", {
        includeHistory: false,
        minConfidence: "verified",
        limit: 50,
      });

      expect(results.some((r) => r.id === verifiedMem.id)).toBe(true);
      expect(results.some((r) => r.id === uncertainMem.id)).toBe(false);
    });

    test("type filter matches metadata.type", async () => {
      const decisionMem = await service.store("type filtered decision jackal", { type: "decision" });
      const otherMem = await service.store("type filtered context jackal", { type: "context" });

      const results = await service.search("jackal", "fact_check", {
        includeHistory: false,
        type: "decision",
        limit: 50,
      });

      expect(results.some((r) => r.id === decisionMem.id)).toBe(true);
      expect(results.some((r) => r.id === otherMem.id)).toBe(false);
    });

    test("tags + tagMatch any/all filter results", async () => {
      const bothTagsMem = await service.store("tag filtered both alpaca", {
        tags: ["red", "blue"],
      });
      const oneTagMem = await service.store("tag filtered one alpaca", {
        tags: ["red"],
      });

      const anyResults = await service.search("alpaca", "fact_check", {
        includeHistory: false,
        tags: ["blue"],
        tagMatch: "any",
        limit: 50,
      });
      expect(anyResults.some((r) => r.id === bothTagsMem.id)).toBe(true);
      expect(anyResults.some((r) => r.id === oneTagMem.id)).toBe(false);

      const allResults = await service.search("alpaca", "fact_check", {
        includeHistory: false,
        tags: ["red", "blue"],
        tagMatch: "all",
        limit: 50,
      });
      expect(allResults.some((r) => r.id === bothTagsMem.id)).toBe(true);
      expect(allResults.some((r) => r.id === oneTagMem.id)).toBe(false);
    });
  });

  describe("flexible deletion", () => {
    test("deletes by tags", async () => {
      const tagged = await service.store("delete by tag content", { tags: ["cleanup"] });
      const other = await service.store("keep this content", { tags: ["keep"] });

      const result = await service.deleteMemories({ tags: ["cleanup"] });

      expect(result.deletedIds).toContain(tagged.id);
      expect(result.deletedIds).not.toContain(other.id);

      const fetched = await repository.findById(tagged.id);
      expect(fetched!.supersededBy).toBe("DELETED");

      const otherFetched = await repository.findById(other.id);
      expect(otherFetched!.supersededBy).not.toBe("DELETED");
    });

    test("deletes by date range (before/after)", async () => {
      const before = new Date(Date.now() - 1000);
      const mem = await service.store("date range content");
      const after = new Date(Date.now() + 1000);

      const result = await service.deleteMemories({ after: before, before: after });

      expect(result.deletedIds).toContain(mem.id);
    });

    test("dryRun does not actually delete", async () => {
      const mem = await service.store("dry run content", { tags: ["dry"] });

      const result = await service.deleteMemories({ tags: ["dry"], dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.deletedIds).toContain(mem.id);

      const fetched = await repository.findById(mem.id);
      expect(fetched!.supersededBy).not.toBe("DELETED");
    });

    test("pinned and critical memories are protected unless force", async () => {
      const pinnedMem = await service.store("pinned protect content", { tags: ["protect"] }, undefined, undefined, {
        pinned: true,
      });
      const criticalMem = await service.store("critical protect content", { tags: ["protect"] }, undefined, undefined, {
        importance: "critical",
      });
      const normalMem = await service.store("normal protect content", { tags: ["protect"] });

      const result = await service.deleteMemories({ tags: ["protect"] });

      expect(result.skippedProtected).toContain(pinnedMem.id);
      expect(result.skippedProtected).toContain(criticalMem.id);
      expect(result.deletedIds).toContain(normalMem.id);
      expect(result.deletedIds).not.toContain(pinnedMem.id);
      expect(result.deletedIds).not.toContain(criticalMem.id);

      const forced = await service.deleteMemories({ tags: ["protect"], force: true });
      expect(forced.deletedIds).toContain(pinnedMem.id);
      expect(forced.deletedIds).toContain(criticalMem.id);
    });

    test("throws when no selector is provided", async () => {
      await expect(service.deleteMemories({})).rejects.toThrow();
    });
  });

  describe("findStale", () => {
    test("excludes fresh memories, includes backdated ones", async () => {
      const fresh = await service.store("fresh memory content");
      const stale = await service.store("stale memory content");

      const oldTimestamp = Date.now() - 200 * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(oldTimestamp, stale.id);

      const staleResults = await service.findStale({ staleDays: 90 });

      expect(staleResults.some((m) => m.id === stale.id)).toBe(true);
      expect(staleResults.some((m) => m.id === fresh.id)).toBe(false);
    });

    test("excludePinned (default true) omits pinned stale memories", async () => {
      const pinnedStale = await service.store("pinned stale content", {}, undefined, undefined, {
        pinned: true,
      });
      const normalStale = await service.store("normal stale content");

      const oldTimestamp = Date.now() - 200 * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(oldTimestamp, pinnedStale.id);
      db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(oldTimestamp, normalStale.id);

      const results = await service.findStale({ staleDays: 90 });

      expect(results.some((m) => m.id === normalStale.id)).toBe(true);
      expect(results.some((m) => m.id === pinnedStale.id)).toBe(false);

      const withPinned = await service.findStale({ staleDays: 90, excludePinned: false });
      expect(withPinned.some((m) => m.id === pinnedStale.id)).toBe(true);
    });
  });

  describe("searchByTags", () => {
    test("any/all match modes and pagination", async () => {
      const m1 = await service.store("tag search one", { tags: ["a", "b"] });
      await new Promise((r) => setTimeout(r, 5));
      const m2 = await service.store("tag search two", { tags: ["a"] });
      await new Promise((r) => setTimeout(r, 5));
      const m3 = await service.store("tag search three", { tags: ["b"] });

      const anyResults = await service.searchByTags(["a"], "any");
      const anyIds = anyResults.map((m) => m.id);
      expect(anyIds).toContain(m1.id);
      expect(anyIds).toContain(m2.id);
      expect(anyIds).not.toContain(m3.id);

      const allResults = await service.searchByTags(["a", "b"], "all");
      const allIds = allResults.map((m) => m.id);
      expect(allIds).toContain(m1.id);
      expect(allIds).not.toContain(m2.id);
      expect(allIds).not.toContain(m3.id);

      const page1 = await service.searchByTags(["a", "b"], "any", 2, 0);
      const page2 = await service.searchByTags(["a", "b"], "any", 2, 2);
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(1);
    });
  });

  describe("getSessionContext", () => {
    test("only pinned/critical memories included, truncation respected", async () => {
      const normalMem = await service.store("normal not included content");
      const pinnedMem = await service.store("pinned included content", {}, undefined, undefined, {
        pinned: true,
      });

      const ctx = await service.getSessionContext({ project: "/proj/test" });
      expect(ctx.memories.some((m) => m.id === pinnedMem.id)).toBe(true);
      expect(ctx.memories.some((m) => m.id === normalMem.id)).toBe(false);

      // Store several long pinned memories, then request a tiny budget.
      const longContent = "x".repeat(500);
      await service.store(longContent, {}, undefined, undefined, { pinned: true });
      await service.store(longContent, {}, undefined, undefined, { pinned: true });
      await service.store(longContent, {}, undefined, undefined, { pinned: true });

      const truncatedCtx = await service.getSessionContext({ project: "/proj/test", maxChars: 200 });
      expect(truncatedCtx.truncated).toBe(true);
      expect(truncatedCtx.memories.length).toBeGreaterThan(0);
    });
  });

  describe("MaintenanceService", () => {
    let maintenance: MaintenanceService;

    beforeEach(() => {
      maintenance = new MaintenanceService(db, join(tmpDir, "test.db"), repository);
    });

    test("health() returns accurate counts", async () => {
      await service.store("normal content");
      const pinnedMem = await service.store("pinned content", {}, undefined, undefined, { pinned: true });
      const archivedMem = await service.store("archived content", {}, undefined, undefined, { archived: true });
      const expiredMem = await service.store("expired content", {}, undefined, undefined, {
        expiresAt: new Date(Date.now() - 1000),
      });
      const deletedMem = await service.store("deleted content");
      await service.delete(deletedMem.id);

      const h = maintenance.health();

      expect(h.total).toBe(5);
      expect(h.deleted).toBe(1);
      expect(h.live).toBe(4);
      expect(h.archived).toBe(1);
      expect(h.pinned).toBe(1);
      expect(h.expired).toBe(1);
      expect(h.schemaVersion).toBeGreaterThanOrEqual(2);
      expect(typeof h.avgUsefulness).toBe("number");
      expect(typeof h.conversationChunks).toBe("number");
      expect(typeof h.journalMode).toBe("string");
      expect(typeof h.backend).toBe("string");

      // Silence unused-var lint for ids referenced only for setup.
      expect(pinnedMem.pinned).toBe(true);
      expect(archivedMem.archived).toBe(true);
      expect(expiredMem.expiresAt).not.toBeNull();
    });

    test("storageStats() returns sensible values", async () => {
      await service.store("stats content one");
      await service.store("stats content two");

      const s = maintenance.storageStats();

      expect(s.fileSizeBytes).toBeGreaterThan(0);
      expect(s.pageCount).toBeGreaterThan(0);
      expect(s.pageSize).toBeGreaterThan(0);
      expect(s.memoryRows).toBe(2);
    });

    test("optimize() runs VACUUM+ANALYZE without throwing and records history", () => {
      const result = maintenance.optimize();

      expect(result).toHaveProperty("pagesBefore");
      expect(result).toHaveProperty("pagesAfter");
      expect(result).toHaveProperty("freedBytes");

      const history = maintenance.getHistory();
      expect(history.some((e) => e.action === "optimize_database")).toBe(true);
    });

    test("cleanupOrphans detects and removes dangling vectors", async () => {
      db.prepare("INSERT INTO memories_vec (id, vector) VALUES (?, ?)").run(
        "orphan-vec",
        Buffer.alloc(384 * 4),
      );

      const report = maintenance.cleanupOrphans(false);
      expect(report.vectorsWithoutMemory).toContain("orphan-vec");
      expect(report.repaired).toBe(false);

      const repairReport = maintenance.cleanupOrphans(true);
      expect(repairReport.removedDanglingVectors).toBeGreaterThanOrEqual(1);

      const followUp = maintenance.cleanupOrphans(false);
      expect(followUp.vectorsWithoutMemory).not.toContain("orphan-vec");
    });
  });

  describe("handler-level smoke tests", () => {
    test("handleMemoryHealth returns a Memory Health report", async () => {
      const result = await handleMemoryHealth(undefined, service);
      expect(result.content[0]!.text).toContain("Memory Health");
    });

    test("handleStorageStats returns a Storage Stats report", async () => {
      const result = await handleStorageStats(undefined, service);
      expect(result.content[0]!.text).toContain("Storage Stats");
    });

    test("handleOptimizeDatabase succeeds", async () => {
      const result = await handleOptimizeDatabase(undefined, service);
      expect(result.isError).not.toBe(true);
    });

    test("handleCleanupOrphans reports orphans", async () => {
      const result = await handleCleanupOrphans({ repair: false }, service);
      expect(result.isError).not.toBe(true);
    });

    test("handleFindStaleMemories reports on stale memories", async () => {
      const stale = await service.store("handler stale content");
      const oldTimestamp = Date.now() - 200 * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?").run(oldTimestamp, stale.id);

      const result = await handleFindStaleMemories({ stale_days: 90 }, service);
      expect(result.content[0]!.text).toContain(stale.id);
    });

    test("handleSearchByTags returns memories tagged x", async () => {
      const mem = await service.store("handler tag content", { tags: ["x"] });

      const result = await handleSearchByTags({ tags: ["x"] }, service);
      expect(result.content[0]!.text).toContain(mem.id);
    });

    test("handleGetSessionContext returns session context text", async () => {
      await service.store("handler session content", {}, undefined, undefined, { pinned: true });

      const result = await handleGetSessionContext({}, service);
      expect(result.content[0]!.text).toContain("Session context");
    });

    test("handleStoreMemories rejects invalid confidence enum", async () => {
      const result = await handleStoreMemories(
        { memories: [{ content: "bad enum content", confidence: "bogus" }] },
        service,
      );
      expect(result.isError).toBe(true);
    });

    test("handleStoreMemories accepts valid pinned + importance", async () => {
      const result = await handleStoreMemories(
        { memories: [{ content: "good enum content", pinned: true, importance: "high" }] },
        service,
      );
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain("Memory stored with ID:");
    });

    test("handleDeleteMemories via handler", async () => {
      const mem = await service.store("handler delete content", { tags: ["handler-del"] });

      const result = await handleDeleteMemories({ tags: ["handler-del"] }, service);
      expect(result.isError).not.toBe(true);
      expect(result.content[0]!.text).toContain(mem.id);
    });

    test("handleSearchMemories returns results respecting includeArchived", async () => {
      await service.store("handler search archived content", {}, undefined, undefined, {
        archived: true,
      });

      const result = await handleSearchMemories(
        { query: "handler search archived content", include_history: false },
        service,
      );
      expect(result.content[0]!.text).toContain("No results found");
    });
  });
});
