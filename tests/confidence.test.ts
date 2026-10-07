import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/core/migrations";
import { knnSearchWithStats, serializeVector } from "../server/core/sqlite-utils";
import { computeConfidence, type SearchSignals, type SimilarityStats } from "../server/core/memory";
import { MemoryRepository } from "../server/core/memory.repository";

/** A store whose query similarities spread like a real one's: mean 0.15, sd 0.08. */
const store = (best: number): SimilarityStats => ({ mean: 0.15, std: 0.08, best });

const signals = (
  cos: number | null,
  ftsRank: number | null,
  similarity: SimilarityStats,
): SearchSignals => ({
  cosineSimilarity: cos,
  ftsMatch: ftsRank !== null,
  knnRank: cos === null ? null : 1,
  ftsRank,
  similarity,
});

describe("two-stage confidence", () => {
  test("the clear best match, confirmed by the keyword lane, is confident", () => {
    expect(computeConfidence(signals(0.62, 1, store(0.62)))).toBeGreaterThan(0.7);
  });

  test("a result well below the query's best match is not", () => {
    const best = computeConfidence(signals(0.62, null, store(0.62)));
    const behind = computeConfidence(signals(0.45, null, store(0.62)));

    expect(behind).toBeLessThan(best / 2);
  });

  test("an off-topic query stays low even for its top result", () => {
    // Nothing in the store is close: the best similarity is the noise floor.
    expect(computeConfidence(signals(0.2, 1, store(0.2)))).toBeLessThan(0.1);
  });

  test("keyword agreement raises confidence; a keyword-only hit stays low", () => {
    const vectorOnly = computeConfidence(signals(0.55, null, store(0.55)));

    expect(computeConfidence(signals(0.55, 1, store(0.55)))).toBeGreaterThan(vectorOnly);
    expect(computeConfidence(signals(null, 1, store(0.55)))).toBeLessThan(0.1);
  });

  test("a reranked result's confidence follows the cross-encoder's verdict", () => {
    const s = signals(0.55, null, store(0.6));
    const doubted = computeConfidence(s, -8);
    const endorsed = computeConfidence(s, 8);

    expect(endorsed).toBeGreaterThan(doubted + 0.3);
    // Still bounded by "is anything relevant at all": an off-topic store stays low.
    expect(computeConfidence(signals(0.2, null, store(0.2)), 8)).toBeLessThan(0.1);
  });

  test("stays within 0–1", () => {
    for (const s of [signals(1, 1, store(1)), signals(-1, null, { mean: 0, std: 0, best: -1 })]) {
      const c = computeConfidence(s);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe("search results carry the similarity stats", () => {
  test("findHybrid rows include them, so search scores with the two-stage model", async () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new MemoryRepository(db);
    const now = new Date();
    for (const [id, x] of [["a", 1], ["b", 0.2]] as const) {
      await repo.insert({
        id,
        content: `memory ${id}`,
        embedding: [x, Math.sqrt(1 - x * x)],
        metadata: {},
        createdAt: now,
        updatedAt: now,
        supersededBy: null,
        usefulness: 0,
        accessCount: 0,
        lastAccessed: null,
        project: null,
      });
    }

    const rows = await repo.findHybrid([1, 0], "unrelated words", 5);

    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.signals.similarity?.best).toBeCloseTo(1, 5);
      expect(r.signals.similarity?.mean).toBeCloseTo(0.6, 5);
    }
  });
});

describe("knnSearchWithStats", () => {
  test("reports mean, spread and best similarity over every vector compared", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const insert = db.prepare("INSERT INTO memories_vec (id, vector) VALUES (?, ?)");
    // Unit vectors at similarity 1, 0.6 and 0.2 to the query [1, 0].
    for (const [id, x] of [["a", 1], ["b", 0.6], ["c", 0.2]] as const) {
      insert.run(id, serializeVector([x, Math.sqrt(1 - x * x)]));
    }

    const { results, stats } = knnSearchWithStats(db, "memories_vec", [1, 0], 2);

    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(stats!.best).toBeCloseTo(1, 5);
    expect(stats!.mean).toBeCloseTo(0.6, 5);
    expect(stats!.std).toBeCloseTo(Math.sqrt((0.16 + 0 + 0.16) / 3), 5);
  });

  test("has no stats for an empty store", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    expect(knnSearchWithStats(db, "memories_vec", [1, 0], 5).stats).toBeNull();
  });
});
