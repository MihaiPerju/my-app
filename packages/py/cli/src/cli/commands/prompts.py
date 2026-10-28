"""Converge the orchestrator's prompt in the AI Studio registry to what this deploy ships.

This step publishes ``agent/instructions.md`` as a registry version, so the worker resolves it by
alias and GEPA has a versioned baseline. Versions are content-addressed, so re-running an unchanged
deploy reuses the version. The ``production`` alias is created but never moved, because repointing
it is how a candidate goes live. The step is skipped unless ``PROMPT_REGISTRY_ENABLED`` is on.
"""

import asyncio
from pathlib import Path
from typing import TypedDict

import structlog
import typer
from env.agents import env as agents_env
from env.mistral import env as mistral_env
from env.observability import env as observability_env
from mistralai.client import Mistral, models
from mistralai.client.utils.retries import BackoffStrategy, RetryConfig

logger = structlog.get_logger("init.prompts")
app = typer.Typer()
INIT_STEP = True  # wired into the deployment init chain (compose services + Helm Jobs)

_INSTRUCTIONS = (
    Path(__file__).resolve().parents[6] / "apps" / "worker" / "src" / "worker" / "agents" / "instructions.md"
)
_PAGE_SIZE = 100
_PRODUCTION_ALIAS = "production"
_MISTRAL_RETRY_CONFIG = RetryConfig(
    strategy="backoff",
    backoff=BackoffStrategy(initial_interval=100, max_interval=100, exponent=1.0, max_elapsed_time=100),
    retry_connection_errors=True,
)


class _StudioOptions(TypedDict):
    server_url: str
    timeout_ms: int
    retries: RetryConfig


def _studio_options() -> _StudioOptions:
    return {
        "server_url": observability_env.observability_api_base_url.rstrip("/"),
        "timeout_ms": int(observability_env.observability_request_timeout_seconds * 1000),
        "retries": _MISTRAL_RETRY_CONFIG,
    }


async def _find_prompt_by_name(client: Mistral, name: str) -> models.Prompt | None:
    page_token: str | None = None
    while True:
        page = await client.beta.prompts.list_async(
            page_size=_PAGE_SIZE,
            page_token=page_token,
            **_studio_options(),
        )
        if page is None:
            return None
        for prompt in page.result.data or []:
            if prompt.name == name:
                return prompt
        page_token = page.result.next_page_token
        if not page_token:
            return None


def _prompt_content(prompt: models.Prompt) -> str | None:
    content = prompt.definition.content if prompt.definition is not None else None
    return content if isinstance(content, str) and content.strip() else None


@app.command(name="prompts", help=__doc__)
def _run() -> None:
    asyncio.run(main())


async def main() -> None:
    if not agents_env.prompt_registry_enabled:
        logger.info("prompt registry sync skipped", reason="PROMPT_REGISTRY_ENABLED is off")
        return

    content = _INSTRUCTIONS.read_text(encoding="utf-8").strip()
    if not content:
        raise RuntimeError(f"{_INSTRUCTIONS} is empty; refusing to publish an empty system prompt")

    client = Mistral(api_key=mistral_env.mistral_api_key or "", server_url=mistral_env.mistral_base_url)
    name = agents_env.prompt_registry_name
    existing = await _find_prompt_by_name(client, name)

    if existing is None:
        created = await client.beta.prompts.create_async(
            name=name,
            definition={"content": content},
            title="Solutions Capabilities orchestrator",
            description="System prompt for the root orchestrator agent, published from instructions.md.",
            notes="Initial version from instructions.md.",
            aliases=[_PRODUCTION_ALIAS],
            **_studio_options(),
        )
        logger.info(
            "prompt created and aliased to production",
            prompt=name,
            prompt_id=created.id,
            version=created.version,
        )
        return

    if not existing.id:
        raise RuntimeError(f"prompt lookup returned no id: {existing!r}")
    prompt_id = existing.id
    result = await client.beta.prompts.create_version_async(
        prompt_id=prompt_id,
        definition={"content": content},
        notes="Published from instructions.md by the prompts command.",
        **_studio_options(),
    )
    version = result.version
    logger.info(
        "prompt version converged",
        prompt=name,
        prompt_id=prompt_id,
        version=version,
        deduplicated=result.deduplicated,
    )

    # First run against a prompt that exists but has never been aliased — adopt this version as
    # production. Any later run leaves the alias alone, so a promoted candidate survives deploys.
    resolved = await client.beta.prompts.get_async(
        prompt_id=prompt_id,
        alias=_PRODUCTION_ALIAS,
        **_studio_options(),
    )
    if _prompt_content(resolved) is None and version is not None:
        await client.beta.prompts.update_version_metadata_async(
            prompt_id=prompt_id,
            version=version,
            aliases={"values": [_PRODUCTION_ALIAS]},
            **_studio_options(),
        )
        logger.info("production alias created", prompt=name, version=version)
