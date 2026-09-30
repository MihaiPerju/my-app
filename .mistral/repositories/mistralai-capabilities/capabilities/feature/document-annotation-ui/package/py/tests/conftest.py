"""Stub the app-local ``env`` package so this package's tests collect standalone.

The package imports ``env.mistral``, ``env.workflows``, and
``env.document_annotation_ui`` at module scope. The app template ships those modules,
but they are not workspace members here. The stubs carry only the read
surface. Production code is unchanged; tests that need a real client install their own via
monkeypatch.
"""

import sys
import types


def _install(name: str, module: types.ModuleType) -> None:
    sys.modules.setdefault(name, module)


def _stub_env() -> None:
    env = types.ModuleType("env")
    env.__path__ = []

    mistral = types.ModuleType("env.mistral")

    class _MistralEnv:
        mistral_api_key = "test-key"
        mistral_base_url = None

    mistral.env = _MistralEnv()

    workflows = types.ModuleType("env.workflows")

    class _WorkflowsEnv:
        activity_read_retry_max_attempts = 3
        activity_retry_backoff_coefficient = 2.0

    workflows.env = _WorkflowsEnv()

    document_annotation_ui = types.ModuleType("env.document_annotation_ui")

    class _DocumentAnnotationUiEnv:
        ingestion_storage_backend = "filesystem"
        ingestion_filesystem_root = ""
        ingestion_s3_bucket = ""
        ingestion_s3_region = ""
        ingestion_s3_endpoint_url = ""
        ingestion_s3_access_key_id = ""
        ingestion_s3_secret_access_key = ""
        ingestion_s3_session_token = ""
        document_annotation_ui_ocr_model = "mistral-ocr-4-0"
        document_annotation_ui_extract_model = "zai-glm-5-2"
        document_annotation_ui_extract_reasoning_effort = "xhigh"
        document_annotation_ui_extract_temperature = 0.0
        document_annotation_ui_extract_top_p = 1.0
        document_annotation_ui_extract_random_seed = 42

    document_annotation_ui.env = _DocumentAnnotationUiEnv()

    _install("env", env)
    _install("env.mistral", mistral)
    _install("env.workflows", workflows)
    _install("env.document_annotation_ui", document_annotation_ui)


_stub_env()
