#!/usr/bin/env bun
/**
 * Statistics suite over a local Obsidian vault.
 *
 * Usage:
 *   bun run benchmark:vault --vault <path> [--bespoke <file>] [--queries N] [--runs N]
 *                           [--out <file>] [--skip-scale] [--skip-dedup]
 *
 * Builds the vault dataset (tests/benchmark/datasets/obsidian.ts) plus any
 * hand-written questions (--bespoke; default ~/.vector-memory/benchmarks/
 * <vault>-bespoke.json when present) and reports:
 *
 *   A. dataset & graph profile        F. scale curve (10/25/50/100% of notes)
 *   B. ingestion                      G. confidence calibration
 *   C. quality by configuration       H. duplicate handling (write-time, cleanup)
 *   D. intent sweep                   I. graph-lane activity
 *   E. latency
 *
 * Embeddings are cached under ~/.vector-memory/benchmark-cache/ keyed by
 * SHA-256 (no plaintext). The report holds aggregate numbers only and is
 * written to .vector-memory/benchmark-reports/ (gitignored) and stdout.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import arg from "arg";
import { BenchmarkRunner, MODEL_NAME, MODEL_DIMENSION, type RunOptions } from "../tests/benchmark/runner";
import { loadObsidianDataset } from "../tests/benchmark/datasets/obsidian";
import { CachedEmbeddings } from "../tests/benchmark/embedding-cache";
import { Sampler } from "../tests/benchmark/loaders/sampler";
import { EmbeddingsService } from "../server/core/embeddings.service";
import { entitiesNamedIn, HUB_DEGREE } from "../server/core/graph-recall";
import { WRITE_DUPLICATE_SIMILARITY } from "../server/core/memory.service";
import type { SearchIntent } from "../server/core/memory";
import type { BenchmarkDataset, CategoryMetrics, QueryCategory, QueryResult } from "../tests/benchmark/types";

const args = arg({
  "--vault": String,
  "--bespoke": String,
  "--queries": Number,
  "--runs": Number,
  "--out": String,
  "--skip-scale": Boolean,
  "--skip-dedup": Boolean,
});
const vaultPath = args["--vault"];
if (!vaultPath) {
  console.error("Usage: bun run benchmark:vault --vault <path> [--bespoke <file>] [--queries N] [--runs N]");
  process.exit(1);
}
const RUNS = args["--runs"] ?? 2;
const defaultBespoke = join(homedir(), ".vector-memory", "benchmarks", `${basename(vaultPath).toLowerCase()}-bespoke.json`);
const bespokeFile = args["--bespoke"] ?? (existsSync(defaultBespoke) ? defaultBespoke : undefined);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = args["--out"] ?? join(import.meta.dir, "..", ".vector-memory", "benchmark-reports", `vault-stats-${stamp}.md`);

// ── Helpers ─────────────────────────────────────────────────────────

const report: string[] = [];
const out = (line = "") => {
  report.push(line);
  console.log(line);
};
const log = (line: string) => process.stderr.write(`${line}\n`);
const f3 = (n: number) => n.toFixed(3);
const f1 = (n: number) => n.toFixed(1);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const table = (header: string[], rows: Array<Array<string | number>>) => {
  out(`| ${header.join(" | ")} |`);
  out(`|${header.map(() => "---").join("|")}|`);
  for (const r of rows) out(`| ${r.join(" | ")} |`);
  out();
};
const time = async <T>(fn: () => Promise<T> | T): Promise<[T, number]> => {
  const t = performance.now();
  const v = await fn();
  return [v, performance.now() - t];
};

const CATEGORY_LABEL: Partial<Record<QueryCategory, string>> = {
  exact_match: "section lookup",
  semantic: "summary paraphrase",
  related_concept: "title lookup",
  bespoke: "bespoke (hand-written)",
  negative: "negative",
};
const CATEGORIES: QueryCategory[] = ["bespoke", "exact_match", "semantic", "related_concept"];
const answerable = (r: QueryResult) => r.category !== "negative";

/** RUNS runs of `opts`: per-run results. */
async function runConfig(runner: BenchmarkRunner, dataset: BenchmarkDataset, opts: RunOptions, runs = RUNS) {
  const all: QueryResult[][] = [];
  for (let i = 0; i < runs; i++) all.push((await runner.runBenchmark(dataset, opts)).queryResults);
  return all;
}

