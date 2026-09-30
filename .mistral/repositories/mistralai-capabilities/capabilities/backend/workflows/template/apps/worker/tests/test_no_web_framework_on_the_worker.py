"""Importing installed features must not load the HTTP delivery machinery.

The rule is about what a toolkit *exposes*, not what it contains: importing
`mistralai_capabilities.<capability>` must not reach `mistralai_capabilities.fastapi`. A capability
may still ship an API-layer submodule -- `chat.vibe.router` and
`document_annotation_ui.api` both import delivery -- as long as the package `__init__`
does not pull it in, because the worker only ever imports the package. That is what this probe
walks, so adding such an import to an `__init__` is what it catches.

The walk is every installed toolkit except `fastapi` itself, rather than a list of names: a list
misses the next capability the day it lands, and `fastapi` is the one thing here that is delivery by
definition.

The probe runs in a subprocess, because pytest imports FastAPI in-process. The framework half uses
import provenance, not `sys.modules`, because the Agents SDK soft-imports FastAPI. The API-delivery
half stays a membership test, because no third party imports this app's own modules.
"""

import subprocess
import sys

_PROBE = """
import builtins
import importlib
import importlib.util
import pkgutil
import sys

# The provenance hook. `builtins.__import__` fires on every import, including a cache hit a
# membership test misses, and `globals` identify the importer. APP_ROOTS lists every top-level this
# app ships, including installed capability toolkits; add a package here when a capability adds one.
APP_ROOTS = (
    "mistralai_capabilities.",
    "api.",
    "cli.",
    "db.",
    "env.",
    "evals.",
    "utils.",
    "worker.",
)
FRAMEWORKS = {"fastapi"}
app_framework_imports = set()

_real_import = builtins.__import__


def _tracking_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.partition(".")[0]
    if root in FRAMEWORKS and globals is not None:
        importer = globals.get("__name__") or ""
        if importer.startswith(APP_ROOTS):
            app_framework_imports.add(root)
    return _real_import(name, globals, locals, fromlist, level)


builtins.__import__ = _tracking_import

import mistralai.workflows as workflows

importlib.import_module("worker.entrypoints.worker")

workflows.discover_all_workflows_in_package("worker.workflows")

# The three delivery namespaces: the generic FastAPI toolkit plus the fastapi-auth and
# fastapi-workflows-auth slices. Named directly so the guard holds even if the imports become lazy; none
# is worker-safe, and the MCP-app half lives elsewhere.
delivery_roots = (
    "mistralai_capabilities.fastapi",
    "mistralai_capabilities.fastapi_auth",
    "mistralai_capabilities.fastapi_workflows_auth",
)

toolkits_spec = importlib.util.find_spec("mistralai_capabilities")

if toolkits_spec is not None:
    toolkits = importlib.import_module("mistralai_capabilities")
    # Enumerate the installed toolkits, do not hardcode a list: a list misses the next capability
    # the day it lands. The delivery packages are skipped because they ARE the layer this guard
    # forbids on the worker.
    for module in pkgutil.iter_modules(toolkits.__path__, f"{toolkits.__name__}."):
        if module.ispkg and module.name not in delivery_roots:
            importlib.import_module(module.name)

frameworks = app_framework_imports
delivery = {name for name in sys.modules if name.startswith(delivery_roots)}
print(",".join(sorted(frameworks | delivery)))
"""


def test_importing_a_feature_loads_no_web_framework() -> None:
    probe = subprocess.run(
        [sys.executable, "-c", _PROBE],
        capture_output=True,
        text=True,
        check=True,
    )

    assert probe.stdout.strip() == "", (
        f"importing installed feature packages pulled in {probe.stdout.strip()} — "
        "the worker must not load a web framework or API delivery module to run an activity. "
        "A capability toolkit's `__init__` is re-exporting an API-layer submodule; keep the import "
        "inside the submodule, where only the API host reaches it."
    )
