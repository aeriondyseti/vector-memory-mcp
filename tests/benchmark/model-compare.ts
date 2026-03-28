#!/usr/bin/env bun
/**
 * Embedding Model Comparison Benchmark
 *
 * Compares embedding models on:
 *   1. Warmup time (cold start model load)
 *   2. Per-embed latency (average over N embeds)
 *   3. Search quality on general dataset
 *   4. Search quality on ConvoMem dataset
 *
 * Usage:
 *   bun run tests/benchmark/model-compare.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../../server/core/connection";
import { MemoryRepository } from "../../server/core/memory.repository";
import { EmbeddingsService } from "../../server/core/embeddings.service";
import { MemoryService } from "../../server/core/memory.service";
import type { SearchIntent } from "../../server/core/memory";
import {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  averagePrecision,
  buildRelevanceScores,
} from "./metrics";
import { generalDataset } from "./datasets";
import { loadConvoMemDataset } from "./datasets/convomem";
import type { BenchmarkDataset, CategoryMetrics, QueryCategory, QueryResult } from "./types";

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

interface ModelConfig {
  name: string;
  huggingfaceName: string;
  dimension: number;
  onnxFile: string;
  /** Prefix added to text when embedding documents (for storage) */
  documentPrefix?: string;
  /** Prefix added to text when embedding queries (for search) */
  queryPrefix?: string;
}

const MODELS: ModelConfig[] = [
  {
    name: "all-MiniLM-L6-v2",
    huggingfaceName: "Xenova/all-MiniLM-L6-v2",
    dimension: 384,
    onnxFile: "onnx/model.onnx",
  },
  {
    name: "nomic-embed-text-v1.5",
    huggingfaceName: "nomic-ai/nomic-embed-text-v1.5",
    dimension: 768,
    onnxFile: "onnx/model_quantized.onnx",
    documentPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  },
];

const LATENCY_SAMPLES = 50;
const QUALITY_RUNS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string { return n.toFixed(3); }
function fmtMs(n: number): string { return n.toFixed(1) + "ms"; }
function fmtS(n: number): string { return (n / 1000).toFixed(2) + "s"; }

function aggregateMetrics(results: QueryResult[]): CategoryMetrics {
  const n = results.length;
  if (n === 0)
    return { meanPrecisionAt1: 0, meanPrecisionAt5: 0, meanRecallAt5: 0,
             meanReciprocalRank: 0, meanNDCGAt5: 0, meanAP10: 0, meanTopConfidence: 0, queryCount: 0 };
  return {
    meanPrecisionAt1: results.reduce((s, r) => s + r.precision1, 0) / n,
    meanPrecisionAt5: results.reduce((s, r) => s + r.precision5, 0) / n,
    meanRecallAt5: results.reduce((s, r) => s + r.recall5, 0) / n,
    meanReciprocalRank: results.reduce((s, r) => s + r.reciprocalRank, 0) / n,
    meanNDCGAt5: results.reduce((s, r) => s + r.ndcg5, 0) / n,
    meanAP10: results.reduce((s, r) => s + r.ap10, 0) / n,
    meanTopConfidence: results.reduce((s, r) => s + r.topConfidence, 0) / n,
    queryCount: n,
  };
}

function averageOfMetrics(runs: CategoryMetrics[]): CategoryMetrics {
  const n = runs.length;
  return {
    meanPrecisionAt1: runs.reduce((s, r) => s + r.meanPrecisionAt1, 0) / n,
    meanPrecisionAt5: runs.reduce((s, r) => s + r.meanPrecisionAt5, 0) / n,
    meanRecallAt5: runs.reduce((s, r) => s + r.meanRecallAt5, 0) / n,
    meanReciprocalRank: runs.reduce((s, r) => s + r.meanReciprocalRank, 0) / n,
    meanNDCGAt5: runs.reduce((s, r) => s + r.meanNDCGAt5, 0) / n,
    meanAP10: runs.reduce((s, r) => s + r.meanAP10, 0) / n,
    meanTopConfidence: runs.reduce((s, r) => s + r.meanTopConfidence, 0) / n,
    queryCount: runs[0].queryCount,
  };
}

