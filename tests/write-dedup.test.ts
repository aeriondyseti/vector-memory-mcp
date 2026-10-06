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
import { handleStoreMemories } from "../server/transports/mcp/handlers";
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
