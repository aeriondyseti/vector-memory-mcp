/**
 * Benchmark Reporter
 *
 * Formats benchmark results and determines pass/fail status
 * based on configurable thresholds.
 */

import type {
  BenchmarkResults,
  CategoryMetrics,
  QueryCategory,
  QueryResult,
} from "./types";

/**
 * Configuration for pass/fail thresholds.
 */
export interface ThresholdConfig {
  /** Minimum Mean Reciprocal Rank for overall pass */
  minMeanReciprocalRank: number;
  /** Minimum Precision@1 for overall pass */
  minMeanPrecisionAt1: number;
  /** Minimum Recall@5 for overall pass */
  minMeanRecallAt5: number;
  /** MRR below this triggers a warning (not failure) */
  warnIfMRRBelow: number;
  /** Per-category threshold overrides */
  categories: Partial<
    Record<
      QueryCategory,
      {
        minMRR?: number;
        minPrecision1?: number;
        minRecall5?: number;
      }
    >
  >;
}

/**
 * Default thresholds adjusted for hybrid search with intent-based scoring.
 * Hybrid search trades some top-1 precision for better overall recall and
 * noise-robustness via controlled jitter.
 * Lowered to account for cross-platform embedding variance in CI.
 */
export const defaultThresholds: ThresholdConfig = {
  minMeanReciprocalRank: 0.5,
  minMeanPrecisionAt1: 0.35,
  minMeanRecallAt5: 0.6,
  warnIfMRRBelow: 0.8,
  categories: {
    exact_match: { minMRR: 0.65, minPrecision1: 0.45 },
    semantic: { minMRR: 0.45 },
    related_concept: { minRecall5: 0.4 },
    negative: {}, // Informational only
    edge_case: { minMRR: 0.3 },
  },
};

/**
 * Report output from formatReport.
 */
export interface ReportOutput {
  /** Formatted report string for console output */
  report: string;
  /** Whether the benchmark passed all thresholds */
  passed: boolean;
  /** Warning messages (issues that don't cause failure) */
  warnings: string[];
  /** Failed queries for debugging */
  failedQueries: QueryResult[];
}

/**
 * Format a metric value for display.
 */
function formatMetric(value: number): string {
  return value.toFixed(3);
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 3) + "..." : s;
}

/**
 * Format benchmark results as a human-readable report.
 */
