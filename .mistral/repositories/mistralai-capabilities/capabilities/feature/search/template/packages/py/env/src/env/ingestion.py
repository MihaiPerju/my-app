"""Typed settings for the scheduled reconciling ingestion job.

Selects the object-storage backend to enumerate, the target search collection, the
schedule cadence, and the reconciliation safety knobs. Cloud credentials are read from the
environment; never commit them.
"""

from typing import Literal

from pydantic import Field

from env._base import BaseEnv


class Env(BaseEnv):
    ingestion_enabled: bool = False
    ingestion_schedule_id: str = "mistralai-capabilities-ingestion"
    ingestion_interval_seconds: int = Field(default=86400, ge=1)
    # Set to a 5-field UTC cron to pin the sweep to a time of day. An interval is anchored to
    # the epoch, so a 24h interval drifts; a cron does not. Non-empty wins over the interval.
    ingestion_cron: str = ""

    ingestion_storage_backend: Literal["filesystem", "s3", "gcs", "azure"] = "filesystem"
    ingestion_source_prefix: str = ""

    ingestion_filesystem_root: str = ""

    ingestion_s3_bucket: str = ""
    ingestion_s3_region: str = ""
    ingestion_s3_endpoint_url: str = ""
    ingestion_s3_access_key_id: str = ""
    ingestion_s3_secret_access_key: str = ""
    ingestion_s3_session_token: str = ""

    ingestion_gcs_bucket: str = ""
    ingestion_gcs_service_account_file: str = ""
    ingestion_gcs_api_root: str = ""

    ingestion_azure_container: str = ""
    ingestion_azure_connection_string: str = ""
    ingestion_azure_account_url: str = ""
    ingestion_azure_use_workload_identity: bool = False

    # Frozen: this names the plugin's chunk table (``{collection}_chunks``), provisioned by the
    # search plugin, and is the leading component of the primary key of search_sources and
    # ingestion_source_state. The plugin cannot template a name, so this default and
    # ``INGESTION_COLLECTION_NAME`` must stay equal; ``activities._open_store`` refuses
    # any other name. Changing it orphans the indexed corpus silently (searches just return empty)
    # and requires a data migration or wiping the store and re-ingesting.
    ingestion_collection_name: str = "mistralai_capabilities_search"
    ingestion_embed_model: str = "mistral-embed-dim128-2510"

    # Documents per batch child workflow. Also the retry granularity: a stage that exhausts its
    # attempts re-runs the whole batch, so a bigger one re-pays for more already-extracted files.
    ingestion_batch_size: int = Field(default=20, ge=1)
    # Batch child workflows in flight at once. The sweep fans out in waves of this width and
    # records the manifest after each, so it also bounds how much work an interrupted pass redoes.
    ingestion_max_concurrent_batches: int = Field(default=5, ge=1)
    ingestion_max_file_bytes: int = Field(default=10 * 1024 * 1024, ge=1)
    ingestion_delete_threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    ingestion_tombstone_gc_days: int = Field(default=30, ge=0)
    ingestion_dry_run: bool = False


env = Env()
