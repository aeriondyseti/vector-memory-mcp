import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { runMigrations, SCHEMA_VERSION } from "../server/core/migrations";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import { indexedText, normalizeContext, MAX_CONTEXT_CHARS } from "../server/core/memory";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;

/** Each distinct text embeds on its own axis (so vectors match nothing); every embedded text is recorded. */
function recordingEmbeddings(): EmbeddingsService & { texts: string[] } {
  const axes = new Map<string, number>();
  const texts: string[] = [];
  const embed = async (text: string): Promise<number[]> => {
    texts.push(text);
    if (!axes.has(text)) axes.set(text, axes.size % DIM);
    const v = new Array(DIM).fill(0);
    v[axes.get(text)!] = 1;
    return v;
  };
  return {
    dimension: DIM,
    texts,
    embed,
    embedBatch: async (batch: string[]) => Promise.all(batch.map(embed)),
  } as unknown as EmbeddingsService & { texts: string[] };
}

describe("normalizeContext / indexedText", () => {
  test("trims and collapses whitespace, empties to null, caps length", () => {
    expect(normalizeContext("  Atlas  >\n Auth ")).toBe("Atlas > Auth");
    expect(normalizeContext("   ")).toBeNull();
    expect(normalizeContext(undefined)).toBeNull();
    expect(normalizeContext("x".repeat(MAX_CONTEXT_CHARS + 50))?.length).toBe(MAX_CONTEXT_CHARS);
  });

  test("puts the context ahead of the text, and leaves text without one alone", () => {
    expect(indexedText("Tokens expire hourly.", "Atlas > Auth")).toBe("Atlas > Auth\n\nTokens expire hourly.");
    expect(indexedText("Tokens expire hourly.", null)).toBe("Tokens expire hourly.");
  });
});

describe("memory context", () => {
  let db: Database;
  let tmpDir: string;
  let repo: MemoryRepository;
  let embeddings: ReturnType<typeof recordingEmbeddings>;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "memory-context-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repo = new MemoryRepository(db);
    embeddings = recordingEmbeddings();
    service = new MemoryService(repo, embeddings, "/proj/test");
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  /** Keyword-lane rank of each memory for `q` (the query vector matches nothing). */
  const keywordRanks = async (q: string) => {
    const rows = await repo.findHybrid(new Array(DIM).fill(0).map((_, i) => (i === DIM - 1 ? 1 : 0)), q, 10);
    return new Map(rows.filter((r) => r.signals.ftsMatch).map((r) => [r.id, r.signals.ftsRank]));
  };

  test("is stored, returned, and embedded ahead of the content — not part of it", async () => {
    const m = await service.store("Tokens expire hourly.", {}, undefined, undefined, { context: "Atlas design > Auth" });

    const back = await repo.findById(m.id);
    expect(back?.content).toBe("Tokens expire hourly.");
    expect(back?.context).toBe("Atlas design > Auth");
    expect(embeddings.texts).toEqual(["Atlas design > Auth\n\nTokens expire hourly."]);
  });

  test("a memory without context embeds its content alone", async () => {
    await service.store("Tokens expire hourly.");
    expect(embeddings.texts).toEqual(["Tokens expire hourly."]);
  });

  test("the keyword lane matches words found only in the context, weighted above content", async () => {
    const inContent = await service.store("The treaty was signed at dawn after the siege.");
    const inContext = await service.store("It was signed at dawn after the siege.", {}, undefined, undefined, {
      context: "Treaty of Ashes",
    });

    const ranks = await keywordRanks("treaty");

    expect(ranks.get(inContext.id)).toBe(1);
    expect(ranks.get(inContent.id)).toBe(2);
  });

  test("reading or voting on a memory keeps its context indexed", async () => {
    const m = await service.store("It was signed at dawn.", {}, undefined, undefined, { context: "Treaty of Ashes" });

    await service.get(m.id);
    await service.vote(m.id, 1);

    expect((await keywordRanks("ashes")).get(m.id)).toBe(1);
  });

  test("updating the context re-embeds; an empty context clears it; a content update keeps it", async () => {
    const m = await service.store("Tokens expire hourly.", {}, undefined, undefined, { context: "Atlas > Auth" });

    await service.update(m.id, { attributes: { context: "Atlas > Sessions" } });
    expect(embeddings.texts.at(-1)).toBe("Atlas > Sessions\n\nTokens expire hourly.");
    expect((await keywordRanks("sessions")).get(m.id)).toBe(1);

    await service.update(m.id, { content: "Tokens expire daily." });
    expect(embeddings.texts.at(-1)).toBe("Atlas > Sessions\n\nTokens expire daily.");

    const cleared = await service.update(m.id, { attributes: { context: "" } });
    expect(cleared?.context).toBeNull();
    expect(embeddings.texts.at(-1)).toBe("Tokens expire daily.");
    expect((await keywordRanks("sessions")).get(m.id)).toBeUndefined();
  });

  test("an update that leaves content and context alone doesn't re-embed", async () => {
    const m = await service.store("Tokens expire hourly.", {}, undefined, undefined, { context: "Atlas > Auth" });
    const embedded = embeddings.texts.length;

    await service.update(m.id, { attributes: { pinned: true } });

    expect(embeddings.texts.length).toBe(embedded);
  });
});

describe("migration v4: memory context", () => {
  test("adds the column and a context column to the keyword index, keeping its rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    // Turn it back into a v3 database: no context column, single-column index.
    db.exec("DROP TABLE memories_fts");
    db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, tokenize = 'porter unicode61')");
    db.exec("ALTER TABLE memories DROP COLUMN context");
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at, usefulness, access_count)
       VALUES ('m1', 'We are migrating the profiles.', '{}', 0, 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO memories_fts (id, content) VALUES ('m1', 'We are migrating the profiles.')").run();
    db.exec("PRAGMA user_version = 3");

    runMigrations(db);

    const columns = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain("context");
    const ftsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memories_fts'").get() as { sql: string }).sql;
    expect(ftsSql).toContain("context");
    expect(ftsSql).toContain("porter");
    expect(db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH '\"migration\"'").all()).toEqual([{ id: "m1" }]);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });
});
