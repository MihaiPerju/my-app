"""The composed environment must cover every Python setting.

A setting is declared in one of two committed places. Capability ``envVars`` are the source of the
generated ``.env``: the app's committed ``.mistral`` ledger records which capabilities are installed
and commits their registry descriptor, so the capability half is read from there. The app's own
settings, which no capability owns, are declared in the committed ``.env.example``. A settings field
declared in neither is invisible to whoever configures a deployment, so compare the installed
settings models with those declarations rather than maintaining another hand-written catalogue.

``.env.example`` only declares names. Nothing loads it at runtime: an app-owned default lives on its
settings field, which pydantic applies wherever the variable is unset, so there is one copy of it. A
value in ``.env.example`` would be a second copy that nothing reads, so the contract rejects one.

Both declarations are committed, so the declaration check gives the same answer locally and in a
fresh clone (CI). The loadability check uses what the runtime reads: the gitignored ``.env`` where
the CLI generated one, otherwise the capability values ``mistral apps init`` would write.
"""

import importlib
import json
import os
import pkgutil
import re
import sys
from pathlib import Path
from uuid import UUID

import env as env_pkg
import pytest
from env._base import BaseEnv
from pydantic import AliasChoices, Field
from pydantic.fields import FieldInfo

_REPO_ROOT = Path(__file__).resolve().parents[1]
_ENV = _REPO_ROOT / ".env"
_APP_ENV = _REPO_ROOT / ".env.example"
_LEDGER = _REPO_ROOT / ".mistral"
_ASSIGNMENT = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
_PLACEHOLDER = re.compile(r"\{\{\s*(env:)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_NO_RECORD = "neither the .mistral ledger nor a generated .env records the installed capabilities' envVars"


def _dotenv(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    return {
        match.group(1): match.group(2)
        for line in path.read_text().splitlines()
        if (match := _ASSIGNMENT.match(line.strip()))
    }


def _render(value: str, app_name: str) -> str:
    """Expand the placeholders `mistral apps init` interpolates into an envVars value."""

    def expand(match: re.Match[str]) -> str:
        if match.group(1):
            return os.environ.get(match.group(2), "")
        return app_name if match.group(2) == "app_name" else match.group(0)

    return _PLACEHOLDER.sub(expand, value)


def _cached_descriptor(registry_id: str) -> Path | None:
    """The one committed cache entry whose descriptor carries this registry id, or None.

    The cache key is the CLI's own business, so it is not reproduced here. Several entries for one
    registry fail rather than guess which is current.
    """
    matches = [
        path
        for path in sorted((_LEDGER / "cache").glob("*/registry.json"))
        if json.loads(path.read_text()).get("id") == registry_id
    ]
    if len(matches) > 1:
        pytest.fail(
            f"several committed cache entries describe registry {registry_id!r}, so the current one is "
            "unknown; delete the stale ones: " + ", ".join(str(path.relative_to(_REPO_ROOT)) for path in matches)
        )
    return matches[0] if matches else None


def _descriptors() -> dict[str, Path]:
    """The committed descriptor of each registry the ledger names in `registries.json`.

    A git registry vendors its whole repository under `subtreePrefix`; a package (npm) registry has
    no subtree, and the CLI commits the descriptor it resolved under `.mistral/cache/<key>/`. A cache
    entry for a registry the ledger no longer names is never read.
    """
    found: dict[str, Path] = {}
    registries_path = _LEDGER / "registries.json"
    if not registries_path.is_file():
        return found
    for registry in json.loads(registries_path.read_text()).get("registries", []):
        acquisition = registry.get("acquisition", {})
        prefix, descriptor = acquisition.get("subtreePrefix"), acquisition.get("descriptorPath")
        if prefix and descriptor:
            if (_REPO_ROOT / prefix / descriptor).is_file():
                found[registry["id"]] = _REPO_ROOT / prefix / descriptor
        elif (cached := _cached_descriptor(registry["id"])) is not None:
            found[registry["id"]] = cached
    return found


def _capability_env_vars() -> dict[str, str] | None:
    """The envVars of every installed capability, rendered as `mistral apps init` writes them.

    Read from the committed ledger (`.mistral/capabilities.json`) and the registry descriptors it
    commits, so they are known in a fresh clone. None only when the app has no ledger at all: a
    ledger naming a capability no committed descriptor resolves fails, rather than letting a local
    `.env` stand in for it.
    """
    installed_path = _LEDGER / "capabilities.json"
    if not installed_path.is_file():
        return None
    by_id: dict[str, dict[str, str]] = {}
    for registry_id, path in _descriptors().items():
        for capability in json.loads(path.read_text()).get("capabilities", []):
            by_id[f"{registry_id}/{capability['kind']}/{capability['id']}"] = capability.get("envVars", {})
    installed = [entry["capability"] for entry in json.loads(installed_path.read_text()).get("installed", [])]
    unresolved = sorted(capability for capability in installed if capability not in by_id)
    if unresolved:
        pytest.fail(
            "the .mistral ledger installs capabilities that no committed registry descriptor "
            "(.mistral/repositories/<registry>/registry.json or .mistral/cache/*/registry.json) "
            "declares, so their envVars are unknown: " + ", ".join(unresolved)
        )
    package = _REPO_ROOT / "package.json"
    app_name = json.loads(package.read_text()).get("name", "app") if package.is_file() else "app"
    # The CLI merges envVars first-wins, so a name declared twice keeps its first declaration.
    merged: dict[str, str] = {}
    for capability in installed:
        for name, value in by_id[capability].items():
            merged.setdefault(name, _render(value, app_name))
    return merged


def _declared_names() -> set[str]:
    """Every variable the app declares: its installed capabilities' envVars and `.env.example`."""
    capability = _capability_env_vars()
    if capability is None:
        # No ledger (an app assembled by hand): the generated `.env` is the only capability record.
        if not _ENV.is_file():
            pytest.skip(_NO_RECORD)
        capability = _dotenv(_ENV)
    return set(capability) | set(_dotenv(_APP_ENV))


def _runtime_values() -> dict[str, str]:
    """What the settings classes load: `.env` where generated, else what init would write there."""
    if _ENV.is_file():
        return _dotenv(_ENV)
    capability = _capability_env_vars()
    if capability is None:
        pytest.skip(_NO_RECORD)
    return capability


def _settings_classes() -> dict[str, type[BaseEnv]]:
    classes: dict[str, type[BaseEnv]] = {}
    for module in pkgutil.iter_modules(env_pkg.__path__):
        if module.name.startswith("_"):
            continue
        settings_class = getattr(importlib.import_module(f"env.{module.name}"), "Env", None)
        if settings_class is not None:
            classes[module.name] = settings_class
    return classes


def _env_names(field_name: str, field: FieldInfo) -> list[str]:
    """Every environment variable pydantic will read this field from."""
    alias = field.validation_alias
    if isinstance(alias, str):
        return [alias]
    if isinstance(alias, AliasChoices):
        return [choice for choice in alias.choices if isinstance(choice, str)]
    return [field_name.upper()]


def _declared() -> dict[str, str]:
    fields: dict[str, str] = {}
    for module_name, settings_class in _settings_classes().items():
        for field_name, field in settings_class.model_fields.items():
            # A double underscore marks a variable the gateway injects at runtime. It has no
            # owning capability and never appears in the generated .env.
            names = [name for name in _env_names(field_name, field) if not name.startswith("__")]
            for name in names:
                fields[name] = f"env/{module_name}.py"
    return fields


def test_every_setting_is_declared() -> None:
    declared = _declared()
    missing = sorted(set(declared) - _declared_names())

    assert missing == [], (
        "declare these in the owning capability's envVars or, for the app's own settings, as a "
        "bare `NAME=` line in .env.example: " + ", ".join(f"{name} ({declared[name]})" for name in missing)
    )


def test_the_committed_example_declares_names_only() -> None:
    """Nothing loads `.env.example`, so a value there is a second copy of a default that nothing reads."""
    valued = sorted(name for name, value in _dotenv(_APP_ENV).items() if value.strip())

    assert valued == [], (
        "leave these empty in .env.example and put the default on the settings field, which pydantic "
        "applies wherever the variable is unset; override it in .env: " + ", ".join(valued)
    )


@pytest.mark.parametrize("module_name", sorted(_settings_classes()))
def test_generated_environment_is_loadable(module_name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """The environment the app runs with must instantiate every installed settings class."""
    for name, value in _runtime_values().items():
        monkeypatch.setenv(name, value)

    _settings_classes()[module_name](_env_file=None)


@pytest.fixture
def app_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway app root: a committed ledger with one installed capability, and no `.env`."""
    module = sys.modules[__name__]
    monkeypatch.setattr(module, "_REPO_ROOT", tmp_path)
    monkeypatch.setattr(module, "_ENV", tmp_path / ".env")
    monkeypatch.setattr(module, "_APP_ENV", tmp_path / ".env.example")
    monkeypatch.setattr(module, "_LEDGER", tmp_path / ".mistral")
    monkeypatch.setenv("USER", "ada")
    subtree = tmp_path / ".mistral" / "repositories" / "reg"
    subtree.mkdir(parents=True)
    (tmp_path / "package.json").write_text(json.dumps({"name": "demo"}))
    capabilities = [
        {"kind": "base", "id": "core", "envVars": {"LOG_LEVEL": "INFO", "APP_NAME": "{{app_name}}"}},
        {"kind": "backend", "id": "workflows", "envVars": {"DEPLOYMENT_NAME": "d-{{app_name}}-{{env:USER}}"}},
    ]
    (subtree / "registry.json").write_text(json.dumps({"id": "reg", "capabilities": capabilities}))
    acquisition = {"descriptorPath": "registry.json", "subtreePrefix": ".mistral/repositories/reg"}
    (tmp_path / ".mistral" / "registries.json").write_text(
        json.dumps({"registries": [{"id": "reg", "acquisition": acquisition}]})
    )
    (tmp_path / ".mistral" / "capabilities.json").write_text(
        json.dumps({"installed": [{"capability": "reg/base/core"}]})
    )
    (tmp_path / ".env.example").write_text("# the app's own\nMY_FEATURE_MODEL=\n")
    return tmp_path


def test_a_fresh_clone_reads_the_capability_declarations_from_the_committed_ledger(app_root: Path) -> None:
    assert _declared_names() == {"LOG_LEVEL", "APP_NAME", "MY_FEATURE_MODEL"}
    assert _runtime_values() == {"LOG_LEVEL": "INFO", "APP_NAME": "demo"}


def test_placeholders_render_as_init_renders_them(app_root: Path) -> None:
    (app_root / ".mistral" / "capabilities.json").write_text(
        json.dumps({"installed": [{"capability": "reg/backend/workflows"}]})
    )

    assert _runtime_values() == {"DEPLOYMENT_NAME": "d-demo-ada"}


def test_a_name_only_in_the_local_env_is_not_a_declaration(app_root: Path) -> None:
    """Otherwise the contract would pass on the developer's machine and fail in CI."""
    (app_root / ".env").write_text("LOG_LEVEL=DEBUG\nAPP_NAME=demo\nONLY_HERE=1\n")

    assert "ONLY_HERE" not in _declared_names()


def test_the_runtime_values_are_the_generated_env_when_present(app_root: Path) -> None:
    (app_root / ".env").write_text("LOG_LEVEL=DEBUG\n")

    assert _runtime_values() == {"LOG_LEVEL": "DEBUG"}


def test_without_a_ledger_the_generated_env_is_the_capability_record(app_root: Path) -> None:
    (app_root / ".mistral" / "capabilities.json").unlink()
    (app_root / ".env").write_text("LOG_LEVEL=INFO\n")

    assert _declared_names() == {"LOG_LEVEL", "MY_FEATURE_MODEL"}


def test_with_neither_a_ledger_nor_an_env_the_contract_skips(app_root: Path) -> None:
    (app_root / ".mistral" / "capabilities.json").unlink()

    with pytest.raises(pytest.skip.Exception):
        _declared_names()
    with pytest.raises(pytest.skip.Exception):
        _runtime_values()


def test_a_ledger_naming_an_unresolvable_capability_fails_with_its_id(app_root: Path) -> None:
    """Falling back to `.env` here would pass locally and leave CI with nothing to check."""
    (app_root / ".mistral" / "capabilities.json").write_text(
        json.dumps({"installed": [{"capability": "reg/base/core"}, {"capability": "other/base/core"}]})
    )
    (app_root / ".env").write_text("LOG_LEVEL=INFO\n")

    with pytest.raises(pytest.fail.Exception, match="other/base/core"):
        _declared_names()


_PACKAGE_ACQUISITION = {"type": "url", "url": "http://127.0.0.1:62006/", "npmPackage": "@reg/registry"}


def _as_package_registry(app_root: Path, registries: list[str]) -> None:
    """Drop the git subtree and name `registries` as package registries, as an npm-sourced app does."""
    (app_root / ".mistral" / "repositories" / "reg" / "registry.json").unlink()
    (app_root / ".mistral" / "registries.json").write_text(
        json.dumps({"registries": [{"id": rid, "acquisition": _PACKAGE_ACQUISITION} for rid in registries]})
    )


def _cache_entry(app_root: Path, key: str, log_level: str) -> None:
    entry = app_root / ".mistral" / "cache" / key
    entry.mkdir(parents=True)
    capabilities = [{"kind": "base", "id": "core", "envVars": {"LOG_LEVEL": log_level}}]
    (entry / "registry.json").write_text(json.dumps({"id": "reg", "capabilities": capabilities}))


def test_a_package_registry_resolves_from_its_committed_cache_entry(app_root: Path) -> None:
    """A package (npm) registry has no subtree; the CLI commits its descriptor under `.mistral/cache`."""
    _as_package_registry(app_root, ["reg"])
    _cache_entry(app_root, "d6b2833bac4a72a9", "INFO")

    assert _capability_env_vars() == {"LOG_LEVEL": "INFO"}


def test_several_cache_entries_for_one_registry_fail(app_root: Path) -> None:
    _as_package_registry(app_root, ["reg"])
    _cache_entry(app_root, "0000000000000000", "STALE")
    _cache_entry(app_root, "d6b2833bac4a72a9", "INFO")

    with pytest.raises(pytest.fail.Exception, match="several committed cache entries"):
        _capability_env_vars()


def test_a_cache_entry_for_a_registry_the_ledger_no_longer_names_resolves_nothing(app_root: Path) -> None:
    _as_package_registry(app_root, [])
    _cache_entry(app_root, "d6b2833bac4a72a9", "INFO")

    with pytest.raises(pytest.fail.Exception, match="reg/base/core"):
        _capability_env_vars()


def test_a_name_declared_twice_keeps_its_first_declaration(app_root: Path) -> None:
    """The CLI merges envVars first-wins, in the ledger's installation order."""
    capabilities = [
        {"kind": "base", "id": "core", "envVars": {"LOG_LEVEL": "INFO"}},
        {"kind": "backend", "id": "workflows", "envVars": {"LOG_LEVEL": "DEBUG"}},
    ]
    (app_root / ".mistral" / "repositories" / "reg" / "registry.json").write_text(
        json.dumps({"id": "reg", "capabilities": capabilities})
    )
    (app_root / ".mistral" / "capabilities.json").write_text(
        json.dumps({"installed": [{"capability": "reg/base/core"}, {"capability": "reg/backend/workflows"}]})
    )

    assert _capability_env_vars() == {"LOG_LEVEL": "INFO"}


class _AppOwnedProbe(BaseEnv):
    my_feature_model: str = "mistral-medium-latest"


def test_an_app_owned_default_applies_without_any_env_line(monkeypatch: pytest.MonkeyPatch) -> None:
    """Declaring `MY_FEATURE_MODEL=` in `.env.example` needs no matching line in `.env`."""
    monkeypatch.delenv("MY_FEATURE_MODEL", raising=False)

    assert _AppOwnedProbe(_env_file=None).my_feature_model == "mistral-medium-latest"


class _AliasProbe(BaseEnv):
    plain: str | None = None
    renamed: str | None = Field(default=None, validation_alias="PROBE_RENAMED")
    injected: str | None = Field(default=None, validation_alias=AliasChoices("__PROBE_NEW", "__PROBE_OLD"))
    partly_injected: str | None = Field(default=None, validation_alias=AliasChoices("__PROBE_GATEWAY", "PROBE_OWN"))


@pytest.mark.parametrize(
    ("field_name", "expected"),
    [
        pytest.param("plain", ["PLAIN"], id="no_alias"),
        pytest.param("renamed", ["PROBE_RENAMED"], id="single_alias"),
        pytest.param("injected", ["__PROBE_NEW", "__PROBE_OLD"], id="alias_choices"),
        pytest.param("partly_injected", ["__PROBE_GATEWAY", "PROBE_OWN"], id="mixed"),
    ],
)
def test_every_name_a_field_reads_is_found(field_name: str, expected: list[str]) -> None:
    assert _env_names(field_name, _AliasProbe.model_fields[field_name]) == expected


def test_a_gateway_injected_name_is_not_owed_to_the_generated_env() -> None:
    declared = {
        name
        for field_name, field in _AliasProbe.model_fields.items()
        for name in _env_names(field_name, field)
        if not name.startswith("__")
    }

    assert declared == {"PLAIN", "PROBE_RENAMED", "PROBE_OWN"}


class _BlankProbe(BaseEnv):
    probe_base_url: str | None = None
    probe_tenant_id: UUID | None = None
    probe_agent_name: str = "nuage-session"

    @property
    def configured(self) -> bool:
        return self.probe_base_url is not None


def test_a_blank_value_reads_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("PROBE_BASE_URL", "PROBE_TENANT_ID"):
        monkeypatch.setenv(name, "")

    settings = _BlankProbe(_env_file=None)

    assert settings.probe_base_url is None
    assert settings.probe_tenant_id is None
    assert settings.configured is False


def test_a_blank_value_leaves_a_non_empty_default_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROBE_AGENT_NAME", "")

    assert _BlankProbe(_env_file=None).probe_agent_name == "nuage-session"
