"""Boot-time check that the consumer provides the settings this capability reads.

A renamed or missing field otherwise surfaces as an AttributeError deep in an activity on the first
run (how the idp_* -> document_annotation_ui_* rename broke extraction). The Protocol is the
typed contract for consumer CI; REQUIRED_SETTINGS derives from it for the runtime presence check.
"""

from typing import Protocol

_SETTINGS_OBJECT = "env.document_annotation_ui"


class DocumentAnnotationUiSettings(Protocol):
    document_annotation_ui_ocr_model: str
    document_annotation_ui_extract_model: str
    document_annotation_ui_extract_reasoning_effort: str
    document_annotation_ui_extract_temperature: float
    document_annotation_ui_extract_top_p: float
    document_annotation_ui_extract_random_seed: int
    ingestion_storage_backend: str
    ingestion_s3_bucket: str
    ingestion_s3_region: str
    ingestion_s3_endpoint_url: str
    ingestion_s3_access_key_id: str
    ingestion_s3_secret_access_key: str
    ingestion_s3_session_token: str


REQUIRED_SETTINGS: tuple[str, ...] = tuple(DocumentAnnotationUiSettings.__annotations__)


class EnvContractError(RuntimeError):
    """Raised at startup when the consumer's settings object omits a required field."""


def validate_settings(settings: object, *, settings_object: str = _SETTINGS_OBJECT) -> None:
    missing = [name for name in REQUIRED_SETTINGS if not hasattr(settings, name)]
    if missing:
        raise EnvContractError(f"{settings_object} is missing required settings: {', '.join(missing)}")


def check_document_annotation_ui_env() -> None:
    # Lazy: the consumer's env module is app-local, imported the way the activities do.
    from env.document_annotation_ui import env

    validate_settings(env)
