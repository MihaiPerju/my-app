"""search baseline: ``search_sources``, ``ingestion_source_state`` and the extensions the store needs.

Shipped by the capability that owns the tables, beside their models (``db/models/search.py`` and
``db/models/ingestion.py``), so a freshly generated app has them after ``init-migrations`` with no
``db:revision`` step, and an app without ``search`` never sees the file. It is the root of its own
branch (``down_revision = None``, labelled ``search``): which capabilities own tables varies per
composition, so no baseline may name another as its parent.

The chunk table (``<collection>_chunks``) is not here: the Postgres search plugin provisions it at
runtime, and autogenerate leaves it alone (``db.schema_filter``). What the plugin cannot do is
create the extensions its DDL needs -- it checks for them and refuses with a named error instead --
so this revision creates ``vector`` (the ``halfvec`` embedding and its HNSW index) and
``pg_textsearch`` (the ``bm25`` access method every collection's lexical index uses). Compose also
seeds both on first boot; this is the authority for every other target. Each is best-effort: a
role that may not create extensions, or a server without one, gets a NOTICE here and the plugin's
precise error at first use, instead of a failed migration that blocks the whole app. Downgrade
keeps them: extensions are database-wide and may serve another schema.

Revision ID: search_0001
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "search_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = ("search",)
depends_on: str | Sequence[str] | None = None

EXTENSIONS = ("vector", "pg_textsearch")


def _create_extension_if_possible(name: str) -> None:
    op.execute(f"""
        DO $$
        BEGIN
          CREATE EXTENSION IF NOT EXISTS {name};
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'extension {name} not created (%); search reports it at first use', SQLERRM;
        END $$;
    """)


def upgrade() -> None:
    for extension in EXTENSIONS:
        _create_extension_if_possible(extension)

    op.create_table(
        "search_sources",
        sa.Column("collection_name", sa.String(length=255), nullable=False),
        sa.Column("source_id", sa.String(length=255), nullable=False),
        sa.Column("doc_id", sa.String(length=255), nullable=False),
        sa.Column("content", sa.String(), nullable=False),
        sa.Column("filename", sa.String(length=1024), nullable=True),
        sa.Column("url", sa.String(length=2048), nullable=True),
        sa.Column("title", sa.String(length=1024), nullable=True),
        sa.Column("mime_type", sa.String(length=255), nullable=True),
        sa.Column("source_metadata", sa.JSON(), nullable=False),
        sa.Column("extraction_version", sa.String(length=64), nullable=False),
        sa.Column("checksum", sa.String(length=128), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("collection_name", "source_id"),
    )
    op.create_index("ix_search_sources_collection", "search_sources", ["collection_name"], unique=False)
    op.create_index(op.f("ix_search_sources_doc_id"), "search_sources", ["doc_id"], unique=False)

    op.create_table(
        "ingestion_source_state",
        sa.Column("collection_name", sa.String(length=255), nullable=False),
        sa.Column("source_key", sa.String(length=255), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("etag", sa.String(length=512), nullable=True),
        sa.Column("mtime", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("run_id", sa.String(length=255), nullable=False),
        sa.PrimaryKeyConstraint("collection_name", "source_key"),
    )
    op.create_index("ix_ingestion_source_state_collection", "ingestion_source_state", ["collection_name"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_ingestion_source_state_collection", table_name="ingestion_source_state")
    op.drop_table("ingestion_source_state")
    op.drop_index(op.f("ix_search_sources_doc_id"), table_name="search_sources")
    op.drop_index("ix_search_sources_collection", table_name="search_sources")
    op.drop_table("search_sources")
