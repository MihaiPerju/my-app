"""Speech-owned workflow names.

The workflow-tool assertions that lived here moved with `create_workflow_tools` to the agents
capability (`apps/worker/tests/agents/test_tooling.py`): exposing a workflow as an agent tool is
an agents-capability concern, and `speech` does not depend on `agents`, so its tests must not import
the agents-owned `worker.workflows.tooling`.
"""

from mistralai.workflows import get_workflow_definition
from mistralai.workflows.core.discovery import discover_workflows_in_module


def test_speech_workflows_have_stable_names() -> None:
    workflow_classes = discover_workflows_in_module("worker.workflows.speech")
    assert {get_workflow_definition(cls).name for cls in workflow_classes} == {
        "speech_transcribe",
        "speech_synthesize",
    }
