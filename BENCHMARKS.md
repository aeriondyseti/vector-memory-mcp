# Benchmarks

Search quality metrics tracked across releases. Higher is better for all metrics.

- **MRR** (Mean Reciprocal Rank): How high the first relevant result ranks (1.0 = always first)
- **P@1** (Precision@1): Fraction of queries where the top result is relevant
- **P@5** (Precision@5): Fraction of top-5 results that are relevant
- **R@5** (Recall@5): Fraction of all relevant items found in top-5
- **NDCG@5**: Ranking quality accounting for position and graded relevance

Results are averaged over multiple runs to smooth out scoring jitter.

## Graph-aware search: before / after (2026-10-06)

**Model:** Xenova/all-MiniLM-L6-v2 (384d) | **Dataset:** general+graph (45 memories, 46 queries; graph of 35 entities, 27 relations, memories auto-linked by mention) | **Averaged over 5 runs per mode**

Same memories and graph in both columns; only `include_graph` differs (off → on).

| Category | MRR | R@5 | NDCG@5 | Queries |
|---|---|---|---|---|
| **Overall (original 38)** | 0.817 → 0.839 (+0.022) | 1.000 → 1.000 (±0) | 0.816 → 0.831 (+0.015) | 38 |
| exact_match | 0.900 → 0.975 (+0.075) | 1.000 → 1.000 (±0) | 0.934 → 0.959 (+0.025) | 8 |
| semantic | 0.856 → 0.864 (+0.008) | 1.000 → 1.000 (±0) | 0.879 → 0.889 (+0.010) | 12 |
| related_concept | 0.988 → 1.000 (+0.012) | 1.000 → 1.000 (±0) | 0.941 → 0.949 (+0.008) | 8 |
| negative | 0.000 → 0.000 (±0) | 1.000 → 1.000 (±0) | 0.000 → 0.000 (±0) | 4 |
| edge_case | 0.944 → 0.950 (+0.006) | 1.000 → 1.000 (±0) | 0.907 → 0.941 (+0.034) | 6 |
| **multi_hop** (new) | 0.301 → 0.395 (+0.094) | 0.625 → 0.887 (+0.262) | 0.468 → 0.628 (+0.160) | 8 |

`multi_hop` queries were written for this comparison: each names an entity whose answers are linked to it in the graph but not worded like the query. Read them as a demonstration of the lane, the original 38 as the regression check.

| multi_hop query | MRR off → on |
|---|---|
| What do we know about Matriarch Valerica's faction? | 0.600 → 0.500 |
| Who leads the group that meets at the Velvet Glove? | 0.250 → 0.333 |
| What else is going on in the city Arch-Mage Varis wrote about? | 0.210 → 0.500 |
| Which figure was executed in the period that the Bastille set off? | 0.500 → 0.500 |
| Other ideas from the same field as Heisenberg | 0.500 → 0.500 |
| Problems we hit while building the Auto-Blogger | 0.000 → 0.333 |
| What did we give up by choosing MongoDB? | 0.350 → 0.333 |
| Which libraries did we pick after the DatePicker trouble? | 0.000 → 0.164 |

**Reading it:** on the original 38 queries the graph lane makes no measurable difference. Repeated identical runs moved overall MRR between −0.004 and +0.022, and the graph-off baseline alone varies 0.817–0.834. On multi-hop queries it finds clearly more of the linked answers: R@5 +0.25 to +0.26 and NDCG@5 +0.15 to +0.16 across runs.

**Tuning (how the default was chosen).** The lane has two parts: memories linked to an entity the **query names** (weight 0.5), and **neighbours** of the top text matches. The neighbour weight was measured on this dataset (deltas vs graph off, 5 runs each):

| Neighbour weight | Original 38 MRR | multi_hop R@5 | multi_hop MRR |
|---|---|---|---|
| 0.5 | −0.116 | +0.258 | +0.088 |
| 0.5, seeds not boosted | −0.200 | +0.287 | +0.340 |
| 0.1 | −0.056 | +0.308 | +0.155 |
| **0 (default)** | **±0 (noise)** | **+0.250** | **+0.098** |

With `RRF_K = 10`, adjacent ranks in one lane differ by under 0.01. Any neighbour vote large enough to matter therefore lifts topic siblings over the true top answer. The default keeps only the named-entity part (`GRAPH_NEIGHBOR_WEIGHT = 0` in `server/core/memory.repository.ts`).

Reproduce with `bun run benchmark:graph` (add `--write` to record a new section here). For a much larger, real-world test, point it at a local Obsidian vault: `bun run benchmark:graph --vault <path>` (see `tests/benchmark/datasets/obsidian.ts`; only aggregate numbers are reported).

## v2.4.0 (2026-03-27)

**Model:** Xenova/all-MiniLM-L6-v2 (384d) | **Dataset:** general (45 memories, 38 queries) | **Queries passed:** ~20/38 | **Averaged over 5 runs**

| Category          | MRR   | P@1   | P@5   | R@5   | NDCG@5 | Queries |
|-------------------|-------|-------|-------|-------|--------|---------|
| **Overall**       | 0.403 | 0.326 | 0.111 | 0.587 | 0.385 |  38 |
| exact_match       | 0.566 | 0.475 | 0.140 | 0.512 | 0.438 |   8 |
| semantic          | 0.426 | 0.350 | 0.110 | 0.533 | 0.435 |  12 |
| related_concept   | 0.304 | 0.200 | 0.095 | 0.475 | 0.342 |   8 |
| negative          | 0.000 | 0.000 | 0.000 | 1.000 | 0.000 |   4 |
| edge_case         | 0.543 | 0.467 | 0.167 | 0.667 | 0.529 |   6 |


