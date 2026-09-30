-- Mounted as 020-extensions.sql so it runs after the image's bundled timescaledb
-- install/tune scripts. This is compose-only first-boot seeding; on every target the `search`
-- baseline migration also creates both extensions (best-effort), since autogenerate cannot see them.
-- `vector` (pgvector): the search chunk table's halfvec column and HNSW index, and the guardrail
-- similarity corpus.
-- `pg_textsearch`: the `bm25` access method the Postgres search plugin builds every collection's
-- lexical index with. It must also be in shared_preload_libraries, which the pinned
-- timescaledb-ha image already does; `CREATE EXTENSION` alone is not enough on another image.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
