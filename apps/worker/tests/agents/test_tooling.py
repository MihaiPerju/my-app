"""Tests for create_workflow_tools (workflow classes -> agent tools)."""

import sys

import mistralai.workflows as workflows
from pydantic import BaseModel
from worker.workflows.tooling import create_workflow_tools


class DemoRequest(BaseModel):
    value: str


class DemoResult(BaseModel):
    value: str


@workflows.workflow.define(name="demo_echo", workflow_display_name="Demo echo")
class DemoWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: DemoRequest) -> DemoResult:
        return DemoResult(value=request.value)


def test_creates_one_tool_per_workflow_using_workflow_names() -> None:
    tools = create_workflow_tools([DemoWorkflow])
    assert {tool.name for tool in tools} == {"demo_echo"}


def test_tool_input_schema_is_the_entrypoint_request_model() -> None:
    tools = {tool.name: tool for tool in create_workflow_tools([DemoWorkflow])}
    assert tools["demo_echo"].input_schema is DemoRequest


def test_tools_are_module_anchored_and_importable_by_name() -> None:
    create_workflow_tools([DemoWorkflow])
    assert sys.modules[DemoWorkflow.__module__].demo_echo_tool.name == "demo_echo"


def test_create_workflow_tools_is_idempotent_per_module() -> None:
    first = create_workflow_tools([DemoWorkflow])
    second = create_workflow_tools([DemoWorkflow])
    assert {id(tool) for tool in first} == {id(tool) for tool in second}
