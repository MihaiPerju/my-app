from fastapi import FastAPI
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.fastapi_workflows_auth.commands import _commands
from support.auth import FakeUserStore, auth_headers, auth_hooks
from support.workflows_auth import FakeExecutionStore, FakeExecutor, workflow_auth_hooks

from conftest import build_app as build_host

USER_ID = "22222222-2222-2222-2222-222222222222"

auth = auth_headers


def build_app(*, commands: object | None = None, executions: FakeExecutionStore | None = None) -> FastAPI:
    users = FakeUserStore()
    execution_store = executions or FakeExecutionStore()
    app = build_host(
        hooks=FastAPIHooks.compose(auth_hooks(users), workflow_auth_hooks(FakeExecutor(), execution_store))
    )
    if commands is not None:
        app.dependency_overrides[_commands] = lambda: commands
    return app
