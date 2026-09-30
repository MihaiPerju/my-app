"""The `helm` capability contributes its `validate` NX target and its chart assets.

The invoke `helm-validate` task became a `validate` target on the `helm` NX project
(`tasks/helm/project.json`), backed by the existing `tools/validate-helm.sh`. These run in the
generated app (where `helm` supplies the project and the chart), so they prove the extraction
preserved the validate command and that the chart lands where it expects it.
"""

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PROJECT = json.loads((_REPO_ROOT / "tasks" / "helm" / "project.json").read_text())


def test_helm_project_exposes_the_validate_target() -> None:
    assert "validate" in _PROJECT["targets"]
    target = _PROJECT["targets"]["validate"]
    assert target["executor"] == "nx:run-commands"
    assert "tools/validate-helm.sh" in target["options"]["command"]


def test_helm_capability_ships_the_chart_and_its_validator() -> None:
    assert (_REPO_ROOT / "deploy/helm/app/Chart.yaml").exists()
    assert (_REPO_ROOT / "tools/validate-helm.sh").exists()
