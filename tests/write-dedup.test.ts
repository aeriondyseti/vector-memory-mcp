import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import {
  MemoryService,
  tokenJaccard,
  WRITE_DUPLICATE_SIMILARITY,
} from "../server/core/memory.service";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import {
  handleCleanupDuplicates,
  handleFindDuplicates,
  handleStoreMemories,
} from "../server/transports/mcp/handlers";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;
const PROJECT = "/proj/test";

/** A unit vector whose cosine similarity with the axis-0 unit vector is `s`. */
function withSimilarity(s: number): number[] {
  const v = new Array(DIM).fill(0);
  v[0] = s;
  v[1] = Math.sqrt(1 - s * s);
  return v;
}

/**
 * Embeddings whose similarities the test decides: a text listed in `vectors`
 * embeds as given; any other text gets an orthogonal axis of its own.
 */
function controlledEmbeddings(vectors: Map<string, number[]>): EmbeddingsService {
  let nextAxis = 10;
  const assigned = new Map<string, number[]>();
  const embed = async (text: string): Promise<number[]> => {
    const given = vectors.get(text) ?? assigned.get(text);
    if (given) return given;
    const v = new Array(DIM).fill(0);
    v[nextAxis++] = 1;
    assigned.set(text, v);
    return v;
  };
  return {
    dimension: DIM,
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)),
  } as unknown as EmbeddingsService;
}

const DECISION = "Kevin chose SQLite with sqlite-vec for the memory store because it needs no server.";
const DECISION_REPEAT = "Kevin chose SQLite with sqlite-vec for the memory store, because it needs no server!";
const DECISION_REWORDED = "The storage layer is a single embedded database file; running a daemon was ruled out.";

describe("tokenJaccard", () => {
  test("ignores case, punctuation and short words", () => {
    expect(tokenJaccard(DECISION, DECISION_REPEAT)).toBe(1);
    expect(tokenJaccard("A cat sat", "a CAT sat!")).toBe(1);
  });

  test("is low for the same idea in other words", () => {
    expect(tokenJaccard(DECISION, DECISION_REWORDED)).toBeLessThan(0.3);
  });

  test("treats two texts without words as identical", () => {
    expect(tokenJaccard("", "!?")).toBe(1);
  });
});

describe("storeUnlessDuplicate", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;
  const vectors = new Map<string, number[]>();

  const service = (): MemoryService =>
    new MemoryService(repository, controlledEmbeddings(vectors), PROJECT);

  const liveCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NULL").get() as { n: number }).n;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "write-dedup-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    vectors.clear();
    vectors.set(DECISION, withSimilarity(1));
    vectors.set(DECISION_REPEAT, withSimilarity(0.99));
    vectors.set(DECISION_REWORDED, withSimilarity(0.97));
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("skips a repeat of one existing memory and returns it", async () => {
    const s = service();
    const first = await s.store(DECISION);

    const outcome = await s.storeUnlessDuplicate(DECISION_REPEAT);

    expect(outcome.status).toBe("duplicate");
    if (outcome.status === "duplicate") {
      expect(outcome.existing.id).toBe(first.id);
      expect(outcome.similarity).toBeGreaterThanOrEqual(WRITE_DUPLICATE_SIMILARITY);
    }
    expect(liveCount()).toBe(1);
  });

  test("stores a similar-embedding memory worded differently", async () => {
    const s = service();
    await s.store(DECISION);

    const outcome = await s.storeUnlessDuplicate(DECISION_REWORDED);

    expect(outcome.status).toBe("stored");
    expect(liveCount()).toBe(2);
  });

  test("stores the same words when the embeddings are not close enough", async () => {
    vectors.set(DECISION_REPEAT, withSimilarity(0.9));
    const s = service();
    await s.store(DECISION);

    const outcome = await s.storeUnlessDuplicate(DECISION_REPEAT);

    expect(outcome.status).toBe("stored");
  });

  test("stores and flags a write that matches several memories", async () => {
    const s = service();
    const a = await s.store(DECISION);
    const b = await s.store(DECISION_REPEAT);

    const outcome = await s.storeUnlessDuplicate(DECISION);

    expect(outcome.status).toBe("stored");
    if (outcome.status === "stored") {
      expect(new Set(outcome.possibleDuplicateOf)).toEqual(new Set([a.id, b.id]));
      expect(new Set(outcome.memory.metadata.possible_duplicate_of as string[])).toEqual(
        new Set([a.id, b.id]),
      );
    }
    expect(liveCount()).toBe(3);
  });

  test("checks only the memory's own project", async () => {
    const s = service();
    await s.store(DECISION, {}, undefined, "/proj/other");

    const outcome = await s.storeUnlessDuplicate(DECISION_REPEAT);

    expect(outcome.status).toBe("stored");
  });

  test("ignores deleted, archived and waypoint memories", async () => {
    const s = service();
    const deleted = await s.store(DECISION);
    await s.delete(deleted.id);
    const archived = await s.store(DECISION);
    await s.setArchived([archived.id], true);
    await s.store(DECISION, { type: "waypoint" });

    const outcome = await s.storeUnlessDuplicate(DECISION_REPEAT);

    expect(outcome.status).toBe("stored");
  });

  test("proactive_context auto-ingest does not pile up repeats", async () => {
    vectors.set("Working on the export pipeline today.", withSimilarity(1));
    const s = service();

    await s.proactiveContext("Working on the export pipeline today.", 5, 0.65, true);
    await s.proactiveContext("Working on the export pipeline today.", 5, 0.65, true);

    expect(liveCount()).toBe(1);
  });
});