/** Metrics over the results `pick` keeps, averaged across runs. */
function metrics(runner: BenchmarkRunner, runs: QueryResult[][], pick: (r: QueryResult) => boolean): CategoryMetrics {
  const per = runs.map((rs) => runner.aggregateMetrics(rs.filter(pick)));
  const avg = (f: (m: CategoryMetrics) => number) => mean(per.map(f));
  return {
    meanPrecisionAt1: avg((m) => m.meanPrecisionAt1),
    meanPrecisionAt5: avg((m) => m.meanPrecisionAt5),
    meanRecallAt5: avg((m) => m.meanRecallAt5),
    meanReciprocalRank: avg((m) => m.meanReciprocalRank),
    meanNDCGAt5: avg((m) => m.meanNDCGAt5),
    meanAP10: avg((m) => m.meanAP10),
    meanTopConfidence: avg((m) => m.meanTopConfidence),
    queryCount: per[0]?.queryCount ?? 0,
  };
}
const latencies = (runs: QueryResult[][]) => runs.flat().map((r) => r.latencyMs ?? 0);

// ── Dataset ─────────────────────────────────────────────────────────

const loaded = loadObsidianDataset({ vaultPath, bespokeFile, queriesPerCategory: args["--queries"] ?? 100 });
const dataset = loaded.dataset;
const stats = loaded.stats;
if (stats.bespoke?.dropped.length) {
  log(`Bespoke questions dropped (${stats.bespoke.dropped.length}):`);
  for (const d of stats.bespoke.dropped) log(`  ${d.id}: ${d.reason}`);
}

out(`# Vault statistics (${new Date().toISOString().slice(0, 10)})`);
out();
out(
  `Model ${MODEL_NAME} (${MODEL_DIMENSION}d) · ${RUNS} runs per configuration · ` +
    `${dataset.queries.length} queries (${dataset.queries.filter((q) => q.category === "bespoke").length} hand-written)`,
);
out();

// ── A. Profile ──────────────────────────────────────────────────────

out("## A. Dataset & graph profile");
out();
const chunkLens = dataset.memories.map((m) => m.content.length);
const perNote = new Map<string, number>();
for (const m of dataset.memories) perNote.set(String(m.metadata?.note), (perNote.get(String(m.metadata?.note)) ?? 0) + 1);
const links = dataset.graph!.memoryLinks ?? [];
const linksPerMemory = new Map<string, number>();
for (const l of links) linksPerMemory.set(l.memoryId, (linksPerMemory.get(l.memoryId) ?? 0) + 1);
const degree = new Map<string, number>(dataset.graph!.entities.map((e) => [e.id, 0]));
for (const l of links) degree.set(l.entityId, (degree.get(l.entityId) ?? 0) + 1);
for (const r of dataset.graph!.relations) {
  degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
  degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
}
const degrees = [...degree.values()];
table(
  ["Measure", "Value"],
  [
    ["Notes scanned / with memories", `${stats.notesScanned} / ${stats.notesWithChunks}`],
    ["Memories (sections)", stats.chunks],
    ["Memory length p10 / p50 / p90 / max (chars)", `${percentile(chunkLens, 10)} / ${percentile(chunkLens, 50)} / ${percentile(chunkLens, 90)} / ${Math.max(...chunkLens)}`],
    ["Memories per note p50 / p90 / max", `${percentile([...perNote.values()], 50)} / ${percentile([...perNote.values()], 90)} / ${Math.max(...perNote.values())}`],
    ["Template boilerplate paragraphs dropped", stats.boilerplateParagraphsDropped],
    ["Entities", stats.entities],
    ["Memories with ≥1 wikilink", `${linksPerMemory.size} (${pct(linksPerMemory.size / stats.chunks)})`],
    ["Wikilinks per linked memory, mean / max", `${f1(mean([...linksPerMemory.values()]))} / ${Math.max(0, ...linksPerMemory.values())}`],
    ["Frontmatter relations", stats.relations],
    ["Entity degree p50 / p90 / p99 / max", `${percentile(degrees, 50)} / ${percentile(degrees, 90)} / ${percentile(degrees, 99)} / ${Math.max(...degrees)}`],
    ["Entities with no links", degrees.filter((d) => d === 0).length],
    [`Hub entities (> ${HUB_DEGREE} links)`, degrees.filter((d) => d > HUB_DEGREE).length],
    ["Unresolved wikilinks", stats.unresolvedLinks],
  ],
);
const byCategory = new Map<string, number>();
for (const q of dataset.queries) byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
const byKind = new Map<string, number>();
for (const q of dataset.queries.filter((q) => q.category === "bespoke")) byKind.set(q.kind ?? "?", (byKind.get(q.kind ?? "?") ?? 0) + 1);
out(
  `Queries: ${[...byCategory].map(([c, n]) => `${CATEGORY_LABEL[c as QueryCategory] ?? c} ${n}`).join(", ")}.` +
    (stats.bespoke ? ` Hand-written: ${stats.bespoke.kept} of ${stats.bespoke.inFile} resolved (${[...byKind].map(([k, n]) => `${k} ${n}`).join(", ")}).` : " No hand-written questions file."),
);
out();

