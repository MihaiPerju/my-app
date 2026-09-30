"""Example: score a moderation policy with guardrailing-eval. Copy and adapt.

Lives under ``tools/`` (not ``packages/py/*``) on purpose: it is a runnable
script, not a workspace member, so uv does not require a ``pyproject.toml`` for it.

Two runs off one core: pre-generation judges the user message, post-generation
judges the answer — same metrics, different ``field`` and (for the binary post
policy) ``classes``. Replace ``ExampleScanner`` with your real scanner (behind an
adapter over the ``guardrailing`` capability that maps ``out_of_scope ->
oos_question``), and ``load_dataset`` with your labeled set (ground truth at
``row["ground_truth"]["expected"]``).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from mistralai.evaluations import Mistral
from mistralai.evaluations.models import Evaluation, Project, System
from mistralai_capabilities.guardrailing_eval import ClassificationOutput, make_task
from mistralai_capabilities.guardrailing_eval.metrics import (
    default_evaluators,
    default_run_evaluators,
    macro_f1_run_evaluator,
    per_group_accuracy_run_evaluator,
)


class ExampleScanner:
    async def classify(self, text: str) -> ClassificationOutput:  # replace with your scanner
        raise NotImplementedError("wire a real ModerationScanner (an adapter over the guardrailing API)")


def load_dataset() -> list[dict[str, Any]]:  # replace with your labeled dataset loader
    return []


async def run(*, phase: str, field: str, classes: tuple[str, ...], local: bool = True) -> None:
    client = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
    run_evaluators = [
        macro_f1_run_evaluator(classes),
        *[e for e in default_run_evaluators() if e.name != "macro_f1"],
        per_group_accuracy_run_evaluator("slice"),
        per_group_accuracy_run_evaluator("language"),
    ]
    run_kwargs: dict[str, Any] = {
        "task": make_task(ExampleScanner(), field=field),
        "evaluators": default_evaluators(),
        "run_evaluators": run_evaluators,
        "dataset": load_dataset(),
        "num_generations": 1,
        "system": System(name="guardrailing-eval", params={"phase": phase}),
        "name": f"{phase}-moderation",
        "local": local,
    }
    if not local:
        run_kwargs |= {"project": Project(name="Moderation"), "evaluation": Evaluation(name=f"{phase}-moderation")}
    result = await client.evaluation.run(**run_kwargs)
    result.show(level="run")


if __name__ == "__main__":
    # pre-generation: judge the user message, 3-way; post-generation: judge the answer, binary.
    asyncio.run(run(phase="pre", field="message", classes=("safe", "oos_question", "unsafe")))
    asyncio.run(run(phase="post", field="answer", classes=("safe", "unsafe")))
