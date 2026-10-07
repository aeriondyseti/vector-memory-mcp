import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../server/core/connection";
import { runMigrations } from "../server/core/migrations";
import { MemoryRepository } from "../server/core/memory.repository";
import { ConversationRepository } from "../server/core/conversation.repository";
import { MemoryService } from "../server/core/memory.service";
import { buildFtsQuery, serializeVector } from "../server/core/sqlite-utils";
import { computeConfidence, STRONG_FTS_RANK } from "../server/core/memory";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;

/** Each distinct text embeds on its own axis: vectors match nothing, so any hit is the keyword lane's. */
function orthogonalEmbeddings(): EmbeddingsService {
  const axes = new Map<string, number>();
  const embed = async (text: string): Promise<number[]> => {
    if (!axes.has(text)) axes.set(text, axes.size % DIM);
    const v = new Array(DIM).fill(0);
    v[axes.get(text)!] = 1;
    return v;
  };
  return {
    dimension: DIM,
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)),
  } as unknown as EmbeddingsService;
}

describe("buildFtsQuery", () => {
  test("drops question and function words, then matches any of what is left", () => {
    expect(buildFtsQuery("Who leads the Scarlet Covenant?")).toBe('"leads" OR "scarlet" OR "covenant"');
    expect(buildFtsQuery("What do we know about Valerica's faction")).toBe('"valerica" OR "faction"');
    expect(buildFtsQuery("Treaty of 1899, the 1899 treaty")).toBe('"treaty" OR "1899"'); // numbers kept, duplicates dropped
  });

  test("requires every content word in exact mode", () => {
    expect(buildFtsQuery("Scarlet Covenant rules", "all")).toBe('"scarlet" "covenant" "rules"');
  });

  test("falls back to the words of a query made only of stop words, and skips an empty one", () => {
    expect(buildFtsQuery("what is it")).toBe('"what" OR "is" OR "it"');
    expect(buildFtsQuery("  ?! ")).toBeNull();
  });

  test("lets no FTS5 syntax through", () => {
    const q = buildFtsQuery('NEAR(a b) AND "quoted" OR star* col:value') ?? "";
    expect(q.replace(/"[a-z0-9]+"/g, "").replace(/\bOR\b/g, "").trim()).toBe("");
    expect(q).not.toMatch(/near\(|\*|:/i);
  });
});

describe("keyword lane", () => {
  let db: Database;
  let tmpDir: string;
  let repo: MemoryRepository;
  let service: MemoryService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fts-keyword-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    repo = new MemoryRepository(db);
    service = new MemoryService(repo, orthogonalEmbeddings(), "/proj/test");
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  const query = async (q: string, mode: "semantic" | "exact" = "semantic") =>
    repo.findHybrid(new Array(DIM).fill(0).map((_, i) => (i === DIM - 1 ? 1 : 0)), q, 10, { mode });

  test("a natural-language question matches by its content words", async () => {
    const valerica = await service.store("Matriarch Valerica leads the Scarlet Covenant and values decorum.");
    await service.store("The Lupine clans of the North are at war with the vampires.");

    const hit = (await query("Who leads the Scarlet Covenant?")).find((r) => r.id === valerica.id);

    expect(hit?.signals.ftsMatch).toBe(true);
    expect(hit?.signals.ftsRank).toBe(1);
  });

  test("ranks keyword hits by BM25, so memories sharing more of the words come first", async () => {
    const one = await service.store("The covenant met on Tuesday.");
    const three = await service.store("The Scarlet Covenant has strict rules.");
    const five = await service.store("The Scarlet Covenant rules forbid holding political office.");
    const none = await service.store("The Lupine clans of the North are at war.");

    const rows = await query("Scarlet Covenant rules on political office");
    const rank = (id: string) => rows.find((r) => r.id === id)?.signals.ftsRank ?? null;

    expect(rank(five.id)).toBe(1);
    expect(rank(three.id)).toBe(2);
    expect(rank(one.id)).toBe(3); // 1 of 5 words: still a hit, ranked last
    expect(rank(none.id)).toBeNull();
  });

  test("stems words, so a form of a word matches another", async () => {
    const m = await service.store("Decision record: we are migrating the user profiles to MongoDB.");

    const hit = (await query("profile migration")).find((r) => r.id === m.id);

    expect(hit?.signals.ftsMatch).toBe(true);
  });

  test("exact mode requires every content word, ignoring question words", async () => {
    const m = await service.store("Matriarch Valerica leads the Scarlet Covenant.");

    expect((await query("Who leads the Scarlet Covenant?", "exact")).map((r) => r.id)).toContain(m.id);
    expect((await query("Scarlet Covenant rules", "exact")).map((r) => r.id)).not.toContain(m.id);
  });

  test("conversation history matches questions too, and a stop-word-only query is safe", async () => {
    db.prepare(
      `INSERT INTO conversation_history (id, content, metadata, created_at, session_id, role,
         message_index_start, message_index_end, project) VALUES (?, ?, '{}', 0, 's1', 'user', 0, 0, '/proj/test')`,
    ).run("c1", "We decided to keep the export pipeline on the nightly schedule.");
    db.prepare("INSERT INTO conversation_history_vec (id, vector) VALUES (?, ?)").run(
      "c1",
      serializeVector(new Array(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0))),
    );
    db.prepare("INSERT INTO conversation_history_fts (id, content) VALUES (?, ?)").run(
      "c1",
      "We decided to keep the export pipeline on the nightly schedule.",
    );
    const conversations = new ConversationRepository(db);
    const probe = new Array(DIM).fill(0).map((_, i) => (i === 1 ? 1 : 0));

    const rows = await conversations.findHybrid(probe, "When does the export pipeline run?", 5);
    expect(rows.find((r) => r.id === "c1")?.signals.ftsMatch).toBe(true);
    await expect(conversations.findHybrid(probe, "?!", 5)).resolves.toBeDefined();
  });
});

