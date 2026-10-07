import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import type { RerankerService } from "../server/core/reranker.service";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;

/** Every text embeds to the same vector: fusion alone can't tell memories apart. */
function flatEmbeddings(): EmbeddingsService {
  const v = () => [1, ...new Array(DIM - 1).fill(0)];
  return {
    dimension: DIM,
    embed: async () => v(),
    embedBatch: async (ts: string[]) => ts.map(v),
  } as unknown as EmbeddingsService;
}

/** Scores a passage by the number in it ("rank 7" → 7); records what it was asked. */
function numberReranker() {
  const calls: Array<{ query: string; passages: string[] }> = [];
  const reranker = {
    calls,
    score: async (query: string, passages: string[]) => {
      calls.push({ query, passages });
      return passages.map((p) => Number(p.match(/rank (\d+)/)?.[1] ?? 0));
    },
  };
  return reranker as unknown as RerankerService & { calls: typeof calls };
}

describe("search reranking", () => {
  let db: Database;
  let tmpDir: string;
  let service: MemoryService;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "reranker-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    service = new MemoryService(new MemoryRepository(db), flatEmbeddings());
    for (const n of [3, 9, 1, 7, 5]) await service.store(`memory rank ${n}`);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  const ranks = async (options: Parameters<MemoryService["search"]>[2] = {}) =>
    (await service.search("which memory", "fact_check", { limit: 5, ...options })).map((r) =>
      Number(r.content.match(/rank (\d+)/)?.[1]),
    );

  test("lifts the memory the cross-encoder prefers, blended with the fused ranking", async () => {
    const before = await ranks();
    const last = before[before.length - 1]!;
    // A cross-encoder that strongly prefers whatever fusion ranked last.
    service.setReranker({
      score: async (_q: string, passages: string[]) =>
        passages.map((p) => (p.endsWith(`rank ${last}`) ? 10 : 0)),
    } as unknown as RerankerService);

    const after = await ranks();

    expect(after.indexOf(last)).toBeLessThan(2);
  });

  test("scores each memory with its context ahead of the content", async () => {
    const reranker = numberReranker();
    service.setReranker(reranker);
    await service.store("memory rank 2", {}, undefined, undefined, { context: "Notes > Ranks" });

    await ranks();

    expect(reranker.calls[0]!.passages).toContain("Notes > Ranks\n\nmemory rank 2");
  });

  test("is skipped with rerank: false, in exact mode, and without a reranker", async () => {
    const reranker = numberReranker();
    service.setReranker(reranker);
    await ranks({ rerank: false });
    await ranks({ mode: "exact" });
    expect(reranker.calls).toEqual([]);

    service.setReranker(null);
    expect((await ranks()).sort()).toEqual([1, 3, 5, 7, 9]);
  });
});
