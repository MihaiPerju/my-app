#!/usr/bin/env python3
"""Put the ``mistral`` CLI on PATH for the generated-app e2e, then export MISTRAL_CLI.

The CLI's public ``install.sh`` is a plain-``curl`` installer that any runner can use, so this
script just fetches and runs it. Pin a release with ``CLI_VERSION=X.Y.Z``, else ``latest``. On
success it appends ``MISTRAL_CLI=<abs path>`` to $GITHUB_ENV. Any environment failure exits 75.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
from pathlib import Path
from typing import NoReturn

# The public installer and where it drops the binary. Overridable via env so a mirror or a fork can
# be used without a code change; the defaults are the public GitHub distribution.
INSTALL_URL = os.environ.get(
    "CLI_INSTALL_URL", "https://raw.githubusercontent.com/mistralai/cli/main/install.sh"
)
# Optional release pin (plain X.Y.Z, no leading "v"); empty => latest. install.sh reads MISTRAL_VERSION.
CLI_VERSION = os.environ.get("CLI_VERSION", "").strip().lstrip("v")
CLI_BIN = Path.home() / ".mistral" / "bin" / "mistral"
EXIT_NEUTRAL = 75


def neutral(reason: str) -> NoReturn:
    # Exit 75 distinguishes an environment fault from a registry regression for local callers.
    # The required GitHub workflow still maps it to failure: an unexecuted check cannot authorize
    # an RC publish.
    print(f"::warning::{reason}")
    raise SystemExit(EXIT_NEUTRAL)


def export_cli(path: Path) -> None:
    if not path.is_file():
        neutral(f"installer finished but no CLI at {path}")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IRUSR)
    try:
        version = subprocess.run(
            [str(path), "--version"], capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        neutral(f"installed CLI not runnable: {error}")
    if version.returncode != 0:
        neutral(f"CLI --version failed: {version.stderr.strip()[:200]}")
    github_env = os.environ.get("GITHUB_ENV")
    if github_env:
        with open(github_env, "a", encoding="utf-8") as handle:
            handle.write(f"MISTRAL_CLI={path}\n")
    # Also drop the path to a file, so the same workflow step can read it. GITHUB_ENV only
    # propagates to later steps, but the harness runs in one step to keep environment-exit 75 in
    # one place.
    out = os.environ.get("CLI_PATH_OUT")
    if out:
        Path(out).write_text(str(path))
    print(f"MISTRAL_CLI={path}  ({version.stdout.strip()})")


def main() -> None:
    """Download the public install.sh and run it, then export the installed binary."""
    runner_tmp = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir())
    installer = runner_tmp / "mistral-install.sh"

    # curl exits non-zero on network or not-found errors, and a stalled download raises
    # TimeoutExpired. These are environment faults, so use neutral-75, not a hard red on a flaky
    # network.
    try:
        fetch = subprocess.run(
            ["curl", "-fsSL", "--retry", "3", "-o", str(installer), INSTALL_URL],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        neutral(f"timed out downloading installer from {INSTALL_URL}")
    if fetch.returncode != 0:
        neutral(f"could not download installer from {INSTALL_URL}: {fetch.stderr.strip()[:300]}")

    env = {**os.environ}
    if CLI_VERSION:
        env["MISTRAL_VERSION"] = CLI_VERSION
    # install.sh handles platform detection, download, and checksum verification itself.
    try:
        run = subprocess.run(
            ["bash", str(installer)], env=env, capture_output=True, text=True, timeout=300
        )
    except subprocess.TimeoutExpired:
        neutral("CLI install.sh timed out (network/asset)")
    if run.returncode != 0:
        detail = (run.stderr or run.stdout).strip()[:300]
        neutral(f"CLI install.sh failed (network/asset): {detail}")

    export_cli(CLI_BIN)


if __name__ == "__main__":
    main()