describe("migration v3: stemmed FTS", () => {
  const ftsSql = (db: Database, name: string) =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql;

  test("a fresh database gets stemming FTS tables", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    expect(ftsSql(db, "memories_fts")).toContain("porter");
    expect(ftsSql(db, "conversation_history_fts")).toContain("porter");
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
  });

  test("an existing database's FTS index is rebuilt with stemming and keeps its rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    // Turn it back into a v2 database with the old, unstemmed index.
    db.exec("DROP TABLE memories_fts");
    db.exec("CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content)");
    db.prepare(
      `INSERT INTO memories (id, content, metadata, created_at, updated_at, usefulness, access_count)
       VALUES ('m1', 'We are migrating the profiles.', '{}', 0, 0, 0, 0)`,
    ).run();
    db.prepare("INSERT INTO memories_fts (id, content) VALUES ('m1', 'We are migrating the profiles.')").run();
    db.exec("PRAGMA user_version = 2");
    const stems = () => db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH '\"migration\"'").all();
    expect(stems()).toEqual([]);

    runMigrations(db);

    expect(ftsSql(db, "memories_fts")).toContain("porter");
    expect(stems()).toEqual([{ id: "m1" }]);
  });
});

describe("confidence from keyword hits", () => {
  const signals = (ftsRank: number | null, cosineSimilarity: number | null) => ({
    cosineSimilarity,
    ftsMatch: ftsRank !== null,
    knnRank: cosineSimilarity === null ? null : 1,
    ftsRank,
  });

  test("only a strong keyword hit adds the agreement bonus", () => {
    const base = computeConfidence(signals(null, 0.4));

    expect(computeConfidence(signals(1, 0.4))).toBeGreaterThan(base);
    expect(computeConfidence(signals(STRONG_FTS_RANK + 1, 0.4))).toBe(base);
  });

  test("a keyword-only result is trusted less when it ranks low", () => {
    expect(computeConfidence(signals(STRONG_FTS_RANK, null))).toBe(0.4);
    expect(computeConfidence(signals(STRONG_FTS_RANK + 1, null))).toBe(0.2);
    expect(computeConfidence(signals(null, null))).toBe(0);
  });
});