describe("store_memories", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;
  let s: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "write-dedup-handler-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    s = new MemoryService(
      repository,
      controlledEmbeddings(
        new Map([
          [DECISION, withSimilarity(1)],
          [DECISION_REPEAT, withSimilarity(0.99)],
        ]),
      ),
      PROJECT,
    );
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  const text = (r: Awaited<ReturnType<typeof handleStoreMemories>>): string =>
    (r.content[0] as { text: string }).text;

  test("names the existing memory instead of storing a duplicate", async () => {
    const first = await s.store(DECISION);

    const result = text(await handleStoreMemories({ memories: [{ content: DECISION_REPEAT }] }, s));

    expect(result).toContain(`Not stored: duplicate of existing memory ${first.id}`);
    expect(result).toContain(DECISION);
    expect(result).not.toContain("Memory stored with ID");
  });

  test("dedups within one batch, keeping the original line for what was stored", async () => {
    const result = text(
      await handleStoreMemories(
        { memories: [{ content: DECISION }, { content: DECISION_REPEAT }, { content: "Unrelated fact." }] },
        s,
      ),
    );

    expect(result).toContain("Stored 2 memories:");
    expect(result).toContain("Not stored: duplicate of existing memory");
  });

  test("allow_duplicates stores the copy anyway", async () => {
    await s.store(DECISION);

    const result = text(
      await handleStoreMemories({ memories: [{ content: DECISION_REPEAT }], allow_duplicates: true }, s),
    );

    expect(result).toMatch(/^Memory stored with ID: /);
  });
});

