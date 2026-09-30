"""Speech synthesis, served as workflow executions.

The sibling of ``speech_transcribe``: the entrypoint reflects, ``wait_for_result=True`` answers
``200`` with the audio, and ``name`` is the registered workflow name. Two mounts are needed and must
not share a ``name``, which is the operation-id stem; a collision fails the build.
"""

from mistralai_capabilities.fastapi_workflows_auth.router import WorkflowRouter
from worker.workflows.speech import SpeechSynthesizeWorkflow

router = WorkflowRouter(
    SpeechSynthesizeWorkflow,
    name="speech_synthesize",
    wait_for_result=True,
)
