import json
from types import SimpleNamespace
from typing import Any

import pytest
from mistralai.client.models import WorkflowScheduleRequest
from mistralai_capabilities.workflows import client as workflows_client
from mistralai_capabilities.workflows.client import ScheduleTimingError


class _NotFound(Exception):
    status_code = 404


class _Conflict(Exception):
    status_code = 409


class _FakeSchedules:
    """Records calls, but builds the real SDK request models first.

    The fake must validate, not just record. An earlier version recorded raw kwargs, which let
    the create path pass a ``mistralai.workflows`` model into a client-models parameter, a
    pydantic ValidationError at runtime that every test still reported green.
    """

    def __init__(self, *, present: bool = False) -> None:
        self._present = present
        self.created: list[dict[str, Any]] = []
        self.updated: list[dict[str, Any]] = []
        self.paused: list[dict[str, Any]] = []
        self.gets = 0

    async def get_schedule_async(self, **_: Any) -> Any:
        self.gets += 1
        if not self._present:
            raise _NotFound
        return object()

    async def schedule_workflow_async(self, **kwargs: Any) -> str:
        WorkflowScheduleRequest(
            schedule=kwargs["schedule"],
            workflow_identifier=kwargs.get("workflow_identifier"),
            deployment_name=kwargs.get("deployment_name"),
        )
        self.created.append(kwargs)
        return "created"

    async def update_schedule_async(self, **kwargs: Any) -> str:
        self.updated.append(kwargs)
        return "updated"

    async def pause_schedule_async(self, **kwargs: Any) -> str:
        if not self._present:
            raise _NotFound
        self.paused.append(kwargs)
        return "paused"


def _install(monkeypatch: pytest.MonkeyPatch, schedules: _FakeSchedules) -> None:
    client = SimpleNamespace(workflows=SimpleNamespace(schedules=schedules))
    monkeypatch.setattr(workflows_client, "Mistral", lambda **_kwargs: client)
    monkeypatch.setattr(workflows_client, "MistralError", (_NotFound, _Conflict))


@pytest.mark.asyncio
async def test_rejects_neither_interval_nor_cron(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _FakeSchedules())
    with pytest.raises(ScheduleTimingError):
        await workflows_client.upsert_schedule(schedule_id="s", workflow_identifier="w", input={})


@pytest.mark.asyncio
async def test_rejects_both_interval_and_cron(monkeypatch: pytest.MonkeyPatch) -> None:
    _install(monkeypatch, _FakeSchedules())
    with pytest.raises(ScheduleTimingError):
        await workflows_client.upsert_schedule(
            schedule_id="s", workflow_identifier="w", input={}, interval_seconds=60, cron_expressions=["0 3 * * *"]
        )


@pytest.mark.asyncio
async def test_create_is_the_only_call_needed(monkeypatch: pytest.MonkeyPatch) -> None:
    # The platform resolves an existing id to an update, so probing with a GET first is
    # a wasted round trip on every deploy.
    schedules = _FakeSchedules()
    _install(monkeypatch, schedules)

    await workflows_client.upsert_schedule(
        schedule_id="s", workflow_identifier="w", input={}, cron_expressions=["0 3 * * *"]
    )

    assert schedules.gets == 0
    assert len(schedules.created) == 1
    assert schedules.updated == []


@pytest.mark.asyncio
async def test_create_sends_the_expected_wire_body(monkeypatch: pytest.MonkeyPatch) -> None:
    schedules = _FakeSchedules()
    _install(monkeypatch, schedules)

    await workflows_client.upsert_schedule(
        schedule_id="eval-1",
        workflow_identifier="agent_evaluation",
        input={"local": False},
        cron_expressions=["0 3 * * *"],
        pause_on_failure=True,
        deployment_name="prod",
    )

    request = WorkflowScheduleRequest(
        schedule=schedules.created[0]["schedule"],
        workflow_identifier=schedules.created[0]["workflow_identifier"],
        deployment_name=schedules.created[0]["deployment_name"],
    )
    assert json.loads(request.model_dump_json()) == {
        "schedule": {
            "input": {"local": False},
            "intervals": [],
            "cron_expressions": ["0 3 * * *"],
            "policy": {"catchup_window_seconds": 86400, "overlap": 1, "pause_on_failure": True},
            "schedule_id": "eval-1",
        },
        "workflow_identifier": "agent_evaluation",
        "deployment_name": "prod",
    }


@pytest.mark.asyncio
async def test_create_encodes_an_interval_as_an_iso_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    schedules = _FakeSchedules()
    _install(monkeypatch, schedules)

    await workflows_client.upsert_schedule(
        schedule_id="s", workflow_identifier="search_reconcile", input={}, interval_seconds=86400
    )

    schedule = schedules.created[0]["schedule"]
    assert schedule.cron_expressions == []
    assert schedule.intervals[0].every == "PT86400S"


@pytest.mark.asyncio
async def test_schedule_id_travels_in_the_body_not_as_a_kwarg(monkeypatch: pytest.MonkeyPatch) -> None:
    # The top-level schedule_id kwarg is deprecated upstream; the body field is the durable one.
    schedules = _FakeSchedules()
    _install(monkeypatch, schedules)

    await workflows_client.upsert_schedule(
        schedule_id="s", workflow_identifier="w", input={}, cron_expressions=["0 3 * * *"]
    )

    assert "schedule_id" not in schedules.created[0]
    assert schedules.created[0]["schedule"].schedule_id == "s"


@pytest.mark.asyncio
async def test_a_failed_create_falls_back_to_update(monkeypatch: pytest.MonkeyPatch) -> None:
    schedules = _FakeSchedules()

    async def conflict(**_: Any) -> None:
        raise _Conflict

    monkeypatch.setattr(schedules, "schedule_workflow_async", conflict)
    _install(monkeypatch, schedules)

    await workflows_client.upsert_schedule(
        schedule_id="s", workflow_identifier="w", input={}, cron_expressions=["0 4 * * *"], pause_on_failure=True
    )

    patch = schedules.updated[0]
    assert patch["schedule_id"] == "s"
    assert patch["schedule"].cron_expressions == ["0 4 * * *"]
    assert patch["schedule"].policy.pause_on_failure is True


@pytest.mark.asyncio
async def test_pause_reports_whether_schedule_existed(monkeypatch: pytest.MonkeyPatch) -> None:
    present = _FakeSchedules(present=True)
    _install(monkeypatch, present)
    assert await workflows_client.pause_schedule_if_present(schedule_id="s", note="off") is True
    assert present.paused[0]["schedule_id"] == "s"

    absent = _FakeSchedules(present=False)
    _install(monkeypatch, absent)
    assert await workflows_client.pause_schedule_if_present(schedule_id="s", note="off") is False
