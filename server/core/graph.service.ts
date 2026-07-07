import { randomUUID } from "crypto";
import type { GraphRepository } from "./graph.repository";
import type { EmbeddingsService } from "./embeddings.service";
import {
  type Entity,
  type EntityType,
  type EdgeType,
  type GraphEdge,
  type EdgeProvenance,
  DEFAULT_CREDIBILITY,
  REFERENCE_EDGE_TYPES,
  type ReferenceEdgeType,
} from "./graph";

/**
 * Business logic + validation for the Knowledge Graph (Feature 19).
 *
 * Three layers built on one `graph_edges` table (namespace-tagged):
 *   - Entity-type / edge-type registries (hard-enforced schema)
 *   - Entity graph (agent-defined nodes + domain edges)
 *   - Memory graph lineage (causal edges between memories)
 *   - Reference bridge (memory -> entity links)
 */
export class GraphService {
  constructor(
    private repo: GraphRepository,
    private embeddings: EmbeddingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Entity-type registry
  // ---------------------------------------------------------------------------

  registerEntityType(t: {
    name: string;
    description: string;
    defaultProperties?: Record<string, unknown>;
    importanceBonus?: number;
  }): EntityType {
    return this.repo.createEntityType(t);
  }

  updateEntityType(
    name: string,
    patch: { description?: string; defaultProperties?: Record<string, unknown>; importanceBonus?: number },
  ): EntityType {
    const updated = this.repo.updateEntityType(name, patch);
    if (!updated) throw new Error(`Entity type "${name}" not found`);
    return updated;
  }

  deleteEntityType(name: string, force = false): void {
    const existing = this.repo.getEntityType(name);
    if (!existing) throw new Error(`Entity type "${name}" not found`);
    if (existing.system) throw new Error(`Cannot delete system entity type "${name}"`);

    const count = this.repo.countEntitiesOfType(name);
    if (count > 0) {
      if (!force) {
        throw new Error(
          `Entity type "${name}" has ${count} entities. Pass force=true to delete them along with the type.`,
        );
      }
      const entities = this.repo.listEntities(name, count, 0);
      for (const e of entities) this.repo.deleteEntity(e.id);
    }

    this.repo.deleteEntityType(name);
  }

  listEntityTypes(): Array<EntityType & { entityCount: number }> {
    return this.repo.listEntityTypes();
  }

  // ---------------------------------------------------------------------------
  // Edge-type registry
  // ---------------------------------------------------------------------------

  registerEdgeType(t: {
    name: string;
    description: string;
    category: string;
    validSourceTypes?: string[] | null;
    validTargetTypes?: string[] | null;
  }): EdgeType {
    return this.repo.createEdgeType(t);
  }

  updateEdgeType(
    name: string,
    patch: {
      description?: string;
      category?: string;
      validSourceTypes?: string[] | null;
      validTargetTypes?: string[] | null;
    },
  ): EdgeType {
    const updated = this.repo.updateEdgeType(name, patch);
    if (!updated) throw new Error(`Edge type "${name}" not found`);
    return updated;
  }

  deleteEdgeType(name: string, force = false): void {
    const existing = this.repo.getEdgeType(name);
    if (!existing) throw new Error(`Edge type "${name}" not found`);
    if (existing.system) throw new Error(`Cannot delete system edge type "${name}"`);

    const count = this.repo.countEdgesOfType(name);
    if (count > 0 && !force) {
      throw new Error(
        `Edge type "${name}" has ${count} edges. Pass force=true to delete them along with the type.`,
      );
    }
    if (count > 0) {
      const all = this.repo
        .edgesByCategory(existing.category)
        .filter((e) => e.edgeType === name);
      for (const e of all) this.repo.deleteEdge(e.id);
    }

    this.repo.deleteEdgeType(name);
  }

  listEdgeTypes(category?: string): Array<EdgeType & { edgeCount: number }> {
    return this.repo.listEdgeTypes(category);
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  async storeEntity(
    type: string,
    name: string,
    properties: Record<string, unknown> = {},
  ): Promise<Entity> {
    const entityType = this.repo.getEntityType(type);
    if (!entityType) {
      throw new Error(
        `Entity type "${type}" is not registered. Call create_entity_type first.`,
      );
    }

    const embedding = await this.embeddings.embed(`${name} ${JSON.stringify(properties)}`);

    const existing = this.repo.getEntityByName(name, type);
    if (existing) {
      return this.repo.updateEntity(existing.id, { properties, embedding })!;
    }

    const now = new Date();
    const entity: Entity = {
      id: randomUUID(),
      type,
      name,
      properties,
      embedding,
      sourceType: "agent",
      sourceRef: null,
      credibility: DEFAULT_CREDIBILITY.agent,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.insertEntity(entity);
    return entity;
  }

  getEntity(idOrName: string, type?: string): Entity | null {
    return this.repo.getEntityById(idOrName) ?? this.repo.getEntityByName(idOrName, type);
  }

  async updateEntity(id: string, properties: Record<string, unknown>): Promise<Entity> {
    const existing = this.repo.getEntityById(id);
    if (!existing) throw new Error(`Entity "${id}" not found`);
    const embedding = await this.embeddings.embed(`${existing.name} ${JSON.stringify(properties)}`);
    const updated = this.repo.updateEntity(id, { properties, embedding });
    if (!updated) throw new Error(`Entity "${id}" not found`);
    return updated;
  }

  deleteEntity(id: string): void {
    this.repo.deleteEntity(id);
  }

  listEntities(type?: string, limit = 50, offset = 0): Entity[] {
    return this.repo.listEntities(type ?? null, limit, offset);
  }

  async searchEntities(
    query: string,
    type?: string,
    limit = 10,
  ): Promise<Array<Entity & { similarity: number }>> {
    const embedding = await this.embeddings.embed(query);
    return this.repo.searchEntities(embedding, type ?? null, limit);
  }

  // ---------------------------------------------------------------------------
  // Domain edges (entity graph)
  // ---------------------------------------------------------------------------

  async linkEntities(
    sourceId: string,
    targetId: string,
    type: string,
    context = "",
  ): Promise<GraphEdge> {
    const edgeType = this.repo.getEdgeType(type);
    if (!edgeType) {
      throw new Error(`Edge type "${type}" is not registered. Call create_edge_type first.`);
    }

    const source = this.repo.getEntityById(sourceId);
    if (!source) throw new Error(`Source entity "${sourceId}" not found`);
    const target = this.repo.getEntityById(targetId);
    if (!target) throw new Error(`Target entity "${targetId}" not found`);

    if (edgeType.validSourceTypes && !edgeType.validSourceTypes.includes(source.type)) {
      throw new Error(
        `Edge type "${type}" requires source entity type in [${edgeType.validSourceTypes.join(", ")}], got "${source.type}"`,
      );
    }
    if (edgeType.validTargetTypes && !edgeType.validTargetTypes.includes(target.type)) {
      throw new Error(
        `Edge type "${type}" requires target entity type in [${edgeType.validTargetTypes.join(", ")}], got "${target.type}"`,
      );
    }

    const embedding = await this.embeddings.embed(`${source.name} ${type} ${target.name}: ${context}`);

    const now = new Date();
    const edge: GraphEdge = {
      id: randomUUID(),
      sourceId,
      sourceNs: "entity",
      targetId,
      targetNs: "entity",
      edgeType: type,
      category: edgeType.category,
      context,
      embedding,
      sourceType: "agent",
      sourceRef: null,
      credibility: DEFAULT_CREDIBILITY.agent,
      provenance: "explicit",
      strength: 1.0,
      createdAt: now,
    };
    this.repo.insertEdge(edge);
    return edge;
  }

  unlinkEntities(edgeId: string): void {
    this.repo.deleteEdge(edgeId);
  }

  entityGraph(
    entityId: string,
    depth = 1,
    typeFilter?: string,
  ): { nodes: Entity[]; edges: GraphEdge[] } {
    const nodes = new Map<string, Entity>();
    const edges = new Map<string, GraphEdge>();

    const root = this.repo.getEntityById(entityId);
    if (!root) return { nodes: [], edges: [] };
    nodes.set(root.id, root);

    let frontier = [entityId];
    const visited = new Set<string>([entityId]);

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        const out = this.repo.edgesFrom(id, "entity");
        const inn = this.repo.edgesTo(id, "entity");
        for (const e of [...out, ...inn]) {
          const neighborId = e.sourceId === id ? e.targetId : e.sourceId;
          const neighbor = this.repo.getEntityById(neighborId);
          if (!neighbor) continue;
          if (typeFilter && neighbor.type !== typeFilter) continue;

          edges.set(e.id, e);
          if (!nodes.has(neighbor.id)) nodes.set(neighbor.id, neighbor);
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }
      }
      frontier = nextFrontier;
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  async searchEntityEdges(query: string, type?: string): Promise<GraphEdge[]> {
    const embedding = await this.embeddings.embed(query);
    const db = this.repo.getDb();
    const rows = db
      .prepare(
        `SELECT ev.id AS id, ev.vector AS vector FROM graph_edges_vec ev
         JOIN graph_edges e ON e.id = ev.id
         WHERE e.category = 'domain' OR e.source_ns = 'entity'`,
      )
      .all() as Array<{ id: string; vector: Buffer }>;

    const qv = new Float32Array(embedding);
    const scored = rows.map((r) => {
      const vec = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4);
      let dot = 0;
      for (let i = 0; i < Math.min(qv.length, vec.length); i++) dot += qv[i] * vec[i];
      return { id: r.id, similarity: dot };
    });
    scored.sort((a, b) => b.similarity - a.similarity);

    const results: GraphEdge[] = [];
    for (const s of scored.slice(0, 20)) {
      const edge = this.repo.getEdgeById(s.id);
      if (!edge) continue;
      if (type && edge.edgeType !== type) continue;
      results.push(edge);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Memory-graph lineage
  // ---------------------------------------------------------------------------

  async lineageLink(
    fromMemoryId: string,
    toMemoryId: string,
    type: string,
    context = "",
  ): Promise<GraphEdge> {
    const edgeType = this.repo.getEdgeType(type);
    if (!edgeType || edgeType.category !== "lineage") {
      throw new Error(`Edge type "${type}" is not a registered lineage edge type.`);
    }

    const embedding = await this.embeddings.embed(`${fromMemoryId} ${type} ${toMemoryId}: ${context}`);

    const now = new Date();
    const edge: GraphEdge = {
      id: randomUUID(),
      sourceId: fromMemoryId,
      sourceNs: "memory",
      targetId: toMemoryId,
      targetNs: "memory",
      edgeType: type,
      category: "lineage",
      context,
      embedding,
      sourceType: "agent",
      sourceRef: null,
      credibility: DEFAULT_CREDIBILITY.agent,
      provenance: "explicit",
      strength: 1.0,
      createdAt: now,
    };
    this.repo.insertEdge(edge);
    return edge;
  }

  lineageTrace(
    memoryId: string,
    direction: "forward" | "backward" | "both" = "both",
    depth = 3,
  ): { edges: GraphEdge[] } {
    const edges = new Map<string, GraphEdge>();
    let frontier = [memoryId];
    const visited = new Set<string>([memoryId]);

    for (let d = 0; d < depth; d++) {
      const nextFrontier: string[] = [];
      for (const id of frontier) {
        const forwardEdges = direction === "forward" || direction === "both"
          ? this.repo.edgesFrom(id, "memory")
          : [];
        const backwardEdges = direction === "backward" || direction === "both"
          ? this.repo.edgesTo(id, "memory")
          : [];

        for (const e of forwardEdges) {
          if (e.category !== "lineage") continue;
          edges.set(e.id, e);
          if (!visited.has(e.targetId)) {
            visited.add(e.targetId);
            nextFrontier.push(e.targetId);
          }
        }
        for (const e of backwardEdges) {
          if (e.category !== "lineage") continue;
          edges.set(e.id, e);
          if (!visited.has(e.sourceId)) {
            visited.add(e.sourceId);
            nextFrontier.push(e.sourceId);
          }
        }
      }
      frontier = nextFrontier;
    }

    return { edges: [...edges.values()] };
  }

  lineageConfirm(edgeId: string): void {
    this.repo.setEdgeProvenance(edgeId, "confirmed" as EdgeProvenance);
  }

  lineageReject(edgeId: string): void {
    this.repo.deleteEdge(edgeId);
  }

  lineageStats(): {
    total: number;
    byType: Record<string, number>;
    byProvenance: Record<string, number>;
  } {
    const edges = this.repo.edgesByCategory("lineage");
    const byType: Record<string, number> = {};
    const byProvenance: Record<string, number> = {};
    for (const e of edges) {
      byType[e.edgeType] = (byType[e.edgeType] ?? 0) + 1;
      byProvenance[e.provenance] = (byProvenance[e.provenance] ?? 0) + 1;
    }
    return { total: edges.length, byType, byProvenance };
  }

  // ---------------------------------------------------------------------------
  // Reference bridge (memory -> entity)
  // ---------------------------------------------------------------------------

  async linkMemoryToEntity(
    memoryId: string,
    entityId: string,
    refType: ReferenceEdgeType = "mentions",
  ): Promise<GraphEdge> {
    if (!REFERENCE_EDGE_TYPES.includes(refType)) {
      throw new Error(
        `Reference type "${refType}" is not valid. Must be one of: ${REFERENCE_EDGE_TYPES.join(", ")}`,
      );
    }

    const embedding = await this.embeddings.embed(`${memoryId} ${refType} ${entityId}`);
    const now = new Date();
    const edge: GraphEdge = {
      id: randomUUID(),
      sourceId: memoryId,
      sourceNs: "memory",
      targetId: entityId,
      targetNs: "entity",
      edgeType: refType,
      category: "reference",
      context: "",
      embedding,
      sourceType: "agent",
      sourceRef: null,
      credibility: DEFAULT_CREDIBILITY.agent,
      provenance: "explicit",
      strength: 1.0,
      createdAt: now,
    };
    this.repo.insertEdge(edge);
    return edge;
  }

  getEntityMemories(entityId: string): string[] {
    return this.repo
      .edgesTo(entityId, "entity")
      .filter((e) => e.category === "reference")
      .map((e) => e.sourceId);
  }
}
