#!/usr/bin/env bun
/**
 * Before/after comparison for graph-aware search.
 *
 * Usage:
 *   bun run scripts/compare-graph-benchmark.ts           # print the comparison
 *   bun run scripts/compare-graph-benchmark.ts --write   # also add it to BENCHMARKS.md
 *
 * Loads the general dataset with its auto-linked knowledge graph once, then
 * runs every query with the graph lane off and on, RUNS times each, and
 * averages to smooth out scoring jitter. "Original" covers the 38 queries
 * that carry the historical numbers; multi_hop was written for this
 * comparison and is reported on its own.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { BenchmarkRunner, MODEL_NAME, MODEL_DIMENSION } from "../tests/benchmark/runner";
import { generalGraphDataset } from "../tests/benchmark/datasets/index";
import type { CategoryMetrics, QueryCategory, QueryResult } from "../tests/benchmark/types";

const BENCHMARKS_PATH = join(import.meta.dir, "..", "BENCHMARKS.md");
const RUNS = 5;
const shouldWrite = process.argv.includes("--write");

const categoryOrder: QueryCategory[] = [
  "exact_match",
  "semantic",
  "related_concept",
  "negative",
  "edge_case",
  "multi_hop",
];

type Row = { label: string; off: CategoryMetrics; on: CategoryMetrics };

const runner = new BenchmarkRunner();
await runner.setup();
await runner.loadDataset(generalGraphDataset);

/** RUNS runs of one mode: per-run query results. */
async function runMode(useGraph: boolean): Promise<QueryResult[][]> {
  const runs: QueryResult[][] = [];
  for (let i = 0; i < RUNS; i++) {
    runs.push((await runner.runBenchmark(generalGraphDataset, { useGraph })).queryResults);
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

const rows: Row[] = [
  {
    label: "**Overall (original 38)**",
    off: averaged(off, (r) => r.category !== "multi_hop"),
    on: averaged(on, (r) => r.category !== "multi_hop"),
  },
  ...categoryOrder.map((cat) => ({
    label: cat === "multi_hop" ? "**multi_hop** (new)" : cat,
    off: averaged(off, (r) => r.category === cat),
    on: averaged(on, (r) => r.category === cat),
  })),
];

const fmt = (n: number) => n.toFixed(3);
const delta = (a: number, b: number) => {
  const d = b - a;
  const s = d >= 0 ? `+${d.toFixed(3)}` : d.toFixed(3);
  return Math.abs(d) < 0.0005 ? "±0" : s;
};
const cell = (a: number, b: number) => `${fmt(a)} → ${fmt(b)} (${delta(a, b)})`;

const graph = generalGraphDataset.graph!;
const lines: string[] = [];
lines.push(`## Graph-aware search: before / after (${new Date().toISOString().slice(0, 10)})`);
lines.push("");
lines.push(
  `**Model:** ${MODEL_NAME} (${MODEL_DIMENSION}d) | ` +
    `**Dataset:** ${generalGraphDataset.name} (${generalGraphDataset.memories.length} memories, ` +
    `${generalGraphDataset.queries.length} queries; graph of ${graph.entities.length} entities, ` +
    `${graph.relations.length} relations, memories auto-linked by mention) | ` +
    `**Averaged over ${RUNS} runs per mode**`,
);
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
lines.push(
  "`multi_hop` queries were written for this comparison: each names an entity whose answers are linked to it in the graph but not worded like the query. Read them as a demonstration of the lane, the original 38 as the regression check.",
);
lines.push("");
lines.push("| multi_hop query | MRR off → on |");
lines.push("|---|---|");
for (const q of generalGraphDataset.queries.filter((q) => q.category === "multi_hop")) {
  lines.push(`| ${q.query} | ${fmt(queryMRR(off, q.id))} → ${fmt(queryMRR(on, q.id))} |`);
}
lines.push("");
const section = lines.join("\n");

console.log("");
console.log(section);

if (shouldWrite) {
  const existing = readFileSync(BENCHMARKS_PATH, "utf-8");
  const firstSection = existing.indexOf("\n## ");
  const updated =
    firstSection >= 0
      ? `${existing.slice(0, firstSection + 1)}${section}\n${existing.slice(firstSection + 1)}`
      : `${existing}\n${section}`;
  writeFileSync(BENCHMARKS_PATH, updated);
  console.log("Added the comparison to BENCHMARKS.md");
}
