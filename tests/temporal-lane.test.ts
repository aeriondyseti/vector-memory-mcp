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

/** Every text embeds alike: only the time focus can tell the memories apart. */
function flatEmbeddings(): EmbeddingsService {
  const v = () => [1, ...new Array(DIM - 1).fill(0)];
  return {
    dimension: DIM,
    embed: async () => v(),
    embedBatch: async (ts: string[]) => ts.map(v),
  } as unknown as EmbeddingsService;
}

describe("temporal lane", () => {
  let db: Database;
  let tmpDir: string;
  let service: MemoryService;
  let marchId: string;
  // The latest March 15 before now.
  const now = new Date();
  const march = new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 2, 15);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "temporal-lane-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    service = new MemoryService(new MemoryRepository(db), flatEmbeddings());
    const old = await service.store("We cooked a mushroom risotto for the guests.");
    marchId = old.id;
    db.prepare("UPDATE memories SET created_at = ?, updated_at = ?, last_accessed = ? WHERE id = ?").run(
      march.getTime(),
      march.getTime(),
      march.getTime(),
      old.id,
    );
    for (const dish of ["a lentil curry", "fish tacos", "a vegetable stew"]) {
      await service.store(`We cooked ${dish} for the guests.`);
    }
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("a period named in the query lifts memories from it over more recent ones", async () => {
    const [top] = await service.search("What did we cook for the guests in March?", "fact_check");
    expect(top!.id).toBe(marchId);
  });

  test("an explicit focus does the same for a query that names no period", async () => {
    const from = new Date(march.getFullYear(), 2, 1).toISOString().slice(0, 10);
    const to = new Date(march.getFullYear(), 3, 1).toISOString().slice(0, 10);
    const [top] = await service.search("What did we cook for the guests?", "fact_check", { during: `${from}..${to}` });
    expect(top!.id).toBe(marchId);
  });

  test("the focus ranks, it doesn't filter", async () => {
    const results = await service.search("What did we cook for the guests in March?", "fact_check");
    expect(results.length).toBe(4);
  });
});
