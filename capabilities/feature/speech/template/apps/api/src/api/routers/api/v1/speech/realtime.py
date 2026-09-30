"""Minting a short-lived client token for browser-driven realtime transcription.

This is not under ``workflows/``: minting a token is a stateless POST, not a durable execution. The
server never proxies the audio. It hands the browser an ``rt_*`` token and the external Mistral
socket URL, and the browser opens the WebSocket to ``api.mistral.ai``. ``MISTRAL_API_KEY`` stays
server-side; the token is the only credential that crosses to the client.
"""

from fastapi import APIRouter, HTTPException
from mistralai_capabilities.speech.activities import mint_realtime_session
from mistralai_capabilities.speech.schemas import RealtimeSessionRequest, RealtimeSessionToken
from utils.mistral import MistralNotConfiguredError, caller_mistral_client

router = APIRouter(tags=["Speech"])


@router.post(
    "/session",
    operation_id="speech_realtime_session",
    responses={503: {"description": "Realtime session minting is unavailable"}},
)
async def create_realtime_session(
    # One shared instance would be constructed at import and reused for every request that omits a
    # body. The model is not frozen, so anything mutating it would leak across callers; default to
    # None and build per request instead.
    body: RealtimeSessionRequest | None = None,
) -> RealtimeSessionToken:
    request = body or RealtimeSessionRequest()
    try:
        client = caller_mistral_client()
    except MistralNotConfiguredError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    try:
        return await mint_realtime_session(request, client)
    except Exception as error:
        # Never echo the upstream exception text: a provider error can carry internal detail, and
        # the type name is all the browser needs to decide to retry. The 503 keeps a transient mint
        # failure retryable without leaking what failed.
        raise HTTPException(status_code=503, detail=f"Session creation failed: {type(error).__name__}") from error
