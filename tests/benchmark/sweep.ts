#!/usr/bin/env bun
/**
 * Parameter Sweep Runner
 *
 * Runs the benchmark across all permutations of tuning parameters,
 * with multi-run averaging per permutation to smooth out jitter.
 *
 * Tuning levers:
 *   - RRF K: Controls rank fusion sharpness (lower = sharper top-rank preference)
 *   - Candidate pool multiplier: How many candidates each retrieval path fetches
 *   - Jitter: Random scoring noise for result diversity
 *
 * Usage:
 *   bun run tests/benchmark/sweep.ts
 *   bun run tests/benchmark/sweep.ts --runs 3    # fewer runs per permutation (default: 5)
 */

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { connectToDatabase } from "../../server/core/connection";
import { MemoryRepository } from "../../server/core/memory.repository";
import { EmbeddingsService } from "../../server/core/embeddings.service";
import {
  knnSearch,
  sanitizeFtsQuery,
  hybridRRF,
  topByRRF,
} from "../../server/core/sqlite-utils";
import {
  precisionAtK,
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  averagePrecision,
  buildRelevanceScores,
} from "./metrics";
import { generalDataset } from "./datasets";
import type { CategoryMetrics, QueryCategory, QueryResult } from "./types";
import type { Memory, HybridRow } from "../../server/core/memory";
import { isDeleted } from "../../server/core/memory";

// ---------------------------------------------------------------------------
// Parameter definitions
// ---------------------------------------------------------------------------

interface SweepParams {
  rrfK: number;
  candidatePoolMultiplier: number;
  jitter: number;
}

const RRF_K_VALUES = [10, 30, 60, 90];
const CANDIDATE_POOL_VALUES = [2, 3, 5, 10];
const JITTER_VALUES = [0.0, 0.01, 0.02, 0.05];

const RUNS_PER_COMBO = (() => {
  const idx = process.argv.indexOf("--runs");
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 5;
})();

// ---------------------------------------------------------------------------
// Scoring (mirrors MemoryService.computeMemoryScore but with injectable jitter)
// ---------------------------------------------------------------------------

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** fact_check profile weights (benchmark standard) */
const WEIGHTS = { relevance: 0.6, recency: 0.1, utility: 0.2 };

function computeScore(candidate: HybridRow, jitter: number, now: Date): number {
  const relevance = candidate.rrfScore;
  const lastAccessed = candidate.lastAccessed ?? candidate.createdAt;
  const hoursSinceAccess = Math.max(
    0,
    (now.getTime() - lastAccessed.getTime()) / (1000 * 60 * 60)
  );
  const recency = Math.pow(0.995, hoursSinceAccess);
  const utility = sigmoid(
    (candidate.usefulness + Math.log(candidate.accessCount + 1)) / 5
  );
  const score =
    WEIGHTS.relevance * relevance +
    WEIGHTS.recency * recency +
    WEIGHTS.utility * utility;
  return score * (1 + (Math.random() * 2 - 1) * jitter);
}

// ---------------------------------------------------------------------------
// Custom hybrid search with parameterized values
// ---------------------------------------------------------------------------

