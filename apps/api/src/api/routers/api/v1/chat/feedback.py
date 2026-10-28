"""A rating on one assistant answer, forwarded to Studio observability and stored nowhere.

The control plane has no feedback surface, so this route does not forward to it and is a separate
module, not an eighth ``VibeAgentsRouter`` operation. The rating leaves as an OTLP
``gen_ai.evaluation.result`` event and is never written here, so a reload forgets it. Chat owns no
table (D29), and the signal is filterable in the Trace Explorer by ``gen_ai.conversation.id``.
"""

from env.vibe_agents import env as vibe_env
from fastapi import APIRouter
from mistralai_capabilities.chat.vibe.schemas import ChatFeedbackRequest
from mistralai_capabilities.fastapi_auth.identity import CurrentUser
from utils.telemetry import record_evaluation_result

EVALUATION_NAME = "user_feedback"

_SCORES: dict[str, tuple[float, str]] = {"up": (1.0, "positive"), "down": (0.0, "negative")}

router = APIRouter()


@router.post("", status_code=204, operation_id="chat_submit_feedback", summary="Rate an assistant answer")
async def submit_feedback(body: ChatFeedbackRequest, user: CurrentUser) -> None:
    score_value, score_label = _SCORES[body.rating]
    record_evaluation_result(
        name=EVALUATION_NAME,
        score_value=score_value,
        score_label=score_label,
        attributes={
            "gen_ai.conversation.id": body.session_id,
            "gen_ai.agent.name": vibe_env.vibe_agents_agent_name,
            "mistral.message.id": body.message_id,
            "enduser.id": str(user.user_id),
        },
        trace_id=body.trace_id,
        span_id=body.span_id,
    )
