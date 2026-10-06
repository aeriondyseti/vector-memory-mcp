import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { memoryStatus, withLifecycleDefaults } from "../server/core/memory";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import {
  handleSearchMemories,
  handleStoreMemories,
  handleUpdateMemories,
} from "../server/transports/mcp/handlers";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;
const PROJECT = "/proj/test";

/** Each distinct text embeds on an axis of its own: no two texts look alike. */
function distinctEmbeddings(): EmbeddingsService {
  const axes = new Map<string, number>();
  const embed = async (text: string): Promise<number[]> => {
    if (!axes.has(text)) axes.set(text, axes.size % DIM);
    const v = new Array(DIM).fill(0);
    v[axes.get(text)!] = 1;
    return v;
  };
  return {
    dimension: DIM,
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)),
  } as unknown as EmbeddingsService;
}

const text = (r: { content: Array<{ type: string; text?: string }> }): string =>
  (r.content[0] as { text: string }).text;

describe("withLifecycleDefaults", () => {
  test("opens task, next-step and blocker memories", () => {
    for (const type of ["task", "next-step", "blocker"]) {
      expect(withLifecycleDefaults({ type }).status).toBe("open");
    }
    expect(withLifecycleDefaults({ type: "decision" }).status).toBeUndefined();
    expect(withLifecycleDefaults({ type: "task", status: "resolved" }).status).toBe("resolved");
  });

  test("trims a key and drops a blank one", () => {
    expect(withLifecycleDefaults({ key: "  current-goal " }).key).toBe("current-goal");
    expect("key" in withLifecycleDefaults({ key: "   " })).toBe(false);
  });

  test("reads an untouched task as open", () => {
    expect(memoryStatus({ type: "task" })).toBe("open");
    expect(memoryStatus({ type: "insight" })).toBe(null);
  });
});

