"""Typed settings for the S3-compatible store used to stage IDP documents.

The names match the shared ``INGESTION_S3_*`` convention without importing ``env.ingestion``,
which belongs to the optional ``search`` capability. IDP itself supports only S3-compatible
storage, supplied locally by its required ``bucket`` dependency.
"""

from __future__ import annotations

from pydantic import Field, model_validator

from env._base import BaseEnv


class Env(BaseEnv):
    ingestion_storage_backend: str = "s3"

    ingestion_s3_bucket: str = ""
    ingestion_s3_region: str = ""
    ingestion_s3_endpoint_url: str = ""
    ingestion_s3_access_key_id: str = ""
    ingestion_s3_secret_access_key: str = ""
    ingestion_s3_session_token: str = ""

    # Model ids for the Document Annotation UI pipeline. Defaults are what the capability ships
    # against; override
    # per deployment (e.g. an instance that lacks the default extract model). Set
    # DOCUMENT_ANNOTATION_UI_EXTRACT_REASONING_EFFORT to "none" for a non-reasoning extract model.
    document_annotation_ui_ocr_model: str = "mistral-ocr-4-0"
    document_annotation_ui_extract_model: str = "zai-glm-5-2"
    document_annotation_ui_extract_reasoning_effort: str = "xhigh"
    # Sampling for the extract chat call. The defaults are self-consistent: temperature=0.0 is
    # greedy, and the API requires top_p == 1 under greedy sampling, so a reasoning extract model
    # with DOCUMENT_ANNOTATION_UI_EXTRACT_REASONING_EFFORT set works out of the box without
    # the caller overriding top_p. The cross-field check below rejects a combination the API would.
    document_annotation_ui_extract_temperature: float = Field(default=0.0, ge=0.0)
    document_annotation_ui_extract_top_p: float = Field(default=1.0, ge=0.0, le=1.0)
    document_annotation_ui_extract_random_seed: int = Field(default=42, ge=0)

    @model_validator(mode="after")
    def _greedy_sampling_requires_top_p_one(self) -> Env:
        """Reject greedy sampling with top_p != 1, the way the extract API does.

        Greedy sampling (temperature 0) with top_p != 1 is `invalid_request_greedy_sampling`
        (3054). Catching it here fails a bad config once at settings load, rather than letting
        every extraction call 400 at runtime — e.g. a deployment that lowers top_p without also
        raising temperature.
        """
        if self.document_annotation_ui_extract_temperature == 0.0 and self.document_annotation_ui_extract_top_p != 1.0:
            raise ValueError(
                "DOCUMENT_ANNOTATION_UI_EXTRACT_TOP_P must be 1.0 when "
                "DOCUMENT_ANNOTATION_UI_EXTRACT_TEMPERATURE is 0 (greedy sampling)."
            )
        return self


env = Env()
