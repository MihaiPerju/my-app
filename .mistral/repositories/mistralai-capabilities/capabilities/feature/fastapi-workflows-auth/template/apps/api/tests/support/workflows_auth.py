from collections.abc import AsyncIterator, Sequence
from typing import Any

from fastapi import FastAPI
from mistralai.workflows import get_workflow_definition
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.fastapi_workflows_auth.commands import (
    _cancel,
    _start,
    _stream,
)
from mistralai_capabilities.fastapi_workflows_auth.ownership import _executions
from mistralai_capabilities.workflows.client import WorkflowRun
from pydantic import BaseModel


class FakeExecutor:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.cancelled: list[str] = []
        self.results: dict[str, BaseModel] = {}

    async def start(
        self,
        workflow_class: type,
        workflow_input: BaseModel,
        *,
        wait_for_result: bool,
        timeout_seconds: float | None = None,
        execution_id: str | None = None,
    ) -> WorkflowRun:
        name = get_workflow_definition(workflow_class).name
        self.calls.append(
            {
                "name": name,
                "input": workflow_input,
                "wait_for_result": wait_for_result,
                "timeout_seconds": timeout_seconds,
                "execution_id": execution_id,
            }
        )
        return WorkflowRun(execution_id=execution_id or "exec-1", result=self.results.get(name))

    async def stream(self, execution_id: str, **_: object) -> AsyncIterator[Any]:
        yield {"event": "completed", "id": "2", "data": {"execution_id": execution_id}}

    async def cancel(self, execution_id: str) -> None:
        self.cancelled.append(execution_id)


class FakeExecutionStore:
    def __init__(self, owned: set[tuple[str, str, str]] | None = None) -> None:
        self.owned = owned if owned is not None else set()
        self.outcomes_by_owner: dict[tuple[str, str], str] = {}

    async def record(self, *, execution_id: str, user_id: str, workflow_name: str) -> None:
        self.owned.add((execution_id, user_id, workflow_name))

    async def is_owned_by(self, *, execution_id: str, user_id: str, workflow_name: str) -> bool:
        return (execution_id, user_id, workflow_name) in self.owned

    async def set_outcome(self, *, execution_id: str, user_id: str, outcome: str) -> bool:
        if (execution_id, user_id) in self.outcomes_by_owner:
            return False
        self.outcomes_by_owner[(execution_id, user_id)] = outcome
        return True

    async def outcomes(self, *, execution_ids: Sequence[str], user_id: str) -> dict[str, str]:
        return {
            execution_id: self.outcomes_by_owner[(execution_id, user_id)]
            for execution_id in execution_ids
            if (execution_id, user_id) in self.outcomes_by_owner
        }


def workflow_auth_hooks(executor: FakeExecutor, executions: FakeExecutionStore) -> FastAPIHooks:
    def configure(app: FastAPI) -> None:
        app.dependency_overrides[_executions] = lambda: executions
        app.dependency_overrides[_start] = lambda: executor.start
        app.dependency_overrides[_stream] = lambda: executor.stream
        app.dependency_overrides[_cancel] = lambda: executor.cancel

    return FastAPIHooks(configure_hooks=(("workflows_auth", configure),))
