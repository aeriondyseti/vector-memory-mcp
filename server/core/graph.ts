/**
 * Knowledge Graph data model (Feature 19).
 *
 * Two graphs, one bridge:
 *   - Memory graph — memory nodes, lineage (causal) edges
 *   - Entity graph — agent-defined entity nodes, domain edges
 *   - Reference layer — memory→entity links bridging the two
 *
 * All edges live in a single `graph_edges` table; a namespace pair
 * (source_ns/target_ns of "memory" | "entity") distinguishes memory-graph,
 * entity-graph, and cross-namespace reference edges.
 */

export type GraphNamespace = "memory" | "entity";

/** Where a fact/relationship originated (provenance). */
export type SourceType =
  | "user"
  | "agent"
  | "inferred"
  | "file"
  | "web"
  | "conversation_history";

/** Default credibility by source type (0.0–1.0). */
export const DEFAULT_CREDIBILITY: Record<SourceType, number> = {
  user: 1.0,
  agent: 0.8,
  inferred: 0.6,
  file: 0.8,
  web: 0.6,
  conversation_history: 0.7,
};

export interface EntityType {
  name: string;
  description: string;
  defaultProperties: Record<string, unknown>;
  importanceBonus: number;
  system: boolean;
  createdAt: Date;
}

export interface EdgeType {
  name: string;
  description: string;
  category: string;
  validSourceTypes: string[] | null;
  validTargetTypes: string[] | null;
  system: boolean;
  createdAt: Date;
}

export interface Entity {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  embedding: number[];
  sourceType: SourceType;
  sourceRef: string | null;
  credibility: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  sourceId: string;
  sourceNs: GraphNamespace;
  targetId: string;
  targetNs: GraphNamespace;
  edgeType: string;
  category: string;
  context: string;
  embedding: number[];
  sourceType: SourceType;
  sourceRef: string | null;
  credibility: number;
  provenance: EdgeProvenance;
  strength: number;
  createdAt: Date;
}

/** How a lineage edge came to exist. */
export type EdgeProvenance = "inferred" | "confirmed" | "explicit";

/**
 * System-prepopulated lineage edge types (memory graph, category "lineage").
 * These are read-only: cannot be modified or deleted.
 */
export const SYSTEM_EDGE_TYPES: Array<{
  name: string;
  description: string;
  category: string;
}> = [
  { name: "caused", description: "The source memory caused the target.", category: "lineage" },
  { name: "informed_by", description: "The source memory was informed by the target.", category: "lineage" },
  { name: "resolved_by", description: "The source problem was resolved by the target.", category: "lineage" },
  { name: "superseded_by", description: "The source memory was superseded by the target.", category: "lineage" },
  { name: "triggered", description: "The source memory triggered the target.", category: "lineage" },
];

/**
 * System entity type: every memory is implicitly a node in the "Memory" type
 * for cross-namespace reference edges.
 */
export const SYSTEM_ENTITY_TYPES: Array<{
  name: string;
  description: string;
}> = [
  { name: "Memory", description: "A stored memory node (system type for the reference bridge)." },
];

/** Reference-layer edge types (memory→entity bridge, category "reference"). */
export const REFERENCE_EDGE_TYPES = [
  "mentions",
  "describes",
  "supports",
  "relates_to",
] as const;
export type ReferenceEdgeType = (typeof REFERENCE_EDGE_TYPES)[number];
