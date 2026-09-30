"""Loop-boundary contract for the chat-feedback (``feedback``) feature.

A rating is cheap to collect and expensive to trust: users vote thumbs-down on correct answers,
slow answers, and by accident. This module holds the shapes and the pure filter that reconstructs
what the user saw. Its record shares three names with ``evals``: ``message``, ``rating``,
``prior_answer``.
"""

import json
from typing import Any

from pydantic import BaseModel, Field

__all__ = [
    "NEGATIVE",
    "POSITIVE",
    "RELEVANCE_JUDGE_SYSTEM",
    "DatasetRecords",
    "DatasetRef",
    "DatasetRequest",
    "FeedbackBatch",
    "FeedbackCase",
    "FeedbackCases",
    "FeedbackHarvestParams",
    "PromptOptimizationParams",
    "PublishCandidateRequest",
    "PublishedCandidate",
    "SeedPrompt",
    "build_cases",
    "exchange_from_span",
    "index_spans_by_id",
    "relevance_prompt",
    "span_attributes",
]

_INPUT_MESSAGES_ATTR = "gen_ai.input.messages"
_OUTPUT_MESSAGES_ATTR = "gen_ai.output.messages"

POSITIVE = "positive"
NEGATIVE = "negative"

RELEVANCE_JUDGE_SYSTEM = (
    "You audit user feedback on an AI assistant. You are given the user's request, the "
    "assistant's answer, and the rating a user gave that answer. Decide whether the rating is "
    "JUSTIFIED by the exchange itself: a thumbs-up should mean the answer genuinely addressed "
    "the request, and a thumbs-down should mean it genuinely did not. Rate your confidence "
    "that the rating is justified as a single integer from 0 to 10. A rating you cannot "
    "corroborate from the exchange — an unexplained downvote on a correct, complete answer, or "
    "an upvote on a refusal — scores low. Reply with only the number."
)


class FeedbackHarvestParams(BaseModel):
    """Input to the harvest workflow. Every field has a settings-derived default at the call site."""

    window_hours: int = Field(default=24, description="How far back to read ratings.")
    evaluation_name: str = Field(default="user_feedback", description="The evaluation_name rows to harvest.")
    judge_model: str = Field(default="mistral-small-latest", description="Model for the relevance judge.")
    relevance_threshold: float = Field(default=0.5, description="Keep ratings the judge scores at or above this.")
    min_records_to_evaluate: int = Field(default=10, description="Below this, write the dataset but skip the eval.")
    dataset_name_prefix: str = Field(default="chat-feedback", description="Dataset name stem; the window is appended.")
    project_name: str = Field(default="Chat feedback", description="AI Studio project the evaluation lands in.")
    system_name: str = Field(default="scheduled", description="System label recorded on the evaluation run.")
    local: bool = Field(default=False, description="When true, skip the AI Studio upload for the evaluation.")


class PromptOptimizationParams(BaseModel):
    """Input to the GEPA optimization workflow."""

    dataset_id: str = Field(default="", description="Harvested dataset to optimize against; empty picks the latest.")
    dataset_name_prefix: str = Field(default="chat-feedback", description="Prefix used to find the latest dataset.")
    project_name: str = Field(default="Chat feedback", description="AI Studio project the candidate runs land in.")
    judge_model: str = Field(default="mistral-small-latest", description="Model the quality scorer judges with.")
    publish_candidate: bool = Field(default=True, description="Write the winner as a new registry version.")


class FeedbackCase(BaseModel):
    """One rating, joined to the exchange it judged and scored for relevance.

    ``relevance`` and ``rationale`` are filled by the judge; a case is only written to the
    dataset once ``relevance`` clears the threshold.
    """

    message: str
    prior_answer: str
    rating: str
    rating_score: float
    trace_id: str
    span_id: str
    conversation_id: str = ""
    timestamp: str = ""
    relevance: float = 0.0
    rationale: str = ""

    def dataset_payload(self) -> dict[str, Any]:
        """The record as an evaluation input.

        ``expected`` is written for the LLM judge that scores the replay. It is derived from the
        rating, not from ground truth. A negative case guidance says what went wrong, which is
        what the judge needs to tell whether the agent has since improved.
        """
        expected = (
            "The answer should address the request well; a previous answer was rated poorly by a user."
            if self.rating == NEGATIVE
            else "A previous answer to this request was rated positively; the answer should remain at least as good."
        )
        return {
            "message": self.message,
            "expected": expected,
            "prior_answer": self.prior_answer,
            "rating": self.rating,
            "rating_score": self.rating_score,
        }

    def dataset_properties(self) -> dict[str, Any]:
        """Provenance kept beside the record in Studio, but out of the evaluated input.

        ``span_id`` is required, not decorative. It is the key an append diffs against, so
        re-running a harvest converges on the day dataset instead of doubling it.
        """
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "conversation_id": self.conversation_id,
            "timestamp": self.timestamp,
            "judge_relevance": self.relevance,
            "judge_rationale": self.rationale,
        }


class FeedbackCases(BaseModel):
    """A batch of cases crossing the activity boundary.

    A model rather than a bare ``list[dict]`` so the boundary is typed once and validated once,
    instead of every downstream activity re-validating each record in a loop.
    """

    cases: list[FeedbackCase] = Field(default_factory=list)


class FeedbackBatch(BaseModel):
    """The harvest params plus the cases they produced — what the judge and the writer take."""

    params: FeedbackHarvestParams
    cases: list[FeedbackCase] = Field(default_factory=list)


