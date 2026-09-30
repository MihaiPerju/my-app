"""Search-relevance LLM judge: how well a retrieved page answers a query, on a 0-5 scale.

Vendored from ``mistralai-search-quality`` 0.3.0 (the ``label_result`` judge), which is retired and
was only ever published to a private index. Only the pieces this judge uses are kept: the prompt
models, the system prompt (``label_result_prompt.txt``, the library's ``label_result`` v3 bundle
rendered with its default doc-level scopes) and the parse-and-retry loop of its ``LLMWorker``. The
prompt (bar trailing whitespace, which the app's pre-commit hooks strip) and the models are kept
byte-for-byte so scores stay comparable with earlier runs; edit them together, since the output
schema in the prompt is generated from ``LabelResultResponse``.

Mistral has no grounding tool here, so scores are un-grounded: treat them as directional and use
them for A/B deltas.
"""

import json
import logging
from datetime import UTC, datetime
from importlib.resources import files
from typing import Any

from env.mistral import env as mistral_env
from mistralai.client import Mistral
from pydantic import BaseModel, Field, ValidationError, field_validator

from evals.judge import judge_retry_config

DEFAULT_JUDGE_MODEL = "mistral-small-latest"
_MAX_ATTEMPTS = 3

logger = logging.getLogger(__name__)


class KnowledgeRubric(BaseModel):
    criteria: list[str] = Field(
        ..., description="Topics, decision vectors, and structural elements a good answer should cover"
    )
    facts: list[str] = Field(
        ..., description="Key essential facts and focus topics for an LLM to provide a good answer"
    )
    traps: list[str] = Field(..., description="Negative constraints, misconceptions, or outdated info to be aware of")


class ResultPage(BaseModel):
    """Represents a single search result to be judged — a full page or a chunk passage."""

    url: str = Field(..., description="The URL of the page")
    title: str | None = Field(None, description="Title of the page")
    text: str | None = Field(None, description="Extracted text content (full page body or a single chunk passage)")
    source_date: str | None = Field(
        None, description="Best available date from SERP engine or page loader (variable precision, UTC)"
    )


class LabelResultInput(BaseModel):
    """Input model for label result LLM call."""

    question_summary: str = Field(..., description="Standalone, context-rich summary of the user's intent")
    knowledge_rubric: KnowledgeRubric = Field(..., description="Knowledge rubric with criteria, facts, and traps")
    query: str = Field(..., description="The search query used to retrieve the result")
    question_date: str | None = Field(
        None, description="Date the user asked the question — reference point for freshness (YYYY-MM-DD)"
    )
    page: ResultPage = Field(..., description="The result page (full document or chunk passage) to judge")


class LabelResultTags(BaseModel):
    """Classification tags for a labeled result."""

    broken: bool = Field(..., description="Technical failures (404, paywalls, empty content)")
    vital: bool = Field(..., description="Must-have result with unique authoritative data")
    volatile: bool = Field(..., description="Time-sensitive information")
    stale: bool = Field(..., description="Outdated or no longer relevant")
    spam: bool = Field(..., description="Low-quality, SEO-driven, or AI-generated content")
    harmful: bool = Field(
        ...,
        description=(
            "Hits a trap or contains content that could lead an LLM into misconception "
            "or low-quality answer if not corrected by other documents"
        ),
    )


