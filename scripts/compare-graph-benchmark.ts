#!/usr/bin/env bun
/**
 * Before/after comparison for graph-aware search.
 *
 * Usage:
 *   bun run benchmark:graph                       # general dataset + its graph
 *   bun run benchmark:graph --write               # ...and add it to BENCHMARKS.md
 *   bun run benchmark:graph --vault <path>        # a local Obsidian vault
 *       [--membership-links] [--queries N] [--runs N] [--write]
 *
 * Loads the dataset with its knowledge graph once, then runs every query
 * with the graph lane off and on, `runs` times each, averaging to smooth
 * out scoring jitter.
 *
 * General dataset: "Original" covers the 38 queries that carry the
 * historical numbers; multi_hop was written for this comparison.
 *
 * Vault: the dataset is built from the vault at run time
 * (tests/benchmark/datasets/obsidian.ts). Only aggregate numbers are printed
 * or written — never query or note text, since a vault is private.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import arg from "arg";
import { BenchmarkRunner, MODEL_NAME, MODEL_DIMENSION } from "../tests/benchmark/runner";
import { generalGraphDataset } from "../tests/benchmark/datasets/index";
import { loadObsidianDataset } from "../tests/benchmark/datasets/obsidian";
import type { BenchmarkDataset, CategoryMetrics, QueryCategory, QueryResult } from "../tests/benchmark/types";

const BENCHMARKS_PATH = join(import.meta.dir, "..", "BENCHMARKS.md");

const args = arg({
  "--write": Boolean,
  "--vault": String,
  "--membership-links": Boolean,
  "--queries": Number,
  "--runs": Number,
});
const vaultPath = args["--vault"];
const isVault = vaultPath !== undefined;
const RUNS = args["--runs"] ?? (isVault ? 3 : 5);

const categoryOrder: QueryCategory[] = [
  "exact_match",
  "semantic",
  "related_concept",
  "negative",
  "edge_case",
  "multi_hop",
];

/** What each category is, for the dataset at hand. */
const categoryLabel = (cat: QueryCategory): string =>
  isVault
    ? ({
        exact_match: "section lookup",
        semantic: "summary paraphrase",
        related_concept: "title lookup",
        negative: "negative",
      } as Partial<Record<QueryCategory, string>>)[cat] ?? cat
    : cat === "multi_hop"
      ? "**multi_hop** (new)"
      : cat;

// ── Dataset ─────────────────────────────────────────────────────────

let dataset: BenchmarkDataset;
let datasetLine: string;
if (isVault) {
  const t = Date.now();
  const loaded = loadObsidianDataset({
    vaultPath: vaultPath!,
    membershipLinks: args["--membership-links"] ?? false,
    queriesPerCategory: args["--queries"] ?? 100,
  });
  dataset = loaded.dataset;
  const s = loaded.stats;
  console.log(`Parsed the vault in ${Date.now() - t}ms:`, s);
  datasetLine =
    `${dataset.name}: a private Obsidian vault (${s.chunks} memories from ${s.notesWithChunks} notes, ` +
    `${dataset.queries.length} generated queries; graph of ${s.entities} entities, ${s.memoryLinks} wikilink ` +
    `memory links${args["--membership-links"] ? " plus note-membership links" : ""}, ${s.relations} frontmatter relations)`;
} else {
  dataset = generalGraphDataset;
  const g = dataset.graph!;
  datasetLine =
    `${dataset.name} (${dataset.memories.length} memories, ${dataset.queries.length} queries; ` +
    `graph of ${g.entities.length} entities, ${g.relations.length} relations, memories auto-linked by mention)`;
}

const runner = new BenchmarkRunner();
await runner.setup();
const loadStart = Date.now();
await runner.loadDataset(dataset);
console.log(`Loaded ${dataset.memories.length} memories and the graph in ${((Date.now() - loadStart) / 1000).toFixed(0)}s`);

// ── Runs ────────────────────────────────────────────────────────────

/** RUNS runs of one mode: per-run query results. */
async function runMode(useGraph: boolean): Promise<QueryResult[][]> {
  const runs: QueryResult[][] = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push((await runner.runBenchmark(dataset, { useGraph })).queryResults);
    process.stdout.write(`  graph ${useGraph ? "on " : "off"}: run ${i + 1}/${RUNS}\n`);
  }
  return runs;
}