class DatasetRef(BaseModel):
    """A written dataset: its id, and how many records it now holds."""

    dataset_id: str
    name: str
    records: int
    appended: int


class DatasetRequest(BaseModel):
    """Which dataset to read: an explicit id, or the newest carrying ``name_prefix``."""

    dataset_id: str = ""
    name_prefix: str = ""


class DatasetRecords(BaseModel):
    """Dataset records as evaluation inputs, unwrapped from whatever envelope stored them."""

    records: list[dict[str, Any]] = Field(default_factory=list)


class SeedPrompt(BaseModel):
    """The registry's prompt for generation 0, or ``None`` to fall back to the shipped file."""

    content: str | None = None


class PublishCandidateRequest(BaseModel):
    content: str
    notes: str


class PublishedCandidate(BaseModel):
    """The outcome of filing a winning prompt, including the case where filing was declined.

    ``published=False`` with a ``reason`` is a normal outcome, not an error. A deployment that does
    not source its prompt from the registry has nowhere to put a candidate, and writing one would
    leave an object nothing reads while the prompts command never converges.
    """

    published: bool = False
    prompt_id: str = ""
    version: int | None = None
    created: bool = False
    reason: str = ""


def _coerce_messages(raw: Any) -> list[dict[str, Any]]:
    """The message list from a span attribute, whatever shape it arrived in.

    OTel attribute values are scalars, so a message list crosses the wire JSON-encoded. The
    ingestion path may already have decoded it, and some producers send a bare string. Handling
    all three here keeps every caller from re-deriving the same defensive parse.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return [{"role": "user", "parts": [{"type": "text", "content": raw}]}]
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    return [m for m in raw if isinstance(m, dict)]


def _message_text(message: dict[str, Any]) -> str:
    """Every text fragment in one message, flattened.

    The GenAI convention nests text under ``parts``, but the key is not stable: ``content`` and
    ``text`` both appear, and older spans put a plain string on ``content``. Collecting whatever is
    present beats asserting a shape that would make the harvest skip real exchanges.
    """
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    fragments: list[str] = []
    parts = message.get("parts")
    for part in parts if isinstance(parts, list) else []:
        if not isinstance(part, dict):
            continue
        text = part.get("content") or part.get("text")
        if isinstance(text, str) and text.strip():
            fragments.append(text.strip())
    return "\n".join(fragments)


def _texts_by_role(raw: Any, role: str) -> list[str]:
    return [t for m in _coerce_messages(raw) if m.get("role") == role and (t := _message_text(m))]


def span_attributes(span: dict[str, Any]) -> dict[str, Any]:
    """A span's attribute map, under whichever key this response used."""
    for key in ("span_attributes", "attributes"):
        value = span.get(key)
        if isinstance(value, dict):
            return value
    return {}


def exchange_from_span(span: dict[str, Any]) -> tuple[str, str]:
    """``(user request, assistant answer)`` for one span, either possibly empty.

    The last user message and the last assistant message, because a span covering a multi-turn
    agent run holds the whole history and the rating was on its final answer.
    """
    attributes = span_attributes(span)
    requests = _texts_by_role(attributes.get(_INPUT_MESSAGES_ATTR), "user")
    answers = _texts_by_role(attributes.get(_OUTPUT_MESSAGES_ATTR), "assistant")
    if not answers:
        answers = _texts_by_role(attributes.get(_OUTPUT_MESSAGES_ATTR), "model")
    return (requests[-1] if requests else "", answers[-1] if answers else "")


def index_spans_by_id(spans: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Spans keyed by ``span_id``, for joining evaluation rows onto their exchange."""
    return {span_id: span for span in spans if (span_id := str(span.get("span_id") or ""))}


def build_cases(
    *,
    evaluations: list[dict[str, Any]],
    spans_by_id: dict[str, dict[str, Any]],
) -> list[FeedbackCase]:
    """Join evaluation rows onto their spans, dropping what cannot be reconstructed.

    A row whose span is missing, or whose span carries no request/answer pair, is skipped instead
    of judged. There is nothing for a judge to corroborate the rating against, and a case with an
    empty prompt would replay as an empty prompt.
    """
    cases: list[FeedbackCase] = []
    for row in evaluations:
        span_id = str(row.get("span_id") or "")
        span = spans_by_id.get(span_id)
        if span is None:
            continue
        request, answer = exchange_from_span(span)
        if not request or not answer:
            continue
        score_value = float(row.get("score_value") or 0.0)
        cases.append(
            FeedbackCase(
                message=request,
                prior_answer=answer,
                rating=str(row.get("score_label") or (POSITIVE if score_value >= 0.5 else NEGATIVE)),
                rating_score=score_value,
                trace_id=str(row.get("trace_id") or ""),
                span_id=span_id,
                conversation_id=str(row.get("conversation_id") or ""),
                timestamp=str(row.get("timestamp") or ""),
            )
        )
    return cases


def relevance_prompt(case: FeedbackCase) -> list[dict[str, str]]:
    """The judge conversation for one case."""
    verdict = "thumbs up (positive)" if case.rating == POSITIVE else "thumbs down (negative)"
    return [
        {"role": "system", "content": RELEVANCE_JUDGE_SYSTEM},
        {
            "role": "user",
            "content": (
                f"User request:\n{case.message}\n\nAssistant answer:\n{case.prior_answer}\n\nUser rating: {verdict}"
            ),
        },
    ]
