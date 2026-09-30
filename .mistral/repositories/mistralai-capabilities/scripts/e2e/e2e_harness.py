"""Shared process, result, and environment helpers for the generated-app E2E."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

REGISTRY_ROOT = Path(__file__).resolve().parents[2]
APP_NAME = "e2eapp"
EXIT_INFRA = 75
PUBLIC_PYPI = "https://pypi.org/simple"
INFRA = re.compile(
    r"ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Temporary failure|network is unreachable|"
    r"TLS handshake|i/o timeout|\b(?:401|403)\b",
    re.IGNORECASE,
)

steps: list[tuple[str, str]] = []
failures: list[str] = []


def capability_roots() -> dict[str, Path]:
    """Map full capability identities to their descriptor-derived kind/id roots."""
    descriptor = json.loads((REGISTRY_ROOT / "registry.json").read_text())
    root = REGISTRY_ROOT / descriptor.get("capabilitiesDir", "capabilities")
    return {
        f"{descriptor['id']}/{capability['kind']}/{capability['id']}": root
        / capability["kind"]
        / capability["id"]
        for capability in descriptor["capabilities"]
    }



def selection_root_capability_ids() -> list[str]:
    """Return ordinary capabilities; derived integrations activate from these roots."""
    descriptor = json.loads((REGISTRY_ROOT / "registry.json").read_text())
    registry_id = descriptor["id"]
    return sorted(
        f"{registry_id}/{capability['kind']}/{capability['id']}"
        for capability in descriptor["capabilities"]
        if "activatedWhen" not in capability
    )

def installed_capability_ids(app_dir: Path) -> list[str]:
    """Read strict v4 installed identities; obsolete or malformed state is an error."""
    path = app_dir / ".mistral" / "capabilities.json"
    state = json.loads(path.read_text())
    if not isinstance(state, dict) or state.get("schemaVersion") != 4:
        raise ValueError(f"{path}: expected schemaVersion 4 capability state")
    installed = state.get("installed")
    if not isinstance(installed, list):
        raise ValueError(f"{path}: expected an installed array")
    identities: set[str] = set()
    for entry in installed:
        reference = entry.get("capability") if isinstance(entry, dict) else None
        if (
            not isinstance(reference, str)
            or re.fullmatch(
                r"[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*",
                reference,
            )
            is None
        ):
            raise ValueError(
                f"{path}: invalid installed capability reference {reference!r}"
            )
        identities.add(reference)
    return sorted(identities)


def run(
    cmd: list[str], cwd: str, env: dict[str, str] | None = None
) -> tuple[bool, str]:
    """Run a command and return success plus its combined captured output."""
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0, f"{proc.stdout}{proc.stderr}"


def uv_index_env() -> dict[str, str]:
    """Force the indexes this repo declares, exactly as the generated app's tasks do.

    uv reads ``UV_DEFAULT_INDEX`` and ``UV_INDEX_URL`` from the environment, and both outrank a
    project's ``[[tool.uv.index]]``. Inheriting the shell would grade a resolution the repo never
    produces. ``UV_EXTRA_INDEX_URL`` is blanked because an extra index reopens the
    dependency-confusion surface the explicit ``mistralai`` index closes.
    """
    env: dict[str, str] = {
        "UV_DEFAULT_INDEX": PUBLIC_PYPI,
        "UV_INDEX_URL": PUBLIC_PYPI,
        "PIP_INDEX_URL": PUBLIC_PYPI,
        "UV_EXTRA_INDEX_URL": "",
    }
    # The pull token for the index core's committed template pins. The generated app names it
    # MISTRAL_REGISTRY_TOKEN; the legacy name is accepted so the e2e runs either way. It is the
    # Basic-auth password, paired with the username that template's uv wrapper pins, as the
    # wrapper itself does.
    runner_token = os.environ.get("MISTRAL_REGISTRY_TOKEN") or os.environ.get(
        "GEMFURY_PULL_TOKEN"
    )
    if not os.environ.get("UV_INDEX_MISTRALAI_USERNAME") and runner_token:
        env["UV_INDEX_MISTRALAI_USERNAME"] = pinned_registry_user()
        env["UV_INDEX_MISTRALAI_PASSWORD"] = runner_token
    return env


def pinned_registry_user() -> str:
    """The private index's Basic-auth username, as core's committed ``tools/uv.sh`` pins it."""
    wrapper = REGISTRY_ROOT / "capabilities" / "base" / "core" / "template" / "tools" / "uv.sh"
    match = re.search(r"^export MISTRAL_REGISTRY_USER=(\S+)$", wrapper.read_text(), re.MULTILINE)
    if match is None:
        raise RuntimeError(f"no MISTRAL_REGISTRY_USER pinned in {wrapper}")
    return match.group(1)


def check(name: str, ok: bool, detail: str = "") -> None:
    """Record one assertion without stopping later independent checks."""
    steps.append(("PASS" if ok else "FAIL", name))
    if not ok:
        failures.append(f"{name}\n{detail}" if detail else name)


def skip(name: str) -> None:
    """Record an intentionally unavailable or inapplicable check."""
    steps.append(("SKIP", name))


def print_summary() -> None:
    print()
    for status, name in steps:
        print(f"  {status}  {name}")


def infra_exit(reason: str) -> NoReturn:
    """Exit 75 for an environment fault, unless a deterministic failure already occurred."""
    print_summary()
    if failures:
        print(f"\nENVIRONMENT -- {reason}", file=sys.stderr)
        print(
            "The environment also failed after registry checks had already failed.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print(f"\nENVIRONMENT -- {reason}", file=sys.stderr)
    print("Not a registry failure. Report neutral.", file=sys.stderr)
    raise SystemExit(EXIT_INFRA)


def finish() -> None:
    """Print the accumulated result and exit non-zero when any check failed."""
    print_summary()
    if failures:
        print(f"\nFAIL -- {len(failures)} of {len(steps)} checks\n", file=sys.stderr)
        for failure in failures:
            print(f"{failure}\n", file=sys.stderr)
        raise SystemExit(1)
    print(
        f"\nOK -- {len(steps)} checks against generated full and minimal applications."
    )
