"""Dependency-free guardrail types shared by the config, scanners, and env.

Kept free of any ``env`` import so an app's ``env.guardrail``
module can declare typed per-edge classifier config (:class:`ClassifierSpec`)
without an import cycle: :mod:`...guardrails.guardrail` imports ``env.guardrail``
to read the config, so the config module must not import ``guardrail`` back.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, get_args

from mistralai_guardrails.classification import ClassificationEnum
from mistralai_guardrails.scanners.llm_scanner import PromptTemplate
from pydantic import BaseModel, create_model, field_validator

GuardrailEdge = Literal["input", "output"]
GUARDRAIL_EDGES: tuple[GuardrailEdge, ...] = get_args(GuardrailEdge)
"""Valid guardrail edges, derived from :data:`GuardrailEdge` so the two never drift."""


class GuardrailClassification(ClassificationEnum):
    SAFE = "safe"
    UNSAFE = "unsafe"
    MALICIOUS = "malicious"
    OUT_OF_SCOPE = "out_of_scope"

    @classmethod
    def on_no_result(cls) -> "GuardrailClassification":
        return cls.SAFE

    @classmethod
    def on_error(cls) -> "GuardrailClassification":
        # Fail closed. A scanner that errors or times out has NOT cleared the input, and
        # treating that as SAFE lets anyone disable the gate by inducing latency.
        # `guardrail_enabled=false` is the intentional way to turn the gate off.
        return cls.MALICIOUS


HARM_MODERATION_CATEGORIES: tuple[str, ...] = (
    "sexual",
    "hate_and_discrimination",
    "violence_and_threats",
    "dangerous",
    "criminal",
    "selfharm",
    "jailbreaking",
    "pii",
)
"""The moderation categories that describe harmful content. For a known model they are what
the moderation scanner checks when ``GUARDRAIL_MODERATION_CATEGORIES`` is left empty (``[]``)."""

TOPIC_MODERATION_CATEGORIES: tuple[str, ...] = ("health", "financial", "law")
"""The moderation categories that only name a subject. The model flags an ordinary question such as
"how long do we have to notify the regulator of a breach" as ``law``, so checking these by default
would block every legal, health, or finance question. To refuse a subject, list it explicitly in
``GUARDRAIL_MODERATION_CATEGORIES``; a flag on it is then classified ``out_of_scope``, not
``malicious``."""

MODERATION_CATEGORIES: tuple[str, ...] = HARM_MODERATION_CATEGORIES + TOPIC_MODERATION_CATEGORIES
"""Every category ``mistral-moderation-latest`` (``mistral-moderation-2603``) returns, verified against
the live API. The names are the model's own response keys. ``dangerous`` and ``criminal`` are two
separate categories: the ``dangerous_and_criminal_content`` name used by older docs does not exist in
this model."""

KNOWN_MODERATION_MODELS: dict[str, tuple[str, ...]] = {
    "mistral-moderation-latest": MODERATION_CATEGORIES,
    "mistral-moderation-2603": MODERATION_CATEGORIES,
}
"""The category names each known ``GUARDRAIL_MODERATION_MODEL`` returns. Category names are
model-specific, so validation and the empty-list default apply only to a model listed here. Add a
model when its response keys have been checked against the live API."""

_RENAMED_MODERATION_CATEGORIES: dict[str, tuple[str, ...]] = {
    "dangerous_and_criminal_content": ("dangerous", "criminal"),
}


def default_moderation_categories(model: str) -> list[str]:
    """The categories to check when ``GUARDRAIL_MODERATION_CATEGORIES`` is empty: the harm categories
    of a known model. A model this module does not know has no safe default, so it raises."""
    if model not in KNOWN_MODERATION_MODELS:
        raise ValueError(_unknown_model_message(model))
    return [name for name in KNOWN_MODERATION_MODELS[model] if name in HARM_MODERATION_CATEGORIES]


def _unknown_model_message(model: str) -> str:
    return (
        f"GUARDRAIL_MODERATION_MODEL={model!r} is not a model whose moderation categories are known "
        f"(known: {sorted(KNOWN_MODERATION_MODELS)!r}), so GUARDRAIL_MODERATION_CATEGORIES cannot default "
        "to its harm categories. List the categories to check in GUARDRAIL_MODERATION_CATEGORIES, "
        "using the names that model returns."
    )


def validate_moderation_categories(names: "list[str] | tuple[str, ...]", *, model: str, setting: str) -> list[str]:
    """Reject a moderation category name that ``model`` does not return.

    ``ModerationScanner`` only compares the names with the model's response at scan time, and raises
    there. The fail-closed policy turns that error into ``malicious``, so one misspelled name
    silently blocks every prompt. Checking the names up front fails with the list of valid names
    instead.

    The names are model-specific. For a model in :data:`KNOWN_MODERATION_MODELS` they are checked
    against that model's names. Any other model's names cannot be checked offline: they are
    returned unchanged, and ``ModerationScanner`` checks them against the model's response on
    every scan.
    """
    known = KNOWN_MODERATION_MODELS.get(model)
    if known is None:
        return list(names)
    unknown = [name for name in names if name not in known]
    if not unknown:
        return list(names)
    renamed = [
        f"{name!r} is now {' and '.join(repr(new) for new in _RENAMED_MODERATION_CATEGORIES[name])}"
        for name in unknown
        if name in _RENAMED_MODERATION_CATEGORIES
    ]
    hint = f" ({'; '.join(renamed)})" if renamed else ""
    raise ValueError(
        f"{setting} names moderation categories {unknown!r} that {model!r} does not return{hint}. "
        f"Valid names: {list(known)!r}."
    )


class GuardrailClassificationResponse(BaseModel):
    classification: GuardrailClassification


def _restricted_response_model(name: str, allowed: tuple[GuardrailClassification, ...]) -> type[BaseModel]:
    # Constrain a classifier's structured output to its declared decision space. A parsed
    # classification outside `allowed` is a prompt/config contract violation; raising here turns it
    # into a scanner error, which the policy treats as MALICIOUS (fail-closed), never a silent pass.
    allowed_set = frozenset(allowed)

    def _validate(cls: type, value: GuardrailClassification) -> GuardrailClassification:
        if value not in allowed_set:
            permitted = ", ".join(sorted(member.value for member in allowed_set))
            raise ValueError(f"classification {value.value!r} not in allowed {{{permitted}}}")
        return value

    return create_model(
        f"{name}_Response",
        classification=(GuardrailClassification, ...),
        __validators__={"_restrict_classification": field_validator("classification")(_validate)},
    )


@dataclass(frozen=True)
class PromptSpec:
    """How to build one LLM classifier's prompt. Provide exactly one source.

    - ``prompt_template``: a ready ``PromptTemplate`` subclass — full control,
      use this to render a versioned ``.j2`` yourself before passing it in. A
      supplied class is opaque to content hashing, so ``cache_identity`` is
      **required** with it: a stable, unique string you bump whenever the
      template's behaviour changes (e.g. ``"scope-check.v3"``). It, not the class,
      keys the response cache.
    - ``template_path``: a file whose text becomes the system prompt.
    - ``system_prompt_content``: inline system prompt text.

    ``task_description`` is appended for the ``template_path`` and
    ``system_prompt_content`` cases and ignored when ``prompt_template`` is given
    (that subclass already carries its own task description). ``cache_identity``
    applies only to ``prompt_template``; the other two are fingerprinted from
    their own content.
    """

    prompt_template: type[PromptTemplate] | None = None
    template_path: Path | str | None = None
    system_prompt_content: str | None = None
    task_description: str = ""
    cache_identity: str | None = None

    def __post_init__(self) -> None:
        sources = (self.prompt_template, self.template_path, self.system_prompt_content)
        if sum(source is not None for source in sources) != 1:
            raise ValueError("PromptSpec needs exactly one of prompt_template, template_path, or system_prompt_content")
        if self.template_path is not None and not Path(self.template_path).is_absolute():
            raise ValueError(
                "PromptSpec.template_path must be absolute — relative paths resolve against the worker's "
                "working directory, not this config module. Resolve it against your module, e.g. "
                "Path(__file__).parent / 'prompts/guardrails/x.j2', or pass a rendered prompt_template."
            )
        if self.prompt_template is not None and not self.cache_identity:
            raise ValueError(
                "PromptSpec.cache_identity is required with prompt_template: a supplied PromptTemplate "
                "class is opaque to content hashing, so give it a stable, unique identity that changes "
                "whenever the template's behaviour changes (e.g. 'scope-check.v3')."
            )
        if self.prompt_template is None and self.cache_identity is not None:
            raise ValueError(
                "PromptSpec.cache_identity applies only to prompt_template; template_path and "
                "system_prompt_content are fingerprinted from their own content."
            )

    def build(self) -> type[PromptTemplate]:
        if self.prompt_template is not None:
            return self.prompt_template
        if self.template_path is not None:
            system = Path(self.template_path).read_text(encoding="utf-8")
        else:
            system = self.system_prompt_content or ""
        return PromptTemplate.prompt_template_factory(
            system_prompt_content=system,
            task_description=self.task_description,
        )

    def fingerprint(self) -> str:
        """A stable, collision-free identity of this prompt, for cache isolation.

        Two behaviourally different prompts must never share a response cache. The parts are
        combined with :func:`json.dumps`, not a delimiter join, so a separator character inside any
        part cannot make two distinct prompts collide. Data sources are hashed by content — an inline
        string, or a file's bytes so editing it busts the cache — while a supplied ``PromptTemplate``
        is opaque and keyed by its explicit ``cache_identity`` (never by class name, which every
        factory-built template shares, and never by instantiating it with fake inputs).
        ``task_description`` participates because it is part of what the model is told.
        """
        source: list[str]
        if self.prompt_template is not None:
            source = ["template", self.cache_identity or ""]
        elif self.template_path is not None:
            path = Path(self.template_path)
            source = ["path", str(path), hashlib.sha256(path.read_bytes()).hexdigest()]
        else:
            source = ["inline", self.system_prompt_content or ""]
        return json.dumps([source, self.task_description], separators=(",", ":"))


@dataclass(frozen=True)
class ClassifierSpec:
    """One LLM classifier on an edge.

    ``allowed_classifications`` is the decision space this classifier is expected
    to emit — the prompt is what instructs the model, so write the decision space
    into ``prompt`` too. It is enforced: :meth:`response_model` restricts the
    classifier's structured output to this set, and an off-list result fails
    closed. ``model_name`` overrides ``GUARDRAIL_LLM_MODEL`` for this classifier
    only.
    """

    name: str
    prompt: PromptSpec
    allowed_classifications: tuple[GuardrailClassification, ...]
    model_name: str | None = None

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("ClassifierSpec.name must be non-empty")
        if not self.allowed_classifications:
            raise ValueError(f"ClassifierSpec {self.name!r} needs at least one allowed classification")
        if GuardrailClassification.SAFE not in self.allowed_classifications:
            # A decision space with no safe outcome (e.g. ``(UNSAFE,)``) makes the edge impossible to
            # pass: safe content is either mislabelled unsafe or fails response validation and becomes
            # fail-closed MALICIOUS, so every request is blocked. Every classifier must be able to clear.
            raise ValueError(f"ClassifierSpec {self.name!r} must allow the safe classification")

    def response_model(self) -> type[BaseModel]:
        return _restricted_response_model(self.name, self.allowed_classifications)

    def cache_fingerprint(self) -> str:
        """Behaviour-defining identity beyond edge/name/model (which the caller adds): the prompt
        identity and the decision space. Two specs differing in either must not share a response
        cache, and reusing a name with a changed prompt/policy must not serve a stale verdict.
        Encoded with :func:`json.dumps` so no field value can collide with the separators.
        """
        allowed = sorted(member.value for member in self.allowed_classifications)
        return json.dumps({"prompt": self.prompt.fingerprint(), "allowed": allowed}, separators=(",", ":"))
