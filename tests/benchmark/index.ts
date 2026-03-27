/**
 * Search Quality Benchmark
 *
 * Exports for programmatic use of the benchmark suite.
 */

export { BenchmarkRunner } from "./runner";
export {
  formatReport,
  formatCompactSummary,
  defaultThresholds,
  type ThresholdConfig,
  type ReportOutput,
} from "./reporter";
export {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  averagePrecision,
  buildRelevanceScores,
} from "./metrics";
export type {
  BenchmarkDataset,
  BenchmarkResults,
  CategoryMetrics,
  QueryCategory,
  QueryResult,
  GroundTruthMemory,
  GroundTruthQuery,
} from "./types";
export { generalDataset } from "./datasets";
