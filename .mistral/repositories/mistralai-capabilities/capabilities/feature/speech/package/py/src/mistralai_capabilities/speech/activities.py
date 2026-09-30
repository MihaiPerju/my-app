"""Speech activities: Voxtral audio transcription and speech synthesis.

The two Temporal activities are the only durable layer that calls the Mistral SDK. Both are thin
passthroughs with no side effects, so both use the read retry policy. :func:`mint_realtime_session`
is not an activity: the API path calls it directly with an explicit client and no retry policy.
"""

import base64
from datetime import timedelta

import mistralai.workflows as workflows
from env.mistral import env as mistral_env
from env.workflows import env as workflows_env
from mistralai.client import Mistral
from mistralai.client.models import FileTypedDict, TimestampGranularity
from mistralai.client.types import UNSET
from mistralai.client.types.basemodel import Unset
from mistralai.workflows import Depends
from mistralai_capabilities.speech.schemas import (
    CreateVoiceRequest,
    ListVoicesResult,
    RealtimeSessionRequest,
    RealtimeSessionToken,
    SynthesizeRequest,
    SynthesizeResult,
    TranscribeRequest,
    TranscribeResult,
    TranscriptionSegment,
    Voice,
)


def _mistral_client() -> Mistral:
    return Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)


# The public Mistral realtime endpoint the browser opens directly. The mint below never proxies
# audio; it only tells the client where to connect and hands it the token to do so.
_REALTIME_WS_BASE = "wss://api.mistral.ai"


def _speaker_id(segment: object) -> str | None:
    """The segment's speaker id, or None when diarization did not supply one.

    Test the sentinel by type, not truthiness. `UNSET or None` yields None only because
    `Unset.__bool__` returns False, which is an undocumented SDK detail that can change. Import
    `Unset` from `types.basemodel`, because `types` re-exports only the `UNSET` singleton.
    """
    speaker_id = getattr(segment, "speaker_id", None)
    if speaker_id is None or isinstance(speaker_id, Unset):
        return None
    return str(speaker_id) or None


@workflows.activity(
    name="speech.transcribe",
    start_to_close_timeout=timedelta(seconds=300),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def speech_transcribe(request: TranscribeRequest, client: Mistral = Depends(_mistral_client)) -> TranscribeResult:
    # Segment timings (and speaker ids) are only returned when a granularity is requested.
    granularities: list[TimestampGranularity] | None = ["segment"] if (request.timestamps or request.diarize) else None

    # The schema guarantees exactly one source. Inline bytes are streamed straight to
    # Voxtral as a multipart `file`; url/id are forwarded as-is, and every unused
    # source stays UNSET/None (omitted) rather than being sent as an explicit null.
    file: FileTypedDict | None = (
        {"file_name": request.file_name or "audio", "content": base64.b64decode(request.file_content)}
        if request.file_content
        else None
    )
    response = await client.audio.transcriptions.complete_async(
        model=request.model,
        file=file,
        file_url=str(request.file_url) if request.file_url else UNSET,
        file_id=request.file_id if request.file_id else UNSET,
        language=request.language,
        diarize=request.diarize,
        timestamp_granularities=granularities,
    )

    segments = [
        TranscriptionSegment(
            text=segment.text,
            start=segment.start,
            end=segment.end,
            speaker_id=_speaker_id(segment),
        )
        for segment in (response.segments or [])
    ]
    return TranscribeResult(
        model=response.model,
        text=response.text,
        language=response.language,
        segments=segments,
    )


@workflows.activity(
    name="speech.synthesize",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def speech_synthesize(request: SynthesizeRequest, client: Mistral = Depends(_mistral_client)) -> SynthesizeResult:
    # The schema guarantees exactly one voice source; forward only that one and leave
    # the other UNSET (omitted) rather than sending it as an explicit null.
    response = await client.audio.speech.complete_async(
        input=request.input,
        model=request.model,
        voice_id=request.voice_id if request.voice_id else UNSET,
        ref_audio=request.ref_audio if request.ref_audio else UNSET,
        response_format=request.response_format,
    )
    return SynthesizeResult(
        model=request.model,
        response_format=request.response_format,
        audio_base64=response.audio_data,
    )


def _optional(value: object) -> str | None:
    """A saved-voice string field, or None when the SDK left it UNSET/null/empty.

    ``OptionalNullable`` fields arrive as the truthy ``Unset`` sentinel, not None. A bare ``or
    None`` lets it through. Only the sentinel, None, and the empty string collapse to None.
    """
    if value is None or isinstance(value, Unset):
        return None
    return str(value) or None


def _map_voice(voice: object) -> Voice:
    """Map an SDK ``VoiceResponse`` down to the fields the app exposes."""
    languages = getattr(voice, "languages", None)
    return Voice(
        id=voice.id,
        name=voice.name,
        user_id=_optional(getattr(voice, "user_id", None)),
        languages=list(languages) if languages else [],
        gender=_optional(getattr(voice, "gender", None)),
        description=_optional(getattr(voice, "description", None)),
    )


@workflows.activity(
    name="speech.voices_list",
    start_to_close_timeout=timedelta(seconds=60),
    retry_policy_max_attempts=workflows_env.activity_read_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def speech_voices_list(
    limit: int = 100, offset: int = 0, client: Mistral = Depends(_mistral_client)
) -> ListVoicesResult:
    # `type_` defaults to "all", so the picker sees the built-in presets and the caller's saved
    # voices together — the free-text field it replaces could reach either.
    response = await client.audio.voices.list_async(limit=limit, offset=offset)
    return ListVoicesResult(
        voices=[_map_voice(voice) for voice in (response.items or [])],
        total=response.total,
    )


@workflows.activity(
    name="speech.voices_create",
    start_to_close_timeout=timedelta(seconds=120),
    retry_policy_max_attempts=workflows_env.activity_mutation_retry_max_attempts,
    retry_policy_backoff_coefficient=workflows_env.activity_retry_backoff_coefficient,
)
async def speech_voices_create(request: CreateVoiceRequest, client: Mistral = Depends(_mistral_client)) -> Voice:
    # A single language maps to the SDK's list; every other optional stays UNSET (omitted) rather
    # than sent as an explicit null, matching the synthesize passthrough above. Creation needs a
    # name, so fall back to the sample's file name when the caller left it blank.
    voice = await client.audio.voices.create_async(
        name=request.name or request.sample_filename or "Cloned voice",
        sample_audio=request.sample_audio,
        sample_filename=request.sample_filename if request.sample_filename else UNSET,
        languages=[request.language] if request.language else None,
        gender=request.gender if request.gender else UNSET,
        description=request.description if request.description else UNSET,
    )
    return _map_voice(voice)


async def mint_realtime_session(request: RealtimeSessionRequest, client: Mistral) -> RealtimeSessionToken:
    """Mint a short-lived client token for a browser-driven realtime transcription socket.

    This is not a Temporal activity. Minting runs in the API request path, so it takes the
    ``client`` explicitly and carries no retry policy. A transient failure surfaces as a 503. The
    mint returns only the ``rt_*`` token and the socket URL; ``MISTRAL_API_KEY`` never reaches the
    client.
    """
    result = await client.realtime.sessions.create_async(request={"purpose": "realtime", "model": request.model})
    ws_url = f"{_REALTIME_WS_BASE}/v1/audio/transcriptions/realtime?model={request.model}"
    return RealtimeSessionToken(
        token=result.client_secret.value,
        expires_at=result.client_secret.expires_at,
        ws_url=ws_url,
    )