// ---------------------------------------------------------------------------
// Run quality benchmark for a given model + dataset
// ---------------------------------------------------------------------------

async function runQualityBenchmark(
  model: ModelConfig,
  dataset: BenchmarkDataset,
  runs: number
): Promise<{ overall: CategoryMetrics; byCategory: Map<QueryCategory, CategoryMetrics> }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `model-compare-${model.name}-`));
  const dbPath = join(tmpDir, "bench.db");
  const db = connectToDatabase(dbPath);
  const repository = new MemoryRepository(db);
  const embeddings = new EmbeddingsService(model.huggingfaceName, model.dimension);
  const service = new MemoryService(repository, embeddings);

  // Load dataset — apply document prefix if model requires it
  const memoryIdMap = new Map<string, string>();
  for (const mem of dataset.memories) {
    const textToStore = model.documentPrefix
      ? model.documentPrefix + mem.content
      : mem.content;
    const stored = await service.store(mem.content, mem.metadata ?? {}, textToStore);
    memoryIdMap.set(mem.id, stored.id);
  }

  const categoryOrder: QueryCategory[] = [
    "exact_match", "semantic", "related_concept", "negative", "edge_case",
  ];

  const allOveralls: CategoryMetrics[] = [];
  const allByCategory: Map<QueryCategory, CategoryMetrics[]> = new Map();
  for (const cat of categoryOrder) allByCategory.set(cat, []);

  const intent: SearchIntent = "fact_check";

  for (let r = 0; r < runs; r++) {
    const queryResults: QueryResult[] = [];
    const categoryResults = new Map<QueryCategory, QueryResult[]>();

    for (const query of dataset.queries) {
      // Apply query prefix if model requires it
      const searchText = model.queryPrefix
        ? model.queryPrefix + query.query
        : query.query;

      const results = await service.search(searchText, intent, { limit: 10 });
      const retrievedIds = results.map((m) => m.id);
      const confidences = results.map((m) => m.confidence);

      const expectedActualIds = query.relevantMemoryIds
        .map((id) => memoryIdMap.get(id))
        .filter((id): id is string => id !== undefined);
      const partialActualIds = (query.partiallyRelevantIds ?? [])
        .map((id) => memoryIdMap.get(id))
        .filter((id): id is string => id !== undefined);

      const relevantSet = new Set(expectedActualIds);
      const relevanceScores = buildRelevanceScores(expectedActualIds, partialActualIds);

      let firstRelevantConfidence: number | null = null;
      for (let i = 0; i < retrievedIds.length; i++) {
        if (relevantSet.has(retrievedIds[i])) {
          firstRelevantConfidence = confidences[i];
          break;
        }
      }

      const result: QueryResult = {
        queryId: query.id,
        query: query.query,
        category: query.category,
        retrievedIds,
        expectedIds: expectedActualIds,
        precision1: precisionAtK(retrievedIds, relevantSet, 1),
        precision5: precisionAtK(retrievedIds, relevantSet, 5),
        recall5: recallAtK(retrievedIds, relevantSet, 5),
        reciprocalRank: reciprocalRank(retrievedIds, relevantSet),
        ndcg5: ndcgAtK(retrievedIds, relevanceScores, 5),
        ap10: averagePrecision(retrievedIds, relevantSet, 10),
        topConfidence: confidences[0] ?? 0,
        firstRelevantConfidence,
        passed: true,
      };
      queryResults.push(result);

      if (!categoryResults.has(query.category)) categoryResults.set(query.category, []);
      categoryResults.get(query.category)!.push(result);
    }

    allOveralls.push(aggregateMetrics(queryResults));
    for (const cat of categoryOrder) {
      const catResults = categoryResults.get(cat);
      if (catResults) allByCategory.get(cat)!.push(aggregateMetrics(catResults));
    }
  }

  rmSync(tmpDir, { recursive: true, force: true });

  const avgOverall = averageOfMetrics(allOveralls);
  const avgByCategory = new Map<QueryCategory, CategoryMetrics>();
  for (const cat of categoryOrder) {
    const catRuns = allByCategory.get(cat)!;
    if (catRuns.length > 0) avgByCategory.set(cat, averageOfMetrics(catRuns));
  }

  return { overall: avgOverall, byCategory: avgByCategory };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("═══════════════════════════════════════════════════════════════");