export function formatReport(
  results: BenchmarkResults,
  thresholds: ThresholdConfig = defaultThresholds
): ReportOutput {
  const lines: string[] = [];
  const warnings: string[] = [];
  let passed = true;

  const o = results.overall;

  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("                SEARCH QUALITY BENCHMARK RESULTS                ");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Overall metrics
  lines.push(`Overall Metrics (${o.queryCount} queries)`);
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push(`  Mean Reciprocal Rank (MRR):  ${formatMetric(o.meanReciprocalRank)}`);
  lines.push(`  Precision@1:                 ${formatMetric(o.meanPrecisionAt1)}`);
  lines.push(`  Precision@5:                 ${formatMetric(o.meanPrecisionAt5)}`);
  lines.push(`  Recall@5:                    ${formatMetric(o.meanRecallAt5)}`);
  lines.push(`  NDCG@5:                      ${formatMetric(o.meanNDCGAt5)}`);
  lines.push(`  MAP@10:                      ${formatMetric(o.meanAP10)}`);
  lines.push("");

  // Check overall thresholds
  if (o.meanReciprocalRank < thresholds.minMeanReciprocalRank) {
    passed = false;
    lines.push(
      `  FAIL: MRR ${formatMetric(o.meanReciprocalRank)} < ${thresholds.minMeanReciprocalRank}`
    );
  } else if (o.meanReciprocalRank < thresholds.warnIfMRRBelow) {
    warnings.push(
      `MRR (${formatMetric(o.meanReciprocalRank)}) could be improved (ideal: ${thresholds.warnIfMRRBelow}+)`
    );
  }

  if (o.meanPrecisionAt1 < thresholds.minMeanPrecisionAt1) {
    passed = false;
    lines.push(
      `  FAIL: Precision@1 ${formatMetric(o.meanPrecisionAt1)} < ${thresholds.minMeanPrecisionAt1}`
    );
  }

  if (o.meanRecallAt5 < thresholds.minMeanRecallAt5) {
    passed = false;
    lines.push(
      `  FAIL: Recall@5 ${formatMetric(o.meanRecallAt5)} < ${thresholds.minMeanRecallAt5}`
    );
  }

  // Per-category metrics
  lines.push("───────────────────────────────────────────────────────────────");
  lines.push("By Category");
  lines.push("───────────────────────────────────────────────────────────────");

  const categoryOrder: QueryCategory[] = [
    "exact_match",
    "semantic",
    "related_concept",
    "negative",
    "edge_case",
  ];

  for (const category of categoryOrder) {
    const metrics = results.byCategory.get(category);
    if (!metrics) continue;

    lines.push("");
    lines.push(`  ${category} (${metrics.queryCount} queries)`);
    lines.push(
      `    MRR: ${formatMetric(metrics.meanReciprocalRank)}  ` +
        `P@1: ${formatMetric(metrics.meanPrecisionAt1)}  ` +
        `R@5: ${formatMetric(metrics.meanRecallAt5)}  ` +
        `NDCG@5: ${formatMetric(metrics.meanNDCGAt5)}  ` +
        `MAP@10: ${formatMetric(metrics.meanAP10)}`
    );

    // Check category thresholds
    const catThresh = thresholds.categories[category];
    if (catThresh) {
      if (
        catThresh.minMRR !== undefined &&
        metrics.meanReciprocalRank < catThresh.minMRR
      ) {
        passed = false;
        lines.push(
          `    FAIL: MRR ${formatMetric(metrics.meanReciprocalRank)} < ${catThresh.minMRR}`
        );
      }
      if (
        catThresh.minPrecision1 !== undefined &&
        metrics.meanPrecisionAt1 < catThresh.minPrecision1
      ) {
        passed = false;
        lines.push(
          `    FAIL: Precision@1 ${formatMetric(metrics.meanPrecisionAt1)} < ${catThresh.minPrecision1}`
        );
      }
      if (
        catThresh.minRecall5 !== undefined &&
        metrics.meanRecallAt5 < catThresh.minRecall5
      ) {
        passed = false;
        lines.push(
          `    FAIL: Recall@5 ${formatMetric(metrics.meanRecallAt5)} < ${catThresh.minRecall5}`
        );
      }
    }
  }

  // Failed queries detail
  const failed = results.queryResults.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("");
    lines.push("───────────────────────────────────────────────────────────────");
    lines.push(`Failed Queries (${failed.length})`);
    lines.push("───────────────────────────────────────────────────────────────");

    for (const f of failed.slice(0, 10)) {
      const rank =
        f.reciprocalRank > 0 ? Math.round(1 / f.reciprocalRank) : "not found";
      lines.push("");
      lines.push(`  ${f.queryId} [${f.category}]`);
      lines.push(`    Query: "${truncate(f.query, 50)}"`);
      lines.push(`    Expected rank: 1, Got: ${rank}`);
      lines.push(`    MRR: ${formatMetric(f.reciprocalRank)}`);
    }

    if (failed.length > 10) {
      lines.push("");
      lines.push(`  ... and ${failed.length - 10} more failed queries`);
    }
  }

  // Summary
  lines.push("");
  lines.push("═══════════════════════════════════════════════════════════════");
  if (passed) {
    lines.push("  BENCHMARK PASSED");
  } else {
    lines.push("  BENCHMARK FAILED");
  }
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  return {
    report: lines.join("\n"),
    passed,
    warnings,
    failedQueries: failed,
  };
}

/**
 * Format a compact summary suitable for CI logs.
 */
export function formatCompactSummary(results: BenchmarkResults): string {
  const o = results.overall;
  const passed = results.queryResults.filter((r) => r.passed).length;
  const total = results.queryResults.length;

  return (
    `Benchmark: ${passed}/${total} queries passed | ` +
    `MRR: ${formatMetric(o.meanReciprocalRank)} | ` +
    `P@1: ${formatMetric(o.meanPrecisionAt1)} | ` +
    `R@5: ${formatMetric(o.meanRecallAt5)} | ` +
    `MAP@10: ${formatMetric(o.meanAP10)}`
  );
}