describe("memory lifecycle", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;
  let s: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    s = new MemoryService(repository, distinctEmbeddings(), PROJECT);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  const search = async (query: string, extra: Record<string, unknown> = {}) =>
    text(
      await handleSearchMemories(
        { query, intent: "fact_check", reason_for_search: "test", include_history: false, ...extra },
        s,
      ),
    );

  describe("superseding (key)", () => {
    test("a new memory with the same key replaces the old one, kept as history", async () => {
      const old = await s.store("Current goal: ship the importer", { key: "current-goal" });
      const next = await s.store("Current goal: polish the exporter", { key: "current-goal" });

      expect((await repository.findById(old.id))?.supersededBy).toBe(next.id);
      expect((await repository.findById(next.id))?.supersededBy).toBeNull();

      const current = await search("Current goal");
      expect(current).toContain(next.id);
      expect(current).not.toContain(old.id);

      const history = await search("Current goal", { include_superseded: true });
      expect(history).toContain(old.id);
      expect(history).toContain(`[SUPERSEDED by ${next.id}]`);
    });

    test("keys are per project, and memories without a key accumulate", async () => {
      const elsewhere = await s.store("Goal in another project", { key: "current-goal" }, undefined, "/proj/other");
      await s.store("Goal here", { key: "current-goal" });
      const a = await s.store("Insight one about caching");
      const b = await s.store("Insight two about caching");

      expect((await repository.findById(elsewhere.id))?.supersededBy).toBeNull();
      expect((await repository.findById(a.id))?.supersededBy).toBeNull();
      expect((await repository.findById(b.id))?.supersededBy).toBeNull();
    });

    test("store_memories takes a key and says what it replaced", async () => {
      const old = await s.store("Preferred editor: Vim", { key: "preferred-editor" });

      const out = text(
        await handleStoreMemories({ memories: [{ content: "Preferred editor: Helix", key: "preferred-editor" }] }, s),
      );

      expect(out).toContain('as the current "preferred-editor", replacing');
      expect(out).toContain(old.id);
    });

    test("giving a memory a key through update_memories replaces the holder", async () => {
      const holder = await s.store("Deploy process: manual", { key: "deploy-process" });
      const other = await s.store("Deploy process: CI on merge");

      await handleUpdateMemories({ updates: [{ id: other.id, key: "deploy-process" }] }, s);

      expect((await repository.findById(holder.id))?.supersededBy).toBe(other.id);
      expect((await repository.findById(other.id))?.metadata.key).toBe("deploy-process");
    });
  });

  describe("open until resolved", () => {
    test("a resolved task drops out of default search and comes back on request", async () => {
      const task = await s.store("Task: migrate the photo archive", { type: "task" });
      expect(task.metadata.status).toBe("open");

      const out = text(await handleUpdateMemories({ updates: [{ id: task.id, status: "resolved" }] }, s));
      expect(out).toContain("updated successfully");

      const resolved = await repository.findById(task.id);
      expect(resolved?.metadata.status).toBe("resolved");
      expect(typeof resolved?.metadata.resolved_at).toBe("string");
      expect(resolved?.metadata.type).toBe("task");

      expect(await search("photo archive")).not.toContain(task.id);
      expect(await search("photo archive", { include_resolved: true })).toContain(task.id);
    });

    test("reopening clears resolved_at", async () => {
      const task = await s.store("Task: renew the passport", { type: "task", status: "resolved" });

      await s.update(task.id, { status: "open" });

      const reopened = await repository.findById(task.id);
      expect(reopened?.metadata.status).toBe("open");
      expect(reopened?.metadata.resolved_at).toBeUndefined();
    });

    test("a new task worded like a resolved one is stored, not called a duplicate", async () => {
      const done = await s.store("Task: water the plants", { type: "task", status: "resolved" });

      const outcome = await s.storeUnlessDuplicate("Task: water the plants", { type: "task" });

      expect(outcome.status).toBe("stored");
      if (outcome.status === "stored") expect(outcome.memory.id).not.toBe(done.id);
    });

    test("an invalid status is refused", async () => {
      const out = text(
        await handleStoreMemories({ memories: [{ content: "Task: x", status: "finished" }] }, s),
      );
      expect(out).toContain("status must be one of: open, resolved");
    });
  });

  describe("session context", () => {
    test("lists open items after pinned ones, leaving out resolved and superseded", async () => {
      await s.store("Always reply in British English.", {}, undefined, undefined, { pinned: true });
      await s.store("Blocker: waiting on the venue contract", { type: "blocker" });
      await s.store("Task: book flights", { type: "task", status: "resolved" });
      await s.store("Next step: draft the itinerary", { type: "next-step", key: "itinerary" });
      await s.store("Next step: share the itinerary", { type: "next-step", key: "itinerary" });

      const { text: ctx } = await s.getSessionContext();

      const lines = ctx.split("\n");
      expect(lines[0]).toBe("- [pinned] Always reply in British English.");
      expect(ctx).toContain("- [open blocker] Blocker: waiting on the venue contract");
      expect(ctx).toContain("- [open next-step] Next step: share the itinerary");
      expect(ctx).not.toContain("book flights");
      expect(ctx).not.toContain("draft the itinerary");
    });
  });

  describe("duplicate cleanup", () => {
    const setVector = (id: string) => {
      const v = new Array(DIM).fill(0);
      v[DIM - 1] = 1;
      db.prepare("INSERT OR REPLACE INTO memories_vec (id, vector) VALUES (?, ?)").run(
        id,
        Buffer.from(new Float32Array(v).buffer),
      );
    };

    test("an open and a resolved copy of a task are left for review", async () => {
      const done = await s.store("Task: file the tax return", { type: "task", status: "resolved" });
      const open = await s.store("Task: file the tax return!", { type: "task" });
      setVector(done.id);
      setVector(open.id);

      const r = await s.cleanupDuplicates();

      expect(r.deleted).toBe(0);
      expect(r.plans.flatMap((p) => p.review.map((i) => i.reason))).toContain("different status");
    });

    test("superseded history is never clustered as a duplicate", async () => {
      const old = await s.store("Current goal: ship it", { key: "current-goal" });
      const next = await s.store("Current goal: ship it!", { key: "current-goal" });
      setVector(old.id);
      setVector(next.id);

      expect(s.findDuplicates(0.9)).toEqual([]);
      expect((await s.cleanupDuplicates()).deleted).toBe(0);
    });
  });
});
