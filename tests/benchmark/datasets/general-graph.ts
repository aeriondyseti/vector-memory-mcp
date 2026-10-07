/**
 * The general dataset with a knowledge graph, for measuring graph-aware
 * search against the same memories with the graph lane off and on.
 *
 * The graph is built mechanically, not tuned to the queries: each entity is
 * linked to every memory that mentions one of its names, and relations are
 * facts the memories state. Distractors mention no entity and stay unlinked.
 *
 * `multiHopQueries` were written for this comparison: each names an entity
 * whose answers are linked to it but not worded like the query. Report them
 * separately from the original queries, which carry the historical numbers.
 */

import type { BenchmarkDataset, BenchmarkGraph, GroundTruthQuery } from "../types";
import { generalDataset } from "./general";

export const generalGraph: BenchmarkGraph = {
  entities: [
    // Aeloria
    { id: "ent-aeloria", name: "Aeloria", type: "place" },
    { id: "ent-varis", name: "Arch-Mage Varis", type: "person", aliases: ["Varis"] },
    { id: "ent-weeping-stone", name: "Weeping Stone", type: "concept" },
    { id: "ent-lost-library", name: "Lost Library", type: "place" },
    { id: "ent-drowned-warden", name: "Drowned Warden", type: "person" },
    // Scarlet Covenant
    { id: "ent-covenant", name: "Scarlet Covenant", type: "organization", aliases: ["Covenant"] },
    { id: "ent-valerica", name: "Matriarch Valerica", type: "person", aliases: ["Valerica"] },
    { id: "ent-velvet-glove", name: "Velvet Glove", type: "place" },
    { id: "ent-lupine", name: "Lupine clans", type: "organization", aliases: ["Lupine"] },
    { id: "ent-circle", name: "Mages of the Circle", type: "organization" },
    // Database migration
    { id: "ent-db-migration", name: "Database migration", type: "project", aliases: ["migrating", "migration"] },
    { id: "ent-mongodb", name: "MongoDB", type: "tool", aliases: ["Mongo", "NoSQL"] },
    { id: "ent-postgres", name: "Postgres", type: "tool" },
    { id: "ent-analytics", name: "analytics service", type: "tool" },
    // UI component library
    { id: "ent-ui-library", name: "UI component library", type: "project", aliases: ["component", "component set"] },
    { id: "ent-mui", name: "MUI", type: "tool", aliases: ["Material UI"] },
    { id: "ent-tailwind", name: "Tailwind CSS", type: "tool", aliases: ["Tailwind"] },
    { id: "ent-datepicker", name: "DatePicker", type: "tool" },
    // French Revolution
    { id: "ent-revolution", name: "French Revolution", type: "event", aliases: ["Revolution"] },
    { id: "ent-bastille", name: "Bastille", type: "event" },
    { id: "ent-robespierre", name: "Robespierre", type: "person" },
    { id: "ent-terror", name: "Reign of Terror", type: "event" },
    { id: "ent-estates", name: "Third Estate", type: "concept", aliases: ["Three Estates"] },
    { id: "ent-guillotine", name: "Guillotine", type: "concept" },
    // Quantum mechanics
    { id: "ent-quantum", name: "Quantum mechanics", type: "concept", aliases: ["quantum"] },
    { id: "ent-heisenberg", name: "Heisenberg", type: "person" },
    { id: "ent-superposition", name: "Superposition", type: "concept" },
    { id: "ent-entanglement", name: "Entanglement", type: "concept" },
    { id: "ent-planck", name: "Max Planck", type: "person" },
    { id: "ent-duality", name: "Wave-particle duality", type: "concept", aliases: ["Double Slit"] },
    // Auto-Blogger
    { id: "ent-autoblogger", name: "Auto-Blogger", type: "project" },
    { id: "ent-python", name: "Python", type: "tool" },
    { id: "ent-openai", name: "OpenAI", type: "tool" },
    // Fitness
    { id: "ent-workout", name: "Workout plan", type: "project", aliases: ["workout", "gym", "fitness"] },
    { id: "ent-back-injury", name: "Lower back injury", type: "concept", aliases: ["back injury", "herniated"] },
  ],
  relations: [
    { from: "ent-varis", to: "ent-aeloria", type: "related_to" },
    { from: "ent-weeping-stone", to: "ent-aeloria", type: "part_of" },
    { from: "ent-lost-library", to: "ent-aeloria", type: "part_of" },
    { from: "ent-drowned-warden", to: "ent-lost-library", type: "related_to" },
    { from: "ent-valerica", to: "ent-covenant", type: "related_to" },
    { from: "ent-velvet-glove", to: "ent-covenant", type: "related_to" },
    { from: "ent-lupine", to: "ent-covenant", type: "related_to" },
    { from: "ent-circle", to: "ent-covenant", type: "related_to" },
    { from: "ent-mongodb", to: "ent-db-migration", type: "part_of" },
    { from: "ent-postgres", to: "ent-db-migration", type: "part_of" },
    { from: "ent-analytics", to: "ent-db-migration", type: "related_to" },
    { from: "ent-mui", to: "ent-ui-library", type: "part_of" },
    { from: "ent-tailwind", to: "ent-ui-library", type: "part_of" },
    { from: "ent-datepicker", to: "ent-ui-library", type: "part_of" },
    { from: "ent-bastille", to: "ent-revolution", type: "part_of" },
    { from: "ent-robespierre", to: "ent-terror", type: "related_to" },
    { from: "ent-terror", to: "ent-revolution", type: "part_of" },
    { from: "ent-estates", to: "ent-revolution", type: "related_to" },
    { from: "ent-guillotine", to: "ent-terror", type: "related_to" },
    { from: "ent-heisenberg", to: "ent-quantum", type: "part_of" },
    { from: "ent-superposition", to: "ent-quantum", type: "part_of" },
    { from: "ent-entanglement", to: "ent-quantum", type: "part_of" },
    { from: "ent-planck", to: "ent-quantum", type: "related_to" },
    { from: "ent-duality", to: "ent-quantum", type: "part_of" },
    { from: "ent-python", to: "ent-autoblogger", type: "part_of" },
    { from: "ent-openai", to: "ent-autoblogger", type: "part_of" },
    { from: "ent-back-injury", to: "ent-workout", type: "related_to" },
  ],
};

