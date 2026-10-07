import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { handleSearchMemories, handleStoreMemories } from "../server/transports/mcp/handlers";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;

/** Each distinct text gets its own axis, except that the query text matches the synthesis. */
function axisEmbeddings(): EmbeddingsService {
  const axes = new Map<string, number>();
  const embed = async (t: string) => {
    const key = t.includes("pattern") ? "pattern" : t;
    if (!axes.has(key)) axes.set(key, axes.size % DIM);
    const v = new Array(DIM).fill(0);
    v[axes.get(key)!] = 1;
    return v;
  };
  return { dimension: DIM, embed, embedBatch: async (ts: string[]) => Promise.all(ts.map(embed)) } as unknown as EmbeddingsService;
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

describe("synthesis memories cite their sources", () => {
  let db: Database;
  let tmpDir: string;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "synthesis-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    service = new MemoryService(new MemoryRepository(db), axisEmbeddings());
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("stores the known sources, drops unknown ones with a note", async () => {
    const a = await service.store("Session 1: the party distrusted the envoy.");
    const b = await service.store("Session 4: the envoy lied about the treaty.");

    const result = await handleStoreMemories(
      {
        memories: [
          { content: "The pattern: the envoy keeps deceiving the party.", sources: [a.id, b.id, "no-such-id"] },
        ],
      },
      service,
    );

    expect(text(result)).toContain("Ignored unknown source ids: no-such-id");
    const stored = service.getRepository().queryMemories({}).find((m) => m.content.startsWith("The pattern"));
    expect(stored!.metadata.sources).toEqual([a.id, b.id]);
  });

  test("search shows the sources, and flags a synthesis whose source was replaced", async () => {
    const a = await service.store("Session 1: the party distrusted the envoy.");
    const b = await service.store("Session 4: the envoy lied about the treaty.");
    await handleStoreMemories(
      { memories: [{ content: "The pattern: the envoy keeps deceiving the party.", sources: [a.id, b.id] }] },
      service,
    );

    const fresh = text(await handleSearchMemories({ query: "what pattern with the envoy" }, service));
    expect(fresh).toContain(`Sources: ${a.id}, ${b.id}`);
    expect(fresh).not.toContain("since replaced");

    await service.delete(b.id);
    const stale = text(await handleSearchMemories({ query: "what pattern with the envoy" }, service));
    expect(stale).toContain("1 since replaced or deleted");
  });
});
