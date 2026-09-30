import api.routers.api.v1.speech.voices as voices_route
import pytest
from fastapi.testclient import TestClient
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
from mistralai_capabilities.speech.schemas import (
    CreateVoiceRequest,
    ListVoicesResult,
    Voice,
)
from support.auth import FakeUserStore, auth_headers, auth_hooks
from support.workflows_auth import FakeExecutionStore, FakeExecutor, workflow_auth_hooks

from conftest import build_app


@pytest.fixture
def users() -> FakeUserStore:
    return FakeUserStore()


@pytest.fixture
def executor() -> FakeExecutor:
    return FakeExecutor()


@pytest.fixture
def client(executor: FakeExecutor, users: FakeUserStore) -> TestClient:
    hooks = FastAPIHooks.compose(auth_hooks(users), workflow_auth_hooks(executor, FakeExecutionStore()))
    return TestClient(build_app(hooks=hooks, routers="api.routers"))


def test_list_voices_returns_presets_and_saved_voices(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_list(*, limit: int, offset: int) -> ListVoicesResult:
        assert (limit, offset) == (100, 0)
        return ListVoicesResult(
            voices=[
                Voice(id="en_paul_neutral", name="Paul", user_id=None),
                Voice(id="voice-1", name="Mine", user_id="user-1", languages=["en"]),
            ],
            total=2,
        )

    monkeypatch.setattr(voices_route, "speech_voices_list", fake_list)

    res = client.get("/api/v1/speech/voices", headers=auth_headers())

    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 2
    # user_id is the ownership marker the web picker keys clone controls off: null for the preset,
    # set for the caller's saved voice.
    assert [(v["id"], v["user_id"]) for v in body["voices"]] == [
        ("en_paul_neutral", None),
        ("voice-1", "user-1"),
    ]


def test_create_voice_clones_from_a_sample(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_create(request: CreateVoiceRequest) -> Voice:
        assert isinstance(request, CreateVoiceRequest)
        assert request.sample_audio == "AAAA"
        return Voice(id="voice-new", name=request.name or "", user_id="user-1", languages=["en"])

    monkeypatch.setattr(voices_route, "speech_voices_create", fake_create)

    res = client.post(
        "/api/v1/speech/voices",
        json={"sample_audio": "AAAA", "name": "My clone", "language": "en"},
        headers=auth_headers(),
    )

    assert res.status_code == 200
    body = res.json()
    assert body["id"] == "voice-new"
    assert body["name"] == "My clone"
    assert body["user_id"] == "user-1"


def test_create_voice_without_a_sample_is_a_validation_error(
    client: TestClient,
) -> None:
    assert client.post("/api/v1/speech/voices", json={"name": "x"}, headers=auth_headers()).status_code == 422


def test_list_voices_does_not_leak_upstream_error_detail(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing_list(*, limit: int, offset: int) -> ListVoicesResult:
        raise RuntimeError("secret upstream detail")

    monkeypatch.setattr(voices_route, "speech_voices_list", failing_list)

    res = client.get("/api/v1/speech/voices", headers=auth_headers())

    assert res.status_code == 503
    assert res.json()["detail"] == "Failed to list voices"
    assert "secret upstream detail" not in res.text


def test_create_voice_does_not_leak_upstream_error_detail(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing_create(request: CreateVoiceRequest) -> Voice:
        raise RuntimeError("secret upstream detail")

    monkeypatch.setattr(voices_route, "speech_voices_create", failing_create)

    res = client.post("/api/v1/speech/voices", json={"sample_audio": "AAAA"}, headers=auth_headers())

    assert res.status_code == 503
    assert res.json()["detail"] == "Failed to create voice"
    assert "secret upstream detail" not in res.text
