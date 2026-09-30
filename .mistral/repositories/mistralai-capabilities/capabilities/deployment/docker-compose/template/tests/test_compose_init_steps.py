"""The docker-compose init root must run exactly the deploy-step commands this app vendored.

Runs in a generated app that installed `docker-compose`, so `deploy/compose/compose.init.yaml` is
present. `cli.commands` is populated by whichever capabilities were installed; the Compose init root
this capability owns declares one `init-<step>` service per deployment step, each running
`python -m cli <step>`. The deploy-step commands are those marked `INIT_STEP = True`; the Compose
root must declare exactly those the app vendored: a rename or drop diverges the service set. The step
list is read through `tools/compose.sh init-steps` — the same discovery the `init` target runs —
rather than a second in-Python parse of the manifest.

Compose-versus-Helm-chart parity is deliberately NOT asserted here: the Helm chart is owned by the
optional `helm` capability, which the default selection does not install, so reaching for
`charts/init/values.yaml` would raise `FileNotFoundError` in any app that took Compose without Helm.
That cross-manifest agreement is enforced at the registry level (tests/registry/init-gating.test.ts),
which renders both manifests across every selection and holds each to the same vendored step set.
"""

import re
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
COMPOSE_SH = REPO / "tools" / "compose.sh"
BASH = shutil.which("bash") or "/bin/bash"
# Typer names a command after its module with `_` -> `-` (`custom_rbac` -> `custom-rbac`).
_INIT_STEPS = sorted(
    path.stem.replace("_", "-")
    for path in (REPO / "packages/py/cli/src/cli/commands").glob("*.py")
    if path.stem != "__init__" and re.search(r"^INIT_STEP = True\b", path.read_text(), re.MULTILINE)
)


def test_compose_runs_exactly_the_init_steps() -> None:
    # Both the compose init root and the marked modules name each step explicitly, so a rename in
    # one place and not the other ships a service that dies on an unknown command, or drops a step
    # from every deploy. The step list is read through the shell the `init` target actually uses.
    result = subprocess.run(
        [BASH, str(COMPOSE_SH), "init-steps"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    assert sorted(result.stdout.split()) == _INIT_STEPS
