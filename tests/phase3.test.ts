import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { HandoffService } from "../server/core/handoff.service";
import { computeQualityScore } from "../server/core/memory";
import { handleToolCall } from "../server/transports/mcp/handlers";
import { createMockEmbeddings, removeDir } from "./utils/test-helpers";

describe("Phase 3 — quality, episodes, proactive context, tags, duplicates, consolidation, handoff", () => {
  let db: Database;
  let repository: MemoryRepository;
  let service: MemoryService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "phase3-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    service = new MemoryService(repository, createMockEmbeddings(), "/proj/test");
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  // Overwrite a memory's stored vector so we can control similarity directly
  // (createMockEmbeddings returns random vectors, which is useless for
  // duplicate-detection tests).
  const setUnitVector = (id: string, axis: number) => {
    const arr = new Array(384).fill(0);
    arr[axis] = 1;
    const vec = Buffer.from(new Float32Array(arr).buffer);
    db.prepare("INSERT OR REPLACE INTO memories_vec (id, vector) VALUES (?, ?)").run(id, vec);
  };

  describe("Quality scoring (Feature 15)", () => {
    test("store sets a numeric qualityScore in [0,1]", async () => {
      const m = await service.store("quality scored content");
      const stored = await repository.findById(m.id);
      expect(stored).not.toBeNull();
      expect(typeof stored!.qualityScore).toBe("number");
      expect(stored!.qualityScore!).toBeGreaterThanOrEqual(0);
      expect(stored!.qualityScore!).toBeLessThanOrEqual(1);
    });

    test("vote raises qualityScore relative to a never-voted memory", async () => {
      const a = await service.store("never voted content");
      const b = await service.store("upvoted content");
      await service.vote(b.id, 1);
      await service.vote(b.id, 1);

      const aFinal = await repository.findById(a.id);
      const bFinal = await repository.findById(b.id);
      expect(bFinal!.qualityScore!).toBeGreaterThan(aFinal!.qualityScore!);
    });

    test("scoreMemories rescores all live memories and reports average", async () => {
      const m1 = await service.store("first content");
      const m2 = await service.store("second content");
      await service.delete((await service.store("to be deleted")).id);

      const result = await service.scoreMemories();
      expect(result.scored).toBe(2);
      expect(result.averageScore).toBeGreaterThanOrEqual(0);
      expect(result.averageScore).toBeLessThanOrEqual(1);

      const r1 = await repository.findById(m1.id);
      const r2 = await repository.findById(m2.id);
      expect(typeof r1!.qualityScore).toBe("number");
      expect(typeof r2!.qualityScore).toBe("number");
    });

    test("computeQualityScore: critical importance scores higher than low importance", () => {
      const now = new Date();
      const base = {
        id: "x",
        content: "same content",
        embedding: [],
        metadata: {},
        createdAt: now,
        updatedAt: now,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: now,
        project: null,
      };
      const critical = { ...base, importance: "critical" as const };
      const low = { ...base, importance: "low" as const };
      expect(computeQualityScore(critical, now)).toBeGreaterThan(
        computeQualityScore(low, now),
      );
    });
  });

  describe("Episodic chains (Feature 23)", () => {
    test("getEpisode returns members ordered by sequence number", async () => {
      const second = await service.store("step two", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 2,
      });
      const first = await service.store("step one", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 1,
      });
      const third = await service.store("step three", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 3,
      });
      const other = await service.store("unrelated episode", {}, undefined, undefined, {
        episodeId: "ep2",
        sequenceNumber: 1,
      });

      const episode = service.getEpisode("ep1");
      expect(episode.map((m) => m.id)).toEqual([first.id, second.id, third.id]);
      expect(episode.find((m) => m.id === other.id)).toBeUndefined();
    });

    test("listEpisodes reports member counts", async () => {
      await service.store("a", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 1,
      });
      await service.store("b", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 2,
      });
      await service.store("c", {}, undefined, undefined, {
        episodeId: "ep1",
        sequenceNumber: 3,
      });

      const episodes = service.listEpisodes();
      const ep1 = episodes.find((e) => e.episodeId === "ep1");
      expect(ep1).toBeDefined();
      expect(ep1!.count).toBe(3);
    });
  });

  describe("Proactive context (Feature 24)", () => {
    test("results meet the confidence threshold", async () => {
      await service.store("the quantum flux capacitor operating manual");
      const results = await service.proactiveContext(
        "quantum flux capacitor operating manual",
        5,
        0.9,
      );
      for (const r of results) {
        expect(r.confidence).toBeGreaterThanOrEqual(0.9);
      }
    });

    test("threshold 0 returns up to maxResults", async () => {
      await service.store("alpha content one");
      await service.store("beta content two");
      await service.store("gamma content three");

      const results = await service.proactiveContext("some context text", 2, 0);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("auto_ingest stores the context as a new observation memory", async () => {
      await service.store("existing content");
      const before = repository.queryMemories({}).length;

      await service.proactiveContext("brand new context to remember", 5, 0, true);

      const after = repository.queryMemories({});
      expect(after.length).toBe(before + 1);
      const observation = after.find(
        (m) => m.content === "brand new context to remember",
      );
      expect(observation).toBeDefined();
      expect(observation!.metadata.type).toBe("observation");
    });
  });

  describe("Tag management (Feature 16)", () => {
    test("listTags aggregates counts across memories, sorted by count desc", async () => {
      await service.store("m1", { tags: ["alpha", "beta"] });
      await service.store("m2", { tags: ["alpha"] });
      await service.store("m3", { tags: ["gamma"] });

      const tags = service.listTags();
      const alpha = tags.find((t) => t.tag === "alpha");
      const beta = tags.find((t) => t.tag === "beta");
      const gamma = tags.find((t) => t.tag === "gamma");
      expect(alpha!.count).toBe(2);
      expect(beta!.count).toBe(1);
      expect(gamma!.count).toBe(1);
      // sorted by count desc
      expect(tags[0].tag).toBe("alpha");
    });

    test("renameTag rewrites tags without touching content or vector", async () => {
      const m = await service.store("tagged content", { tags: ["a", "other"] });

      const changed = await service.renameTag("a", "b");
      expect(changed).toBe(1);

      const updated = await repository.findById(m.id);
      expect(updated!.metadata.tags).toEqual(["other", "b"]);
      expect(updated!.content).toBe("tagged content");

      const vecRow = db.prepare("SELECT 1 FROM memories_vec WHERE id = ?").get(m.id);
      expect(vecRow).toBeTruthy();
    });

    test("mergeTags merges several source tags into one target", async () => {
      const m = await service.store("merge me", { tags: ["x", "y", "z"] });
      const changed = await service.mergeTags(["x", "y"], "merged");
      expect(changed).toBe(1);

      const updated = await repository.findById(m.id);
      const tags = updated!.metadata.tags as string[];
      expect(tags).toContain("merged");
      expect(tags).toContain("z");
      expect(tags).not.toContain("x");
      expect(tags).not.toContain("y");
    });

    test("deleteTag removes a tag from all memories", async () => {
      await service.store("m1", { tags: ["gone", "keep"] });
      await service.store("m2", { tags: ["keep"] });

      const changed = await service.deleteTag("gone");
      expect(changed).toBe(1);

      const tags = service.listTags();
      expect(tags.find((t) => t.tag === "gone")).toBeUndefined();
    });
  });

  describe("Duplicate detection & merge (Feature 14)", () => {
    test("findDuplicates clusters identical vectors and excludes an orthogonal one", async () => {
      const dupA = await service.store("duplicate content A");
      const dupB = await service.store("duplicate content B");
      const distinct = await service.store("orthogonal distinct content");

      setUnitVector(dupA.id, 0);
      setUnitVector(dupB.id, 0);
      setUnitVector(distinct.id, 1);

      const clusters = service.findDuplicates(0.9);
      expect(clusters.length).toBe(1);
      const cluster = clusters[0];
      const clusterIds = new Set([cluster.keepId, ...cluster.duplicateIds]);
      expect(clusterIds.has(dupA.id)).toBe(true);
      expect(clusterIds.has(dupB.id)).toBe(true);
      expect(clusterIds.has(distinct.id)).toBe(false);
    });

    test("mergeDuplicates soft-deletes the merged-away memories", async () => {
      const dupA = await service.store("duplicate content A");
      const dupB = await service.store("duplicate content B");
      setUnitVector(dupA.id, 0);
      setUnitVector(dupB.id, 0);

      const merged = await service.mergeDuplicates(dupA.id, [dupB.id], "keep_newest");
      expect(merged).not.toBeNull();

      const survivor = await repository.findById(dupA.id);
      const gone = await repository.findById(dupB.id);
      expect(survivor!.supersededBy).toBeNull();
      expect(gone!.supersededBy).toBe("DELETED");
    });

    test("cleanupDuplicates auto-merges clusters and reports counts", async () => {
      const dupA = await service.store("duplicate content A");
      const dupB = await service.store("duplicate content B");
      const distinct = await service.store("orthogonal distinct content");
      setUnitVector(dupA.id, 0);
      setUnitVector(dupB.id, 0);
      setUnitVector(distinct.id, 1);

      const result = await service.cleanupDuplicates(0.9);
      expect(result.clusters).toBe(1);
      expect(result.deleted).toBe(1);

      const liveIds = repository.queryMemories({}).map((m) => m.id);
      const goneCount = [dupA.id, dupB.id].filter((id) => !liveIds.includes(id)).length;
      expect(goneCount).toBe(1);
      expect(liveIds).toContain(distinct.id);
    });
  });

  describe("Consolidation (Feature 18)", () => {
    test("recommend reports without changing anything", async () => {
      await service.store("some content");
      const before = repository.queryMemories({}).length;

      const result = await service.consolidateMemories("recommend");
      expect(result.action).toBe("recommend");
      expect(result.total).toBe(before);
      expect(typeof result.duplicateClusters).toBe("number");
      expect(typeof result.forgetCandidates).toBe("number");
      expect(typeof result.averageQuality).toBe("number");

      const after = repository.queryMemories({}).length;
      expect(after).toBe(before);
    });

    test("run rescores and compresses duplicate clusters", async () => {
      const dupA = await service.store("duplicate content A");
      const dupB = await service.store("duplicate content B");
      setUnitVector(dupA.id, 0);
      setUnitVector(dupB.id, 0);

      const result = await service.consolidateMemories("run");
      expect(result.action).toBe("run");
      expect(typeof result.rescored).toBe("number");
      expect(typeof result.compressed).toBe("number");
      expect(typeof result.forgotten).toBe("number");

      const a = await repository.findById(dupA.id);
      const b = await repository.findById(dupB.id);
      // Exactly one of the pair should have been merged away as a duplicate.
      const deletedCount = [a, b].filter((m) => m!.supersededBy === "DELETED").length;
      expect(deletedCount).toBe(1);
    });
  });

  describe("Session handoff (Feature 20)", () => {
    let handoffService: HandoffService;

    beforeEach(() => {
      handoffService = new HandoffService(join(tmpDir, "test.db"));
    });

    test("prepare returns a handoff with uuid id, createdAt, and null resumedAt", () => {
      const handoff = handoffService.prepare({
        summary: "did some work",
        nextSteps: ["ship it"],
        project: "/proj/test",
      });
      expect(handoff.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(handoff.createdAt).toBeTruthy();
      expect(handoff.resumedAt).toBeNull();
    });

    test("list returns prepared handoffs", () => {
      handoffService.prepare({ summary: "first", project: "/proj/test" });
      const list = handoffService.list();
      expect(list.length).toBe(1);
      expect(list[0].summary).toBe("first");
    });

    test("resume with no id resumes the most recent and sets resumedAt", () => {
      handoffService.prepare({ summary: "older", project: "/proj/test" });
      const newer = handoffService.prepare({ summary: "newer", project: "/proj/test" });

      const resumed = handoffService.resume();
      expect(resumed).not.toBeNull();
      expect(resumed!.id).toBe(newer.id);
      expect(resumed!.resumedAt).not.toBeNull();
    });

    test("resume with explicit id targets that handoff", () => {
      const first = handoffService.prepare({ summary: "first", project: "/proj/test" });
      handoffService.prepare({ summary: "second", project: "/proj/test" });

      const resumed = handoffService.resume(first.id);
      expect(resumed!.id).toBe(first.id);
      expect(resumed!.resumedAt).not.toBeNull();
    });

    test("latest returns the most recent without marking resumed", () => {
      handoffService.prepare({ summary: "older", project: "/proj/test" });
      const newer = handoffService.prepare({ summary: "newer", project: "/proj/test" });

      const latest = handoffService.latest();
      expect(latest!.id).toBe(newer.id);
      expect(latest!.resumedAt).toBeNull();
    });

    test("two prepares produce a list of length 2, newest first", () => {
      handoffService.prepare({ summary: "first", project: "/proj/test" });
      const second = handoffService.prepare({ summary: "second", project: "/proj/test" });

      const list = handoffService.list();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe(second.id);
    });

    test("render produces a string containing the summary", () => {
      const handoff = handoffService.prepare({
        summary: "a very particular summary",
        project: "/proj/test",
      });
      const rendered = HandoffService.render(handoff);
      expect(rendered).toContain("a very particular summary");
    });

    test("project scoping excludes handoffs from other projects", () => {
      handoffService.prepare({ summary: "for this project", project: "/proj/test" });
      handoffService.prepare({ summary: "for another project", project: "/other" });

      const scoped = handoffService.list(20, "/proj/test");
      expect(scoped.length).toBe(1);
      expect(scoped[0].summary).toBe("for this project");
    });
  });

  describe("Handler smoke tests", () => {
    test("score_memories", async () => {
      await service.store("some content to score");
      const res = await handleToolCall("score_memories", {}, service);
      expect(res.content[0].text).toContain("Rescored");
    });

    test("list_tags", async () => {
      await service.store("tagged", { tags: ["special-tag"] });
      const res = await handleToolCall("list_tags", {}, service);
      expect(res.content[0].text).toContain("special-tag");
    });

    test("find_duplicates", async () => {
      const dupA = await service.store("duplicate content A");
      const dupB = await service.store("duplicate content B");
      setUnitVector(dupA.id, 0);
      setUnitVector(dupB.id, 0);

      const res = await handleToolCall(
        "find_duplicates",
        { similarity_threshold: 0.9 },
        service,
      );
      expect(res.content[0].text).toMatch(/[Cc]luster/);
    });

    test("prepare_handoff", async () => {
      const res = await handleToolCall("prepare_handoff", { summary: "x" }, service);
      expect(res.content[0].text).toContain("Handoff saved");
    });

    test("list_episodes", async () => {
      await service.store("episodic content", {}, undefined, undefined, {
        episodeId: "ep-handler",
        sequenceNumber: 1,
      });
      const res = await handleToolCall("list_episodes", {}, service);
      expect(res.content[0].text).toContain("ep-handler");
    });

    test("consolidate_memories status", async () => {
      await service.store("some content");
      const res = await handleToolCall(
        "consolidate_memories",
        { action: "status" },
        service,
      );
      expect(res.content[0].text).toContain("Consolidation");
    });
  });
});
