/**
 * ConvoMem Benchmark Test
 *
 * Evaluates retrieval quality against Salesforce ConvoMem dataset.
 * Downloads data on first run (cached for subsequent runs).
 */

import { describe, expect, beforeAll, afterAll } from "bun:test";
import { BenchmarkRunner } from "./benchmark/runner";
import { formatReport, formatCompactSummary, defaultThresholds } from "./benchmark/reporter";
import { loadConvoMemDataset } from "./benchmark/datasets/convomem";
import { isModelAvailable, testWithModel } from "./utils/model-loader";
import type { BenchmarkDataset } from "./benchmark/types";

describe("ConvoMem Benchmark", () => {
  let runner: BenchmarkRunner;
  let dataset: BenchmarkDataset;

  beforeAll(async () => {
    if (!isModelAvailable()) return;

    // Load a small subset for CI — 10 evidence items per category + fillers
    console.log("Loading ConvoMem dataset...");
    dataset = await loadConvoMemDataset({ perCategory: 10, seed: 42 });
    console.log(
      `  Dataset: ${dataset.memories.length} memories, ${dataset.queries.length} queries`
    );

    runner = new BenchmarkRunner();
    await runner.setup();
    await runner.loadDataset(dataset);
  }, 120_000); // Allow 2 min for download + embedding

  afterAll(async () => {
    if (runner) await runner.teardown();
  });

  testWithModel("ConvoMem retrieval quality report", async () => {
    const results = await runner.runBenchmark(dataset);
    const { report } = formatReport(results, defaultThresholds);

    console.log(report);
    console.log(formatCompactSummary(results));

    // Report metrics but don't enforce thresholds yet —
    // this is a new external dataset, we need to establish a baseline first
    expect(results.queryResults.length).toBeGreaterThan(0);
  });

  testWithModel("per-query results for debugging", async () => {
    const results = await runner.runBenchmark(dataset);
    expect(results.queryResults.length).toBe(dataset.queries.length);

    for (const result of results.queryResults) {
      expect(result.queryId).toBeDefined();
      expect(typeof result.reciprocalRank).toBe("number");
    }
  });
});
