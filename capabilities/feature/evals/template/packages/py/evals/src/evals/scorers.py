"""Scorers for the agent and search evaluations.

Per-record scorers grade one task output; the run-level scorers aggregate. ``response_present`` and
``keyword_coverage`` are deterministic (no model call); ``response_quality`` and
``search_llm_relevance`` are LLM judges, retried with backoff (``evals.judge``). ``scorer_coverage``
reports, on every track, how many records each scorer actually scored.
"""

import re
from dataclasses import dataclass

from mistralai.workflows.plugins.evaluations import evaluation
from mistralai.workflows.plugins.evaluations.types import Goal, RunEvaluator, RunEvaluatorContext, Score, ScorerContext
from pydantic import JsonValue

from evals.judge import JUDGE_SCORER_MAX_CONCURRENCY, JUDGE_SCORER_TIMEOUT, judge_retry_config, parse_rating

__all__ = [
    "ScorerCoverage",
    "keyword_coverage",
    "matches_format",
    "mean_quality",
    "parse_rating",
    "response_present",
    "response_quality",
    "scorer_coverage",
    "scorer_coverage_evaluator",
    "scorer_coverage_report",
    "search_llm_relevance",
    "search_mean_recall_at_10",
    "search_mrr",
    "search_ndcg_at_10",
    "search_recall_at_10",
]

_JUDGE_SYSTEM = (
    "You grade an AI assistant's answer to a user request. Given the request, the answer, and "
    "guidance on what a good answer contains, reply with a single integer from 0 to 10 rating how "
    "well the answer satisfies the request. Reply with only the number."
)


def _answer_text(output: object) -> str:
    if isinstance(output, dict):
        return str(output.get("response", ""))
    return str(output or "")


def _keyword_present(keyword: str, answer: str) -> bool:
    r"""True if ``keyword`` occurs as a whole word in ``answer`` (case-insensitive).

    Substring matching scores ``red`` against ``reduction``. A ``\b`` anchors only next to a word
    character (``\w``, which counts ``_``), so a boundary is added per edge only for a word edge:
    ``red`` -> ``\bred\b`` (whole word), ``c++`` -> ``\bc\+\+`` (leading only),
    ``$100`` -> ``\$100\b`` (trailing only).
    """
    keyword = keyword.strip().lower()
    if not keyword:
        return False
    left = r"\b" if re.match(r"\w", keyword[0]) else ""
    right = r"\b" if re.match(r"\w", keyword[-1]) else ""
    return re.search(rf"{left}{re.escape(keyword)}{right}", answer.lower()) is not None


@evaluation.scorer
async def response_present(ctx: ScorerContext) -> Score:
    answer = _answer_text(ctx.output).strip()
    return Score(value=1.0 if answer else 0.0, rationale="non-empty answer" if answer else "empty answer")


@evaluation.scorer
async def keyword_coverage(ctx: ScorerContext) -> Score:
    expected = ctx.input_record.get("expected_keywords") or []
    if not expected:
        return Score(value=1.0, rationale="no expected keywords")
    answer = _answer_text(ctx.output)
    hits = [term for term in expected if _keyword_present(str(term), answer)]
    return Score(value=len(hits) / len(expected), rationale=f"{len(hits)}/{len(expected)} keywords present")


@evaluation.scorer
async def matches_format(ctx: ScorerContext) -> Score:
    """1.0 if the answer matches the record's ``expected_format`` regex (``re.search``), else 0.0.

    A structural conformance check for records that pin a shape rather than content: a JSON-ish
    envelope, a required prefix, a citation marker, a phone or date format. Records without an
    ``expected_format`` abstain with 1.0, the same way ``keyword_coverage`` does.
    """
    pattern = ctx.input_record.get("expected_format")
    if not pattern:
        return Score(value=1.0, rationale="no expected format")
    ok = re.search(str(pattern), _answer_text(ctx.output)) is not None
    return Score(
        value=1.0 if ok else 0.0,
        rationale=f"matches /{pattern}/" if ok else f"does not match /{pattern}/",
    )


