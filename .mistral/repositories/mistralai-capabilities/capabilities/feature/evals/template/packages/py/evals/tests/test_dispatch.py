from types import SimpleNamespace

import httpx
import pytest
from evals import dispatch
from evals.dispatch import EvalPollAbandonedError, EvalRunFailedError, summarize_eval_result, wait_for_execution


def _execution(status: str | None, result: object = None) -> SimpleNamespace:
    return SimpleNamespace(status=status, result=result)


class _Poller:
    """Answers each poll from a script: an exception is raised, anything else is returned."""

    def __init__(self, script: list[object]) -> None:
        self.script = list(script)
        self.calls = 0

    async def __call__(self, execution_id: str) -> SimpleNamespace:
        self.calls += 1
        step = self.script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step  # type: ignore[return-value]


async def _no_sleep(_: float) -> None:
    return None


async def test_a_dropped_connection_mid_run_does_not_kill_the_wait() -> None:
    # The reported failure: `ConnectError` while the run was still going, which it survived.
    poller = _Poller(
        [
            _execution("RUNNING"),
            httpx.ConnectError("All connection attempts failed"),
            httpx.ReadTimeout("timed out"),
            _execution("RUNNING"),
            _execution("COMPLETED", {"statistics": {}}),
        ]
    )
    messages: list[str] = []
    result = await wait_for_execution("exec-1", get=poller, sleep=_no_sleep, report=messages.append)
    assert result == {"statistics": {}}
    assert poller.calls == 5
    assert all("exec-1" in message for message in messages)
    assert len(messages) == 2


async def test_polling_gives_up_after_consecutive_failures_and_names_the_execution() -> None:
    poller = _Poller([httpx.ConnectError("down")] * 3)
    with pytest.raises(EvalPollAbandonedError, match="exec-2"):
        await wait_for_execution(
            "exec-2", get=poller, sleep=_no_sleep, report=lambda _: None, max_consecutive_failures=3
        )


async def test_a_non_transient_error_is_not_retried() -> None:
    poller = _Poller([ValueError("bad request shape")])
    with pytest.raises(ValueError):
        await wait_for_execution("exec-3", get=poller, sleep=_no_sleep, report=lambda _: None)
    assert poller.calls == 1


async def test_a_failed_run_raises() -> None:
    poller = _Poller([_execution("FAILED")])
    with pytest.raises(EvalRunFailedError, match="FAILED"):
        await wait_for_execution("exec-4", get=poller, sleep=_no_sleep, report=lambda _: None)


async def test_no_wait_prints_the_id_and_does_not_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_start(workflow_class: type, params: object, *, wait_for_result: bool) -> SimpleNamespace:
        assert wait_for_result is False
        return SimpleNamespace(execution_id="exec-5")

    async def must_not_poll(execution_id: str) -> None:
        raise AssertionError("polled with --no-wait")

    monkeypatch.setattr(dispatch, "start_workflow", fake_start)
    monkeypatch.setattr(dispatch, "get_execution", must_not_poll)
    monkeypatch.setattr(dispatch, "workflow_name", lambda _cls: "search_corpus_evaluation")
    messages: list[str] = []
    assert await dispatch.submit_eval(object, SimpleNamespace(), wait=False, report=messages.append) is None
    assert "exec-5" in messages[0]


@pytest.mark.parametrize("wrapped", [False, True])
def test_summary_puts_the_sample_count_beside_every_average(wrapped: bool) -> None:
    output = {
        "run_url": None,
        "statistics": {"search_llm_relevance": {"avg": 1.0, "sample_count": 2}},
        "run_scores": {"scorer_coverage": {"value": 2 / 15, "rationale": "search_llm_relevance scored 2/15"}},
    }
    # The execution API returns an entrypoint's output as `{"result": <output>}`.
    lines = summarize_eval_result({"result": output} if wrapped else output)
    assert lines == [
        "search_llm_relevance: avg 1.000 over 2 scored record(s)",
        "scorer_coverage: 0.133 search_llm_relevance scored 2/15",
    ]