// ── B. Ingestion ────────────────────────────────────────────────────

const cache = new CachedEmbeddings(
  new EmbeddingsService(MODEL_NAME, MODEL_DIMENSION),
  MODEL_NAME,
  join(homedir(), ".vector-memory", "benchmark-cache", `embeddings-${MODEL_NAME.replace(/[^a-z0-9]+/gi, "_")}.bin`),
);
const runner = new BenchmarkRunner();
await runner.setup({ embeddings: cache.asService() });
log("Loading the vault...");
const misses0 = cache.misses;
const [, loadMs] = await time(() => runner.loadDataset(dataset));
cache.save();
const embedded = cache.misses - misses0;
const dbBytes = [runner.getDbPath(), `${runner.getDbPath()}-wal`].filter(existsSync).reduce((s, p) => s + statSync(p).size, 0);

out("## B. Ingestion");
out();
table(
  ["Measure", "Value"],
  [
    ["Load time (store + graph)", `${(loadMs / 1000).toFixed(1)} s`],
    ["Embedded this run / served from cache", `${embedded} / ${cache.hits}`],
    ["Throughput", `${f1(dataset.memories.length / (loadMs / 1000))} memories/s${embedded === 0 ? " (embeddings cached: storage + graph only)" : ""}`],
    ["Database size (incl. WAL)", `${(dbBytes / 1024 / 1024).toFixed(1)} MB`],
  ],
);

// ── C/E/I. Configurations ───────────────────────────────────────────

const CONFIGS: Array<{ name: string; opts: RunOptions }> = [
  { name: "graph off", opts: { useGraph: false } },
  { name: "graph on (default)", opts: {} },
  { name: "graph on + neighbours 0.1", opts: { graphWeights: { neighbor: 0.1 } } },
  { name: "hybrid mode", opts: { mode: "hybrid" } },
  { name: "exact mode (keyword only, every word must match)", opts: { mode: "exact" } },
];
const results = new Map<string, QueryResult[][]>();
// Untimed warm-up pass (JIT, SQLite page cache), so the first configuration
// measured isn't penalised for going first.
log("Warm-up pass");
await runner.runBenchmark(dataset, {});
for (const c of CONFIGS) {
  log(`Configuration: ${c.name}`);
  results.set(c.name, await runConfig(runner, dataset, c.opts));
}

// ── D. Intents (default configuration) ──────────────────────────────

const INTENTS: SearchIntent[] = ["fact_check", "continuity", "frequent", "associative", "explore"];
const intentResults = new Map<SearchIntent, QueryResult[][]>();
for (const intent of INTENTS) {
  log(`Intent: ${intent}`);
  intentResults.set(intent, intent === "fact_check" ? results.get("graph on (default)")! : await runConfig(runner, dataset, { intent }));
}

// ── I. Named entities per query (before membership links change nothing here) ──

const db = runner.getService().getRepository().getDb();
const namedCounts = dataset.queries.filter((q) => q.category !== "negative").map((q) => entitiesNamedIn(db, q.query).length);

// ── F. Scale curve ──────────────────────────────────────────────────

