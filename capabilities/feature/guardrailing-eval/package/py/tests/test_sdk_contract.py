"""Contract tests against the real ``mistralai.evaluations`` SDK.

Proves the task and evaluators use the SDK's context dispatch and return the
shapes execution expects (a ``Score`` from scorers, a ``ClassificationOutput``
from the task). Requires ``mistralai-evaluations`` installed.
"""

from __future__ import annotations

import asyncio

from mistralai.evaluations.execution import _uses_context_style
from mistralai.evaluations.models import (
    EvaluationRunRecord,
    Generation,
    RunEvaluatorContext,
    RunEvaluatorRecord,
    Score,
    ScorerContext,
    TaskContext,
)

from mistralai_capabilities.guardrailing_eval import adapters, metrics
from mistralai_capabilities.guardrailing_eval.runner import make_task


class _FakeScanner:
    def __init__(self, label: str) -> None:
        self._label = label

    async def classify(self, text: str) -> dict:
        return {"classification": self._label}


def test_task_is_context_style_and_reads_the_field() -> None:
    task = make_task(_FakeScanner("safe"), field="answer")
    assert _uses_context_style(task, TaskContext)
    ctx = TaskContext(input_record={"answer": "hello"}, metadata={})
    out = asyncio.run(task(ctx))
    assert out == {"classification": "safe"}


def test_task_fails_closed_on_scanner_error() -> None:
    class _Boom:
        async def classify(self, text: str) -> dict:
            raise RuntimeError("scanner down")

    task = make_task(_Boom(), field="text")
    out = asyncio.run(task(TaskContext(input_record={"text": "x"}, metadata={})))
    assert out["parse_failed"] is True


def test_per_row_evaluators_are_context_style_and_return_scores() -> None:
    ev = metrics.classification_correct_evaluator()
    assert _uses_context_style(ev.scorer, ScorerContext)
    hit = ev.scorer(ScorerContext(input_record={"ground_truth": {"expected": "safe"}}, output={"classification": "safe"}, metadata={}))
    miss = ev.scorer(ScorerContext(input_record={"ground_truth": {"expected": "unsafe"}}, output={"classification": "safe"}, metadata={}))
    assert isinstance(hit, Score) and hit.value == 1
    assert isinstance(miss, Score) and miss.value == 0

    fp = metrics.fp_on_safe_evaluator().scorer
    over = fp(ScorerContext(input_record={"ground_truth": {"expected": "safe"}}, output={"classification": "unsafe"}, metadata={}))
    assert isinstance(over, Score) and over.value == 1

    pf = metrics.parse_failure_evaluator().scorer
    bad = pf(ScorerContext(input_record={"ground_truth": {"expected": "safe"}}, output={}, metadata={}))
    assert isinstance(bad, Score) and bad.value == 1


def test_failure_evaluators_are_minimized() -> None:
    assert metrics.fp_on_safe_evaluator().direction == "minimize"
    assert metrics.parse_failure_evaluator().direction == "minimize"
    assert metrics.over_blocking_failures_run_evaluator().direction == "minimize"


def test_group_evaluator_rejects_missing_or_non_string_groups() -> None:
    import pytest

    scorer = metrics.per_group_accuracy_run_evaluator("language").scorer
    for metadata in ({}, {"language": 1}):
        ctx = _run_ctx(
            [
                (
                    {"ground_truth": {"expected": "safe"}, "metadata": metadata},
                    [{"classification": "safe"}],
                )
            ]
        )
        with pytest.raises(ValueError):
            scorer(ctx)


def _run_ctx(rows: list[tuple[dict, list[dict]]]) -> RunEvaluatorContext:
    records = []
    for input_fields, outputs in rows:
        gens = [Generation(output=o, status="success") for o in outputs]
        run_record = EvaluationRunRecord(input_record=input_fields, generations=gens)
        records.append(RunEvaluatorRecord(input=input_fields, output=run_record))
    return RunEvaluatorContext(records=records, statistics={}, metadata={})


def test_run_evaluators_return_scores() -> None:
    ctx = _run_ctx(
        [
            ({"ground_truth": {"expected": "safe"}}, [{"classification": "safe"}]),
            ({"ground_truth": {"expected": "unsafe"}}, [{"classification": "unsafe"}]),
            ({"ground_truth": {"expected": "safe"}}, [{"classification": "unsafe"}]),  # over-block
        ]
    )
    macro = metrics.macro_f1_run_evaluator().scorer(ctx)
    assert isinstance(macro, Score) and isinstance(macro.value, float)

    over = metrics.over_blocking_failures_run_evaluator().scorer(ctx)
    assert isinstance(over, Score) and over.value == 1
    assert len(over.metadata["failures"]) == 1


def test_guardrailing_adapter_enum_map_is_exhaustive_and_fail_closed() -> None:
    import pytest

    # Assert exhaustiveness against the upstream enum itself: a new
    # GuardrailClassification member must break this test rather than silently
    # become a runtime parse failure. Skip only when guardrailing's runtime
    # (an intentionally non-declared dependency) is absent from the test env.
    guardrail = pytest.importorskip("mistralai_capabilities.guardrails.guardrail")
    assert {member.value for member in guardrail.GuardrailClassification} == set(adapters._ENUM_VALUE_TO_LABEL)
    assert adapters._ENUM_VALUE_TO_LABEL["out_of_scope"] == "oos_question"
