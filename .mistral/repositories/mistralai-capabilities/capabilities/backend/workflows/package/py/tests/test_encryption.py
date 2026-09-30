"""Both halves of payload encryption: the resolved config, and how each SDK entry point gets it.

The failure this suite catches is silent. A worker that encrypts while the API does not decrypt
raises nothing, so the assertions are about what each side is handed, not about a round trip.
"""

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from env.workflows import env as workflows_env
from mistralai.extra.workflows.encoding.config import PayloadEncryptionMode
from mistralai.workflows.core.config.config import config as sdk_config
from pydantic import SecretStr
from mistralai_capabilities.workflows import client as workflows_client
from mistralai_capabilities.workflows.encryption import EncryptionNotConfiguredError, payload_encryption

_KEY = "deadbeef" * 8
_OTHER_KEY = "abad1dea" * 8


@pytest.fixture(autouse=True)
def _reset() -> Any:
    payload_encryption.cache_clear()
    workflows_client._encoded_clients.clear()
    yield
    payload_encryption.cache_clear()
    workflows_client._encoded_clients.clear()


@pytest.fixture(autouse=True)
def _restore_sdk_config() -> Any:
    # ``run_worker`` configures the SDK's module-level config; restore it the way the SDK does.
    snapshot = sdk_config.model_copy(deep=True)
    yield
    sdk_config.__dict__.update(snapshot.__dict__)


def _configure(monkeypatch: pytest.MonkeyPatch, mode: str, key: str | None, previous: str | None = None) -> None:
    monkeypatch.setattr(workflows_env, "workflows_encryption_mode", mode)
    monkeypatch.setattr(workflows_env, "workflows_encryption_key", SecretStr(key) if key else None)
    monkeypatch.setattr(workflows_env, "workflows_encryption_previous_key", SecretStr(previous) if previous else None)


def test_off_yields_no_config(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "off", _KEY)
    assert payload_encryption() is None


@pytest.mark.parametrize("mode", ["partial", "full"])
def test_a_mode_without_a_key_is_refused(monkeypatch: pytest.MonkeyPatch, mode: str) -> None:
    _configure(monkeypatch, mode, None)
    with pytest.raises(EncryptionNotConfiguredError, match="requires WORKFLOWS_ENCRYPTION_KEY"):
        payload_encryption()


@pytest.mark.parametrize("bad", ["nothex!!", "abc", "de" * 20])
def test_a_malformed_key_is_refused_at_startup(monkeypatch: pytest.MonkeyPatch, bad: str) -> None:
    # The SDK would otherwise fail inside a payload round-trip, far from the cause.
    _configure(monkeypatch, "full", bad)
    with pytest.raises(EncryptionNotConfiguredError):
        payload_encryption()


def test_the_sdk_own_variables_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "full", _KEY)
    monkeypatch.setenv("TEMPORAL_PAYLOAD_ENCRYPTION__MODE", "partial")
    with pytest.raises(EncryptionNotConfiguredError, match="TEMPORAL_PAYLOAD_ENCRYPTION__MODE"):
        payload_encryption()


def test_the_public_dev_key_is_flagged(monkeypatch: pytest.MonkeyPatch) -> None:
    # The key every generated app starts with is public; running on it must not go unnoticed.
    warnings: list[str] = []
    monkeypatch.setattr(
        "mistralai_capabilities.workflows.encryption.logger",
        SimpleNamespace(warning=lambda event, **_kwargs: warnings.append(event), info=lambda *_a, **_k: None),
    )
    _configure(monkeypatch, "partial", _KEY)
    assert payload_encryption() is not None
    assert any("public development key" in event for event in warnings)

    payload_encryption.cache_clear()
    warnings.clear()
    _configure(monkeypatch, "partial", _OTHER_KEY)
    assert payload_encryption() is not None
    assert warnings == []


