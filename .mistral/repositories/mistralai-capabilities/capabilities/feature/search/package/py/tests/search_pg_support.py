"""Shared Postgres bootstrap for the search test suites."""

import os

from db.models.search import EMBEDDING_DIM

DIM = EMBEDDING_DIM

pg_contract_enabled = bool(os.getenv("RUN_PG_CONTRACT"))