type ScalePoint = { fraction: number; memories: number; queries: number; loadS: number; off: CategoryMetrics; on: CategoryMetrics; fixedOff: CategoryMetrics; fixedOn: CategoryMetrics; p50On: number; p50Off: number };
const scale: ScalePoint[] = [];
if (!args["--skip-scale"]) {
  const notes = [...perNote.keys()];
  new Sampler(7).shuffleInPlace(notes);
  const fractions = [0.1, 0.25, 0.5, 1];
  const subsetOf = (fraction: number): BenchmarkDataset => {
    const keep = new Set(notes.slice(0, Math.ceil(notes.length * fraction)));
    const memories = dataset.memories.filter((m) => keep.has(String(m.metadata?.note)));
    const ids = new Set(memories.map((m) => m.id));
    return {
      ...dataset,
      memories,
      queries: dataset.queries.filter((q) => q.category === "negative" || q.relevantMemoryIds.every((id) => ids.has(id))),
      graph: { ...dataset.graph!, memoryLinks: (dataset.graph!.memoryLinks ?? []).filter((l) => ids.has(l.memoryId)) },
    };
  };
  const fixed = new Set(subsetOf(fractions[0]).queries.filter((q) => q.category !== "negative").map((q) => q.id));
  for (const fraction of fractions) {
    log(`Scale: ${fraction * 100}%`);
    const sub = subsetOf(fraction);
    const r = new BenchmarkRunner();
    await r.setup({ embeddings: cache.asService() });
    const [, ms] = await time(() => r.loadDataset(sub));
    const off = await runConfig(r, sub, { useGraph: false }, 1);
    const on = await runConfig(r, sub, {}, 1);
    scale.push({
      fraction,
      memories: sub.memories.length,
      queries: sub.queries.filter((q) => q.category !== "negative").length,
      loadS: ms / 1000,
      off: metrics(r, off, answerable),
      on: metrics(r, on, answerable),
      fixedOff: metrics(r, off, (q) => fixed.has(q.queryId)),
      fixedOn: metrics(r, on, (q) => fixed.has(q.queryId)),
      p50Off: percentile(latencies(off), 50),
      p50On: percentile(latencies(on), 50),
    });
    await r.teardown();
  }
  cache.save();
}

// ── Membership links (changes the graph: last) ──────────────────────

log("Configuration: graph on + membership links");
const membership = dataset.memories.map((m) => ({ memoryId: m.id, entityId: String(m.metadata?.note) }));
const added = runner.linkMemories(membership);
results.set("graph on + membership links", await runConfig(runner, dataset, {}));

// ── H. Duplicates ───────────────────────────────────────────────────

let dedup: { stored: number; flagged: number; skipped: number; skippedExact: number; ms: number } | null = null;
let clusters: { found: number; members: number; sizes: number[]; ms: number } | null = null;
let cleanup: { mergeClusters: number; merged: number; review: Map<string, number>; ms: number } | null = null;
if (!args["--skip-dedup"]) {
  log("Duplicates: find_duplicates (0.92)");
  const service = runner.getService();
  const [found, findMs] = await time(() => service.findDuplicates(0.92));
  clusters = {
    found: found.length,
    members: found.reduce((s, c) => s + c.duplicateIds.length + 1, 0),
    sizes: found.map((c) => c.duplicateIds.length + 1),
    ms: findMs,
  };
  log(`Duplicates: cleanup plan (${WRITE_DUPLICATE_SIMILARITY}, dry run)`);
  const [plan, planMs] = await time(() => service.cleanupDuplicates(WRITE_DUPLICATE_SIMILARITY, true));
  const review = new Map<string, number>();
  for (const p of plan.plans) for (const i of p.review) review.set(i.reason, (review.get(i.reason) ?? 0) + 1);
  cleanup = { mergeClusters: plan.clusters, merged: plan.deleted, review, ms: planMs };

  log("Duplicates: write-time check over every memory");
  const r = new BenchmarkRunner();
  await r.setup({ embeddings: cache.asService() });
  const s = r.getService();
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  let stored = 0, flagged = 0, skipped = 0, skippedExact = 0;
  const [, ms] = await time(async () => {
    for (const m of dataset.memories) {
      const o = await s.storeUnlessDuplicate(m.content, m.metadata ?? {});
      if (o.status === "duplicate") {
        skipped++;
        if (norm(o.existing.content) === norm(m.content)) skippedExact++;
      } else {
        stored++;
        if (o.possibleDuplicateOf.length > 0) flagged++;
      }
    }
  });
  dedup = { stored, flagged, skipped, skippedExact, ms };
  await r.teardown();
}
await runner.teardown();
cache.save();