def test_rotation_keeps_the_previous_key_as_secondary(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "full", _KEY, previous=_OTHER_KEY)
    config = payload_encryption()

    assert config is not None
    assert config.mode is PayloadEncryptionMode.FULL
    assert config.main_key is not None and config.main_key.get_secret_value() == _KEY
    assert config.secondary_key is not None and config.secondary_key.get_secret_value() == _OTHER_KEY


async def test_the_worker_is_handed_the_config_before_it_builds_its_codec(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The codec is built inside the SDK's run_worker from this global, so the only thing worth
    # asserting is what the value is at the moment the SDK is entered.
    _configure(monkeypatch, "full", _KEY)
    seen: list[Any] = []

    async def _fake_run_worker(_classes: list[type], **_kwargs: Any) -> str:
        seen.append(sdk_config.worker.temporal_payload_encryption)
        return "ran"

    monkeypatch.setattr(workflows_client.workflows, "run_worker", _fake_run_worker)
    monkeypatch.setattr(sdk_config.worker, "temporal_payload_encryption", None)

    assert await workflows_client.run_worker([]) == "ran"
    assert seen[0] is not None
    assert seen[0].mode is PayloadEncryptionMode.FULL


async def test_the_worker_config_is_cleared_when_encryption_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    # Unconditional assignment: whatever the SDK parsed out of its own environment handling
    # must not survive as a second, disagreeing source of truth.
    _configure(monkeypatch, "off", None)
    seen: list[Any] = []

    async def _fake_run_worker(_classes: list[type], **_kwargs: Any) -> None:
        seen.append(sdk_config.worker.temporal_payload_encryption)

    monkeypatch.setattr(workflows_client.workflows, "run_worker", _fake_run_worker)
    monkeypatch.setattr(sdk_config.worker, "temporal_payload_encryption", "left over from the SDK")

    await workflows_client.run_worker([])
    assert seen == [None]


async def test_the_worker_targets_our_host_key_and_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    # The SDK reads SERVER_URL / MISTRAL_API_KEY / DEPLOYMENT_NAME itself at import, which can be
    # before the repo-root .env is loaded; it must run against the app's settings instead.
    _configure(monkeypatch, "off", None)
    monkeypatch.setattr(workflows_env, "workflows_base_url", "https://workflows.example.test")
    monkeypatch.setattr(workflows_env, "deployment_name", "deployment-my-app-alice")
    monkeypatch.setattr(workflows_client.env, "mistral_api_key", "app-key")
    sdk_config.worker.server_url = "https://api.mistral.ai"
    sdk_config.worker.agent.mistral_client_server_url = "https://api.mistral.ai"
    sdk_config.common.mistral_api_key = None
    sdk_config.worker.deployment_name = None
    seen: dict[str, Any] = {}

    async def _fake_run_worker(_classes: list[type], **kwargs: Any) -> None:
        seen.update(
            kwargs=kwargs,
            server_url=sdk_config.worker.server_url,
            agent_url=sdk_config.worker.agent.mistral_client_server_url,
            api_key=sdk_config.common.mistral_api_key,
            deployment_name=sdk_config.worker.deployment_name,
        )

    monkeypatch.setattr(workflows_client.workflows, "run_worker", _fake_run_worker)

    await workflows_client.run_worker([])

    assert seen["server_url"] == "https://workflows.example.test"
    assert seen["agent_url"] == "https://workflows.example.test"
    assert seen["api_key"] is not None and seen["api_key"].get_secret_value() == "app-key"
    assert seen["deployment_name"] == "deployment-my-app-alice"
    # With config discovery on, the SDK ignores an ``api_key`` argument.
    assert seen["kwargs"] == {}


async def test_an_agent_url_set_on_purpose_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "off", None)
    monkeypatch.setattr(workflows_env, "workflows_base_url", "https://workflows.example.test")
    sdk_config.worker.server_url = "https://api.mistral.ai"
    sdk_config.worker.agent.mistral_client_server_url = "https://llm.example.test"

    async def _fake_run_worker(_classes: list[type], **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(workflows_client.workflows, "run_worker", _fake_run_worker)

    await workflows_client.run_worker([])

    assert sdk_config.worker.agent.mistral_client_server_url == "https://llm.example.test"


def test_an_invalid_deployment_name_is_refused_before_the_worker_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    # Assigning the SDK attribute directly would skip its validation.
    _configure(monkeypatch, "off", None)
    monkeypatch.setattr(workflows_env, "deployment_name", "has spaces")

    with pytest.raises(ValueError, match="is invalid"):
        workflows_client._configure_worker()


class _Recorder:
    def __init__(self) -> None:
        self.namespace_calls: list[dict[str, Any]] = []
        self.configure_calls: list[dict[str, Any]] = []
        self.fail_times = 0

    async def namespace(self, _client: Any, **kwargs: Any) -> str:
        self.namespace_calls.append(kwargs)
        if len(self.namespace_calls) <= self.fail_times:
            raise RuntimeError("whoami unavailable")
        return "ns-1"

    async def configure(self, config: Any, **kwargs: Any) -> None:
        self.configure_calls.append({"config": config, **kwargs})

    @property
    def configured(self) -> list[Any]:
        return [call["client"] for call in self.configure_calls]


def _install_client(monkeypatch: pytest.MonkeyPatch, recorder: _Recorder) -> list[object]:
    # A fresh object per construction, like the real ``Mistral``: the SDK keeps the encoding
    # config on the instance, so a stand-in shared across constructions would hide a client that
    # was never configured.
    built: list[object] = []

    def _mistral(**_kwargs: Any) -> object:
        built.append(object())
        return built[-1]

    monkeypatch.setattr(workflows_client, "Mistral", _mistral)
    monkeypatch.setattr(workflows_client, "get_scheduler_namespace", recorder.namespace)
    monkeypatch.setattr(workflows_client, "configure_workflow_encoding", recorder.configure)
    return built


async def test_the_hook_is_not_installed_when_encryption_is_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "off", None)
    recorder = _Recorder()
    built = _install_client(monkeypatch, recorder)

    assert await workflows_client._client() is built[-1]
    assert recorder.namespace_calls == []
    assert recorder.configure_calls == []


