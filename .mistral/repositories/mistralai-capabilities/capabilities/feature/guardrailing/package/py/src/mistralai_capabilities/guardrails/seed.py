"""Seed the pgvector corpus the guardrail similarity scanner matches against.

Feature logic, so it lives with the feature rather than in the script that used to
own it: both the ``seed-guardrail`` command and the deployment init step call
:func:`seed_guardrail_corpus`. Idempotent — a populated table is left alone unless
``force`` is set, which makes it safe to run on every deploy.
"""

import json
from pathlib import Path

from env.db import env as db_env
from env.guardrail import env as guardrail_env
from env.mistral import env as mistral_env
from mistralai.client import Mistral
from mistralai_capabilities.guardrails.guardrail import sync_pg_url
from mistralai_guardrails.classification import DefaultClassification
from mistralai_guardrails.models.vector_search import DatabaseRecord
from mistralai_guardrails.scanners.similarity_scanner.vector_stores.pgvector import (
    PgVectorBackend,
    PgVectorConfig,
)
from pydantic import BaseModel

_EMBED_MODEL = "mistral-embed"
_EMBED_DIMENSION = 1024

DEFAULT_DATASET = Path(__file__).resolve().parent / "data" / "seed.json"


class MissingApiKeyError(RuntimeError):
    """Raised when seeding is attempted without a Mistral API key."""


class DatasetNotFoundError(FileNotFoundError):
    """Raised when the seed dataset file does not exist."""


class SeedOutcome(BaseModel):
    seeded: int
    skipped_existing: int
    total_rows: int


def seed_guardrail_corpus(
    dataset: Path | None = None,
    *,
    batch_size: int = 100,
    force: bool = False,
) -> SeedOutcome:
    """Embed the labelled prompt dataset into the guardrail pgvector table."""
    path = dataset or DEFAULT_DATASET
    if not mistral_env.mistral_api_key:
        raise MissingApiKeyError("MISTRAL_API_KEY must be set to seed the guardrail corpus")
    if not path.exists():
        raise DatasetNotFoundError(f"dataset not found: {path}")

    records = json.loads(path.read_text())
    backend = PgVectorBackend(
        config=PgVectorConfig(
            connection_url=sync_pg_url(db_env.database_url),
            table_name=guardrail_env.guardrail_embeddings_table,
        )
    )
    backend.setup(dimension=_EMBED_DIMENSION)

    existing = backend.count()
    if existing and not force:
        return SeedOutcome(seeded=0, skipped_existing=existing, total_rows=existing)
    if existing:
        backend.clear()

    client = Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)
    for start in range(0, len(records), batch_size):
        batch = records[start : start + batch_size]
        response = client.embeddings.create(model=_EMBED_MODEL, inputs=[r["prompt"] for r in batch])
        backend.feed_records(
            [
                DatabaseRecord(
                    content=r["prompt"],
                    classification=DefaultClassification(r["classification"]),
                    subcategory=r.get("subcategory", ""),
                )
                for r in batch
            ],
            [item.embedding for item in response.data],
        )

    return SeedOutcome(seeded=len(records), skipped_existing=0, total_rows=backend.count())
