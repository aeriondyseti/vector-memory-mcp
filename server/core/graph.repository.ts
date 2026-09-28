import type { Database } from "bun:sqlite";
import { serializeVector, deserializeVector, safeParseJsonObject } from "./sqlite-utils";
import {
  type Entity,
  type EntityType,
  type EdgeType,
  type GraphEdge,
  type GraphNamespace,
  type SourceType,
  type EdgeProvenance,
  SYSTEM_ENTITY_TYPES,
  SYSTEM_EDGE_TYPES,
} from "./graph";

/**
 * Create the knowledge-graph tables (idempotent) and seed system entity/edge
 * types. Safe to call on every startup.
 */
export function ensureGraphSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_types (
      name TEXT PRIMARY KEY,
      description TEXT,
      default_properties TEXT DEFAULT '{}',
      importance_bonus REAL DEFAULT 0,
      system INTEGER DEFAULT 0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS edge_types (
      name TEXT PRIMARY KEY,
      description TEXT,
      category TEXT,
      valid_source_types TEXT,
      valid_target_types TEXT,
      system INTEGER DEFAULT 0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT,
      name TEXT,
      properties TEXT DEFAULT '{}',
      source_type TEXT,
      source_ref TEXT,
      credibility REAL,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS entities_vec (
      id TEXT PRIMARY KEY,
      vector BLOB
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      source_ns TEXT,
      target_id TEXT,
      target_ns TEXT,
      edge_type TEXT,
      category TEXT,
      context TEXT DEFAULT '',
      source_type TEXT,
      source_ref TEXT,
      credibility REAL,
      provenance TEXT,
      strength REAL DEFAULT 1.0,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS graph_edges_vec (
      id TEXT PRIMARY KEY,
      vector BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_source_id ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_target_id ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_edge_type ON graph_edges(edge_type);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_category ON graph_edges(category);
  `);

  const now = Date.now();

  const insertEntityType = db.prepare(
    `INSERT OR IGNORE INTO entity_types (name, description, default_properties, importance_bonus, system, created_at)
     VALUES (?, ?, '{}', 0, 1, ?)`,
  );
  for (const t of SYSTEM_ENTITY_TYPES) {
    insertEntityType.run(t.name, t.description, now);
  }

  const insertEdgeType = db.prepare(
    `INSERT OR IGNORE INTO edge_types (name, description, category, valid_source_types, valid_target_types, system, created_at)
     VALUES (?, ?, ?, NULL, NULL, 1, ?)`,
  );
  for (const t of SYSTEM_EDGE_TYPES) {
    insertEdgeType.run(t.name, t.description, t.category, now);
  }
}

export class GraphRepository {
  constructor(private db: Database) {}

  getDb(): Database {
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Row mapping
  // ---------------------------------------------------------------------------

  private rowToEntityType(row: Record<string, unknown>): EntityType {
    return {
      name: row.name as string,
      description: (row.description as string) ?? "",
      defaultProperties: safeParseJsonObject(row.default_properties),
      importanceBonus: (row.importance_bonus as number) ?? 0,
      system: Boolean(row.system),
      createdAt: new Date(row.created_at as number),
    };
  }

  private rowToEdgeType(row: Record<string, unknown>): EdgeType {
    return {
      name: row.name as string,
      description: (row.description as string) ?? "",
      category: (row.category as string) ?? "",
      validSourceTypes: row.valid_source_types
        ? (JSON.parse(row.valid_source_types as string) as string[])
        : null,
      validTargetTypes: row.valid_target_types
        ? (JSON.parse(row.valid_target_types as string) as string[])
        : null,
      system: Boolean(row.system),
      createdAt: new Date(row.created_at as number),
    };
  }

  private rowToEntity(row: Record<string, unknown>, embedding: number[] = []): Entity {
    return {
      id: row.id as string,
      type: row.type as string,
      name: row.name as string,
      properties: safeParseJsonObject(row.properties),
      embedding,
      sourceType: row.source_type as SourceType,
      sourceRef: (row.source_ref as string) ?? null,
      credibility: (row.credibility as number) ?? 0,
      createdAt: new Date(row.created_at as number),
      updatedAt: new Date(row.updated_at as number),
    };
  }

  private rowToEdge(row: Record<string, unknown>, embedding: number[] = []): GraphEdge {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      sourceNs: row.source_ns as GraphNamespace,
      targetId: row.target_id as string,
      targetNs: row.target_ns as GraphNamespace,
      edgeType: row.edge_type as string,
      category: row.category as string,
      context: (row.context as string) ?? "",
      embedding,
      sourceType: row.source_type as SourceType,
      sourceRef: (row.source_ref as string) ?? null,
      credibility: (row.credibility as number) ?? 0,
      provenance: row.provenance as EdgeProvenance,
      strength: (row.strength as number) ?? 1.0,
      createdAt: new Date(row.created_at as number),
    };
  }

  private getEntityEmbedding(id: string): number[] {
    const row = this.db
      .prepare("SELECT vector FROM entities_vec WHERE id = ?")
      .get(id) as { vector: Buffer } | null;
    return row ? deserializeVector(row.vector) : [];
  }

  private getEdgeEmbedding(id: string): number[] {
    const row = this.db
      .prepare("SELECT vector FROM graph_edges_vec WHERE id = ?")
      .get(id) as { vector: Buffer } | null;
    return row ? deserializeVector(row.vector) : [];
  }

  // ---------------------------------------------------------------------------
  // Entity types
  // ---------------------------------------------------------------------------

  createEntityType(t: {
    name: string;
    description: string;
    defaultProperties?: Record<string, unknown>;
    importanceBonus?: number;
  }): EntityType {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO entity_types (name, description, default_properties, importance_bonus, system, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(
        t.name,
        t.description,
        JSON.stringify(t.defaultProperties ?? {}),
        t.importanceBonus ?? 0,
        now,
      );
    return this.getEntityType(t.name)!;
  }

  updateEntityType(
    name: string,
    patch: { description?: string; defaultProperties?: Record<string, unknown>; importanceBonus?: number },
  ): EntityType | null {
    const existing = this.getEntityType(name);
    if (!existing) return null;

    this.db
      .prepare(
        `UPDATE entity_types SET description = ?, default_properties = ?, importance_bonus = ? WHERE name = ?`,
      )
      .run(
        patch.description ?? existing.description,
        JSON.stringify(patch.defaultProperties ?? existing.defaultProperties),
        patch.importanceBonus ?? existing.importanceBonus,
        name,
      );
    return this.getEntityType(name);
  }

  deleteEntityType(name: string): void {
    const existing = this.getEntityType(name);
    if (!existing) return;
    if (existing.system) {
      throw new Error(`Cannot delete system entity type "${name}"`);
    }
    this.db.prepare("DELETE FROM entity_types WHERE name = ?").run(name);
  }

  getEntityType(name: string): EntityType | null {
    const row = this.db
      .prepare("SELECT * FROM entity_types WHERE name = ?")
      .get(name) as Record<string, unknown> | null;
    return row ? this.rowToEntityType(row) : null;
  }

  listEntityTypes(): Array<EntityType & { entityCount: number }> {
    const rows = this.db
      .prepare("SELECT * FROM entity_types ORDER BY name ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.rowToEntityType(row),
      entityCount: this.countEntitiesOfType(row.name as string),
    }));
  }

  countEntitiesOfType(name: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM entities WHERE type = ?")
      .get(name) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------------------
  // Edge types
  // ---------------------------------------------------------------------------

  createEdgeType(t: {
    name: string;
    description: string;
    category: string;
    validSourceTypes?: string[] | null;
    validTargetTypes?: string[] | null;
  }): EdgeType {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO edge_types (name, description, category, valid_source_types, valid_target_types, system, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        t.name,
        t.description,
        t.category,
        t.validSourceTypes ? JSON.stringify(t.validSourceTypes) : null,
        t.validTargetTypes ? JSON.stringify(t.validTargetTypes) : null,
        now,
      );
    return this.getEdgeType(t.name)!;
  }

  updateEdgeType(
    name: string,
    patch: {
      description?: string;
      category?: string;
      validSourceTypes?: string[] | null;
      validTargetTypes?: string[] | null;
    },
  ): EdgeType | null {
    const existing = this.getEdgeType(name);
    if (!existing) return null;

    const validSourceTypes =
      patch.validSourceTypes !== undefined ? patch.validSourceTypes : existing.validSourceTypes;
    const validTargetTypes =
      patch.validTargetTypes !== undefined ? patch.validTargetTypes : existing.validTargetTypes;

    this.db
      .prepare(
        `UPDATE edge_types SET description = ?, category = ?, valid_source_types = ?, valid_target_types = ? WHERE name = ?`,
      )
      .run(
        patch.description ?? existing.description,
        patch.category ?? existing.category,
        validSourceTypes ? JSON.stringify(validSourceTypes) : null,
        validTargetTypes ? JSON.stringify(validTargetTypes) : null,
        name,
      );
    return this.getEdgeType(name);
  }

  deleteEdgeType(name: string): void {
    const existing = this.getEdgeType(name);
    if (!existing) return;
    if (existing.system) {
      throw new Error(`Cannot delete system edge type "${name}"`);
    }
    this.db.prepare("DELETE FROM edge_types WHERE name = ?").run(name);
  }

  getEdgeType(name: string): EdgeType | null {
    const row = this.db
      .prepare("SELECT * FROM edge_types WHERE name = ?")
      .get(name) as Record<string, unknown> | null;
    return row ? this.rowToEdgeType(row) : null;
  }

  listEdgeTypes(category?: string): Array<EdgeType & { edgeCount: number }> {
    const rows = (
      category
        ? this.db
            .prepare("SELECT * FROM edge_types WHERE category = ? ORDER BY name ASC")
            .all(category)
        : this.db.prepare("SELECT * FROM edge_types ORDER BY name ASC").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...this.rowToEdgeType(row),
      edgeCount: this.countEdgesOfType(row.name as string),
    }));
  }

  countEdgesOfType(name: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE edge_type = ?")
      .get(name) as { n: number };
    return row.n;
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  insertEntity(e: Entity): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entities (id, type, name, properties, source_type, source_ref, credibility, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id,
          e.type,
          e.name,
          JSON.stringify(e.properties),
          e.sourceType,
          e.sourceRef,
          e.credibility,
          e.createdAt.getTime(),
          e.updatedAt.getTime(),
        );
      this.db
        .prepare("INSERT INTO entities_vec (id, vector) VALUES (?, ?)")
        .run(e.id, serializeVector(e.embedding));
    });
    tx();
  }

  getEntityById(id: string): Entity | null {
    const row = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToEntity(row, this.getEntityEmbedding(id));
  }

  getEntityByName(name: string, type?: string): Entity | null {
    const row = (
      type
        ? this.db.prepare("SELECT * FROM entities WHERE name = ? AND type = ?").get(name, type)
        : this.db.prepare("SELECT * FROM entities WHERE name = ?").get(name)
    ) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToEntity(row, this.getEntityEmbedding(row.id as string));
  }

  updateEntity(
    id: string,
    patch: { properties?: Record<string, unknown>; name?: string; embedding?: number[] },
  ): Entity | null {
    const existing = this.getEntityById(id);
    if (!existing) return null;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE entities SET name = ?, properties = ?, updated_at = ? WHERE id = ?")
        .run(
          patch.name ?? existing.name,
          JSON.stringify(patch.properties ?? existing.properties),
          now,
          id,
        );
      if (patch.embedding) {
        this.db.prepare("DELETE FROM entities_vec WHERE id = ?").run(id);
        this.db
          .prepare("INSERT INTO entities_vec (id, vector) VALUES (?, ?)")
          .run(id, serializeVector(patch.embedding));
      }
    });
    tx();
    return this.getEntityById(id);
  }

  deleteEntity(id: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM graph_edges_vec WHERE id IN (SELECT id FROM graph_edges WHERE source_id = ? OR target_id = ?)")
        .run(id, id);
      this.db.prepare("DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?").run(id, id);
      this.db.prepare("DELETE FROM entities_vec WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM entities WHERE id = ?").run(id);
    });
    tx();
  }

  listEntities(type: string | null, limit: number, offset: number): Entity[] {
    const rows = (
      type
        ? this.db
            .prepare("SELECT * FROM entities WHERE type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .all(type, limit, offset)
        : this.db
            .prepare("SELECT * FROM entities ORDER BY created_at DESC LIMIT ? OFFSET ?")
            .all(limit, offset)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntity(row, this.getEntityEmbedding(row.id as string)));
  }

  searchEntities(
    queryVec: number[],
    type: string | null,
    limit: number,
  ): Array<Entity & { similarity: number }> {
    const rows = (
      type
        ? this.db.prepare("SELECT id, vector FROM entities_vec v WHERE EXISTS (SELECT 1 FROM entities e WHERE e.id = v.id AND e.type = ?)").all(type)
        : this.db.prepare("SELECT id, vector FROM entities_vec").all()
    ) as Array<{ id: string; vector: Buffer }>;

    const qv = new Float32Array(queryVec);
    const scored = rows.map((r) => {
      const vec = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4);
      let dot = 0;
      for (let i = 0; i < Math.min(qv.length, vec.length); i++) dot += qv[i] * vec[i];
      return { id: r.id, similarity: dot };
    });
    scored.sort((a, b) => b.similarity - a.similarity);

    const top = scored.slice(0, limit);
    const results: Array<Entity & { similarity: number }> = [];
    for (const s of top) {
      const entity = this.getEntityById(s.id);
      if (entity) results.push({ ...entity, similarity: s.similarity });
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Edges
  // ---------------------------------------------------------------------------

  insertEdge(e: GraphEdge): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO graph_edges
             (id, source_id, source_ns, target_id, target_ns, edge_type, category, context,
              source_type, source_ref, credibility, provenance, strength, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          e.id,
          e.sourceId,
          e.sourceNs,
          e.targetId,
          e.targetNs,
          e.edgeType,
          e.category,
          e.context,
          e.sourceType,
          e.sourceRef,
          e.credibility,
          e.provenance,
          e.strength,
          e.createdAt.getTime(),
        );
      this.db
        .prepare("INSERT INTO graph_edges_vec (id, vector) VALUES (?, ?)")
        .run(e.id, serializeVector(e.embedding));
    });
    tx();
  }

  getEdgeById(id: string): GraphEdge | null {
    const row = this.db
      .prepare("SELECT * FROM graph_edges WHERE id = ?")
      .get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToEdge(row, this.getEdgeEmbedding(id));
  }

  deleteEdge(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM graph_edges_vec WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM graph_edges WHERE id = ?").run(id);
    });
    tx();
  }

  edgesFrom(id: string, ns: GraphNamespace): GraphEdge[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_edges WHERE source_id = ? AND source_ns = ?")
      .all(id, ns) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEdge(row, this.getEdgeEmbedding(row.id as string)));
  }

  edgesTo(id: string, ns: GraphNamespace): GraphEdge[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_edges WHERE target_id = ? AND target_ns = ?")
      .all(id, ns) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEdge(row, this.getEdgeEmbedding(row.id as string)));
  }

  edgesByCategory(category: string): GraphEdge[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_edges WHERE category = ?")
      .all(category) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEdge(row, this.getEdgeEmbedding(row.id as string)));
  }

  setEdgeProvenance(id: string, provenance: EdgeProvenance): void {
    this.db.prepare("UPDATE graph_edges SET provenance = ? WHERE id = ?").run(provenance, id);
  }
}
