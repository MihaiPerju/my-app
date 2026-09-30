"""Saved voices, served as plain reads and one create — not durable workflow work.

Listing and cloning are direct Voxtral round trips rather than workflow executions, which is why
this file holds hand-rolled handlers instead of a ``WorkflowRouter`` mount. It used to sit at
``/v1`` to stay outside the old ``/v1/workflows`` tree; that tree is gone, so it lives with the
rest of the feature and the distinction stays where it belongs — in the code, not the URL.

Both handlers bind ``""``, so the directory supplies the ``/voices`` segment, and they call the
speech activities directly, which resolve their own client and retry. Every failure collapses to
``503`` while ``from exc`` keeps the cause.
"""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from mistralai_capabilities.speech.activities import speech_voices_create, speech_voices_list
from mistralai_capabilities.speech.schemas import CreateVoiceRequest, ListVoicesResult, Voice

router = APIRouter(tags=["Voices"])


@router.get(
    "",
    operation_id="voices_list",
    responses={503: {"description": "The upstream voices API is unavailable"}},
)
async def list_voices(
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ListVoicesResult:
    try:
        return await speech_voices_list(limit=limit, offset=offset)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Failed to list voices") from exc


@router.post(
    "",
    operation_id="voices_create",
    responses={503: {"description": "The upstream voices API is unavailable"}},
)
async def create_voice(request: CreateVoiceRequest) -> Voice:
    try:
        return await speech_voices_create(request)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Failed to create voice") from exc
