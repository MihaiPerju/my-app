from mistralai_capabilities.search import retrieval_quality as rq
from mistralai_capabilities.search.local_store import reset_local_stores


async def test_synthetic_eval_reports_ir_metrics() -> None:
    reset_local_stores()
    summary = await rq.run_synthetic_retrieval_quality_eval()
    assert summary.total_queries == 1
    metrics = summary.workflow_metrics_avg[rq.VECTOR_STEP]
    flat = rq.flatten_metrics(metrics)
    assert flat["recall@10"] == 1.0
    assert flat["hit_rate"] == 1.0
    assert 0.0 < flat["ndcg@10"] <= 1.0
    assert 0.0 < flat["mrr"] <= 1.0


async def test_score_query_gold_on_page_twelve() -> None:
    reset_local_stores()
    flat = await rq.score_query("net capital requirement", ["page_number_12"])
    assert flat["recall@10"] == 1.0
    assert flat["mrr"] > 0.0


async def test_score_query_wrong_gold_is_zero_recall() -> None:
    reset_local_stores()
    flat = await rq.score_query("net capital requirement", ["page_number_999"])
    assert flat["recall@10"] == 0.0
    assert flat["hit_rate"] == 0.0


def test_source_metrics_perfect_ranking() -> None:
    flat = rq.source_metrics(["gdpr/article-033.md", "gdpr/article-034.md"], ["gdpr/article-033.md"])
    assert flat == {"recall@10": 1.0, "ndcg@10": 1.0, "mrr": 1.0, "hit_rate": 1.0}


def test_source_metrics_ranks_a_late_hit_below_one() -> None:
    flat = rq.source_metrics(["a.md", "b.md", "gold.md"], ["gold.md"])
    assert flat["recall@10"] == 1.0
    assert flat["mrr"] == 1 / 3
    assert flat["ndcg@10"] == 0.5  # 1/log2(4) over an ideal of 1/log2(2)


def test_source_metrics_partial_recall_and_cutoff() -> None:
    ranked = [f"s{i}.md" for i in range(12)]
    flat = rq.source_metrics(ranked, ["s0.md", "s11.md"], k=10)
    assert flat["recall@10"] == 0.5  # s11 sits past the cutoff
    assert flat["hit_rate"] == 1.0


def test_source_metrics_miss_is_zero() -> None:
    flat = rq.source_metrics(["a.md"], ["gold.md"])
    assert flat == {"recall@10": 0.0, "ndcg@10": 0.0, "mrr": 0.0, "hit_rate": 0.0}


def test_source_metrics_matches_exactly_unless_globbed() -> None:
    # A bare fragment must not pass by substring; a glob is the explicit opt-in.
    assert rq.source_metrics(["gdpr/article-033-breach.md"], ["article-033"])["recall@10"] == 0.0
    assert rq.source_metrics(["gdpr/article-033-breach.md"], ["gdpr/article-033*"])["recall@10"] == 1.0


def test_source_metrics_credits_each_gold_entry_once() -> None:
    # Two sources matching one glob are one relevant item, so nDCG stays within [0, 1].
    flat = rq.source_metrics(["gdpr/a-1.md", "gdpr/a-2.md"], ["gdpr/a-*"])
    assert flat["ndcg@10"] == 1.0
    assert flat["recall@10"] == 1.0


def test_source_metrics_matches_overlapping_gold_entries_without_order_bias() -> None:
    # `docs/a.md` fits both entries. Crediting it to the glob (first in gold order) would leave
    # `docs/b.md` with no entry to satisfy; the assignment must credit both, in either gold order.
    for gold in (["docs/*", "docs/a.md"], ["docs/a.md", "docs/*"]):
        flat = rq.source_metrics(["docs/a.md", "docs/b.md"], gold)
        assert flat == {"recall@10": 1.0, "ndcg@10": 1.0, "mrr": 1.0, "hit_rate": 1.0}, gold


def test_source_metrics_prefers_the_assignment_that_credits_earlier_ranks() -> None:
    # Rank 0 and rank 2 can only use the glob; rank 1 can use either entry. The best assignment
    # credits ranks 0 and 1 (glob -> rank 0, exact -> rank 1), not ranks 1 and 2.
    flat = rq.source_metrics(["docs/x.md", "docs/a.md", "docs/y.md"], ["docs/a.md", "docs/*"])
    assert flat["recall@10"] == 1.0
    assert flat["ndcg@10"] == 1.0
    assert flat["mrr"] == 1.0


def test_flatten_metrics_emits_only_populated_fields() -> None:
    from mistralai.search.toolkit.evals import RetrievalMetrics

    flat = rq.flatten_metrics(RetrievalMetrics(recall_at_k={5: 0.5}, mrr=0.25))
    assert flat == {"recall@5": 0.5, "mrr": 0.25}


async def test_eval_harness_grades_the_ranking_search_search_serves() -> None:
    """The harness must grade what search_search serves, or evals stop tracking the product.

    Both send the query TEXT through `search`, because that is what turns lexical fusion on: the
    postgres plugin fuses whenever `query.query` is non-empty. So `hybrid=False` has to arrive as
    an empty string, not as a different method call.
    """
    from mistralai_capabilities.search.schemas import FilteredVectorSearchQuery

    class _Store:
        def __init__(self) -> None:
            self.queries: list[str | None] = []

        async def search(self, query: FilteredVectorSearchQuery) -> list:
            self.queries.append(query.query)
            return []

    fused = _Store()
    await rq.make_store_workflow(fused, lambda _text: [0.0, 1.0])("net capital requirement")
    assert fused.queries == ["net capital requirement"]

    opted_out = _Store()
    await rq.make_store_workflow(opted_out, lambda _text: [0.0, 1.0], hybrid=False)("net capital requirement")
    assert opted_out.queries == [""]