// ── Report: C ───────────────────────────────────────────────────────

const configNames = [...results.keys()];
out("## C. Retrieval quality by configuration");
out();
out("Answerable queries (all categories except negative), averaged over runs.");
out();
table(
  ["Configuration", "MRR", "P@1", "R@5", "NDCG@5", "Latency p50 / p95 (ms)"],
  configNames.map((n) => {
    const m = metrics(runner, results.get(n)!, answerable);
    const l = latencies(results.get(n)!);
    return [n, f3(m.meanReciprocalRank), f3(m.meanPrecisionAt1), f3(m.meanRecallAt5), f3(m.meanNDCGAt5), `${f1(percentile(l, 50))} / ${f1(percentile(l, 95))}`];
  }),
);
out("MRR by query category:");
out();
table(
  ["Configuration", ...CATEGORIES.map((c) => CATEGORY_LABEL[c] ?? c)],
  configNames.map((n) => [n, ...CATEGORIES.map((c) => f3(metrics(runner, results.get(n)!, (r) => r.category === c).meanReciprocalRank))]),
);
if (byKind.size > 0) {
  out("Hand-written questions by kind — MRR (R@5):");
  out();
  const kinds = [...byKind.keys()].sort();
  table(
    ["Configuration", ...kinds.map((k) => `${k} (${byKind.get(k)})`)],
    configNames.map((n) => [
      n,
      ...kinds.map((k) => {
        const m = metrics(runner, results.get(n)!, (r) => r.category === "bespoke" && r.kind === k);
        return `${f3(m.meanReciprocalRank)} (${f3(m.meanRecallAt5)})`;
      }),
    ]),
  );
}
out(`Membership links added for the last configuration: ${added}.`);
out();

// ── Report: D ───────────────────────────────────────────────────────

out("## D. Intent sweep (graph on, default mode)");
out();
table(
  ["Intent", "MRR", "R@5", "NDCG@5", "Hand-written MRR"],
  INTENTS.map((i) => {
    const runs = intentResults.get(i)!;
    const m = metrics(runner, runs, answerable);
    const b = metrics(runner, runs, (r) => r.category === "bespoke");
    return [i, f3(m.meanReciprocalRank), f3(m.meanRecallAt5), f3(m.meanNDCGAt5), b.queryCount ? f3(b.meanReciprocalRank) : "–"];
  }),
);

// ── Report: E ───────────────────────────────────────────────────────

out("## E. Latency (ms per search, all runs)");
out();
table(
  ["Configuration", "p50", "p95", "p99", "max"],
  configNames.map((n) => {
    const l = latencies(results.get(n)!);
    return [n, f1(percentile(l, 50)), f1(percentile(l, 95)), f1(percentile(l, 99)), f1(Math.max(...l))];
  }),
);

// ── Report: F ───────────────────────────────────────────────────────

if (scale.length) {
  out("## F. Scale curve (nested random subsets of notes; 1 run each)");
  out();
  out(`"Fixed" = the ${scale[0].queries} queries answerable at the smallest size, asked at every size: same questions, bigger haystack.`);
  out();
  table(
    ["Notes", "Memories", "Queries", "Load (s)", "MRR off → on", "Fixed-set MRR off → on", "Fixed-set R@5 off → on", "p50 ms off / on"],
    scale.map((p) => [
      pct(p.fraction),
      p.memories,
      p.queries,
      f1(p.loadS),
      `${f3(p.off.meanReciprocalRank)} → ${f3(p.on.meanReciprocalRank)}`,
      `${f3(p.fixedOff.meanReciprocalRank)} → ${f3(p.fixedOn.meanReciprocalRank)}`,
      `${f3(p.fixedOff.meanRecallAt5)} → ${f3(p.fixedOn.meanRecallAt5)}`,
      `${f1(p.p50Off)} / ${f1(p.p50On)}`,
    ]),
  );
}