describe("cleanup_duplicates and consolidation", () => {
  let db: Database;
  let repository: MemoryRepository;
  let tmpDir: string;
  let s: MemoryService;

  const RULE = "Deploys run from the main branch after CI passes.";
  const RULE_AGAIN = "Deploys run from the main branch, after CI passes!";
  const RULE_THIRD = "deploys run from the main branch after ci passes";
  const RULE_REWORDED = "Shipping happens off main once the pipeline is green.";

  /** Store `content` with its vector at `degrees` in a plane (cos of the gap = similarity). */
  const storeAt = async (
    content: string,
    degrees: number,
    createdAt: number,
    extra: { project?: string; pinned?: boolean } = {},
  ) => {
    const m = await s.store(content, {}, undefined, extra.project, { pinned: extra.pinned });
    const v = new Array(DIM).fill(0);
    v[0] = Math.cos((degrees * Math.PI) / 180);
    v[1] = Math.sin((degrees * Math.PI) / 180);
    db.prepare("INSERT OR REPLACE INTO memories_vec (id, vector) VALUES (?, ?)").run(
      m.id,
      Buffer.from(new Float32Array(v).buffer),
    );
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(createdAt, m.id);
    return m.id;
  };

  const isLive = (id: string): boolean =>
    (db.prepare("SELECT superseded_by FROM memories WHERE id = ?").get(id) as { superseded_by: string | null })
      .superseded_by === null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cleanup-dedup-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repository = new MemoryRepository(db);
    s = new MemoryService(repository, controlledEmbeddings(new Map()), PROJECT);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("merges a clear duplicate into the newest", async () => {
    const older = await storeAt(RULE, 0, 1000);
    const newer = await storeAt(RULE_AGAIN, 5, 2000);

    const r = await s.cleanupDuplicates();

    expect(r).toMatchObject({ clusters: 1, deleted: 1, review: 0 });
    expect(isLive(newer)).toBe(true);
    expect(isLive(older)).toBe(false);
  });

  test("merges only members that match the survivor directly, not through the chain", async () => {
    // 0° ~ 15° ~ 30°: neighbours at cos 0.966, the ends at cos 0.866.
    const a = await storeAt(RULE, 0, 1000);
    const b = await storeAt(RULE_AGAIN, 15, 2000);
    const keep = await storeAt(RULE_THIRD, 30, 3000);

    const r = await s.cleanupDuplicates();

    expect(isLive(keep)).toBe(true);
    expect(isLive(b)).toBe(false);
    expect(isLive(a)).toBe(true);
    expect(r.plans[0]?.review).toEqual([{ id: a, reason: "similar only through other members" }]);
  });

  test("leaves different wording, other projects and pinned memories for review", async () => {
    const keep = await storeAt(RULE, 0, 5000);
    const reworded = await storeAt(RULE_REWORDED, 2, 1000);
    const elsewhere = await storeAt(RULE_AGAIN, 2, 2000, { project: "/proj/other" });
    const pinned = await storeAt(RULE_THIRD, 2, 3000, { pinned: true });

    const r = await s.cleanupDuplicates();

    expect(r.deleted).toBe(0);
    expect([keep, reworded, elsewhere, pinned].every(isLive)).toBe(true);
    const reasons = new Map(r.plans.flatMap((p) => p.review.map((i) => [i.id, i.reason])));
    expect(reasons.get(reworded)).toBe("worded differently");
    expect(reasons.get(elsewhere)).toBe("different project");
    expect(reasons.get(pinned)).toBe("pinned or critical");
  });

  test("dry_run lists the plan without merging", async () => {
    const older = await storeAt(RULE, 0, 1000);
    const newer = await storeAt(RULE_AGAIN, 5, 2000);
    await storeAt(RULE_REWORDED, 3, 500);

    const text = ((await handleCleanupDuplicates({ dry_run: true }, s)).content[0] as { text: string }).text;

    expect(text).toContain("Would merge 1 duplicate memories in 1 clusters");
    expect(text).toContain(`keep ${newer}, merge: ${older}`);
    expect(text).toContain("worded differently");
    expect(isLive(older)).toBe(true);
  });

  test("find_duplicates still lists every candidate from 0.92, read-only", async () => {
    // cos(20°) = 0.94: a candidate for find_duplicates, below cleanup's 0.95.
    const a = await storeAt(RULE, 0, 1000);
    const b = await storeAt(RULE_AGAIN, 20, 2000);

    const found = ((await handleFindDuplicates({}, s)).content[0] as { text: string }).text;
    const cleaned = await s.cleanupDuplicates();

    expect(found).toContain("1 duplicate clusters (threshold 0.92)");
    expect(cleaned.deleted).toBe(0);
    expect(isLive(a) && isLive(b)).toBe(true);
  });

  test("consolidation compresses only clear duplicates and counts the rest", async () => {
    const older = await storeAt(RULE, 0, 1000);
    const newer = await storeAt(RULE_AGAIN, 5, 2000);
    const reworded = await storeAt(RULE_REWORDED, 3, 500);

    const preview = await s.consolidateMemories("recommend");
    const run = await s.consolidateMemories("run");

    expect(preview).toMatchObject({ duplicateClusters: 1, duplicatesForReview: 1 });
    expect(run.compressed).toBe(1);
    expect(isLive(newer)).toBe(true);
    expect(isLive(older)).toBe(false);
    expect(isLive(reworded)).toBe(true);
  });
});
