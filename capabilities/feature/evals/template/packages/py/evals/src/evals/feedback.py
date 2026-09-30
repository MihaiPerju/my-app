"""Evaluator wiring for a replay of harvested feedback cases.

The harvest itself is the ``feedback`` feature in ``mistralai_capabilities.feedback``. This
module holds only how a replay of that dataset is scored. Beyond the shared judge parser
(``evals.judge``), the two packages stay decoupled; their only data coupling is three record
fields: ``message``, ``rating``, and ``prior_answer``.
"""

from mistralai.workflows.plugins.evaluations import evaluation
from mistralai.workflows.plugins.evaluations.types import Evaluator, Goal, Score, ScorerContext

from evals.agent import response_present_evaluator, response_quality_evaluator

NEGATIVE = "negative"


@evaluation.scorer
async def improved_on_feedback(ctx: ScorerContext) -> Score:
    """Whether the agent stopped reproducing an answer a user rejected.

    A cheap, deterministic companion to ``evals.scorers.response_quality``. On a thumbs-down case
    it checks whether the agent still emits the same text; it is not a quality measure. A
    thumbs-up case passes if the agent still answers, so it guards the cases users liked.
    """
    output = ctx.output if isinstance(ctx.output, dict) else {}
    answer = str(output.get("response") or "").strip()
    if not answer:
        return Score(value=0.0, rationale="empty answer on a case a user had rated")
    if str(ctx.input_record.get("rating")) == NEGATIVE:
        prior = str(ctx.input_record.get("prior_answer") or "")
        changed = answer != prior
        return Score(
            value=1.0 if changed else 0.0,
            rationale="answer differs from the one the user rejected" if changed else "reproduced the rejected answer",
        )
    return Score(value=1.0, rationale="previously-liked case still answered")


def build_feedback_evaluators() -> list[Evaluator]:
    """Evaluators for a replay of harvested feedback cases.

    ``response_present`` and ``response_quality`` are the agent track's own evaluator objects, not
    copies, so a feedback run and the nightly run stay comparable in Studio.
    ``improved_on_feedback`` is the one this dataset adds.
    """
    return [
        response_present_evaluator(),
        response_quality_evaluator(),
        Evaluator(
            name="improved_on_feedback",
            description="Rejected answers changed; accepted ones still answer.",
            scorer=improved_on_feedback,
            goal=Goal.gte(0.5),
        ),
    ]
