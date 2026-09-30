"""Ingestion reconciliation manifest: per-source fingerprint + tombstone state.

One row per (collection, source_key) tracks the last-ingested fingerprint so the
scheduled job can classify new/updated/deleted/unchanged sources and soft-delete
vanished ones without re-reading the whole corpus.
"""

from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, Index
from sqlmodel import Field, SQLModel


class IngestionSourceState(SQLModel, table=True):
    __tablename__ = "ingestion_source_state"
    __table_args__ = (Index("ix_ingestion_source_state_collection", "collection_name"),)

    collection_name: str = Field(primary_key=True, max_length=255)
    source_key: str = Field(primary_key=True, max_length=255)
    size: int = 0
    etag: str | None = Field(default=None, max_length=512)
    mtime: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))
    last_seen_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC)
    )
    deleted_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))
    run_id: str = Field(default="", max_length=255)
