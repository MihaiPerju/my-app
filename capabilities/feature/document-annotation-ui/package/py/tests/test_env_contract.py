"""The env contract fails a boot with a bad consumer settings object, naming every missing field."""

import types

import pytest
from mistralai_capabilities.document_annotation_ui.env_contract import (
    REQUIRED_SETTINGS,
    EnvContractError,
    check_document_annotation_ui_env,
    validate_settings,
)


def _complete() -> types.SimpleNamespace:
    return types.SimpleNamespace(**dict.fromkeys(REQUIRED_SETTINGS, "set"))


def test_a_missing_field_is_named_alongside_the_settings_object() -> None:
    settings = _complete()
    del settings.document_annotation_ui_ocr_model

    with pytest.raises(EnvContractError) as failure:
        validate_settings(settings, settings_object="env.document_annotation_ui")

    assert "document_annotation_ui_ocr_model" in str(failure.value)
    assert "env.document_annotation_ui" in str(failure.value)


def test_every_missing_field_is_reported_in_one_pass() -> None:
    settings = _complete()
    del settings.document_annotation_ui_ocr_model
    del settings.ingestion_s3_bucket

    with pytest.raises(EnvContractError) as failure:
        validate_settings(settings)

    message = str(failure.value)
    assert "document_annotation_ui_ocr_model" in message
    assert "ingestion_s3_bucket" in message


def test_the_check_passes_against_a_conforming_consumer() -> None:
    """The real entrypoint against the conftest-stubbed consumer env."""
    check_document_annotation_ui_env()


def test_importing_the_workflow_fires_the_check(monkeypatch: pytest.MonkeyPatch) -> None:
    """A consumer that imports DocumentExtractionWorkflow gets the check for free.

    The check lives in the published package, not the copyable template, so it cannot be
    lost to template drift. Removing a field from the stubbed env must fail the import.
    """
    import importlib
    import sys

    from mistralai_capabilities.document_annotation_ui import workflow as workflow_module

    env = sys.modules["env.document_annotation_ui"].env
    monkeypatch.delattr(type(env), "document_annotation_ui_ocr_model")

    with pytest.raises(EnvContractError, match="document_annotation_ui_ocr_model"):
        importlib.reload(workflow_module)
