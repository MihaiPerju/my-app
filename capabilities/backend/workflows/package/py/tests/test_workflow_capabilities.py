"""`workflow_capabilities` is what lets a caller-facing surface publish only what a workflow serves.

Every workflow here uses the SDK's own decorators rather than a stand-in: the function reads the
SDK's definition object, so a fake would test nothing but itself.
"""

import mistralai.workflows as workflows
import pytest
from pydantic import BaseModel
from mistralai_capabilities.workflows import client
from mistralai_capabilities.workflows.client import workflow_capabilities


class Input(BaseModel):
    message: str


class Output(BaseModel):
    echoed: str


@workflows.workflow.define(name="clients_test_capabilities_bare")
class BareWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: Input) -> Output:
        return Output(echoed=request.message)


@workflows.workflow.define(name="clients_test_capabilities_full")
class FullWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: Input) -> Output:
        return Output(echoed=request.message)

    @workflows.workflow.signal()
    async def nudge(self) -> None: ...

    @workflows.workflow.query()
    def progress(self) -> str:
        return "running"

    @workflows.workflow.update()
    async def revise(self) -> str:
        return "revised"


# `_internal=True` is the only way to declare a reserved name — the decorator refuses one
# otherwise — and it is exactly how the SDK's own chat plumbing registers these two. Declaring
# them here is what makes the filter, rather than an empty definition, the thing under test.
@workflows.workflow.define(name="clients_test_capabilities_reserved")
class ReservedWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: Input) -> Output:
        return Output(echoed=request.message)

    @workflows.workflow.query(name="__get_pending_inputs", _internal=True)
    def pending(self) -> str:
        return "none"

    @workflows.workflow.update(name="__submit_input", _internal=True)
    async def submit(self) -> str:
        return "accepted"

    @workflows.workflow.query()
    def progress(self) -> str:
        return "running"


def test_a_workflow_with_no_handlers_declares_no_commands() -> None:
    capabilities = workflow_capabilities(BareWorkflow)

    assert (capabilities.signals, capabilities.queries, capabilities.updates) == ((), (), ())


def test_declared_handlers_are_reported_by_name() -> None:
    capabilities = workflow_capabilities(FullWorkflow)

    assert capabilities.signals == ("nudge",)
    assert capabilities.queries == ("progress",)
    assert capabilities.updates == ("revise",)


def test_the_reserved_handlers_are_filtered_out_while_a_real_sibling_survives() -> None:
    """The definition holds all three; only the author's own may reach this app's contract."""
    declared = workflows.get_workflow_definition(ReservedWorkflow)
    assert {handler.name for handler in declared.queries} == {"__get_pending_inputs", "progress"}
    assert {handler.name for handler in declared.updates} == {"__submit_input"}

    capabilities = workflow_capabilities(ReservedWorkflow)

    assert capabilities.queries == ("progress",)
    assert capabilities.updates == ()


def test_the_reserved_sets_are_read_from_the_sdk_rather_than_restated(monkeypatch: pytest.MonkeyPatch) -> None:
    """A new internal handler must drop out of the contract on an SDK bump, not need a code change.

    Widening the set at runtime is what distinguishes reading from restating: a hardcoded list
    would keep reporting `progress`.
    """
    monkeypatch.setattr(client, "RESERVED_QUERY_NAMES", frozenset({"__get_pending_inputs", "progress"}))

    assert workflow_capabilities(ReservedWorkflow).queries == ()


def test_every_declared_signal_is_public_because_the_sdk_reserves_none() -> None:
    """There is no `RESERVED_SIGNAL_NAMES`; assuming a signal equivalent would silently drop routes."""
    import mistralai.workflows.core.config.config as sdk_config

    assert not [name for name in dir(sdk_config) if name.startswith("RESERVED_SIGNAL")]
    assert workflow_capabilities(FullWorkflow).signals == ("nudge",)


def test_a_class_that_was_never_defined_raises_rather_than_reporting_nothing() -> None:
    """An empty answer would read as "declares no handlers" for a class that declares no workflow."""

    class NotAWorkflow:
        pass

    with pytest.raises(ValueError, match="Cannot get definition"):
        workflow_capabilities(NotAWorkflow)
