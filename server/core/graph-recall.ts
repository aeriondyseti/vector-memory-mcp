/**
 * Graph lane for memory search: memories connected, through the knowledge
 * graph, to the best text matches or to entities the query names.
 *
 * Every link is a graph_edges row — memory→entity references, memory↔memory
 * lineage, entity↔entity domain edges — walked here as undirected. A memory
 * reached in d links ranks by d (fewer first), then by how many seeds reach
 * it. Hub entities (more than HUB_DEGREE links) are not expanded through, so
 * an entity everything mentions does not connect everything.
 */

import type { Database } from "bun:sqlite";

/** Links walked from a seed: memory–entity–entity–memory at most. */
export const GRAPH_MAX_HOPS = 3;
/** Entities with more links than this are reached but not walked through. */
export const HUB_DEGREE = 50;
/** Entity names shorter than this never match a query (too ambiguous). */
const MIN_ENTITY_NAME_LENGTH = 3;

type Node = { ns: "memory" | "entity"; id: string };

export interface GraphHit {
  id: string;
  /** Links from the nearest seed. */
  distance: number;
  /** Distinct seeds that reach it. */
  seeds: number;
}

const nodeKey = (n: Node): string => `${n.ns}:${n.id}`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entities whose name appears in `query` as a whole word (case-insensitive). */
export function entitiesNamedIn(db: Database, query: string): string[] {
  const rows = db.prepare("SELECT id, name FROM entities").all() as Array<{ id: string; name: string | null }>;
  return rows
    .filter((r) => (r.name?.trim().length ?? 0) >= MIN_ENTITY_NAME_LENGTH)
    .filter((r) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(r.name!.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(query),
    )
    .map((r) => r.id);
}

function neighbours(db: Database, node: Node): Node[] {
  const rows = db
    .prepare(
      `SELECT target_ns AS ns, target_id AS id FROM graph_edges WHERE source_ns = ? AND source_id = ?
       UNION ALL
       SELECT source_ns AS ns, source_id AS id FROM graph_edges WHERE target_ns = ? AND target_id = ?`,
    )
    .all(node.ns, node.id, node.ns, node.id) as Array<{ ns: string; id: string }>;
  return rows
    .filter((r): r is Node => r.ns === "memory" || r.ns === "entity")
    .map((r) => ({ ns: r.ns, id: r.id }));
}

/**
 * Memories reachable from the seeds within GRAPH_MAX_HOPS links, nearest
 * first. A seed is not reached from itself, but is from another seed: two
 * linked matches reinforce each other.
 */
export function graphRecall(
  db: Database,
  seeds: { memoryIds: string[]; entityIds: string[] },
  limit: number,
): GraphHit[] {
  const seedNodes: Node[] = [
    ...seeds.memoryIds.map((id) => ({ ns: "memory" as const, id })),
    ...seeds.entityIds.map((id) => ({ ns: "entity" as const, id })),
  ];
  const hits = new Map<string, { distance: number; seeds: Set<string> }>();

  // One breadth-first walk per seed, so each hit knows which seeds reach it.
  for (const seed of seedNodes) {
    const seen = new Set([nodeKey(seed)]);
    let frontier: Node[] = [seed];
    for (let d = 1; d <= GRAPH_MAX_HOPS && frontier.length > 0; d++) {
      const next: Node[] = [];
      for (const node of frontier) {
        const around = neighbours(db, node);
        // A hub is reached, but the walk does not pass through it — unless it
        // is the seed itself, which the query named.
        if (node.ns === "entity" && around.length > HUB_DEGREE && node !== seed) continue;
        for (const n of around) {
          const key = nodeKey(n);
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(n);
          if (n.ns === "memory") {
            const hit = hits.get(n.id) ?? { distance: d, seeds: new Set<string>() };
            hit.distance = Math.min(hit.distance, d);
            hit.seeds.add(nodeKey(seed));
            hits.set(n.id, hit);
          }
        }
      }
      frontier = next;
    }
  }

  return [...hits.entries()]
    .map(([id, h]) => ({ id, distance: h.distance, seeds: h.seeds.size }))
    .sort((a, b) => a.distance - b.distance || b.seeds - a.seeds)
    .slice(0, limit);
}
