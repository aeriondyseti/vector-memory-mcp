import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import type { EmbeddingsService } from "../server/core/embeddings.service";
import { entitiesNamedIn, graphRecall, HUB_DEGREE } from "../server/core/graph-recall";
import { handleSearchMemories } from "../server/transports/mcp/handlers";
import { removeDir } from "./utils/test-helpers";

const DIM = 384;
const PROJECT = "/proj/test";

/** Each distinct text embeds on an axis of its own: vectors never link memories. */
function distinctEmbeddings(): EmbeddingsService {
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

let db: Database;
let tmpDir: string;
let s: MemoryService;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-search-"));
  db = connectToDatabase(join(tmpDir, "test.db"));
  s = new MemoryService(new MemoryRepository(db), distinctEmbeddings(), PROJECT);
});

afterEach(() => {
  db.close();
  removeDir(tmpDir);
});

function entity(name: string): string {
  const id = randomUUID();
  db.prepare("INSERT INTO entities (id, type, name, properties, created_at, updated_at) VALUES (?, 'concept', ?, '{}', 0, 0)").run(
    id,
    name,
  );
  return id;
}

function link(from: { ns: "memory" | "entity"; id: string }, to: { ns: "memory" | "entity"; id: string }): void {
  db.prepare(
    `INSERT INTO graph_edges (id, source_id, source_ns, target_id, target_ns, edge_type, category, created_at)
     VALUES (?, ?, ?, ?, ?, 'related_to', 'test', 0)`,
  ).run(randomUUID(), from.id, from.ns, to.id, to.ns);
}

const mem = (id: string) => ({ ns: "memory" as const, id });
const ent = (id: string) => ({ ns: "entity" as const, id });

describe("graphRecall", () => {
  test("measures distance in links, whatever the link type", () => {
    const [seed, lineage, sameEntity, viaEntities, tooFar] = ["s", "l", "e", "ee", "far"];
    const a = entity("Alpha");
    const b = entity("Beta");
    const c = entity("Gamma");
    link(mem(seed), mem(lineage)); //                       1 link
    link(mem(seed), ent(a));
    link(mem(sameEntity), ent(a)); //                       2 links
    link(ent(a), ent(b));
    link(mem(viaEntities), ent(b)); //                      3 links
    link(ent(b), ent(c));
    link(mem(tooFar), ent(c)); //                           4 links: out of reach

    const hits = graphRecall(db, { memoryIds: [seed], entityIds: [] }, 10);

    expect(hits.map((h) => [h.id, h.distance])).toEqual([
      [lineage, 1],
      [sameEntity, 2],
      [viaEntities, 3],
    ]);
  });

  test("reaches a seed from another seed, never from itself", () => {
    const e = entity("Shared");
    link(mem("s1"), ent(e));
    link(mem("s2"), ent(e));

    expect(graphRecall(db, { memoryIds: ["s1"], entityIds: [] }, 10)).toEqual([
      { id: "s2", distance: 2, seeds: 1 },
    ]);
    const both = graphRecall(db, { memoryIds: ["s1", "s2"], entityIds: [] }, 10);
    expect(both.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "s1", distance: 2, seeds: 1 },
      { id: "s2", distance: 2, seeds: 1 },
    ]);
  });

  test("ranks a memory reached from more seeds first at equal distance", () => {
    const e1 = entity("One");
    const e2 = entity("Two");
    link(mem("s1"), ent(e1));
    link(mem("s2"), ent(e2));
    link(mem("both"), ent(e1));
    link(mem("both"), ent(e2));
    link(mem("one"), ent(e1));

    const hits = graphRecall(db, { memoryIds: ["s1", "s2"], entityIds: [] }, 10);

    expect(hits[0]).toEqual({ id: "both", distance: 2, seeds: 2 });
    expect(hits[1]).toEqual({ id: "one", distance: 2, seeds: 1 });
  });

  test("does not walk through a hub entity, unless the query named it", () => {
    const hub = entity("Everyone");
    link(mem("seed"), ent(hub));
    for (let i = 0; i < HUB_DEGREE + 1; i++) link(mem(`m${i}`), ent(hub));

    expect(graphRecall(db, { memoryIds: ["seed"], entityIds: [] }, 100)).toEqual([]);
    expect(graphRecall(db, { memoryIds: [], entityIds: [hub] }, 100).length).toBe(HUB_DEGREE + 2);
  });
});

describe("entitiesNamedIn", () => {
  test("matches whole names, ignoring case", () => {
    const gala = entity("Spring Gala");
    entity("Gal");
    entity("main");
    const ab = entity("AB");

    const found = entitiesNamedIn(db, "What is the budget for the spring gala? Check the domain.");

    expect(found).toEqual([gala]);
    expect(entitiesNamedIn(db, "AB testing")).not.toContain(ab); // too short to trust
  });
});

describe("search with the graph lane", () => {
  // These tests are about the lane, so they opt in unless a test says otherwise.
  const search = async (query: string, extra: Record<string, unknown> = {}) =>
    (
      (
        await handleSearchMemories(
          { query, intent: "fact_check", reason_for_search: "test", include_history: false, limit: 3, include_graph: true, ...extra },
          s,
        )
      ).content[0] as { text: string }
    ).text;

  const positionOf = (out: string, id: string): number => {
    const i = out.indexOf(`ID: ${id}`);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };

  async function eventMemories() {
    const venue = await s.store("Venue contract signed with Harbour Hall for the spring event.");
    const catering = await s.store("Catering budget capped at four thousand.");
    const filler = await Promise.all(
      ["Tomatoes need staking in May.", "Library books are due Friday.", "Bike tyres want 60 psi."].map((t) =>
        s.store(t),
      ),
    );
    const gala = entity("Spring Gala");
    link(mem(venue.id), ent(gala));
    link(mem(catering.id), ent(gala));
    return { venue, catering, filler, gala };
  }

  test("does not boost mere neighbours of the best match (GRAPH_NEIGHBOR_WEIGHT is 0)", async () => {
    const { venue } = await eventMemories();

    const out = await search("venue contract");

    expect(positionOf(out, venue.id)).toBe(out.indexOf("ID: "));
    expect(out).not.toContain("via graph");
  });

  test("finds memories about an entity the query names", async () => {
    const { venue, catering } = await eventMemories();

    const out = await search("what do we know about the Spring Gala", { limit: 2 });

    expect(out).toContain(venue.id);
    expect(out).toContain(catering.id);
    expect(out).toContain("via graph (1 link)");
  });

  test("is off unless asked for, and never used in exact mode", async () => {
    await eventMemories();
    const named = "what do we know about the Spring Gala";

    expect(await search(named)).toContain("via graph"); // opted in by this suite's helper
    expect(await search(named, { include_graph: undefined })).not.toContain("via graph"); // the tool's default
    expect(await search(named, { include_graph: false })).not.toContain("via graph");
    expect(await search(named, { mode: "exact" })).not.toContain("via graph");
  });

  test("a project-scoped search keeps graph hits in the project", async () => {
    const { venue, gala } = await eventMemories();
    const elsewhere = await s.store("Other project's note on the gala.", {}, undefined, "/proj/other");
    link(mem(elsewhere.id), ent(gala));

    const out = await search("venue contract", { scope: "project", limit: 10 });

    expect(out).toContain(venue.id);
    expect(out).not.toContain(elsewhere.id);
  });
});