class LabelResultResponse(BaseModel):
    """Response model for label result LLM output."""

    language: str = Field(..., description="ISO 639-1 language code (e.g., 'en', 'fr')")
    description: str = Field(..., description="One paragraph document description in the document's main language")
    description_translated: str | None = Field(
        ...,
        description=(
            "English translation of description if main language is not English. MUST be null if language is 'en'."
        ),
    )
    reasoning: str = Field(..., description="Reasoning trace justifying scoring and classification decisions")
    reasoning_translated: str | None = Field(
        ...,
        description=(
            "English translation of reasoning if main language is not English. MUST be null if language is 'en'."
        ),
    )
    tags: LabelResultTags = Field(..., description="Classification tags")
    score: int = Field(..., description="Utility score, integer in [0, 5] inclusive (0 = useless, 5 = perfect)")

    @field_validator("score")
    @classmethod
    def score_in_range(cls, v: int) -> int:
        if not 0 <= v <= 5:
            raise ValueError(f"score must be in [0, 5], got {v}")
        return v

    document_date: str | None = Field(
        ...,
        description=(
            "LLM's best estimate of publication date (variable precision: YYYY, YYYY-MM, "
            "YYYY-MM-DD, or YYYY-MM-DD HH:MM UTC). null if undatable."
        ),
    )


class LLMResponseError(Exception):
    """The judge returned no valid ``LabelResultResponse`` after every attempt."""


def system_prompt(now: datetime | None = None) -> str:
    """The judge's system prompt, stamped with the current UTC time as the library did."""
    today_date = (now or datetime.now(UTC)).strftime("%Y-%m-%d %H:%M")
    schema = json.dumps(LabelResultResponse.model_json_schema(), indent=2, ensure_ascii=False)
    template = files("evals.search").joinpath("label_result_prompt.txt").read_text(encoding="utf-8")
    return template.replace("{today_date}", today_date).replace("{label_result_output_schema}", schema)


def _strip_markdown_code_blocks(text: str) -> str:
    json_text = text.strip()
    if json_text.startswith("```json"):
        json_text = json_text[7:]
    elif json_text.startswith("```"):
        json_text = json_text[3:]
    if json_text.endswith("```"):
        json_text = json_text[:-3]
    return json_text.strip()


def _response_text(raw: dict[str, Any]) -> str:
    choices = raw.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str):
            return content
        if content is not None:
            return str(content)
    return ""


async def judge_relevance(
    query: str,
    page: ResultPage,
    *,
    question_summary: str | None = None,
    knowledge_rubric: KnowledgeRubric | None = None,
    model_id: str = DEFAULT_JUDGE_MODEL,
) -> LabelResultResponse:
    """Score a retrieved page's relevance to ``query`` on the 0-5 scale via Mistral.

    Asks for structured output (``chat.parse_async``) and still parses and validates the text,
    retrying up to three times on invalid JSON or a schema violation. Rate limits, 5xx and dropped
    connections are retried with backoff by the client (``judge_retry_config``); what still fails
    after that raises, and the run's ``scorer_coverage`` reports it. Requires ``MISTRAL_API_KEY``.
    """
    user_input = LabelResultInput(
        question_summary=question_summary or query,
        knowledge_rubric=knowledge_rubric or KnowledgeRubric(criteria=[], facts=[], traps=[]),
        query=query,
        page=page,
    )
    messages = [
        {"role": "system", "content": system_prompt()},
        {"role": "user", "content": user_input.model_dump_json(indent=2)},
    ]
    client = Mistral(
        api_key=mistral_env.mistral_api_key or "",
        server_url=mistral_env.mistral_base_url,
        retry_config=judge_retry_config(),
    )
    last_error: Exception | None = None
    for attempt in range(_MAX_ATTEMPTS):
        if attempt > 0:
            logger.warning("Retrying relevance judge after %s (attempt %d)", type(last_error).__name__, attempt)
        try:
            # Inside the handler: `parse_async` itself runs `json.loads` + `model_validate` on the
            # reply, so a malformed answer raises here, before the text is ever re-parsed below.
            parsed = await client.chat.parse_async(
                model=model_id, messages=messages, response_format=LabelResultResponse
            )
            text = _response_text(parsed.model_dump(mode="json"))
            return LabelResultResponse.model_validate(json.loads(_strip_markdown_code_blocks(text)))
        except (json.JSONDecodeError, ValidationError) as error:
            last_error = error
    raise LLMResponseError(
        f"LLM did not return a valid LabelResultResponse response after {_MAX_ATTEMPTS} attempts"
    ) from last_error
