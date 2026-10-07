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

/** Every text embeds alike: what is found depends on lifecycle, not similarity. */
function flatEmbeddings(): EmbeddingsService {
  const v = () => [1, ...new Array(DIM - 1).fill(0)];
  return {
    dimension: DIM,
    embed: async () => v(),
    embedBatch: async (ts: string[]) => ts.map(v),
  } as unknown as EmbeddingsService;
}

describe("lifecycle-aware search", () => {
  let db: Database;
  let tmpDir: string;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-search-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    service = new MemoryService(new MemoryRepository(db), flatEmbeddings());
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("a current memory carries the versions it replaced, newest first", async () => {
    await service.store("The team goal is to ship the beta by March.", { key: "team-goal" });
    await service.store("The team goal is to ship the beta by June, after the audit.", { key: "team-goal" });
    const current = await service.store("The team goal is now a public launch in September.", { key: "team-goal" });

    const [top] = await service.search("team goal", "fact_check");

    expect(top!.id).toBe(current.id);
    expect(top!.history?.map((h) => h.content)).toEqual([
      "The team goal is to ship the beta by June, after the audit.",
      "The team goal is to ship the beta by March.",
    ]);
  });

  test("a merged duplicate is not shown as an earlier version", async () => {
    const keep = await service.store("Valerica leads the Scarlet Covenant.");
    const dup = await service.store("Valerica leads the Scarlet Covenant!");
    await service.mergeDuplicates(keep.id, [dup.id], "keep_content");

    const [top] = await service.search("Who leads the Scarlet Covenant?", "fact_check");

    expect(top!.id).toBe(keep.id);
    expect(top!.history).toBeUndefined();
  });

  test("status filters to open or to resolved memories", async () => {
    const open = await service.store("Fix the login timeout.", { type: "task" });
    const done = await service.store("Fix the login redirect.", { type: "task", status: "resolved" });
    await service.store("The login page uses OAuth.", { type: "decision" });

    const ids = async (status: "open" | "resolved") =>
      (await service.search("login", "fact_check", { status })).map((r) => r.id);

    expect(await ids("open")).toEqual([open.id]);
    expect(await ids("resolved")).toEqual([done.id]);
  });
});