console.log("              EMBEDDING MODEL COMPARISON BENCHMARK             ");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");

// Load ConvoMem dataset (downloads and caches)
console.log("Loading ConvoMem dataset...");
const convomemDataset = await loadConvoMemDataset({ perCategory: 10, seed: 42 });
console.log(`  ConvoMem: ${convomemDataset.memories.length} memories, ${convomemDataset.queries.length} queries`);
console.log(`  General:  ${generalDataset.memories.length} memories, ${generalDataset.queries.length} queries`);
console.log("");

interface ModelResults {
  warmupMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  general: { overall: CategoryMetrics; byCategory: Map<QueryCategory, CategoryMetrics> };
  convomem: { overall: CategoryMetrics; byCategory: Map<QueryCategory, CategoryMetrics> };
}

const allModelResults: Map<string, ModelResults> = new Map();

for (const model of MODELS) {
  console.log(`── ${model.name} (${"─".repeat(50 - model.name.length)})`);
  console.log("");

  // 1. Warmup (cold start)
  console.log("  [1/4] Measuring warmup time...");
  const embeddings = new EmbeddingsService(model.huggingfaceName, model.dimension);
  const warmupStart = performance.now();
  await embeddings.warmup();
  const warmupMs = performance.now() - warmupStart;
  console.log(`         Warmup: ${fmtS(warmupMs)}`);

  // 2. Latency
  console.log(`  [2/4] Measuring latency (${LATENCY_SAMPLES} embeds)...`);
  const testTexts = [
    "What color do I use for hot leads?",
    "The project deadline is next Friday and we need to finalize the design",
    "I prefer using TypeScript over JavaScript for backend development",
    "Schedule a meeting with the sales team for quarterly review discussion",
    "The new CRM integration requires OAuth2 authentication setup",
  ];
  const latencies: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const text = testTexts[i % testTexts.length];
    const prefixed = model.queryPrefix ? model.queryPrefix + text : text;
    const start = performance.now();
    await embeddings.embed(prefixed);
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);
  const avgLatencyMs = latencies.reduce((s, v) => s + v, 0) / latencies.length;
  const p50LatencyMs = latencies[Math.floor(latencies.length * 0.5)];
  const p95LatencyMs = latencies[Math.floor(latencies.length * 0.95)];
  console.log(`         Avg: ${fmtMs(avgLatencyMs)}  P50: ${fmtMs(p50LatencyMs)}  P95: ${fmtMs(p95LatencyMs)}`);

  // 3. General dataset quality
  console.log(`  [3/4] Running general dataset (${QUALITY_RUNS} runs)...`);
  const general = await runQualityBenchmark(model, generalDataset, QUALITY_RUNS);
  console.log(`         MRR: ${fmt(general.overall.meanReciprocalRank)}  MAP: ${fmt(general.overall.meanAP10)}  R@5: ${fmt(general.overall.meanRecallAt5)}`);

  // 4. ConvoMem quality
  console.log(`  [4/4] Running ConvoMem dataset (${QUALITY_RUNS} runs)...`);
  const convomem = await runQualityBenchmark(model, convomemDataset, QUALITY_RUNS);
  console.log(`         MRR: ${fmt(convomem.overall.meanReciprocalRank)}  MAP: ${fmt(convomem.overall.meanAP10)}  R@5: ${fmt(convomem.overall.meanRecallAt5)}`);

  allModelResults.set(model.name, {
    warmupMs,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    general,
    convomem,
  });

  console.log("");
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

