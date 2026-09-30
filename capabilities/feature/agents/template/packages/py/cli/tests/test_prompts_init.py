"""Prompt initialization policy over the official SDK shape."""

from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import env
import pytest

_CAPABILITIES = Path(__file__).resolve().parents[7]
env.__path__.extend(
    [
        str(_CAPABILITIES / "feature/agents/template/packages/py/env/src/env"),
        str(_CAPABILITIES / "feature/observability/template/packages/py/env/src/env"),
    ]
)

prompts = import_module("cli.commands.prompts")
models = import_module("mistralai.client.models")


def _page(*items: models.Prompt, token: str | None = None):
    return SimpleNamespace(result=SimpleNamespace(data=list(items), next_page_token=token))


@pytest.fixture
def api(monkeypatch: pytest.MonkeyPatch, tmp_path):
    prompt_api = SimpleNamespace(
        list_async=AsyncMock(),
        create_async=AsyncMock(),
        create_version_async=AsyncMock(),
        get_async=AsyncMock(),
        update_version_metadata_async=AsyncMock(),
    )
    client = SimpleNamespace(beta=SimpleNamespace(prompts=prompt_api))
    instructions = tmp_path / "instructions.md"
    instructions.write_text("ship this prompt", encoding="utf-8")
    monkeypatch.setattr(prompts, "_INSTRUCTIONS", instructions)
    monkeypatch.setattr(prompts, "Mistral", lambda **_kwargs: client)
    monkeypatch.setattr(prompts.agents_env, "prompt_registry_enabled", True)
    monkeypatch.setattr(prompts.agents_env, "prompt_registry_name", "wanted")
    return prompt_api


async def test_lookup_follows_every_page(api) -> None:
    wanted = models.Prompt(id="p-1", name="wanted")
    api.list_async.side_effect = [
        _page(models.Prompt(id="other", name="other"), token="next"),
        _page(wanted),
    ]

    assert await prompts._find_prompt_by_name(SimpleNamespace(beta=SimpleNamespace(prompts=api)), "wanted") is wanted
    assert api.list_async.await_args_list[1].kwargs["page_token"] == "next"


async def test_fresh_prompt_is_created_with_production_alias(api) -> None:
    api.list_async.return_value = _page()
    api.create_async.return_value = models.Prompt(id="p-1", name="wanted", version=1)

    await prompts.main()

    assert api.create_async.await_args.kwargs["aliases"] == ["production"]
    api.get_async.assert_not_awaited()


async def test_existing_prompt_converges_typed_version_without_moving_production(
    api,
) -> None:
    api.list_async.return_value = _page(models.Prompt(id="p-1", name="wanted"))
    api.create_version_async.return_value = models.CreatePromptVersionResponse(version=4, deduplicated=True)
    api.get_async.return_value = models.Prompt(definition={"content": "live"})

    await prompts.main()

    assert api.create_version_async.await_args.kwargs["prompt_id"] == "p-1"
    api.update_version_metadata_async.assert_not_awaited()


async def test_existing_prompt_without_id_is_refused(api) -> None:
    api.list_async.return_value = _page(models.Prompt(name="wanted"))

    with pytest.raises(RuntimeError, match=r"prompt lookup returned no id:"):
        await prompts.main()


async def test_first_resolvable_version_receives_production_alias(api) -> None:
    api.list_async.return_value = _page(models.Prompt(id="p-1", name="wanted"))
    api.create_version_async.return_value = models.CreatePromptVersionResponse(version=3, deduplicated=False)
    api.get_async.return_value = models.Prompt()

    await prompts.main()

    assert api.update_version_metadata_async.await_args.kwargs["aliases"] == {"values": ["production"]}
