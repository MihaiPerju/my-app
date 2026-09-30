from mistralai_capabilities.guardrails.spec import GuardrailEdge
from pydantic import BaseModel

__all__ = ["GuardrailEdge", "GuardrailMessage", "GuardrailScanRequest", "GuardrailScanResult"]


class GuardrailMessage(BaseModel):
    role: str
    content: str


class GuardrailScanRequest(BaseModel):
    messages: list[GuardrailMessage]
    # Which edge of the turn is being scanned. It selects the per-edge scanner set (see
    # env.guardrail.llm_classifiers) and labels the verdict: "blocked" on "input" refused a prompt,
    # on "output" withheld an answer, and those are different incidents. Defaulted rather than
    # required so an in-flight execution replaying an older payload still deserializes (D11).
    edge: GuardrailEdge = "input"


class GuardrailScanResult(BaseModel):
    classification: str
    blocked: bool
    refusal: str | None = None
