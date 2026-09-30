"""Adapter: run the ``guardrailing`` capability's guardrail as an eval scanner.

The eval's ``ModerationScanner`` is ``classify(text) -> ClassificationOutput``,
but ``guardrailing`` exposes a ``Guardrail`` built by ``build_guardrail`` and
scanned with ``classify_async(messages)``, whose enum uses ``out_of_scope`` where
the eval label space uses ``oos_question``. This adapter bridges both gaps so a
run can score the real runtime guardrail.

Importing this module pulls ``guardrailing``'s runtime (its ``clients``/``env``
foundation packages), so it is kept out of the eval core: ``schema``,
``_scoring``, ``runner``, and ``metrics`` never import ``guardrailing``. Import it
only when you actually evaluate the guardrailing capability.
"""

from typing import TYPE_CHECKING

from mistralai_capabilities.guardrailing_eval.schema import ClassificationOutput, ModerationLabel
if TYPE_CHECKING:
    from mistralai.client import Mistral


# guardrailing's GuardrailClassification -> the eval's raw label space. The only
# non-identity mapping is out_of_scope -> oos_question; an enum value missing from
# this map is reported as a parse failure (fail-closed) rather than silently
# mis-scored, so a new guardrailing class can never be scored as safe by default.
_ENUM_VALUE_TO_LABEL: dict[str, ModerationLabel] = {
    "safe": "safe",
    "unsafe": "unsafe",
    "malicious": "malicious",
    "out_of_scope": "oos_question",
}


class GuardrailingScanner:
    """Wrap the ``guardrailing`` guardrail as a ``ModerationScanner``.

    The guardrail and its scanners are built once on construction and reused.
    ``guardrailing``'s scan is edge-independent (the edge is only a telemetry
    label), so there is no edge parameter here.
    """

    def __init__(self, client: "Mistral | None" = None) -> None:
        from mistralai_capabilities.guardrails import guardrail as guardrail_config

        self._config = guardrail_config
        self._guardrail = guardrail_config.build_guardrail(client)

    async def classify(self, text: str) -> ClassificationOutput:
        messages = self._config.to_messages([("user", text)])
        classification = await self._guardrail.classify_async(messages)
        label = _ENUM_VALUE_TO_LABEL.get(classification.value)
        if label is None:
            return ClassificationOutput(parse_failed=True, error=f"unmapped guardrail classification {classification.value!r}")
        return ClassificationOutput(classification=label)
