#!/usr/bin/env python3
"""Fast, CLI-free mirror of the generated app's ``oxfmt --check apps packages`` (``quality:check-ts``).

The sibling of ``lint_templates.py``. A template file the app's formatter would rewrite surfaces
nowhere until the 15-20 min ``generated-app-e2e`` runs ``nx run quality:check-ts`` on the composed
tree (PR #197 reached CI with a markdown code block oxfmt reflows). Capability templates never
contribute the same path twice (a registry test enforces it), so the composed ``apps/`` and
``packages/`` trees are the union of every template's copies. This rebuilds that union through the
same composition ``lint_templates.py`` uses (``template_overlay``), drops in the code-quality
``.oxfmtrc.json``, and runs the oxfmt version code-quality pins, mapping each finding back to the
template that owns it.

Exit codes: 0 clean, 1 format findings, 2 the environment could not run oxfmt.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from template_overlay import CODE_QUALITY_TEMPLATE as CODE_QUALITY
from template_overlay import Owners, compose, source_paths

ZONES = ("apps", "packages")
# Rendered later by the CLI, so their bytes are not what the app's formatter sees.
SKIP_SUFFIXES = (".hbs",)
SKIP_DIRS = {"node_modules", "__pycache__", ".venv"}


def pinned_oxfmt() -> str:
    manifest = json.loads((CODE_QUALITY / "packages" / "ts" / "code-quality" / "package.json").read_text())
    for section in ("dependencies", "devDependencies"):
        version = manifest.get(section, {}).get("oxfmt")
        if version:
            return version
    raise SystemExit("code-quality does not pin oxfmt; cannot mirror the app's formatter")


def formatted_by_app(relative: Path) -> bool:
    """Whether the app's formatter sees this template file's bytes as committed."""
    return not relative.name.endswith(SKIP_SUFFIXES) and not SKIP_DIRS.intersection(relative.parts)


def compose_zones(dest: Path) -> Owners:
    owners = compose(dest, zones=ZONES, include=formatted_by_app)
    shutil.copyfile(CODE_QUALITY / ".oxfmtrc.json", dest / ".oxfmtrc.json")
    return owners


def main() -> int:
    bunx = shutil.which("bunx")
    if bunx is None:
        print("bunx not found; cannot run oxfmt", file=sys.stderr)
        return 2
    version = pinned_oxfmt()
    with tempfile.TemporaryDirectory(prefix="fmt-templates-") as tmp:
        tree = Path(tmp)
        owners = compose_zones(tree)
        result = subprocess.run(
            [bunx, f"oxfmt@{version}", "--check", *ZONES],
            cwd=tree,
            capture_output=True,
            text=True,
            check=False,
        )
    output = result.stdout + result.stderr
    if result.returncode == 0:
        print(f"oxfmt@{version}: {len(owners)} template files formatted as the generated app expects")
        return 0
    findings = [line.split(" (")[0].strip() for line in output.splitlines() if re.match(r"^(apps|packages)/", line)]
    if not findings:
        print(output, file=sys.stderr)
        return 2
    print(f"oxfmt@{version} would reformat {len(findings)} template file(s):")
    for relative in findings:
        for source in source_paths(relative, owners) or [relative]:
            print(f"  {source}")
    print("Format them with the pinned oxfmt and the code-quality .oxfmtrc.json (see this script).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
