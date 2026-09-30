"""Persistent Agentic Search source metadata.

SearchSource holds display metadata (filename, url, title) for each ingested source.
The chunk table is managed by the mistralai-search-toolkit-plugins-postgres plugin and
is not declared here — its table name is ``{collection_name}_chunks``.

:data:`EMBEDDING_DIM` stays here even though no column in this module uses it any more: it is the
one place the deployment's vector width is written down. The stores and the benchmark import it, and
the search plugin sizes its ``halfvec`` chunk column to it when it first provisions the table. No
migration pins the width -- the ``search_0001`` baseline creates the metadata tables, not the chunk
table -- so this constant is the single source of truth. The plugin only creates the column on an empty table
(``Table.create(checkfirst=True)``); a width change on a live deployment needs a deliberate migration
that drops and re-provisions the chunk table.
"""

from typing import Any

from sqlalchemy import JSON, Column, Index
from sqlmodel import Field, SQLModel

# The deployment's vector width. Matches mistral-embed-dim128-2510, the default embedding model for
# both ingestion and query; the plugin provisions its chunk column to this width.
EMBEDDING_DIM = 128


class SearchSource(SQLModel, table=True):
    __tablename__ = "search_sources"
    __table_args__ = (Index("ix_search_sources_collection", "collection_name"),)

    collection_name: str = Field(primary_key=True, max_length=255)
    source_id: str = Field(primary_key=True, max_length=255)
    doc_id: str = Field(default="", index=True, max_length=255)
    content: str
    filename: str | None = Field(default=None, max_length=1024)
    url: str | None = Field(default=None, max_length=2048)
    title: str | None = Field(default=None, max_length=1024)
    mime_type: str | None = Field(default=None, max_length=255)
    source_metadata: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    extraction_version: str = Field(default="1.0.0", max_length=64)
    checksum: str = Field(default="", max_length=128)
    page_count: int = 0
