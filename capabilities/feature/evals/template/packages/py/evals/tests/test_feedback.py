"""The one scorer the harvested-feedback track adds, and the evaluators it runs beside.

``improved_on_feedback`` is deliberately not a quality measure, which makes it easy to
misread as one and "fix" — so what it does and does not reward is asserted here.
"""

from types import SimpleNamespace

from evals import agent as agent_evals
from evals.feedback import build_feedback_evaluators, improved_on_feedback


def _ctx(output: object, input_record: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(output=output, input_record=input_record or {}, system=None, metadata={})


async def test_reproducing_a_rejected_answer_scores_zero() -> None:
    ctx = _ctx({"response": "the same bad answer"}, {"rating": "negative", "prior_answer": "the same bad answer"})
    score = await improved_on_feedback.__original_eval_fn__(ctx)
    assert score.value == 0.0
    assert "reproduced" in score.rationale


async def test_any_different_answer_on_a_rejected_case_scores_one() -> None:
    # Deliberately not a quality measure: a *different* bad answer passes. It is a change
    # detector, read beside response_quality, never instead of it.
    ctx = _ctx({"response": "a different bad answer"}, {"rating": "negative", "prior_answer": "the old one"})
    score = await improved_on_feedback.__original_eval_fn__(ctx)
    assert score.value == 1.0


async def test_a_previously_liked_case_passes_as_long_as_it_still_answers() -> None:
    ctx = _ctx({"response": "anything"}, {"rating": "positive", "prior_answer": "anything"})
    assert (await improved_on_feedback.__original_eval_fn__(ctx)).value == 1.0


async def test_an_empty_answer_scores_zero_whichever_way_the_user_voted() -> None:
    for rating in ("negative", "positive"):
        ctx = _ctx({"response": "   "}, {"rating": rating, "prior_answer": "x"})
        assert (await improved_on_feedback.__original_eval_fn__(ctx)).value == 0.0


def test_the_shared_evaluators_are_the_agent_track_s_own_not_copies() -> None:
    # The comparability claim: a feedback run and the seeded nightly run must report the same
    # metric under the same name with the same goal. Re-declaring them here would let the two
    # drift silently the first time someone retunes a goal.
    feedback = {e.name: e for e in build_feedback_evaluators()}
    nightly = {e.name: e for e in agent_evals.build_evaluators()}

    for name in ("response_present", "response_quality"):
        assert feedback[name].scorer is nightly[name].scorer
        assert feedback[name].goal == nightly[name].goal
        assert feedback[name].description == nightly[name].description


def test_the_feedback_track_adds_exactly_one_evaluator_of_its_own() -> None:
    names = {e.name for e in build_feedback_evaluators()}
    assert names == {"response_present", "response_quality", "improved_on_feedback"}
    assert all(e.goal is not None for e in build_feedback_evaluators())
