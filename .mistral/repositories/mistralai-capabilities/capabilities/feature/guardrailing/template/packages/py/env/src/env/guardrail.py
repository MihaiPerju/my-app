from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import Field, model_validator

from env._base import BaseEnv

if TYPE_CHECKING:
    from mistralai_capabilities.guardrails.schemas import GuardrailEdge
    from mistralai_capabilities.guardrails.spec import ClassifierSpec


class Env(BaseEnv):
    """Settings for the agent guardrail gate (mistralai-guardrails).

    Complex fields (lists/dicts) are parsed as JSON from the matching upper-case
    env var, e.g. ``GUARDRAIL_ALLOWED_TOPICS='["billing","outages"]'``.
    """

    # The master switch (D7). False turns the gate off, whatever the two edge flags say. The edge
    # flags are AND-ed with it, so each edge can be turned off on its own. Read them through the two
    # ``*_effective`` properties below, never on their own.
    guardrail_enabled: bool = True

    # Scan the incoming user prompt (plus any replayed history) before the model runs. A blocked
    # prompt never reaches the model: the turn answers with the refusal instead.
    guardrail_input_enabled: bool = True

    # Scan the model's final answer before it reaches the caller. Off by default, and the only flag
    # here that is. While it is effective the chat stream buffers, because a token streamed live is
    # not scanned yet, so the caller waits out the whole turn with no progressive feedback
    # (``studio/agents/events.py``). This is a product decision, so the flag is opt-in.
    guardrail_output_enabled: bool = False

    # Shown to the caller when a scan blocks a prompt or an answer and the scanner did not
    # supply its own refusal text. Deployment-tunable so the wording can match the product's
    # voice (and its language) without a code change.
    guardrail_refusal_message: str = "I'm unable to help with that request."

    # The similarity scanner needs a seeded pgvector table; disable it to run the
    # gate with only the LLM + moderation scanners (before seeding, or with no DB).
    guardrail_similarity_enabled: bool = True
    guardrail_embeddings_table: str = "guardrail_embeddings"
    guardrail_similarity_threshold: float = 0.90
    guardrail_similarity_top_k: int = 2

    guardrail_llm_model: str = "mistral-small-latest"

    # The moderation categories that block, using the model's own names. Names are model-specific;
    # for mistral-moderation-latest / -2603 (spec.KNOWN_MODERATION_MODELS) they are validated at
    # startup against:
    #   harm:    sexual, hate_and_discrimination, violence_and_threats, dangerous, criminal,
    #            selfharm, jailbreaking (-> malicious), pii (-> unsafe)
    #   subject: health, financial, law (-> out_of_scope)
    # Empty (the default) checks the harm categories only. The subject categories flag ordinary
    # questions about their subject, so list one only to refuse that subject. `dangerous` and
    # `criminal` are separate names; `dangerous_and_criminal_content` does not exist.
    # With any other GUARDRAIL_MODERATION_MODEL, list the categories explicitly (empty is refused at
    # startup): their names cannot be checked offline, so the scanner checks them on each scan, and
    # a name that model does not return fails every scan closed.
    # Empty thresholds keep the model's own flag for every category.
    guardrail_moderation_model: str = "mistral-moderation-latest"
    guardrail_moderation_categories: list[str] = Field(default_factory=list)
    guardrail_moderation_thresholds: dict[str, float] = Field(default_factory=dict)

    # Empty topic lists ⇒ no out_of_scope gating (permissive default for a general agent).
    guardrail_allowed_topics: list[str] = Field(default_factory=list)
    guardrail_forbidden_topics: list[str] = Field(default_factory=list)

    guardrail_timeout_seconds: float = 15.0

    @model_validator(mode="after")
    def _known_moderation_categories(self) -> Env:
        # A name the model does not return would otherwise fail every scan, and the fail-closed
        # policy would block every prompt. Fail here, at startup, with the valid names instead. The
        # names are model-specific, so they are checked against GUARDRAIL_MODERATION_MODEL's own.
        from mistralai_capabilities.guardrails.spec import (
            default_moderation_categories,
            validate_moderation_categories,
        )

        model = self.guardrail_moderation_model
        if self.guardrail_moderation_categories:
            validate_moderation_categories(
                self.guardrail_moderation_categories, model=model, setting="GUARDRAIL_MODERATION_CATEGORIES"
            )
        else:
            default_moderation_categories(model)  # raises for a model with no known harm categories
        validate_moderation_categories(
            list(self.guardrail_moderation_thresholds), model=model, setting="GUARDRAIL_MODERATION_THRESHOLDS"
        )
        return self

    @property
    def guardrail_input_effective(self) -> bool:
        return self.guardrail_enabled and self.guardrail_input_enabled

    @property
    def guardrail_output_effective(self) -> bool:
        return self.guardrail_enabled and self.guardrail_output_enabled


env = Env()

# Opt-in per-edge LLM classifiers. None keeps the single joint 4-way classifier (built from the
# fields above) on both edges. Set a dict of edge -> [ClassifierSpec, ...] to run specialised
# classifiers per edge (e.g. a scope check AND an unsafe check on input, one check on output); an
# edge absent from the dict runs no LLM classifier. See the capability SKILL for a worked example.
llm_classifiers: dict[GuardrailEdge, list[ClassifierSpec]] | None = None