@evaluation.scorer(execution_timeout=JUDGE_SCORER_TIMEOUT, max_concurrency=JUDGE_SCORER_MAX_CONCURRENCY)
async def response_quality(ctx: ScorerContext) -> Score:
    from env.mistral import env as mistral_env
    from mistralai.client import Mistral

    model = str((ctx.system.params.get("judge_model") if ctx.system else None) or "mistral-small-latest")
    guidance = ctx.input_record.get("expected") or ctx.input_record.get("rubric") or "(no specific guidance)"
    prompt = (
        f"Request:\n{ctx.input_record.get('message', '')}\n\n"
        f"Answer:\n{_answer_text(ctx.output)}\n\n"
        f"Guidance:\n{guidance}"
    )
    client = Mistral(
        api_key=mistral_env.mistral_api_key or "",
        server_url=mistral_env.mistral_base_url,
        retry_config=judge_retry_config(),
    )
    response = await client.chat.complete_async(
        model=model,
        messages=[{"role": "system", "content": _JUDGE_SYSTEM}, {"role": "user", "content": prompt}],
    )
    rating = parse_rating(str(response.choices[0].message.content))
    return Score(value=rating, rationale=f"LLM judge ({model}) rated {rating:.2f}")


def _mean_stat(ctx: RunEvaluatorContext, *, key: str, noun: str, unit: str) -> Score:
    """The mean of a per-case scorer's ``avg`` statistic, over the ``count`` cases it saw.

    Both run-scorers report the same shape: read one statistic by key, answer 0.0 when the run
    produced no numeric values, otherwise the average. ``noun`` and ``unit`` only word the rationale.
    """
    stats = ctx.statistics.get(key)
    avg = getattr(stats, "avg", None)
    if avg is None:
        return Score(value=0.0, rationale=f"no numeric {key} statistics")
    count = getattr(stats, "count", 0)
    return Score(value=float(avg), rationale=f"mean {noun} across {count} {unit}")


@evaluation.run_scorer
async def mean_quality(ctx: RunEvaluatorContext) -> Score:
    return _mean_stat(ctx, key="response_quality", noun="quality", unit="cases")


def _ir_metrics(output: object) -> dict[str, float]:
    if isinstance(output, dict):
        metrics = output.get("metrics")
        if isinstance(metrics, dict):
            return {str(k): float(v) for k, v in metrics.items() if isinstance(v, (int, float))}
    return {}


def _ir_score(output: object, metric: str) -> Score:
    metrics = _ir_metrics(output)
    value = metrics.get(metric)
    if value is None:
        return Score(value=0.0, rationale=f"{metric} not reported")
    return Score(value=max(0.0, min(1.0, value)), rationale=f"{metric}={value:.3f}")


@evaluation.scorer
async def search_recall_at_10(ctx: ScorerContext) -> Score:
    return _ir_score(ctx.output, "recall@10")


@evaluation.scorer
async def search_ndcg_at_10(ctx: ScorerContext) -> Score:
    return _ir_score(ctx.output, "ndcg@10")


@evaluation.scorer
async def search_mrr(ctx: ScorerContext) -> Score:
    return _ir_score(ctx.output, "mrr")


@evaluation.scorer(execution_timeout=JUDGE_SCORER_TIMEOUT, max_concurrency=JUDGE_SCORER_MAX_CONCURRENCY)
async def search_llm_relevance(ctx: ScorerContext) -> Score:
    from evals.search.relevance import ResultPage, judge_relevance

    output = ctx.output if isinstance(ctx.output, dict) else {}
    page = output.get("page")
    if not isinstance(page, dict):
        return Score(value=0.0, rationale="no retrieved page to judge")
    query = str(output.get("query") or ctx.input_record.get("query") or "")
    model = str((ctx.system.params.get("judge_model") if ctx.system else None) or "mistral-small-latest")
    response = await judge_relevance(query, ResultPage(**page), model_id=model)
    return Score(value=response.score / 5.0, rationale=f"Mistral search-quality judge scored {response.score}/5")


