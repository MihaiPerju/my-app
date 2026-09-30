"""Speech workflows: transcribe audio with Voxtral, and synthesize it back.

Two operations, two workflows: each entrypoint takes one Pydantic request and delegates to its
activity. Discovery picks them up. The HTTP surface is hand-written in ``routers/api/v1/speech.py``;
these classes declare no route.
"""

import mistralai.workflows as workflows
from mistralai.workflows import workflow as _wf

with _wf.unsafe.imports_passed_through():
    from mistralai_capabilities.speech import activities
    from mistralai_capabilities.speech.schemas import (
        SynthesizeRequest,
        SynthesizeResult,
        TranscribeRequest,
        TranscribeResult,
    )


@workflows.workflow.define(name="speech_transcribe", workflow_display_name="Transcribe audio")
class SpeechTranscribeWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: TranscribeRequest) -> TranscribeResult:
        return await activities.speech_transcribe(request)


@workflows.workflow.define(name="speech_synthesize", workflow_display_name="Synthesize speech")
class SpeechSynthesizeWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: SynthesizeRequest) -> SynthesizeResult:
        return await activities.speech_synthesize(request)