export const multiHopQueries: GroundTruthQuery[] = [
  {
    id: "mh-001",
    query: "What do we know about Matriarch Valerica's faction?",
    relevantMemoryIds: ["covenant-high-1", "covenant-medium-1"],
    partiallyRelevantIds: ["covenant-low-1"],
    category: "multi_hop",
  },
  {
    id: "mh-002",
    query: "Who leads the group that meets at the Velvet Glove?",
    relevantMemoryIds: ["covenant-high-2"],
    partiallyRelevantIds: ["covenant-high-1"],
    category: "multi_hop",
  },
  {
    id: "mh-003",
    query: "What else is going on in the city Arch-Mage Varis wrote about?",
    relevantMemoryIds: ["aeloria-medium-1", "aeloria-high-2"],
    partiallyRelevantIds: ["aeloria-low-1"],
    category: "multi_hop",
  },
  {
    id: "mh-004",
    query: "Which figure was executed in the period that the Bastille set off?",
    relevantMemoryIds: ["revolution-medium-1"],
    partiallyRelevantIds: ["revolution-low-1"],
    category: "multi_hop",
  },
  {
    id: "mh-005",
    query: "Other ideas from the same field as Heisenberg",
    relevantMemoryIds: ["quantum-medium-1", "quantum-high-2", "quantum-medium-2"],
    partiallyRelevantIds: ["quantum-low-1"],
    category: "multi_hop",
  },
  {
    id: "mh-006",
    query: "Problems we hit while building the Auto-Blogger",
    relevantMemoryIds: ["python-medium-1"],
    partiallyRelevantIds: ["python-high-1", "python-high-2"],
    category: "multi_hop",
  },
  {
    id: "mh-007",
    query: "What did we give up by choosing MongoDB?",
    relevantMemoryIds: ["db-high-2"],
    partiallyRelevantIds: ["db-high-1", "db-low-1"],
    category: "multi_hop",
  },
  {
    id: "mh-008",
    query: "Which libraries did we pick after the DatePicker trouble?",
    relevantMemoryIds: ["ui-high-1", "ui-high-2"],
    partiallyRelevantIds: ["ui-medium-1"],
    category: "multi_hop",
  },
];

/** The general memories and queries, plus the graph and the multi-hop queries. */
export const generalGraphDataset: BenchmarkDataset = {
  ...generalDataset,
  name: "general+graph",
  description: "General dataset with an auto-linked knowledge graph and multi-hop queries",
  queries: [...generalDataset.queries, ...multiHopQueries],
  graph: generalGraph,
};
