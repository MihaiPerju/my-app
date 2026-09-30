"""The seam between a moderation scanner and the evaluation harness.

The app owns the scanner — its pinned prompts, model, thresholds, and whichever
backend it runs (the ``guardrailing`` capability via ``adapters.GuardrailingScanner``,
an LLM classifier, the legacy cerberus path). The eval only needs it to turn one
piece of text into a ``ClassificationOutput``. ``make_task`` wraps a scanner into
the task ``mistralai.evaluations`` runs per row: it reads the text out of the
``TaskContext``'s input record (the ``answer`` field for post-generation, the
message field for pre-generation) and converts any scanner error into a
fail-closed ``parse_failed`` output the metrics score as ``unsafe`` — a crash
blocks, never passes.

The task's ``ctx: TaskContext`` annotation is what makes the SDK dispatch it
context-style (``mistralai.evaluations.execution._uses_context_style``), the same
contract the ``metrics`` scorers use, so ``TaskContext`` is imported normally.
This module therefore needs ``mistralai.evaluations``; the package root re-exports
``make_task`` lazily (see ``__init__``) so ``import mistralai_capabilities.guardrailing_eval``
stays SDK-free.
"""

from collections.abc import Awaitable, Callable
from typing import Protocol

from mistralai.evaluations.models import TaskContext

from mistralai_capabilities.guardrailing_eval.schema import ClassificationOutput


class ModerationScanner(Protocol):
    """A scanner the app supplies that classifies one piece of text.

    The ``guardrailing`` capability is not a drop-in: it exports a ``Guardrail``
    built by ``build_guardrail`` (no ``classify(text)``), and its out-of-scope
    value is ``out_of_scope``, not ``oos_question``. Use
    ``adapters.GuardrailingScanner``, which calls the real guardrail API and maps
    the enum, rather than passing the ``Guardrail`` here directly.
    """

    async def classify(self, text: str) -> ClassificationOutput: ...


TaskFn = Callable[[TaskContext], Awaitable[ClassificationOutput]]


def make_task(scanner: ModerationScanner, *, field: str = "text") -> TaskFn:
    """Adapt a scanner to an evaluations task function.

    ``field`` names the input-record key holding the text to classify — ``answer``
    for post-generation moderation, the user-message key for pre-generation. Any
    scanner error becomes a fail-closed ``parse_failed`` output.
    """

    async def task(ctx: TaskContext) -> ClassificationOutput:
        text = ctx.input_record[field]  # a missing/misnamed field is a dataset bug: fail the run.
        if not isinstance(text, str):
            return ClassificationOutput(parse_failed=True, error=f"field '{field}' is not a string: {type(text).__name__}")
        try:
            return await scanner.classify(text)
        except Exception as exc:  # noqa: BLE001 — a scanner crash must block, not pass.
            return ClassificationOutput(parse_failed=True, error=repr(exc))

    return task
