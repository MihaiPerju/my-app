"""The `helm` capability's init chart runs exactly the deploy-step commands the app ships.

Runs in a generated app where `core` supplies the cli commands and `helm` supplies the umbrella
chart. The guard moved here with the chart: a deployment-free app has no chart to check, and the
parity guard belongs beside the manifest that can drift.

Chart-versus-Compose parity is deliberately NOT asserted here: the Compose init file is owned by the
optional `docker-compose` capability, which a Helm-only app need not install, so reaching for
`deploy/compose/compose.init.yaml` would raise `FileNotFoundError`. That cross-manifest agreement is
enforced at the registry level (tests/registry/init-gating.test.ts), which renders both manifests
across every selection and holds each to the same vendored step set.
"""

import re
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
_CLI = _REPO / "packages/py/cli"
_CHART_VALUES = _REPO / "deploy/helm/app/charts/init/values.yaml"
_CHART_STEP = re.compile(r"^  - name: (\S+)\n    hookWeight:", re.MULTILINE)

# Typer names a command after its module with `_` -> `-` (`custom_rbac` -> `custom-rbac`).
_INIT_STEPS = sorted(
    path.stem.replace("_", "-")
    for path in (_CLI / "src/cli/commands").glob("*.py")
    if path.stem != "__init__" and re.search(r"^INIT_STEP = True\b", path.read_text(), re.MULTILINE)
)


def test_the_chart_runs_exactly_the_init_steps() -> None:
    # Both manifests name each step explicitly, so a rename in one place and not the other ships a
    # Job that dies on an unknown command, or drops a step from every deploy. The chart's step set
    # must match the deploy-step commands (those marked `INIT_STEP`) the app ships.
    assert sorted(_CHART_STEP.findall(_CHART_VALUES.read_text())) == _INIT_STEPS
