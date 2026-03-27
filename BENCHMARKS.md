# Benchmarks

Search quality metrics tracked across releases. Higher is better for all metrics.

- **MRR** (Mean Reciprocal Rank): How high the first relevant result ranks (1.0 = always first)
- **P@1** (Precision@1): Fraction of queries where the top result is relevant
- **P@5** (Precision@5): Fraction of top-5 results that are relevant
- **R@5** (Recall@5): Fraction of all relevant items found in top-5
- **NDCG@5**: Ranking quality accounting for position and graded relevance

Results are averaged over multiple runs to smooth out scoring jitter.

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


