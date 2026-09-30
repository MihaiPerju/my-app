"""Submit an eval run to the worker, print its execution id, and optionally follow it to the end.

The ``eval-*`` commands used ``dispatch_workflow``, which starts the run and polls it inside one SDK
call. The execution id never reached the terminal, and the poll had no retry: one dropped
connection while a 20-minute run was still going raised ``ConnectError`` and killed the command,
though the run itself carried on and completed on the worker. Here the start and the wait are two
steps. The id is printed first, so a lost terminal still leaves something to look up, and polling
retries transient failures with backoff. ``--no-wait`` stops after the start.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from mistralai_capabilities.workflows.client import (
    MistralError,
    WorkflowExecutionResponse,
    get_execution,
    start_workflow,
    workflow_name,
)
from pydantic import BaseModel

POLL_INTERVAL_SECONDS = 5.0
MAX_POLL_BACKOFF_SECONDS = 60.0
# Consecutive failed polls before giving up. With the backoff above that is roughly eight minutes
# of an unreachable API, long enough to ride out a restart and short enough to notice an outage.
MAX_CONSECUTIVE_POLL_FAILURES = 12

# Statuses the run can still leave. Everything else except COMPLETED is a terminal failure.
_IN_FLIGHT = frozenset({"RUNNING", "RETRYING_AFTER_ERROR", "CONTINUED_AS_NEW"})

Report = Callable[[str], None]
GetExecution = Callable[[str], Awaitable[WorkflowExecutionResponse]]
Sleep = Callable[[float], Awaitable[None]]


class EvalRunFailedError(RuntimeError):
    """The eval execution reached a terminal status other than COMPLETED."""


class EvalPollAbandonedError(RuntimeError):
    """Polling gave up on repeated transient failures; the execution may still be running."""


def is_transient(error: BaseException) -> bool:
    """A poll failure worth retrying: a dropped connection or timeout, a 429, or a 5xx."""
    if isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, MistralError):
        status = getattr(error, "status_code", None)
        return status == 429 or (isinstance(status, int) and status >= 500)
    return False


async def wait_for_execution(
    execution_id: str,
    *,
    report: Report = print,
    get: GetExecution = get_execution,
    sleep: Sleep = asyncio.sleep,
    poll_interval: float = POLL_INTERVAL_SECONDS,
    max_consecutive_failures: int = MAX_CONSECUTIVE_POLL_FAILURES,
) -> Any:
    """Poll ``execution_id`` until it completes and return its result.

    Transient poll failures back off exponentially and never count against the run; only
    ``max_consecutive_failures`` in a row abandon the wait, and the error says the run may still be
    going. A terminal status other than COMPLETED raises :class:`EvalRunFailedError`.
    """
    failures = 0
    while True:
        try:
            execution = await get(execution_id)
        except Exception as error:
            if not is_transient(error):
                raise
            failures += 1
            if failures >= max_consecutive_failures:
                raise EvalPollAbandonedError(
                    f"Gave up polling execution {execution_id} after {failures} failed attempts "
                    f"({type(error).__name__}: {error}). The run may still be going on the worker; "
                    "look it up by this id in the console."
                ) from error
            delay = min(poll_interval * 2 ** (failures - 1), MAX_POLL_BACKOFF_SECONDS)
            report(
                f"Polling {execution_id} failed ({type(error).__name__}: {error}); the run is unaffected. "
                f"Retrying in {delay:.0f}s."
            )
            await sleep(delay)
            continue
        failures = 0
        status = execution.status
        if status == "COMPLETED":
            return execution.result
        if status is None or status in _IN_FLIGHT:
            await sleep(poll_interval)
            continue
        raise EvalRunFailedError(f"Execution {execution_id} ended with status {status}.")


async def submit_eval(
    workflow_class: type,
    params: BaseModel,
    *,
    wait: bool,
    report: Report = print,
) -> Any:
    """Start ``workflow_class`` on the worker, print its execution id, and wait unless told not to.

    Returns the run's result, or ``None`` with ``wait=False``.
    """
    run = await start_workflow(workflow_class, params, wait_for_result=False)
    report(f"Started {workflow_name(workflow_class)}: execution {run.execution_id}")
    if not wait:
        report("Not waiting (--no-wait). The run continues on the worker; look it up by this id in the console.")
        return None
    return await wait_for_execution(run.execution_id, report=report)


def summarize_eval_result(result: Any) -> list[str]:
    """One line per evaluator (its average and how many records it scored) and per run score.

    The sample count sits beside every average on purpose: an average over 2 of 15 records is not
    the same claim as one over 15, and the bare number does not say which it is.
    """
    # A workflow entrypoint's output reaches the execution API wrapped as `{"result": <output>}`.
    if isinstance(result, dict) and set(result) == {"result"}:
        result = result["result"]
    if not isinstance(result, dict):
        return [f"result: {result!r}"]
    lines: list[str] = []
    if result.get("run_url"):
        lines.append(f"run: {result['run_url']}")
    for name, stats in (result.get("statistics") or {}).items():
        if not isinstance(stats, dict):
            continue
        average = stats.get("avg")
        shown = f"{average:.3f}" if isinstance(average, (int, float)) else "n/a"
        count = stats.get("sample_count", stats.get("count", 0))
        lines.append(f"{name}: avg {shown} over {count} scored record(s)")
    for name, score in (result.get("run_scores") or {}).items():
        if not isinstance(score, dict):
            continue
        value = score.get("value")
        shown = f"{value:.3f}" if isinstance(value, (int, float)) else "n/a"
        detail = score.get("rationale") or score.get("error") or ""
        lines.append(f"{name}: {shown} {detail}".rstrip())
    return lines
