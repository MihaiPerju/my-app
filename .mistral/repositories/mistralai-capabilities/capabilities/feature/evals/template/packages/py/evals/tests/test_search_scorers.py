from types import SimpleNamespace

import pytest
from evals import scorers
from evals.dataset import SEARCH_RETRIEVAL_DATASET


def _ctx(output: object) -> SimpleNamespace:
    return SimpleNamespace(output=output, input_record={}, system=None, metadata={})


async def test_search_recall_reports_metric() -> None:
    score = await scorers.search_recall_at_10.__original_eval_fn__(_ctx({"metrics": {"recall@10": 1.0}}))
    assert score.value == pytest.approx(1.0)


async def test_search_ndcg_reports_metric() -> None:
    score = await scorers.search_ndcg_at_10.__original_eval_fn__(_ctx({"metrics": {"ndcg@10": 0.63}}))
    assert score.value == pytest.approx(0.63)


async def test_search_mrr_reports_metric() -> None:
    score = await scorers.search_mrr.__original_eval_fn__(_ctx({"metrics": {"mrr": 0.5}}))
    assert score.value == pytest.approx(0.5)


async def test_search_scorer_missing_metric_is_zero() -> None:
    score = await scorers.search_recall_at_10.__original_eval_fn__(_ctx({"metrics": {}}))
    assert score.value == 0.0


async def test_search_scorer_clamps_out_of_range() -> None:
    score = await scorers.search_recall_at_10.__original_eval_fn__(_ctx({"metrics": {"recall@10": 1.4}}))
    assert score.value == 1.0


async def test_search_mean_recall_aggregates() -> None:
    ctx = SimpleNamespace(statistics={"search_recall_at_10": SimpleNamespace(avg=0.8, count=3)})
    score = await scorers.search_mean_recall_at_10.__original_eval_fn__(ctx)
    assert score.value == pytest.approx(0.8)


async def test_search_mean_recall_missing_stats() -> None:
    score = await scorers.search_mean_recall_at_10.__original_eval_fn__(SimpleNamespace(statistics={}))
    assert score.value == 0.0


def test_search_dataset_shape() -> None:
    assert len(SEARCH_RETRIEVAL_DATASET) >= 1
    for record in SEARCH_RETRIEVAL_DATASET:
        assert record["query"]
        assert record["relevant_reference_ids"]