@evaluation.run_scorer
async def search_mean_recall_at_10(ctx: RunEvaluatorContext) -> Score:
    return _mean_stat(ctx, key="search_recall_at_10", noun="recall@10", unit="queries")


_MAX_REPORTED_ERRORS = 3
_MAX_ERROR_CHARS = 200


@dataclass(frozen=True)
class ScorerCoverage:
    """How many of a run's generations one evaluator scored, and the first reasons it did not."""

    total: int
    scored: int
    errors: tuple[str, ...]

    @property
    def failed(self) -> int:
        return self.total - self.scored

    @property
    def fraction(self) -> float:
        return self.scored / self.total if self.total else 1.0

    def as_json(self) -> dict[str, JsonValue]:
        return {"total": self.total, "scored": self.scored, "failed": self.failed, "errors": list(self.errors)}


_ALL_EVALUATORS = "all evaluators"
_NO_GENERATION = "record produced no generation"


def scorer_coverage_report(ctx: RunEvaluatorContext) -> dict[str, ScorerCoverage]:
    """Per evaluator: how many generations it scored, how many it failed on, and why.

    A generation whose task failed counts as a failure for every evaluator, because none of them
    could score it, and so does a record the plugin returned with no generation at all. The plugin
    keeps a failed scorer's record as an ``error`` score and leaves it out of the evaluator's
    statistics, so an average alone cannot tell 15 scored records from 2. When every task failed,
    no evaluator name survives into the context; the whole run is then reported under
    ``"all evaluators"`` so it scores 0 instead of reading as fully covered.
    """
    generations = [generation for record in ctx.records for generation in record.output.generations]
    empty_records = sum(1 for record in ctx.records if not record.output.generations)
    total = len(generations) + empty_records
    names = list(dict.fromkeys([*ctx.statistics, *(name for g in generations for name in g.scores)]))
    if not names and total:
        names = [_ALL_EVALUATORS]
    report: dict[str, ScorerCoverage] = {}
    for name in names:
        scored = 0
        errors: list[str] = [_NO_GENERATION] * empty_records
        for generation in generations:
            scores = generation.scores.get(name, [])
            if any(score.status == "success" and score.value is not None for score in scores):
                scored += 1
            elif generation.status == "error":
                errors.append(f"task failed: {generation.error}")
            else:
                errors.extend(str(score.error) for score in scores if score.status == "error")
        distinct = tuple(dict.fromkeys(error[:_MAX_ERROR_CHARS] for error in errors))
        report[name] = ScorerCoverage(total=total, scored=scored, errors=distinct[:_MAX_REPORTED_ERRORS])
    return report


@evaluation.run_scorer
async def scorer_coverage(ctx: RunEvaluatorContext) -> Score:
    """The lowest share of records any evaluator actually scored; 1.0 means nothing was dropped.

    Read it next to every average in the run: an average over a covered fraction below 1.0 is
    an average over the records that happened to survive. ``metadata`` carries the per-evaluator
    counts and the first distinct errors. A run with no records scores 0: it measured nothing.
    """
    report = scorer_coverage_report(ctx)
    if not report:
        return Score(value=0.0, rationale="no records were evaluated")
    gaps = [
        f"{name} scored {row.scored}/{row.total} ({'; '.join(row.errors) or 'no error recorded'})"
        for name, row in report.items()
        if row.failed
    ]
    rationale = "; ".join(gaps) if gaps else f"all {len(report)} evaluators scored every record"
    return Score(
        value=min(row.fraction for row in report.values()),
        rationale=rationale,
        metadata={name: row.as_json() for name, row in report.items()},
    )


def scorer_coverage_evaluator() -> RunEvaluator:
    """The coverage run evaluator every track reports, so a dropped record fails the run's goals."""
    return RunEvaluator(
        name="scorer_coverage",
        description="Lowest share of records any evaluator scored (1.0 = none dropped by a scorer or task error).",
        scorer=scorer_coverage,
        goal=Goal.gte(1.0),
    )