async def test_every_call_gets_the_configured_client(monkeypatch: pytest.MonkeyPatch) -> None:
    # The silent failure: only the first client carried the config, so every later call sent
    # cleartext and got ciphertext back.
    _configure(monkeypatch, "full", _KEY)
    recorder = _Recorder()
    _install_client(monkeypatch, recorder)

    clients = [await workflows_client._client() for _ in range(3)]

    assert len(recorder.configure_calls) == 1
    assert all(client is recorder.configured[0] for client in clients)


async def test_the_hook_resolves_the_namespace_against_our_own_host(monkeypatch: pytest.MonkeyPatch) -> None:
    # Letting the SDK resolve it would send this deployment's whoami to the public Mistral host.
    _configure(monkeypatch, "full", _KEY)
    recorder = _Recorder()
    _install_client(monkeypatch, recorder)

    await workflows_client._client()

    assert recorder.namespace_calls == [{"server_url": workflows_env.workflows_base_url}]
    assert recorder.configure_calls[0]["namespace"] == "ns-1"


async def test_concurrent_first_calls_install_the_hook_once(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch, "full", _KEY)
    recorder = _Recorder()
    _install_client(monkeypatch, recorder)

    clients = await asyncio.gather(*(workflows_client._client() for _ in range(10)))

    assert len(recorder.namespace_calls) == 1
    assert len(recorder.configure_calls) == 1
    assert all(client is recorder.configured[0] for client in clients)


async def test_a_failed_install_is_raised_and_then_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    # Fail closed: a caller that proceeded here would put cleartext on the wire under `full`.
    _configure(monkeypatch, "full", _KEY)
    recorder = _Recorder()
    recorder.fail_times = 1
    _install_client(monkeypatch, recorder)

    with pytest.raises(RuntimeError, match="whoami unavailable"):
        await workflows_client._client()

    assert await workflows_client._client() is recorder.configured[0]
    assert len(recorder.configure_calls) == 1
