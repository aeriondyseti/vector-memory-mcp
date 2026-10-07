import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { EmbeddingsService, modelProfile } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

describe("embedding model profiles", () => {
  test("MiniLM mean-pools and embeds queries as they are", () => {
    const service = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
    expect(modelProfile("Xenova/all-MiniLM-L6-v2").pooling).toBe("mean");
    expect(service.queryText("who leads the covenant")).toBe("who leads the covenant");
  });

  test("retrieval models take the first token and prefix queries, not stored text", () => {
    const service = new EmbeddingsService("Snowflake/snowflake-arctic-embed-xs", 384);
    expect(modelProfile("Snowflake/snowflake-arctic-embed-xs").pooling).toBe("cls");
    expect(service.queryText("who leads the covenant")).toBe(
      "Represent this sentence for searching relevant passages: who leads the covenant",
    );
  });

  test("an unknown model defaults to mean pooling without a prefix", () => {
    expect(modelProfile("someone/new-model")).toEqual({ pooling: "mean", queryPrefix: "" });
  });
});

describe("search embeds the query as a query", () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "embedding-profiles-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("through embedQuery, while stored text goes through embed", async () => {
    const calls: Array<["embed" | "embedQuery", string]> = [];
    const vector = () => [1, ...new Array(383).fill(0)];
    const embeddings = {
      dimension: 384,
      embed: async (t: string) => (calls.push(["embed", t]), vector()),
      embedQuery: async (t: string) => (calls.push(["embedQuery", t]), vector()),
      embedBatch: async (ts: string[]) => ts.map(vector),
    } as unknown as EmbeddingsService;
    const service = new MemoryService(new MemoryRepository(db), embeddings);

    await service.store("The covenant meets at dusk.");
    await service.search("when does the covenant meet", "fact_check");

    expect(calls).toEqual([
      ["embed", "The covenant meets at dusk."],
      ["embedQuery", "when does the covenant meet"],
    ]);
  });
});
