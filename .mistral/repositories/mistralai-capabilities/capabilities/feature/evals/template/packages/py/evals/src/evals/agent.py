"""Agent E2E evaluation config: params, evaluator wiring, and task helpers.

This owns the "what to evaluate and how to score it" for the agent track.
The workflow classes in ``apps/worker/src/worker/workflows/evals.py`` import from here and own only
the Temporal orchestration (``evaluation.run`` + ``orchestrator_agent.run``).
"""

from typing import Any

from mistralai.workflows.plugins.evaluations.types import Evaluator, Goal, RunEvaluator, TaskContext

from evals.params import EvalParams
from evals.scorers import (
    keyword_coverage,
    mean_quality,
    response_present,
    response_quality,
    scorer_coverage_evaluator,
)


class AgentEvalParams(EvalParams):
    """Agent-track run parameters; identical in shape to every other track (see ``EvalParams``)."""


def task_message(params: dict[str, Any]) -> str:
    return str(TaskContext.model_validate(params).input_record["message"])


def task_output(response: str) -> dict[str, Any]:
    return {"response": response}


def response_present_evaluator() -> Evaluator:
    """The "did it answer at all" guard, shared by every agent-answering track.

    A factory rather than a module-level constant so no track can mutate the instance another
    one is about to report against.
    """
    return Evaluator(
        name="response_present",
        description="Agent returned a non-empty answer.",
        scorer=response_present,
        goal=Goal.gte(1.0),
    )


def response_quality_evaluator() -> Evaluator:
    """The LLM-judge quality grade, shared by every agent-answering track.

    Shared, not restated, because the seeded nightly run and the harvested-feedback run must be
    comparable in Studio. Two tracks report the same metric only if they report the same evaluator,
    including name, description, and goal. Re-declaring it would let the two drift the first time
    someone retunes the goal.
    """
    return Evaluator(
        name="response_quality",
        description="LLM-judge rating of answer quality.",
        scorer=response_quality,
        goal=Goal.gte(0.6),
    )


def build_evaluators() -> list[Evaluator]:
    return [
        response_present_evaluator(),
        Evaluator(
            name="keyword_coverage",
            description="Expected routing keywords appear in the answer.",
            scorer=keyword_coverage,
            goal=Goal.gte(0.5),
        ),
        response_quality_evaluator(),
    ]


def build_run_evaluators() -> list[RunEvaluator]:
    return [
        RunEvaluator(
            name="mean_quality",
            description="Mean LLM-judge quality across cases.",
            scorer=mean_quality,
            goal=Goal.gte(0.6),
        ),
        scorer_coverage_evaluator(),
    ]
