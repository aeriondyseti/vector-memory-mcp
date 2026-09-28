import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { ensureGraphSchema, GraphRepository } from "../server/core/graph.repository";
import { GraphService } from "../server/core/graph.service";
import { createMockEmbeddings, removeDir } from "./utils/test-helpers";

describe("Knowledge Graph core (Feature 19)", () => {
  let db: Database;
  let repo: GraphRepository;
  let service: GraphService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "graph-"));
    db = connectToDatabase(join(tmpDir, "test.db"));
    ensureGraphSchema(db);
    repo = new GraphRepository(db);
    service = new GraphService(repo, createMockEmbeddings());
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("system entity types are seeded (Memory)", () => {
    const types = service.listEntityTypes();
    const memory = types.find((t) => t.name === "Memory");
    expect(memory).toBeDefined();
    expect(memory!.system).toBe(true);
  });

  test("system lineage edge types are seeded", () => {
    const types = service.listEdgeTypes("lineage");
    const names = types.map((t) => t.name).sort();
    expect(names).toEqual(
      ["caused", "informed_by", "resolved_by", "superseded_by", "triggered"].sort(),
    );
    for (const t of types) expect(t.system).toBe(true);
  });

  test("ensureGraphSchema is idempotent", () => {
    expect(() => {
      ensureGraphSchema(db);
      ensureGraphSchema(db);
    }).not.toThrow();
    expect(service.listEntityTypes().filter((t) => t.name === "Memory").length).toBe(1);
  });

  test("storeEntity throws for unregistered type", async () => {
    await expect(service.storeEntity("Character", "Bob", {})).rejects.toThrow(/not registered/);
  });

  test("registerEntityType then storeEntity succeeds", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const entity = await service.storeEntity("Character", "Bob", { age: 30 });
    expect(entity.id).toBeDefined();
    expect(entity.type).toBe("Character");
    expect(entity.name).toBe("Bob");
    expect(entity.sourceType).toBe("agent");
  });

  test("storeEntity upserts by (name, type)", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const first = await service.storeEntity("Character", "Bob", { age: 30 });
    const second = await service.storeEntity("Character", "Bob", { age: 31 });
    expect(second.id).toBe(first.id);
    expect(second.properties.age).toBe(31);
  });

  test("registerEdgeType with type constraints", () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    const edgeType = service.registerEdgeType({
      name: "RESIDES_IN",
      description: "resides in",
      category: "domain",
      validSourceTypes: ["Character"],
      validTargetTypes: ["Location"],
    });
    expect(edgeType.validSourceTypes).toEqual(["Character"]);
    expect(edgeType.validTargetTypes).toEqual(["Location"]);
  });

  test("linkEntities succeeds when types satisfy constraints", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    service.registerEdgeType({
      name: "RESIDES_IN",
      description: "resides in",
      category: "domain",
      validSourceTypes: ["Character"],
      validTargetTypes: ["Location"],
    });

    const bob = await service.storeEntity("Character", "Bob");
    const town = await service.storeEntity("Location", "Springfield");

    const edge = await service.linkEntities(bob.id, town.id, "RESIDES_IN", "lives there");
    expect(edge.sourceId).toBe(bob.id);
    expect(edge.targetId).toBe(town.id);
    expect(edge.category).toBe("domain");
    expect(edge.provenance).toBe("explicit");
  });

  test("linkEntities throws when edge type is not registered", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const bob = await service.storeEntity("Character", "Bob");
    const alice = await service.storeEntity("Character", "Alice");
    await expect(service.linkEntities(bob.id, alice.id, "UNKNOWN_EDGE")).rejects.toThrow(
      /not registered/,
    );
  });

  test("linkEntities throws on type-constraint violation", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    service.registerEdgeType({
      name: "RESIDES_IN",
      description: "resides in",
      category: "domain",
      validSourceTypes: ["Character"],
      validTargetTypes: ["Location"],
    });

    const bob = await service.storeEntity("Character", "Bob");
    const alice = await service.storeEntity("Character", "Alice");

    await expect(service.linkEntities(bob.id, alice.id, "RESIDES_IN")).rejects.toThrow(
      /requires target entity type/,
    );
  });

  test("entityGraph returns the neighbor and edge", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    service.registerEdgeType({
      name: "RESIDES_IN",
      description: "resides in",
      category: "domain",
      validSourceTypes: ["Character"],
      validTargetTypes: ["Location"],
    });

    const bob = await service.storeEntity("Character", "Bob");
    const town = await service.storeEntity("Location", "Springfield");
    await service.linkEntities(bob.id, town.id, "RESIDES_IN");

    const graph = service.entityGraph(bob.id, 1);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([bob.id, town.id].sort());
    expect(graph.edges.length).toBe(1);
  });

  test("entityGraph respects typeFilter", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    service.registerEdgeType({
      name: "RESIDES_IN",
      description: "resides in",
      category: "domain",
    });

    const bob = await service.storeEntity("Character", "Bob");
    const alice = await service.storeEntity("Character", "Alice");
    const town = await service.storeEntity("Location", "Springfield");
    await service.linkEntities(bob.id, town.id, "RESIDES_IN");
    await service.linkEntities(bob.id, alice.id, "RESIDES_IN");

    const graph = service.entityGraph(bob.id, 1, "Location");
    expect(graph.nodes.map((n) => n.id)).not.toContain(alice.id);
    expect(graph.nodes.map((n) => n.id)).toContain(town.id);
  });

  test("searchEntities returns the stored entity", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const bob = await service.storeEntity("Character", "Bob", { age: 30 });

    const results = await service.searchEntities("Bob", "Character", 5);
    expect(results.map((r) => r.id)).toContain(bob.id);
  });

  test("deleteEntity removes its edges", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEntityType({ name: "Location", description: "A location" });
    service.registerEdgeType({ name: "RESIDES_IN", description: "resides in", category: "domain" });

    const bob = await service.storeEntity("Character", "Bob");
    const town = await service.storeEntity("Location", "Springfield");
    const edge = await service.linkEntities(bob.id, town.id, "RESIDES_IN");

    service.deleteEntity(bob.id);

    expect(service.getEntity(bob.id)).toBeNull();
    expect(repo.getEdgeById(edge.id)).toBeNull();
  });

  test("deleteEntityType without force throws when entities exist", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    await service.storeEntity("Character", "Bob");
    expect(() => service.deleteEntityType("Character")).toThrow(/has 1 entities/);
  });

  test("deleteEntityType with force succeeds and removes entities", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const bob = await service.storeEntity("Character", "Bob");
    service.deleteEntityType("Character", true);

    expect(service.getEntity(bob.id)).toBeNull();
    expect(service.listEntityTypes().find((t) => t.name === "Character")).toBeUndefined();
  });

  test("deleteEntityType throws for system types", () => {
    expect(() => service.deleteEntityType("Memory")).toThrow(/system/);
  });

  test("deleteEdgeType throws for system types", () => {
    expect(() => service.deleteEdgeType("caused")).toThrow(/system/);
  });

  test("lineageLink with a system lineage type works and lineageTrace finds it", async () => {
    const edge = await service.lineageLink("mem-1", "mem-2", "caused", "root cause");
    expect(edge.category).toBe("lineage");
    expect(edge.sourceNs).toBe("memory");

    const forward = service.lineageTrace("mem-1", "forward", 2);
    expect(forward.edges.map((e) => e.id)).toContain(edge.id);

    const backward = service.lineageTrace("mem-2", "backward", 2);
    expect(backward.edges.map((e) => e.id)).toContain(edge.id);
  });

  test("lineageLink throws for non-lineage edge type", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    service.registerEdgeType({ name: "OWNS", description: "owns", category: "domain" });
    await expect(service.lineageLink("mem-1", "mem-2", "OWNS")).rejects.toThrow(
      /not a registered lineage edge type/,
    );
  });

  test("lineageConfirm sets provenance to confirmed", async () => {
    const edge = await service.lineageLink("mem-1", "mem-2", "caused");
    service.lineageConfirm(edge.id);
    const updated = repo.getEdgeById(edge.id);
    expect(updated!.provenance).toBe("confirmed");
  });

  test("lineageReject deletes the edge", async () => {
    const edge = await service.lineageLink("mem-1", "mem-2", "caused");
    service.lineageReject(edge.id);
    expect(repo.getEdgeById(edge.id)).toBeNull();
  });

  test("lineageStats aggregates by type and provenance", async () => {
    await service.lineageLink("mem-1", "mem-2", "caused");
    const e2 = await service.lineageLink("mem-2", "mem-3", "triggered");
    service.lineageConfirm(e2.id);

    const stats = service.lineageStats();
    expect(stats.total).toBe(2);
    expect(stats.byType.caused).toBe(1);
    expect(stats.byType.triggered).toBe(1);
    expect(stats.byProvenance.explicit).toBe(1);
    expect(stats.byProvenance.confirmed).toBe(1);
  });

  test("linkMemoryToEntity + getEntityMemories round-trip", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const bob = await service.storeEntity("Character", "Bob");

    await service.linkMemoryToEntity("mem-1", bob.id, "mentions");
    await service.linkMemoryToEntity("mem-2", bob.id, "describes");

    const memoryIds = service.getEntityMemories(bob.id);
    expect(memoryIds.sort()).toEqual(["mem-1", "mem-2"].sort());
  });

  test("linkMemoryToEntity rejects invalid reference type", async () => {
    service.registerEntityType({ name: "Character", description: "A character" });
    const bob = await service.storeEntity("Character", "Bob");
    await expect(
      // @ts-expect-error testing runtime validation of an invalid ref type
      service.linkMemoryToEntity("mem-1", bob.id, "bogus"),
    ).rejects.toThrow(/not valid/);
  });
});
