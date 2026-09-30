"""Shared guardrail / moderation evaluation core.

The SDK-free surface (labels, the fail-closed normalizer, the pure scoring math)
is re-exported here so ``import mistralai_capabilities.guardrailing_eval`` never needs
``mistralai.evaluations``. The scanner seam (``make_task`` / ``TaskFn`` /
``ModerationScanner``, in ``runner``) and the Evaluator factories (in ``metrics``)
depend on the SDK, so they are re-exported lazily via ``__getattr__`` — resolved
only when an app actually wires the harness — keeping the eager import SDK-free.
"""

from typing import TYPE_CHECKING, Any

from mistralai_capabilities.guardrailing_eval import _scoring
from mistralai_capabilities.guardrailing_eval.schema import (
    ClassificationOutput,
    EvalLabel,
    ModerationLabel,
    expected_label,
    normalize_prediction,
)

if TYPE_CHECKING:
    from mistralai_capabilities.guardrailing_eval.runner import ModerationScanner, TaskFn, make_task

_LAZY = frozenset(("ModerationScanner", "TaskFn", "make_task"))


def __getattr__(name: str) -> Any:
    if name in _LAZY:
        from mistralai_capabilities.guardrailing_eval import runner

        return getattr(runner, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "ClassificationOutput",
    "EvalLabel",
    "ModerationLabel",
    "ModerationScanner",
    "TaskFn",
    "_scoring",
    "expected_label",
    "make_task",
    "normalize_prediction",
]
