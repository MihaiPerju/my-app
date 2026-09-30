"""guardrails activities: the agent guardrail scan.

Runs the mistralai-guardrails :class:`Guardrail` (similarity + LLM + moderation
scanners) over a message list and returns a block decision with a refusal string.
The guardrail is built lazily and cached so scanners/backends are reused across
activity invocations.
"""

import asyncio
from datetime import timedelta

import mistralai.workflows as workflows
from env.mistral import env as mistral_env
from env.workflows import env as workflows_env
from mistralai.client import Mistral
from mistralai.workflows import Depends
from mistralai_capabilities.guardrails import guardrail as guardrail_config
from mistralai_capabilities.guardrails.guardrail import GuardrailClassification
from mistralai_capabilities.guardrails.schemas import GuardrailEdge, GuardrailScanRequest, GuardrailScanResult
from utils.telemetry import record_evaluation_result


def _mistral_client() -> Mistral:
    return Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)


EVALUATION_NAME = "guardrail"

_guardrails: dict[GuardrailEdge, guardrail_config.Guardrail] = {}


def get_guardrail(client: Mistral, edge: GuardrailEdge = "input") -> guardrail_config.Guardrail:
    cached = _guardrails.get(edge)
    if cached is None:
        cached = guardrail_config.build_guardrail(client, edge)
        _guardrails[edge] = cached
    return cached


@workflows.activity(
    name="guardrails.scan",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def guardrails_scan(
    request: GuardrailScanRequest, client: Mistral = Depends(_mistral_client)
) -> GuardrailScanResult:
    guardrail = await asyncio.to_thread(get_guardrail, client, request.edge)
    messages = guardrail_config.to_messages([(m.role, m.content) for m in request.messages])
    classification = await guardrail.classify_async(messages)
    blocked = classification is not GuardrailClassification.SAFE

    # Emitted from the activity, not the hook. A hook runs in workflow code, which replays, so it
    # would publish the same verdict on every replay. An activity body runs once per attempt and
    # never on replay, which makes this side effect safe. No trace or span id is passed, so the
    # record inherits the activity's current span and lands on the span that produced the verdict.
    record_evaluation_result(
        name=EVALUATION_NAME,
        score_value=0.0 if blocked else 1.0,
        score_label=classification.value,
        attributes={"mistral.guardrail.edge": request.edge},
    )

    return GuardrailScanResult(
        classification=classification.value,
        blocked=blocked,
        refusal=guardrail_config.get_refusal_response(classification),
    )
