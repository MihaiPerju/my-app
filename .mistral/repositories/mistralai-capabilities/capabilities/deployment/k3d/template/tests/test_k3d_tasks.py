"""The `k3d` capability contributes its `up`/`down` NX targets and its local-cluster assets.

The invoke `k3d-up`/`k3d-down` tasks became `up`/`down` targets on the `k3d` NX project
(`tasks/k3d/project.json`), backed by the existing `tools/k3d-up.sh`/`tools/k3d-down.sh`. These run
in the generated app (where `helm` supplies the umbrella chart and `k3d` supplies the project and
the local-cluster assets), so they prove the extraction preserved the commands, that the local
assets land where the helpers expect them, and that `k3d` reuses the `helm` chart rather than
shipping one of its own.
"""

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PROJECT = json.loads((_REPO_ROOT / "tasks" / "k3d" / "project.json").read_text())


def test_k3d_project_exposes_the_up_and_down_targets() -> None:
    assert {"up", "down"} <= set(_PROJECT["targets"])
    up = _PROJECT["targets"]["up"]
    down = _PROJECT["targets"]["down"]
    assert up["executor"] == "nx:run-commands"
    assert down["executor"] == "nx:run-commands"
    assert "tools/k3d-up.sh" in up["options"]["command"]
    assert "tools/k3d-down.sh" in down["options"]["command"]


def test_k3d_capability_ships_only_local_cluster_assets() -> None:
    # The lifecycle helpers and local overlay it owns.
    assert (_REPO_ROOT / "tools/k3d-up.sh").exists()
    assert (_REPO_ROOT / "tools/k3d-down.sh").exists()
    assert (_REPO_ROOT / "deploy/k3d/values-local.yaml").exists()
    assert (_REPO_ROOT / "deploy/k3d/keycloak.yaml").exists()


def test_k3d_reuses_the_helm_chart_it_deploys() -> None:
    # `helm` (a hard dependency) owns the chart; k3d-up deploys that chart, so it must be present and
    # k3d must not have shipped a duplicate of its own.
    assert (_REPO_ROOT / "deploy/helm/app/Chart.yaml").exists()
    assert "deploy/helm/app" in (_REPO_ROOT / "tools/k3d-up.sh").read_text()
