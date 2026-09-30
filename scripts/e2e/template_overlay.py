"""Rebuild a generated app's file tree from the committed capability templates, no CLI involved.

``lint_templates.py`` (ruff) and ``fmt_templates.py`` (oxfmt) both check the templates the way the
generated app sees them: composed. This module owns that composition, so the two gates cannot drift
on which templates exist, the order they overlay in, how a template path maps to an app path, or
which capability owns a file.

- Every ``capabilities/<kind>/<id>/template`` contributes, in sorted order.
- A template file at ``template/<path>`` lands at ``<path>`` in the app.
- Where two templates write one path the later one wins, as in a generated app, and both are
  recorded as owners so a finding points at every source.
"""

from __future__ import annotations

import shutil
from collections import defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CAPABILITIES = REPO / "capabilities"
# `capabilities/<kind>/<id>/template` is the overlay every capability contributes to an app.
CAPS_GLOB = "capabilities/*/*/template"
# The code-quality template: the lint and format configs every generated app runs under.
CODE_QUALITY_TEMPLATE = CAPABILITIES / "tooling" / "code-quality" / "template"

Owners = dict[str, list[str]]


def templates() -> list[Path]:
    """Every capability template directory, in overlay order."""
    return sorted(REPO.glob(CAPS_GLOB))


def capability_id(template: Path) -> str:
    """``<kind>/<id>`` for a ``capabilities/<kind>/<id>/template`` directory."""
    return template.parent.relative_to(CAPABILITIES).as_posix()


def template_files(template: Path, zones: Iterable[str] | None = None) -> list[Path]:
    """A template's files in sorted order, limited to the top-level ``zones`` when given."""
    roots = [template] if zones is None else [template / zone for zone in zones]
    return sorted(path for root in roots if root.is_dir() for path in root.rglob("*") if path.is_file())


def compose(
    dest: Path,
    *,
    zones: Iterable[str] | None = None,
    include: Callable[[Path], bool] | None = None,
) -> Owners:
    """Overlay every template into ``dest``; map each app-relative path to the capabilities that wrote it.

    ``zones`` limits the copy to top-level directories (``apps``, ``packages``); ``include`` is
    called with the path relative to its template and drops the file when it returns False.
    """
    zones = tuple(zones) if zones is not None else None
    owners: Owners = defaultdict(list)
    for template in templates():
        capability = capability_id(template)
        for source in template_files(template, zones):
            relative = source.relative_to(template)
            if include is not None and not include(relative):
                continue
            out = dest / relative
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, out)
            owners[relative.as_posix()].append(capability)
    return owners


def source_paths(relative: str, owners: Owners) -> list[str]:
    """The committed template path(s) an app-relative file came from, for an actionable report."""
    return [f"capabilities/{capability}/template/{relative}" for capability in owners.get(relative, [])]
