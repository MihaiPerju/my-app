"""``create_workflow_tools``: turn workflow classes into agent tools.

It returns one ``@agents.tool`` per workflow class, reusing the workflow's name, description, and
entrypoint models. Each handler runs the workflow via ``execute_workflow``, written as a
child-workflow call but run inline in the tool's Temporal activity today. Each tool is installed as
a module attribute (``<name>_tool``), so the Agents SDK can dispatch it by dotted import path.
"""

import sys
from collections.abc import Iterable
from typing import Any

from mistralai.agents import agents
from mistralai.workflows import execute_workflow, get_workflow_definition
from mistralai_capabilities.workflows.client import infer_workflow_models


def _tool_for(cls: type) -> Any:
    definition = get_workflow_definition(cls)
    if definition is None:
        raise TypeError(f"{cls.__name__} must be decorated with @workflows.workflow.define")
    export = f"{definition.name}_tool"
    module = sys.modules[cls.__module__]
    existing = getattr(module, export, None)
    if existing is not None:
        return existing

    request_type, return_type = infer_workflow_models(cls)
    if return_type is None:
        raise TypeError(f"{cls.__name__} entrypoint must declare a return type")
    description = definition.description or definition.display_name or (cls.__doc__ or "").strip() or definition.name

    async def handler(args: Any) -> Any:
        return await execute_workflow(cls, args)

    handler.__name__ = export
    handler.__qualname__ = export
    handler.__module__ = cls.__module__
    handler.__annotations__ = {"args": request_type, "return": return_type}

    # `model_access="direct"` keeps these callable by the model itself, as they were on the alpha
    # runtime; the Unified Harness otherwise exposes an authored tool only to the sandbox runtime.
    tool = agents.tool(
        name=definition.name,
        description=description,
        input_schema=request_type,
        model_access="direct",
    )(handler)
    setattr(module, export, tool)
    return tool


def create_workflow_tools(workflow_classes: Iterable[type]) -> list[Any]:
    """Return one ``@agents.tool`` ToolDefinition per workflow class (idempotent per module)."""
    return [_tool_for(cls) for cls in workflow_classes]
