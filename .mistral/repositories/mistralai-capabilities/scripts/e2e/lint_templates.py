#!/usr/bin/env python3
"""Fast, CLI-free mirror of the generated app's ``ruff check``.

Capability templates are OVERLAYS. ``base/core`` ships ``packages/py/env/src/env/_base.py`` while
``deployment/apps`` adds ``packages/py/env/src/env/gateway.py`` to the *same* package. Ruff's isort
classifies ``env`` as first-party only when it can see the assembled package under a source root, so
linting a single template in place both misses real errors and invents phantom ones. The whole
package exists only in a generated app -- which is why an unsorted import in a template surfaces
nowhere until the 15-20 min ``generated-app-e2e`` finally runs ``nx run quality:lint`` on the
composed tree (this is exactly how PR #171 inherited a gateway.py I001 it never touched).

This script reconstructs that composed tree from the committed templates -- no CLI, no registry, no
network -- drops in the code-quality ``ruff.toml``, and runs the same ``ruff check``. It reproduces
the e2e's lint result in seconds and maps every finding back to the template that owns the file, so
the fast ``framework-check`` job and the pre-commit hook can reject it before a PR is ever opened.
The full ``generated-app-e2e`` remains the authoritative backstop.

Exit codes: 0 clean, 1 lint findings, 2 the environment could not run ruff.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

from template_overlay import CODE_QUALITY_TEMPLATE, compose, source_paths, templates

# The one ruff config a generated app lints under; `nx run quality:lint` -> `ruff check .` uses it.
RUFF_CONFIG = CODE_QUALITY_TEMPLATE / "ruff.toml"
# The code-quality package a generated app installs; its ruff pin is the version contract this gate
# must match so pre-commit, framework-check, and `nx run quality:lint` never disagree on a ruleset.
CODE_QUALITY_PYPROJECT = CODE_QUALITY_TEMPLATE / "packages" / "py" / "code-quality" / "pyproject.toml"
RUFF_SPEC_FALLBACK = "ruff>=0.14"


def ruff_spec() -> str:
    """The ruff requirement the generated app enforces, read from the code-quality package.

    Resolving ruff through this exact constraint keeps this fast gate and the app's
    ``nx run quality:lint`` on one contract, rather than trusting whatever ``ruff`` a developer
    happens to have on PATH. Falls back to the current floor if the manifest cannot be read.
    """
    try:
        manifest = tomllib.loads(CODE_QUALITY_PYPROJECT.read_text())
        # ruff lives in [dependency-groups].dev (a lint-only tool, not a runtime dep); scan the
        # project dependencies too so a future relocation still resolves.
        requirements = [
            *manifest.get("project", {}).get("dependencies", []),
            *manifest.get("dependency-groups", {}).get("dev", []),
        ]
        for dependency in requirements:
            requirement = dependency.replace(" ", "")
            if re.match(r"ruff(?![\w-])", requirement):
                return requirement
    except (OSError, tomllib.TOMLDecodeError):
        pass
    return RUFF_SPEC_FALLBACK


def ruff_command() -> list[str] | None:
    """Resolve ruff through uv under the code-quality constraint; never an arbitrary PATH binary.

    A developer's stale global ruff would pass here yet fail the app's gate (or vice versa), so the
    binary is always resolved -- and cached -- by uv from the same requirement the app installs.
    """
    spec = ruff_spec()
    if shutil.which("uvx"):
        return ["uvx", spec]
    if shutil.which("uv"):
        return ["uv", "tool", "run", spec]
    return None


def main() -> int:
    if not RUFF_CONFIG.is_file():
        print(f"code-quality ruff config not found at {RUFF_CONFIG}", file=sys.stderr)
        return 2
    ruff = ruff_command()
    if ruff is None:
        print("uv not found: install uv so ruff can be resolved at the required version.", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="template-lint-") as tmp:
        root = Path(tmp).resolve()  # ruff reports resolved paths; macOS symlinks /var -> /private/var
        # The full tree is copied, not just `*.py`: ruff's first-party classification reads the
        # surrounding project layout (package `pyproject.toml` markers and source roots), and a
        # Python-only copy misclassifies imports and invents phantom findings.
        owners = compose(root)
        shutil.copyfile(RUFF_CONFIG, root / "ruff.toml")
        result = subprocess.run(
            [*ruff, "check", "--output-format=json", "."],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode not in (0, 1):  # 0 clean, 1 findings; anything else is a ruff failure
            print("ruff could not run against the assembled templates:", file=sys.stderr)
            sys.stderr.write(result.stderr or result.stdout)
            return 2
        try:
            findings = json.loads(result.stdout or "[]")
        except json.JSONDecodeError:
            print("ruff could not run against the assembled templates:", file=sys.stderr)
            sys.stderr.write(result.stderr or result.stdout)
            return 2
        # Resolve each finding to its template source(s) while the assembled tree still exists.
        reports: list[tuple[str, list[str]]] = []
        for finding in findings:
            relative = Path(finding["filename"]).relative_to(root).as_posix()
            location = finding.get("location") or {}
            row = location.get("row", "?")
            column = location.get("column", "?")
            code = finding.get("code") or "ruff"
            fixable = " [*]" if finding.get("fix") else ""
            sources = source_paths(relative, owners) or [f"(assembled) {relative}"]
            reports.append(
                (
                    f"  {code}{fixable}  {finding.get('message', '')}",
                    [f"        {path}:{row}:{column}" for path in sources],
                )
            )

    template_count = len(templates())
    python_files = sum(1 for path in owners if path.endswith(".py"))
    if not reports:
        print(f"template lint: no ruff findings ({python_files} Python files across {template_count} templates).")
        return 0

    print(f"template lint: {len(reports)} ruff finding(s) in the composed app tree.\n")
    print("These files lint clean in isolation but fail `nx run quality:lint` once composed into a")
    print("generated app. Edit the template source(s) below (ruff --fix resolves import sorting).\n")
    for header, locations in reports:
        print(header)
        for location in locations:
            print(location)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
