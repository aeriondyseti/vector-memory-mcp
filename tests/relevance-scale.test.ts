import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;
const unit = (x: number) => [x, Math.sqrt(1 - x * x), ...new Array(DIM - 2).fill(0)];

/** The query sits on axis 0; each stored text gets the similarity its script gives it. */
function scriptedEmbeddings(similarity: Record<string, number>): EmbeddingsService {
  const embed = async (t: string) => unit(similarity[t] ?? 1);
  return {
    dimension: DIM,
    embed,
    embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)),
  } as unknown as EmbeddingsService;
}

describe("relevance vs recency", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "relevance-scale-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("an older exact match outranks a fresh weak one for a fact check", async () => {
    const exact = "The Scarlet Covenant is led by Matriarch Valerica.";
    const weak = "Lunch was a cheese sandwich today.";
    const service = new MemoryService(
      new MemoryRepository(db),
      scriptedEmbeddings({ [exact]: 0.95, [weak]: 0.5 }),
    );
    const old = await service.store(exact);
    await service.store(weak);
    const ninetyDaysAgo = Date.now() - 90 * 86_400_000;
    db.prepare("UPDATE memories SET created_at = ?, updated_at = ?, last_accessed = ? WHERE id = ?").run(
      ninetyDaysAgo,
      ninetyDaysAgo,
      ninetyDaysAgo,
      old.id,
    );

    const results = await service.search("Who leads the Scarlet Covenant?", "fact_check");

    expect(results[0]?.id).toBe(old.id);
  });
});
