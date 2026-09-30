import json
from pathlib import Path

import pytest
from evals.search.corpus import (
    EmptyGoldSetError,
    SearchCorpusEvalParams,
    corpus_search_request,
    load_gold_set,
    validate_gold_set,
)
from pydantic import ValidationError


def test_gold_set_round_trips_and_keeps_extra_keys(tmp_path: Path) -> None:
    path = tmp_path / "gold.json"
    path.write_text(json.dumps([{"query": "q", "relevant_sources": ["a.md"], "notes": "why"}]))
    assert load_gold_set(path) == [{"query": "q", "relevant_sources": ["a.md"], "notes": "why"}]


def test_empty_gold_set_is_refused() -> None:
    with pytest.raises(EmptyGoldSetError):
        validate_gold_set([])


@pytest.mark.parametrize(
    "record",
    [
        {"query": "", "relevant_sources": ["a.md"]},
        {"query": "q", "relevant_sources": []},
        {"query": "q"},
        # The synthetic track's shape is not a corpus gold case; mixing them up must fail loudly.
        {"query": "q", "relevant_reference_ids": ["page_number_12"]},
    ],
)
def test_malformed_gold_case_is_refused(record: dict) -> None:
    with pytest.raises(ValidationError):
        validate_gold_set([record])


def test_system_records_the_retrieval_settings() -> None:
    system = SearchCorpusEvalParams(top_k=20, hybrid=False, rerank=True, system_name="dense").system()
    assert system.name == "dense"
    assert system.params == {"judge_model": "mistral-small-latest", "top_k": 20, "hybrid": False, "rerank": True}


def test_corpus_search_request_reads_settings_from_the_system() -> None:
    case, request = corpus_search_request(
        {
            "input_record": {"query": "q", "relevant_sources": ["a.md"]},
            "system": {"name": "s", "params": {"top_k": 3, "hybrid": False, "rerank": False}},
        }
    )
    assert case.relevant_sources == ["a.md"]
    assert (request.query, request.top_k, request.hybrid, request.rerank) == ("q", 3, False, False)
