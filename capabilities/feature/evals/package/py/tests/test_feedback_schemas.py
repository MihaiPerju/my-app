"""The feedback feature pure half: reconstructing exchanges and shaping dataset records.

Everything here runs without a network, which is why ``schemas`` stays free of clients. The parts
most likely to be wrong (tolerating whatever shape a span attribute arrived in, and refusing to
build a case out of half an exchange) would otherwise only be exercised against live Studio data.
"""

import json
from typing import Any

from mistralai_capabilities.feedback.schemas import (
    NEGATIVE,
    POSITIVE,
    FeedbackCase,
    build_cases,
    exchange_from_span,
    index_spans_by_id,
    relevance_prompt,
)


def _span(span_id: str, *, request: str = "hello?", answer: str = "hi!", encode: bool = True) -> dict[str, Any]:
    messages_in = [{"role": "user", "parts": [{"type": "text", "content": request}]}]
    messages_out = [{"role": "assistant", "parts": [{"type": "text", "content": answer}]}]
    return {
        "span_id": span_id,
        "span_attributes": {
            "gen_ai.input.messages": json.dumps(messages_in) if encode else messages_in,
            "gen_ai.output.messages": json.dumps(messages_out) if encode else messages_out,
        },
    }


def _row(span_id: str, *, score: float = 0.0, label: str = NEGATIVE) -> dict[str, Any]:
    return {
        "span_id": span_id,
        "trace_id": "a" * 32,
        "conversation_id": "conv-1",
        "timestamp": "2026-08-01T10:00:00Z",
        "evaluation_name": "user_feedback",
        "score_value": score,
        "score_label": label,
    }


def test_exchange_is_recovered_from_json_encoded_attributes() -> None:
    assert exchange_from_span(_span("s1")) == ("hello?", "hi!")


def test_exchange_is_recovered_when_the_ingester_already_decoded_the_attribute() -> None:
    assert exchange_from_span(_span("s1", encode=False)) == ("hello?", "hi!")


def test_exchange_falls_back_to_plain_string_content() -> None:
    span = {
        "span_attributes": {
            "gen_ai.input.messages": json.dumps([{"role": "user", "content": "direct"}]),
            "gen_ai.output.messages": json.dumps([{"role": "assistant", "content": "reply"}]),
        }
    }
    assert exchange_from_span(span) == ("direct", "reply")


def test_exchange_takes_the_last_turn_of_a_multi_turn_span() -> None:
    span = {
        "span_attributes": {
            "gen_ai.input.messages": json.dumps(
                [{"role": "user", "content": "first"}, {"role": "user", "content": "second"}]
            ),
            "gen_ai.output.messages": json.dumps(
                [{"role": "assistant", "content": "early"}, {"role": "assistant", "content": "final"}]
            ),
        }
    }
    assert exchange_from_span(span) == ("second", "final")


def test_a_rating_whose_span_is_missing_is_dropped() -> None:
    assert build_cases(evaluations=[_row("absent")], spans_by_id={}) == []


def test_a_rating_whose_span_has_no_exchange_is_dropped() -> None:
    empty: dict[str, Any] = {"span_id": "s1", "span_attributes": {}}
    assert build_cases(evaluations=[_row("s1")], spans_by_id=index_spans_by_id([empty])) == []


def test_a_rating_joined_to_its_exchange_becomes_a_case() -> None:
    cases = build_cases(evaluations=[_row("s1")], spans_by_id=index_spans_by_id([_span("s1")]))
    assert len(cases) == 1
    case = cases[0]
    assert (case.message, case.prior_answer, case.rating) == ("hello?", "hi!", NEGATIVE)
    assert case.conversation_id == "conv-1"


def test_rating_label_is_derived_from_the_score_when_absent() -> None:
    row = _row("s1", score=1.0)
    del row["score_label"]
    cases = build_cases(evaluations=[row], spans_by_id=index_spans_by_id([_span("s1")]))
    assert cases[0].rating == POSITIVE


def test_dataset_payload_carries_the_key_the_agent_eval_task_reads() -> None:
    # `evals.agent.task_message` reads input_record["message"]; a payload without it would
    # replay as an empty prompt rather than failing, so this is asserted rather than assumed.
    case = FeedbackCase(message="q", prior_answer="a", rating=NEGATIVE, rating_score=0.0, trace_id="t", span_id="s")
    payload = case.dataset_payload()
    assert payload["message"] == "q"
    assert payload["rating"] == NEGATIVE
    assert "expected" in payload


def test_dataset_properties_keep_provenance_out_of_the_evaluated_input() -> None:
    case = FeedbackCase(
        message="q", prior_answer="a", rating=POSITIVE, rating_score=1.0, trace_id="t", span_id="s", relevance=0.8
    )
    assert set(case.dataset_payload()) & set(case.dataset_properties()) == set()
    assert case.dataset_properties()["judge_relevance"] == 0.8


def test_span_id_travels_in_properties_because_the_append_diff_keys_on_it() -> None:
    # `feedback_write_dataset` reads this back to decide what is already filed. Without it the
    # append is no longer idempotent and a resumed harvest would double every record.
    case = FeedbackCase(message="q", prior_answer="a", rating=NEGATIVE, rating_score=0.0, trace_id="t", span_id="s1")
    assert case.dataset_properties()["span_id"] == "s1"


def test_the_judge_is_told_which_way_the_user_voted() -> None:
    negative = FeedbackCase(message="q", prior_answer="a", rating=NEGATIVE, rating_score=0.0, trace_id="t", span_id="s")
    positive = negative.model_copy(update={"rating": POSITIVE})
    assert "thumbs down" in relevance_prompt(negative)[-1]["content"]
    assert "thumbs up" in relevance_prompt(positive)[-1]["content"]