// ── Report: G ───────────────────────────────────────────────────────

out("## G. Confidence calibration (graph on, first run)");
out();
const first = results.get("graph on (default)")![0];
const right = first.filter((r) => answerable(r) && r.precision1 === 1).map((r) => r.topConfidence);
const wrong = first.filter((r) => answerable(r) && r.precision1 === 0).map((r) => r.topConfidence);
const neg = first.filter((r) => r.category === "negative").map((r) => r.topConfidence);
table(
  ["Top-1 result", "Count", "Confidence p10 / p50 / p90"],
  [
    ["relevant", right.length, `${f3(percentile(right, 10))} / ${f3(percentile(right, 50))} / ${f3(percentile(right, 90))}`],
    ["not relevant", wrong.length, `${f3(percentile(wrong, 10))} / ${f3(percentile(wrong, 50))} / ${f3(percentile(wrong, 90))}`],
    ["negative query", neg.length, `${f3(percentile(neg, 10))} / ${f3(percentile(neg, 50))} / ${f3(percentile(neg, 90))}`],
  ],
);
out("If results below a confidence threshold were withheld (proactive_context uses 0.65):");
out();
const answerableFirst = first.filter(answerable);
table(
  ["Threshold", "Answerable queries answered", "Top-1 precision when answered", "Negative queries answered"],
  [0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.8].map((t) => {
    const ans = answerableFirst.filter((r) => r.topConfidence >= t);
    return [t, pct(ans.length / answerableFirst.length), ans.length ? pct(mean(ans.map((r) => r.precision1))) : "–", pct(neg.filter((c) => c >= t).length / Math.max(1, neg.length))];
  }),
);

// ── Report: H ───────────────────────────────────────────────────────

if (clusters && cleanup && dedup) {
  out("## H. Duplicate handling");
  out();
  table(
    ["Measure", "Value"],
    [
      ["Write-time check: stored / skipped / stored-but-flagged", `${dedup.stored} / ${dedup.skipped} / ${dedup.flagged}`],
      ["…skipped that were exact text repeats", `${dedup.skippedExact} of ${dedup.skipped}`],
      ["…time to store every memory with the check", `${(dedup.ms / 1000).toFixed(1)} s (${f1(dedup.ms / dataset.memories.length)} ms/memory)`],
      ["find_duplicates (0.92): clusters / memories in them", `${clusters.found} / ${clusters.members}`],
      ["…cluster size p50 / max", `${percentile(clusters.sizes, 50)} / ${Math.max(0, ...clusters.sizes)}`],
      ["…time", `${(clusters.ms / 1000).toFixed(1)} s`],
      [`cleanup_duplicates (${WRITE_DUPLICATE_SIMILARITY}, dry run): clusters merged / memories merged away`, `${cleanup.mergeClusters} / ${cleanup.merged}`],
      ["…left for review", [...cleanup.review].map(([k, v]) => `${k}: ${v}`).join(", ") || "none"],
      ["…time", `${(cleanup.ms / 1000).toFixed(1)} s`],
    ],
  );
}

// ── Report: I ───────────────────────────────────────────────────────

out("## I. Graph-lane activity (graph on, default)");
out();
const def = results.get("graph on (default)")!.flat().filter(answerable);
const naming = namedCounts.filter((n) => n > 0);
table(
  ["Measure", "Value"],
  [
    ["Queries naming ≥1 entity", `${naming.length} of ${namedCounts.length} (${pct(naming.length / namedCounts.length)})`],
    ["Entities named, mean / max (when ≥1)", `${f1(mean(naming))} / ${Math.max(0, ...naming)}`],
    ["Queries with ≥1 result via the graph", pct(def.filter((r) => (r.graphResults ?? 0) > 0).length / def.length)],
    ["Share of returned results reached via the graph", pct(mean(def.map((r) => (r.graphResults ?? 0) / Math.max(1, r.retrievedIds.length))))],
  ],
);

mkdirSync(join(outFile, ".."), { recursive: true });
writeFileSync(outFile, `${report.join("\n")}\n`);
log(`Report written to ${outFile}`);
