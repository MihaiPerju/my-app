import importlib
from pathlib import Path


def test_observability_runtime_is_installed() -> None:
    from mistralai.extra.observability import get_telemetry_tracer

    importlib.import_module("mistralai_capabilities.observability")
    importlib.import_module("opentelemetry.sdk.trace")
    assert callable(get_telemetry_tracer)


def test_observability_configuration_and_skill_are_vendored() -> None:
    app_root = Path(__file__).resolve().parents[1]

    env = (app_root / ".env").read_text()
    assert "MISTRAL_OTLP_TRACES_ENDPOINT=https://api.mistral.ai/telemetry/v1/traces" in env
    assert "MISTRAL_SDK_TELEMETRY=dedicated" in env
    assert "OTEL_ENABLED=true" in env

    assert (app_root / ".agents/skills/observe/SKILL.md").is_file()