const categoryOrder: QueryCategory[] = [
  "exact_match", "semantic", "related_concept", "negative", "edge_case",
];

console.log("═══════════════════════════════════════════════════════════════════════════════════════");
console.log("                              SIDE-BY-SIDE COMPARISON                                 ");
console.log("═══════════════════════════════════════════════════════════════════════════════════════");
console.log("");

// Performance
console.log("─── Performance ────────────────────────────────────────────");
console.log(
  "  " + "Metric".padEnd(20) +
  MODELS.map((m) => m.name.padStart(25)).join("")
);
console.log("  " + "─".repeat(20 + MODELS.length * 25));

const metrics = ["Warmup", "Avg latency", "P50 latency", "P95 latency"];
for (const metric of metrics) {
  const values = MODELS.map((m) => {
    const r = allModelResults.get(m.name)!;
    switch (metric) {
      case "Warmup": return fmtS(r.warmupMs);
      case "Avg latency": return fmtMs(r.avgLatencyMs);
      case "P50 latency": return fmtMs(r.p50LatencyMs);
      case "P95 latency": return fmtMs(r.p95LatencyMs);
      default: return "";
    }
  });
  console.log("  " + metric.padEnd(20) + values.map((v) => v.padStart(25)).join(""));
}

// Quality — General dataset
console.log("");
console.log("─── Quality: General Dataset ───────────────────────────────");
console.log(
  "  " + "Category".padEnd(20) +
  MODELS.map((m) => ("MRR / MAP / R@5").padStart(25)).join("")
);
console.log("  " + "".padEnd(20) +
  MODELS.map((m) => m.name.padStart(25)).join("")
);
console.log("  " + "─".repeat(20 + MODELS.length * 25));

const printRow = (label: string, getMetrics: (r: ModelResults) => CategoryMetrics | undefined) => {
  const values = MODELS.map((m) => {
    const metrics = getMetrics(allModelResults.get(m.name)!);
    if (!metrics) return "—".padStart(25);
    return `${fmt(metrics.meanReciprocalRank)} / ${fmt(metrics.meanAP10)} / ${fmt(metrics.meanRecallAt5)}`.padStart(25);
  });
  console.log("  " + label.padEnd(20) + values.join(""));
};

printRow("Overall", (r) => r.general.overall);
for (const cat of categoryOrder) {
  printRow(cat, (r) => r.general.byCategory.get(cat));
}

// Quality — ConvoMem dataset
console.log("");
console.log("─── Quality: ConvoMem Dataset ──────────────────────────────");
console.log(
  "  " + "Category".padEnd(20) +
  MODELS.map((m) => ("MRR / MAP / R@5").padStart(25)).join("")
);
console.log("  " + "".padEnd(20) +
  MODELS.map((m) => m.name.padStart(25)).join("")
);
console.log("  " + "─".repeat(20 + MODELS.length * 25));

printRow("Overall", (r) => r.convomem.overall);
for (const cat of categoryOrder) {
  printRow(cat, (r) => r.convomem.byCategory.get(cat));
}

// Summary
console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  SUMMARY");
console.log("═══════════════════════════════════════════════════════════════");
for (const model of MODELS) {
  const r = allModelResults.get(model.name)!;
  console.log(`  ${model.name}:`);
  console.log(`    Warmup: ${fmtS(r.warmupMs)}  Latency: ${fmtMs(r.avgLatencyMs)} avg`);
  console.log(`    General  — MRR: ${fmt(r.general.overall.meanReciprocalRank)}  MAP: ${fmt(r.general.overall.meanAP10)}`);
  console.log(`    ConvoMem — MRR: ${fmt(r.convomem.overall.meanReciprocalRank)}  MAP: ${fmt(r.convomem.overall.meanAP10)}`);
}
console.log("═══════════════════════════════════════════════════════════════");
