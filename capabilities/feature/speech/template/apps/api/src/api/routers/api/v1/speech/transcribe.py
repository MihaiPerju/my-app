"""Transcription, served as workflow executions.

The entrypoint reflects one Pydantic argument and its return hint, so no ``request_model=`` is
needed. ``wait_for_result=True`` answers ``200`` with the transcription instead of ``202``. ``name``
must match ``@workflow.define(name=...)``; a drift yields an empty listing.
"""

from mistralai_capabilities.fastapi_workflows_auth.router import WorkflowRouter
from worker.workflows.speech import SpeechTranscribeWorkflow

router = WorkflowRouter(
    SpeechTranscribeWorkflow,
    name="speech_transcribe",
    wait_for_result=True,
)
