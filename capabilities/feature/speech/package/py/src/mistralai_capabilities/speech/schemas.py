"""Loop-boundary contract for the Speech (``speech``) feature.

Activities, workflows, and the web client import this frozen field contract. Transcription takes
``file_url``, ``file_id``, or base64 ``file_content``; synthesis returns ``audio_base64`` and its
``response_format``. A voice uses ``voice_id``; ``user_id`` is ``None`` for presets the picker hides.
"""

from datetime import datetime
from typing import Self

from mistralai.client.models import SpeechOutputFormat
from pydantic import AnyHttpUrl, BaseModel, Field, model_validator

_DEFAULT_TRANSCRIBE_MODEL = "voxtral-mini-latest"
_DEFAULT_TTS_MODEL = "voxtral-mini-tts-2603"
_DEFAULT_REALTIME_MODEL = "voxtral-mini-transcribe-realtime-2602"

# Reuse the SDK's output-format enum directly so the two can never drift.
SpeechFormat = SpeechOutputFormat

__all__ = [
    "CreateVoiceRequest",
    "ListVoicesResult",
    "RealtimeSessionRequest",
    "RealtimeSessionToken",
    "SpeechFormat",
    "SynthesizeRequest",
    "SynthesizeResult",
    "TranscribeRequest",
    "TranscribeResult",
    "TranscriptionSegment",
    "Voice",
]


class TranscribeRequest(BaseModel):
    """Transcribe one audio file referenced by public URL or uploaded file id."""

    file_url: AnyHttpUrl | None = Field(
        default=None,
        description="Publicly fetchable audio URL; bytes are fetched server-side. Mutually exclusive with file_id.",
    )
    file_id: str | None = Field(
        default=None,
        description="ID of a file uploaded to Mistral /v1/files. Mutually exclusive with file_url.",
    )
    file_content: str | None = Field(
        default=None,
        description="Base64-encoded audio bytes uploaded inline. Mutually exclusive with file_url and file_id.",
    )
    file_name: str | None = Field(
        default=None,
        description="Optional display/name for inline file_content (e.g. 'meeting.mp3').",
    )
    model: str = Field(default=_DEFAULT_TRANSCRIBE_MODEL, description="Mistral transcription (Voxtral) model.")
    language: str | None = Field(
        default=None,
        description="ISO-639-1 language hint (e.g. 'en'); auto-detected when omitted. Providing it can boost accuracy.",
    )
    diarize: bool = Field(default=False, description="Attribute speakers to segments (who spoke when).")
    timestamps: bool = Field(default=False, description="Return per-segment start/end timestamps.")

    @model_validator(mode="after")
    def _exactly_one_source(self) -> Self:
        provided = sum(bool(source) for source in (self.file_url, self.file_id, self.file_content))
        if provided != 1:
            raise ValueError("Provide exactly one audio source: file_url, file_id, or file_content")
        return self


class TranscriptionSegment(BaseModel):
    """A timed transcript segment, optionally attributed to a speaker."""

    text: str = Field(description="Transcribed text for this segment.")
    start: float = Field(description="Segment start time in seconds.")
    end: float = Field(description="Segment end time in seconds.")
    speaker_id: str | None = Field(default=None, description="Speaker label when diarization is enabled.")


class TranscribeResult(BaseModel):
    model: str = Field(description="Model that produced the transcription.")
    text: str = Field(description="Full transcribed text.")
    language: str | None = Field(default=None, description="Detected (or provided) language code.")
    segments: list[TranscriptionSegment] = Field(
        default_factory=list,
        description="Per-segment timings; empty unless timestamps or diarization were requested.",
    )


class SynthesizeRequest(BaseModel):
    """Synthesize speech audio from text using Voxtral TTS."""

    input: str = Field(min_length=1, description="Text to synthesize into speech.")
    model: str = Field(default=_DEFAULT_TTS_MODEL, description="Mistral TTS (Voxtral) model.")
    voice_id: str | None = Field(
        default=None,
        description="Preset or saved custom voice to speak with. Provide this or ref_audio.",
    )
    ref_audio: str | None = Field(
        default=None,
        description="Base64-encoded reference audio (3-25s, single speaker) for zero-shot voice cloning.",
    )
    response_format: SpeechFormat = Field(default="mp3", description="Output audio container/codec.")

    @model_validator(mode="after")
    def _exactly_one_voice(self) -> Self:
        if bool(self.voice_id) == bool(self.ref_audio):
            raise ValueError("Provide exactly one voice source: voice_id or ref_audio")
        return self


class SynthesizeResult(BaseModel):
    model: str = Field(description="Model that produced the audio.")
    response_format: SpeechFormat = Field(description="Encoding of audio_base64.")
    audio_base64: str = Field(description="Base64-encoded synthesized audio in the requested format.")


class RealtimeSessionRequest(BaseModel):
    """Ask for a short-lived client token to drive a browser WebSocket transcription."""

    model: str = Field(
        default=_DEFAULT_REALTIME_MODEL,
        description="Mistral realtime transcription (Voxtral) model the minted session will use.",
    )


class RealtimeSessionToken(BaseModel):
    """A minted ``rt_*`` client token plus the external socket the browser opens itself.

    The server never proxies the audio: it hands back this token and the Mistral realtime
    ``ws_url``, and the browser connects straight to ``api.mistral.ai``. The token is the only
    credential that crosses to the client — ``MISTRAL_API_KEY`` never leaves the server.
    """

    token: str = Field(description="Short-lived client secret (``rt_*``) authenticating the browser socket.")
    expires_at: datetime = Field(description="When the token stops being accepted; mint a new one after this.")
    ws_url: str = Field(description="External Mistral realtime transcription WebSocket URL the browser opens.")


class Voice(BaseModel):
    """A preset or saved custom voice the synthesis form can speak with."""

    id: str = Field(description="Opaque voice id; pass this as SynthesizeRequest.voice_id.")
    name: str = Field(description="Human-readable voice name shown in the picker.")
    user_id: str | None = Field(
        default=None,
        description="Owner of a custom voice; None for a preset. Preset voices cannot be mutated.",
    )
    languages: list[str] = Field(
        default_factory=list,
        description="Languages the voice is tagged for; empty when the voice declares none.",
    )
    gender: str | None = Field(default=None, description="Voice gender label, when the voice declares one.")
    description: str | None = Field(default=None, description="Free-text description, when the voice declares one.")


class ListVoicesResult(BaseModel):
    voices: list[Voice] = Field(default_factory=list, description="The requested page of voices.")
    total: int = Field(description="Total number of voices matching the query across all pages.")


class CreateVoiceRequest(BaseModel):
    """Clone a new saved voice from a single reference audio sample."""

    sample_audio: str = Field(
        min_length=1,
        description="Base64-encoded reference audio (3-25s, single speaker) to clone the voice from.",
    )
    sample_filename: str | None = Field(
        default=None,
        description="Original file name of the sample; its extension helps the API detect the codec.",
    )
    name: str | None = Field(
        default=None,
        description="Name for the new voice; a name is derived from the sample file when omitted.",
    )
    language: str | None = Field(
        default=None,
        description="ISO-639-1 language the voice is tagged for (e.g. 'en').",
    )
    gender: str | None = Field(default=None, description="Optional gender label for the new voice.")
    description: str | None = Field(default=None, description="Optional free-text description for the new voice.")