/** Metrics over the queries `pick` keeps, averaged across runs. */
function averaged(runs: QueryResult[][], pick: (r: QueryResult) => boolean): CategoryMetrics {
  const perRun = runs.map((results) => runner.aggregateMetrics(results.filter(pick)));
  const mean = (f: (m: CategoryMetrics) => number) => perRun.reduce((s, m) => s + f(m), 0) / perRun.length;
  return {
    meanPrecisionAt1: mean((m) => m.meanPrecisionAt1),
    meanPrecisionAt5: mean((m) => m.meanPrecisionAt5),
    meanRecallAt5: mean((m) => m.meanRecallAt5),
    meanReciprocalRank: mean((m) => m.meanReciprocalRank),
    meanNDCGAt5: mean((m) => m.meanNDCGAt5),
    meanAP10: mean((m) => m.meanAP10),
    meanTopConfidence: mean((m) => m.meanTopConfidence),
    queryCount: perRun[0]?.queryCount ?? 0,
  };
}

/** Mean reciprocal rank of one query across runs. */
function queryMRR(runs: QueryResult[][], queryId: string): number {
  const ranks = runs.map((rs) => rs.find((r) => r.queryId === queryId)?.reciprocalRank ?? 0);
  return ranks.reduce((s, x) => s + x, 0) / ranks.length;
}

console.log(`Running ${RUNS} iterations with the graph lane off, then on...`);
const off = await runMode(false);
const on = await runMode(true);
await runner.teardown();

// ── Report ──────────────────────────────────────────────────────────

const overall = isVault
  ? { label: "**Overall** (excl. negative)", pick: (r: QueryResult) => r.category !== "negative" }
  : { label: "**Overall (original 38)**", pick: (r: QueryResult) => r.category !== "multi_hop" };
const rows = [
  { label: overall.label, off: averaged(off, overall.pick), on: averaged(on, overall.pick) },
  ...categoryOrder.map((cat) => ({
    label: categoryLabel(cat),
    off: averaged(off, (r) => r.category === cat),
    on: averaged(on, (r) => r.category === cat),
  })),
];

const fmt = (n: number) => n.toFixed(3);
const delta = (a: number, b: number) => {
  const d = b - a;
  return Math.abs(d) < 0.0005 ? "±0" : d >= 0 ? `+${d.toFixed(3)}` : d.toFixed(3);
};
const cell = (a: number, b: number) => `${fmt(a)} → ${fmt(b)} (${delta(a, b)})`;

const lines: string[] = [];
lines.push(
  `## Graph-aware search: before / after${isVault ? ", Obsidian vault" : ""} (${new Date().toISOString().slice(0, 10)})`,
);
lines.push("");
lines.push(`**Model:** ${MODEL_NAME} (${MODEL_DIMENSION}d) | **Dataset:** ${datasetLine} | **Averaged over ${RUNS} runs per mode**`);
lines.push("");
lines.push("Same memories and graph in both columns; only `include_graph` differs (off → on).");
lines.push("");
lines.push("| Category | MRR | R@5 | NDCG@5 | Queries |");
lines.push("|---|---|---|---|---|");
for (const r of rows) {
  if (r.off.queryCount === 0) continue;
  lines.push(
    `| ${r.label} | ${cell(r.off.meanReciprocalRank, r.on.meanReciprocalRank)} | ` +
      `${cell(r.off.meanRecallAt5, r.on.meanRecallAt5)} | ` +
      `${cell(r.off.meanNDCGAt5, r.on.meanNDCGAt5)} | ${r.off.queryCount} |`,
  );
}
lines.push("");
if (isVault) {
  lines.push(
    "Queries are generated from the vault's structure: **section lookup** (`Note title: Heading` → that section), " +
      "**summary paraphrase** (a sentence of the note's frontmatter summary, which is not stored → the note's sections), " +
      "**title lookup** (`What do we know about <title>?` → the note's sections). A note's first five sections are relevant, the rest partially.",
  );
} else {
  lines.push(
    "`multi_hop` queries were written for this comparison: each names an entity whose answers are linked to it in the graph but not worded like the query. Read them as a demonstration of the lane, the original 38 as the regression check.",
  );
  lines.push("");
  lines.push("| multi_hop query | MRR off → on |");
  lines.push("|---|---|");
  for (const q of dataset.queries.filter((q) => q.category === "multi_hop")) {
    lines.push(`| ${q.query} | ${fmt(queryMRR(off, q.id))} → ${fmt(queryMRR(on, q.id))} |`);
  }
}
lines.push("");
const section = lines.join("\n");

console.log("");
console.log(section);

if (args["--write"]) {
  const existing = readFileSync(BENCHMARKS_PATH, "utf-8");
  const firstSection = existing.indexOf("\n## ");
  const updated =
    firstSection >= 0
      ? `${existing.slice(0, firstSection + 1)}${section}\n${existing.slice(firstSection + 1)}`
      : `${existing}\n${section}`;
  writeFileSync(BENCHMARKS_PATH, updated);
  console.log("Added the comparison to BENCHMARKS.md");
}