function findHybridParameterized(
  repository: MemoryRepository,
  embedding: number[],
  query: string,
  limit: number,
  params: SweepParams
): HybridRow[] {
  const db = repository.getDb();
  const candidateLimit = limit * params.candidatePoolMultiplier;

  // Vector KNN
  const vectorResults = knnSearch(db, "memories_vec", embedding, candidateLimit);

  // FTS5
  const ftsQuery = sanitizeFtsQuery(query);
  const ftsResults: Array<{ id: string }> = ftsQuery
    ? (db
        .prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?")
        .all(ftsQuery, candidateLimit) as Array<{ id: string }>)
    : [];

  // RRF with parameterized K
  const rrfScores = hybridRRF(vectorResults, ftsResults, params.rrfK);
  const topIds = topByRRF(rrfScores, limit);

  if (topIds.length === 0) return [];

  // Fetch full rows
  const placeholders = topIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...topIds) as Array<Record<string, unknown>>;

  const rowMap = new Map<string, Record<string, unknown>>();
  for (const row of rows) rowMap.set(row.id as string, row);

  const results: HybridRow[] = [];
  for (const id of topIds) {
    const row = rowMap.get(id);
    if (!row) continue;
    results.push({
      id: row.id as string,
      content: row.content as string,
      embedding: [], // Not needed for scoring
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : {},
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      supersededBy: (row.superseded_by as string) ?? null,
      usefulness: (row.usefulness as number) ?? 0,
      accessCount: (row.access_count as number) ?? 0,
      lastAccessed: row.last_accessed ? new Date(row.last_accessed as string) : null,
      rrfScore: rrfScores.get(id) ?? 0,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Single benchmark run with parameterized search
// ---------------------------------------------------------------------------

function runOnce(
  repository: MemoryRepository,
  queryEmbeddings: Map<string, number[]>,
  memoryIdMap: Map<string, string>,
  params: SweepParams
): { queryResults: QueryResult[]; byCategory: Map<QueryCategory, QueryResult[]> } {
  const now = new Date();
  const queryResults: QueryResult[] = [];
  const categoryResults = new Map<QueryCategory, QueryResult[]>();

  for (const query of generalDataset.queries) {
    const queryEmbedding = queryEmbeddings.get(query.id)!;

    // Run parameterized hybrid search
    const candidates = findHybridParameterized(
      repository,
      queryEmbedding,
      query.query,
      50, // effectiveLimit * 5, matching service behavior for limit=10
      params
    );

    // Score and rank (mirrors service layer)
    const scored = candidates
      .filter((c) => !isDeleted(c))
      .map((c) => ({
        id: c.id,
        score: computeScore(c, params.jitter, now),
      }));
    scored.sort((a, b) => b.score - a.score);
    const retrievedIds = scored.slice(0, 10).map((s) => s.id);

    // Map expected IDs
    const expectedActualIds = query.relevantMemoryIds
      .map((id) => memoryIdMap.get(id))
      .filter((id): id is string => id !== undefined);
    const partialActualIds = (query.partiallyRelevantIds ?? [])
      .map((id) => memoryIdMap.get(id))
      .filter((id): id is string => id !== undefined);

    const relevantSet = new Set(expectedActualIds);
    const relevanceScores = buildRelevanceScores(expectedActualIds, partialActualIds);

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
      passed: true,
    };

    queryResults.push(result);
    if (!categoryResults.has(query.category)) categoryResults.set(query.category, []);
    categoryResults.get(query.category)!.push(result);
  }

  return { queryResults, byCategory: categoryResults };
}

// ---------------------------------------------------------------------------
// Aggregate metrics
// ---------------------------------------------------------------------------

function aggregateMetrics(results: QueryResult[]): CategoryMetrics {
  const n = results.length;
  if (n === 0)
    return {
      meanPrecisionAt1: 0, meanPrecisionAt5: 0, meanRecallAt5: 0,
      meanReciprocalRank: 0, meanNDCGAt5: 0, meanAP10: 0, queryCount: 0,
    };
  return {
    meanPrecisionAt1: results.reduce((s, r) => s + r.precision1, 0) / n,
    meanPrecisionAt5: results.reduce((s, r) => s + r.precision5, 0) / n,
    meanRecallAt5: results.reduce((s, r) => s + r.recall5, 0) / n,
    meanReciprocalRank: results.reduce((s, r) => s + r.reciprocalRank, 0) / n,
    meanNDCGAt5: results.reduce((s, r) => s + r.ndcg5, 0) / n,
    meanAP10: results.reduce((s, r) => s + r.ap10, 0) / n,
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
    queryCount: runs[0].queryCount,
  };
}

function stddev(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
}

// ---------------------------------------------------------------------------
// Sweep result type
// ---------------------------------------------------------------------------

interface SweepResult {
  params: SweepParams;
  overall: CategoryMetrics;
  byCategory: Map<QueryCategory, CategoryMetrics>;
  mrrStddev: number; // Stability metric: stddev of MRR across runs
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Build permutation matrix
const permutations: SweepParams[] = [];
for (const rrfK of RRF_K_VALUES) {
  for (const candidatePoolMultiplier of CANDIDATE_POOL_VALUES) {
    for (const jitter of JITTER_VALUES) {
      permutations.push({ rrfK, candidatePoolMultiplier, jitter });
    }
  }
}

const totalPermutations = permutations.length;
const totalRuns = totalPermutations * RUNS_PER_COMBO;

console.log("═══════════════════════════════════════════════════════════════");
console.log("              SEARCH QUALITY PARAMETER SWEEP                   ");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");
console.log(`Levers:`);
console.log(`  RRF K:              ${RRF_K_VALUES.join(", ")}`);
console.log(`  Candidate pool:     ${CANDIDATE_POOL_VALUES.join(", ")}`);
console.log(`  Jitter:             ${JITTER_VALUES.join(", ")}`);
console.log(`  Permutations:       ${totalPermutations}`);
console.log(`  Runs per combo:     ${RUNS_PER_COMBO}`);
console.log(`  Total runs:         ${totalRuns}`);
console.log("");

// Setup
console.log("Setting up...");
const tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-sweep-"));
const dbPath = join(tmpDir, "sweep.db");
const db = connectToDatabase(dbPath);
const repository = new MemoryRepository(db);
const embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);

// Load dataset
console.log("Loading dataset and embedding memories...");
const memoryIdMap = new Map<string, string>();
for (const mem of generalDataset.memories) {
  const embedding = await embeddings.embed(mem.content);
  const id = crypto.randomUUID();
  const now = new Date();
  const memory: Memory = {
    id,
    content: mem.content,
    embedding,
    metadata: mem.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    supersededBy: null,
    usefulness: 0,
    accessCount: 0,
    lastAccessed: now,
  };
  repository.insert(memory);
  memoryIdMap.set(mem.id, id);
}

// Pre-compute all query embeddings
console.log("Embedding queries...");
const queryEmbeddings = new Map<string, number[]>();
for (const query of generalDataset.queries) {
  queryEmbeddings.set(query.id, await embeddings.embed(query.query));
}

console.log("Setup complete. Running sweep...\n");

// Run sweep
const results: SweepResult[] = [];
const categoryOrder: QueryCategory[] = [
  "exact_match", "semantic", "related_concept", "negative", "edge_case",
];

for (let pi = 0; pi < permutations.length; pi++) {
  const params = permutations[pi];
  const label = `K=${String(params.rrfK).padStart(3)} pool=${String(params.candidatePoolMultiplier).padStart(2)} jitter=${params.jitter.toFixed(2)}`;

  const runOveralls: CategoryMetrics[] = [];
  const runMRRs: number[] = [];
  const runByCategories: Map<QueryCategory, CategoryMetrics[]> = new Map();
  for (const cat of categoryOrder) runByCategories.set(cat, []);

  for (let r = 0; r < RUNS_PER_COMBO; r++) {
    const { queryResults, byCategory } = runOnce(repository, queryEmbeddings, memoryIdMap, params);
    const overall = aggregateMetrics(queryResults);
    runOveralls.push(overall);
    runMRRs.push(overall.meanReciprocalRank);

    for (const cat of categoryOrder) {
      const catResults = byCategory.get(cat);
      if (catResults) runByCategories.get(cat)!.push(aggregateMetrics(catResults));
    }
  }

  const avgOverall = averageOfMetrics(runOveralls);
  const avgByCategory = new Map<QueryCategory, CategoryMetrics>();
  for (const cat of categoryOrder) {
    const catRuns = runByCategories.get(cat)!;
    if (catRuns.length > 0) avgByCategory.set(cat, averageOfMetrics(catRuns));
  }

  const result: SweepResult = {
    params,
    overall: avgOverall,
    byCategory: avgByCategory,
    mrrStddev: stddev(runMRRs),
  };
  results.push(result);

  const pct = ((pi + 1) / permutations.length * 100).toFixed(0);
  process.stdout.write(
    `  [${pct.padStart(3)}%] ${label}  MRR=${avgOverall.meanReciprocalRank.toFixed(3)}  MAP=${avgOverall.meanAP10.toFixed(3)}  R@5=${avgOverall.meanRecallAt5.toFixed(3)}  σ=${result.mrrStddev.toFixed(3)}\n`
  );
}

// Cleanup
rmSync(tmpDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

// Sort by composite score: MRR + MAP + R@5 (equal weight)
results.sort((a, b) => {
  const scoreA = a.overall.meanReciprocalRank + a.overall.meanAP10 + a.overall.meanRecallAt5;
  const scoreB = b.overall.meanReciprocalRank + b.overall.meanAP10 + b.overall.meanRecallAt5;
  return scoreB - scoreA;
});

const fmt = (n: number) => n.toFixed(3);
const fmtP = (n: number) => n.toFixed(2);

console.log("");
console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
console.log("                                    SWEEP RESULTS (ranked by MRR + MAP + R@5)                      ");
console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
console.log("");
console.log(
  "Rank".padStart(4) + "  " +
  "RRF_K".padStart(5) + "  " +
  "Pool".padStart(4) + "  " +
  "Jitter".padStart(6) + "  │  " +
  "MRR".padStart(5) + "  " +
  "P@1".padStart(5) + "  " +
  "R@5".padStart(5) + "  " +
  "NDCG".padStart(5) + "  " +
  "MAP".padStart(5) + "  " +
  "σ(MRR)".padStart(6) + "  │  " +
  "Composite".padStart(9)
);
console.log("─".repeat(100));

// Highlight current defaults
const currentDefault = { rrfK: 60, candidatePoolMultiplier: 3, jitter: 0.02 };

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const p = r.params;
  const composite = r.overall.meanReciprocalRank + r.overall.meanAP10 + r.overall.meanRecallAt5;
  const isCurrent =
    p.rrfK === currentDefault.rrfK &&
    p.candidatePoolMultiplier === currentDefault.candidatePoolMultiplier &&
    p.jitter === currentDefault.jitter;
  const marker = isCurrent ? " ◄ CURRENT" : "";

  console.log(
    String(i + 1).padStart(4) + "  " +
    String(p.rrfK).padStart(5) + "  " +
    String(p.candidatePoolMultiplier).padStart(4) + "  " +
    fmtP(p.jitter).padStart(6) + "  │  " +
    fmt(r.overall.meanReciprocalRank).padStart(5) + "  " +
    fmt(r.overall.meanPrecisionAt1).padStart(5) + "  " +
    fmt(r.overall.meanRecallAt5).padStart(5) + "  " +
    fmt(r.overall.meanNDCGAt5).padStart(5) + "  " +
    fmt(r.overall.meanAP10).padStart(5) + "  " +
    fmt(r.mrrStddev).padStart(6) + "  │  " +
    fmt(composite).padStart(9) +
    marker
  );
}

// Top 5 detail breakdown by category
console.log("");
console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");
console.log("                              TOP 5 — PER-CATEGORY BREAKDOWN                                     ");
console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════");

for (let i = 0; i < Math.min(5, results.length); i++) {
  const r = results[i];
  const p = r.params;
  console.log("");
  console.log(`#${i + 1}  K=${p.rrfK}  pool=${p.candidatePoolMultiplier}  jitter=${fmtP(p.jitter)}  (σ=${fmt(r.mrrStddev)})`);
  console.log("  " + "Category".padEnd(18) + "MRR".padStart(6) + "P@1".padStart(6) + "R@5".padStart(6) + "NDCG".padStart(6) + "MAP".padStart(6));
  console.log("  " + "─".repeat(48));

  for (const cat of categoryOrder) {
    const m = r.byCategory.get(cat);
    if (!m) continue;
    console.log(
      "  " + cat.padEnd(18) +
      fmt(m.meanReciprocalRank).padStart(6) +
      fmt(m.meanPrecisionAt1).padStart(6) +
      fmt(m.meanRecallAt5).padStart(6) +
      fmt(m.meanNDCGAt5).padStart(6) +
      fmt(m.meanAP10).padStart(6)
    );
  }
}

// Summary
const best = results[0];
const currentIdx = results.findIndex(
  (r) =>
    r.params.rrfK === currentDefault.rrfK &&
    r.params.candidatePoolMultiplier === currentDefault.candidatePoolMultiplier &&
    r.params.jitter === currentDefault.jitter
);

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  SUMMARY");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  Best:    K=${best.params.rrfK} pool=${best.params.candidatePoolMultiplier} jitter=${fmtP(best.params.jitter)}  (rank #1)`);
console.log(`  Current: K=60 pool=3 jitter=0.02  (rank #${currentIdx + 1})`);
console.log(`  Best MRR:    ${fmt(best.overall.meanReciprocalRank)} vs current ${fmt(results[currentIdx].overall.meanReciprocalRank)}`);
console.log(`  Best MAP:    ${fmt(best.overall.meanAP10)} vs current ${fmt(results[currentIdx].overall.meanAP10)}`);
console.log(`  Best R@5:    ${fmt(best.overall.meanRecallAt5)} vs current ${fmt(results[currentIdx].overall.meanRecallAt5)}`);
console.log("═══════════════════════════════════════════════════════════════");
