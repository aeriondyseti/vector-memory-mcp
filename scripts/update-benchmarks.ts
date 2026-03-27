#!/usr/bin/env bun
/**
 * Update BENCHMARKS.md with current search quality metrics.
 *
 * Usage:
 *   bun run scripts/update-benchmarks.ts           # uses version from package.json
 *   bun run scripts/update-benchmarks.ts "2.4.0"   # explicit version label
 *
 * Runs the benchmark suite 5 times, averages results to smooth out
 * jitter from intent-based scoring, and prepends a new section to BENCHMARKS.md.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { BenchmarkRunner, MODEL_NAME, MODEL_DIMENSION } from "../tests/benchmark/runner";
import { generalDataset } from "../tests/benchmark/datasets/index";
import type {
  BenchmarkResults,
  CategoryMetrics,
  QueryCategory,
} from "../tests/benchmark/types";

const BENCHMARKS_PATH = join(import.meta.dir, "..", "BENCHMARKS.md");
const RUNS = 5;

const version =
  process.argv[2] ??
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8"))
    .version;

const date = new Date().toISOString().slice(0, 10);

function fmt(n: number): string {
  return n.toFixed(3);
}

function averageMetrics(runs: CategoryMetrics[]): CategoryMetrics {
  const n = runs.length;
  return {
    meanPrecisionAt1: runs.reduce((s, r) => s + r.meanPrecisionAt1, 0) / n,
    meanPrecisionAt5: runs.reduce((s, r) => s + r.meanPrecisionAt5, 0) / n,
    meanRecallAt5: runs.reduce((s, r) => s + r.meanRecallAt5, 0) / n,
    meanReciprocalRank: runs.reduce((s, r) => s + r.meanReciprocalRank, 0) / n,
    meanNDCGAt5: runs.reduce((s, r) => s + r.meanNDCGAt5, 0) / n,
    queryCount: runs[0].queryCount,
  };
}

function formatCategoryRow(name: string, m: CategoryMetrics): string {
  return (
    `| ${name.padEnd(17)} ` +
    `| ${fmt(m.meanReciprocalRank)} ` +
    `| ${fmt(m.meanPrecisionAt1)} ` +
    `| ${fmt(m.meanPrecisionAt5)} ` +
    `| ${fmt(m.meanRecallAt5)} ` +
    `| ${fmt(m.meanNDCGAt5)} ` +
    `| ${String(m.queryCount).padStart(3)} |`
  );
}

const categoryOrder: QueryCategory[] = [
  "exact_match",
  "semantic",
  "related_concept",
  "negative",
  "edge_case",
];

// --- Main ---

console.log(`Running ${RUNS} benchmark iterations for v${version}...`);

const runner = new BenchmarkRunner();
await runner.setup();
await runner.loadDataset(generalDataset);

const allResults: BenchmarkResults[] = [];
const passedCounts: number[] = [];

for (let i = 0; i < RUNS; i++) {
  const results = await runner.runBenchmark(generalDataset);
  allResults.push(results);
  passedCounts.push(results.queryResults.filter((r) => r.passed).length);
  process.stdout.write(`  Run ${i + 1}/${RUNS}: MRR ${fmt(results.overall.meanReciprocalRank)}\n`);
}

await runner.teardown();

// Average overall metrics
const avgOverall = averageMetrics(allResults.map((r) => r.overall));
const avgPassed = Math.round(passedCounts.reduce((s, n) => s + n, 0) / RUNS);
const total = allResults[0].queryResults.length;

// Average per-category metrics
const avgByCategory = new Map<QueryCategory, CategoryMetrics>();
for (const cat of categoryOrder) {
  const catRuns = allResults
    .map((r) => r.byCategory.get(cat))
    .filter((m): m is CategoryMetrics => m !== undefined);
  if (catRuns.length > 0) avgByCategory.set(cat, averageMetrics(catRuns));
}

// Format section
const lines: string[] = [];
lines.push(`## v${version} (${date})`);
lines.push("");
lines.push(
  `**Model:** ${MODEL_NAME} (${MODEL_DIMENSION}d) | ` +
  `**Dataset:** ${generalDataset.name} (${generalDataset.memories.length} memories, ${generalDataset.queries.length} queries) | ` +
  `**Queries passed:** ~${avgPassed}/${total} | ` +
  `**Averaged over ${RUNS} runs**`
);
lines.push("");
lines.push("| Category          | MRR   | P@1   | P@5   | R@5   | NDCG@5 | Queries |");
lines.push("|-------------------|-------|-------|-------|-------|--------|---------|");
lines.push(formatCategoryRow("**Overall**", avgOverall));

for (const cat of categoryOrder) {
  const m = avgByCategory.get(cat);
  if (m) lines.push(formatCategoryRow(cat, m));
}

lines.push("");
const newSection = lines.join("\n");

// Print summary
console.log("");
console.log(
  `Averaged: ${avgPassed}/${total} passed | ` +
  `MRR: ${fmt(avgOverall.meanReciprocalRank)} | ` +
  `P@1: ${fmt(avgOverall.meanPrecisionAt1)} | ` +
  `R@5: ${fmt(avgOverall.meanRecallAt5)}`
);

// Write BENCHMARKS.md
let existing = "";
const header =
  "# Benchmarks\n\n" +
  "Search quality metrics tracked across releases. Higher is better for all metrics.\n\n" +
  "- **MRR** (Mean Reciprocal Rank): How high the first relevant result ranks (1.0 = always first)\n" +
  "- **P@1** (Precision@1): Fraction of queries where the top result is relevant\n" +
  "- **P@5** (Precision@5): Fraction of top-5 results that are relevant\n" +
  "- **R@5** (Recall@5): Fraction of all relevant items found in top-5\n" +
  "- **NDCG@5**: Ranking quality accounting for position and graded relevance\n\n" +
  "Results are averaged over multiple runs to smooth out scoring jitter.\n\n";

if (existsSync(BENCHMARKS_PATH)) {
  existing = readFileSync(BENCHMARKS_PATH, "utf-8");
  const headerEnd = existing.indexOf("\n## ");
  if (headerEnd >= 0) {
    existing = existing.slice(headerEnd + 1);
  } else {
    existing = "";
  }
}

writeFileSync(BENCHMARKS_PATH, header + newSection + "\n" + existing);

console.log(`Updated BENCHMARKS.md`);
