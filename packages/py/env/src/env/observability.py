"""Settings for reading back from Mistral Studio observability and the object registry.

This mirrors write-only ``env.telemetry``. Studio's read surface is a plain REST API on the regular
API host, so the read path needs its own base URL. Two surfaces share this module because they share
a host and bearer: ``/v1/observability/*`` and ``/v2/prompts``. Auth is ``MISTRAL_API_KEY``, but
reading is off by default behind the ``obs_online_evaluations`` flag, granted per workspace.
"""

from pydantic import Field

from env._base import BaseEnv


class Env(BaseEnv):
    # The read API's host. Same deployment as the chat/completions API, not the telemetry
    # ingestion host in `env.telemetry`, which only accepts OTLP.
    observability_api_base_url: str = "https://api.mistral.ai"

    # Off by default, because `/v1/observability/*` reads are gated behind the
    # `obs_online_evaluations` feature flag. Turning this on without the grant makes every
    # call 404; leaving it off makes the harvest a no-op that logs why it did nothing.
    observability_read_enabled: bool = False

    # One request's budget. The span-evaluation search hits ClickHouse behind a cursor, so a
    # wide time range is paginated rather than slow — but a cold shard can still be sluggish.
    observability_request_timeout_seconds: float = Field(default=30.0, gt=0)

    # Rows per page. The API caps this server-side; a smaller value only costs round trips.
    observability_page_size: int = Field(default=100, ge=1, le=1000)

    # A ceiling on pagination, so one harvest cannot walk an unbounded backlog into memory.
    # Reached-the-cap is logged, not raised: a truncated harvest is still a useful harvest.
    observability_max_pages: int = Field(default=50, ge=1)


env = Env()
