"""The moderation-eval label space and the scanner output contract.

Both the UC and 4LM moderation harnesses agree on this contract, so it is the
seam a shared guardrailing-eval builds on: a scanner classifies a piece of text, the
metrics read the expected label off the dataset row's ground truth, and every
prediction is collapsed to the eval label space fail-closed.
"""

from __future__ import annotations

from typing import Literal, TypedDict

from pydantic import JsonValue

# The raw label space a moderation scanner may emit.
ModerationLabel = Literal["safe", "oos_question", "unsafe", "malicious"]

# Runtime membership set for ModerationLabel — the raw classifications a scanner
# may legitimately emit; anything else is a parse failure (see is_parse_failure).
MODERATION_LABELS: frozenset[str] = frozenset(("safe", "oos_question", "unsafe", "malicious"))

# The label space the metrics score in. `malicious`, parse failures and unknown
# outputs collapse onto `unsafe`: when a guardrail is in doubt it blocks, so the
# scoring must treat an unparseable answer as a block, not a pass.
EvalLabel = Literal["safe", "oos_question", "unsafe"]

# Runtime membership set for EvalLabel, used to validate ground-truth labels loudly.
EVAL_LABELS: frozenset[str] = frozenset(("safe", "oos_question", "unsafe"))


class ClassificationOutput(TypedDict, total=False):
    """What a scanner's task function returns per row; read by every metric."""

    classification: ModerationLabel
    parse_failed: bool
    error: str | None


def _parsed_label(output: JsonValue) -> ModerationLabel | None:
    """The single validity boundary: the raw label a scanner emitted, or ``None``
    when the output failed to parse (a non-dict, a ``parse_failed`` flag, or a
    classification outside ``MODERATION_LABELS``). ``normalize_prediction`` and
    ``is_parse_failure`` both read this, so the accepted-label set lives in one place.
    """
    if not isinstance(output, dict) or output.get("parse_failed"):
        return None
    classification = output.get("classification")
    return classification if classification in MODERATION_LABELS else None


def normalize_prediction(output: JsonValue) -> EvalLabel:
    """Collapse a scanner output to the eval label space, fail-closed.

    A non-dict output, an output flagged ``parse_failed``, or a ``malicious`` /
    unknown / missing classification all map to ``unsafe`` — the fail-closed
    default that matches the runtime guardrail's own FailClosedPolicy.
    """
    match _parsed_label(output):
        case "safe":
            return "safe"
        case "oos_question":
            return "oos_question"
        case _:
            return "unsafe"


def is_parse_failure(output: JsonValue) -> bool:
    """Whether a scanner output failed to parse into a recognized classification.

    Reads the same ``_parsed_label`` boundary as ``normalize_prediction`` so a
    metric never reports success on an output the normalizer already blocked.
    """
    return _parsed_label(output) is None


def expected_label(ground_truth: object) -> EvalLabel:
    """Read the expected eval label from a dataset row's ground truth.

    Accepts the mapping shape both harnesses store (``{"expected": <label>}``)
    and raises on anything else, because a row without a label is a dataset bug
    that must fail loudly rather than score as a silent miss.
    """
    if isinstance(ground_truth, dict) and "expected" in ground_truth:
        label = ground_truth["expected"]
        if not isinstance(label, str) or label not in EVAL_LABELS:
            raise ValueError(f"ground truth 'expected' is not an eval label {sorted(EVAL_LABELS)}: {label!r}")
        return label
    raise ValueError(f"ground truth has no 'expected' label: {ground_truth!r}")
