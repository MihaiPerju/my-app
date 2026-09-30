"""The generic delivery runtime must not import persistence or a feature slice.

``mistralai_capabilities.fastapi`` is the feature-agnostic HTTP delivery layer — the file-based
router loader, the hook runtime and the SSE encoder. It carries no identity gate, execution surface
or concrete store: those live in the ``fastapi-auth`` and ``fastapi-workflows-auth`` capabilities,
which extend the host through its routers and hook seams. If the generic layer imports ``db`` or a
capability slice, a bare ``fastapi`` app stops booting without them. This runs in a subprocess,
because the API test suite has already imported ``db`` in-process.
"""

import subprocess
import sys

_PROBE = """
import sys

# The whole generic delivery surface, including empty app-local hook discovery.
import mistralai_capabilities.fastapi.hooks
import mistralai_capabilities.fastapi.routing
import mistralai_capabilities.fastapi.sse
from mistralai_capabilities.fastapi.hooks import FastAPIHooks

FastAPIHooks.discover("uninstalled_api")
# `db` must be absent: the Postgres stores that import it live in the `fastapi-auth` and
# `fastapi-workflows-auth` capabilities.
persistence = {name.partition(".")[0] for name in sys.modules} & {"db"}
# Every capability toolkit that is not this generic one — including the sibling `fastapi_auth` and
# `fastapi_workflows_auth` delivery slices. Named as an exclusion rather than a list of capabilities so a
# new feature is covered the day it lands.
features = {
    name
    for name in sys.modules
    if name.startswith("mistralai_capabilities.")
    and name != "mistralai_capabilities.fastapi"
    and not name.startswith("mistralai_capabilities.fastapi.")
}
print(",".join(sorted(persistence | features)))
"""


def test_the_delivery_layer_imports_no_persistence_or_feature() -> None:
    probe = subprocess.run(
        [sys.executable, "-c", _PROBE], capture_output=True, text=True, check=True
    )

    assert probe.stdout.strip() == "", (
        f"importing mistralai_capabilities.fastapi pulled in {probe.stdout.strip()} — the generic "
        "delivery runtime must stay free of `db` and of any capability slice. The Postgres stores "
        "live in the `fastapi-auth` and `fastapi-workflows-auth` capabilities, whose host wiring installs "
        "them via dependency_overrides."
    )
