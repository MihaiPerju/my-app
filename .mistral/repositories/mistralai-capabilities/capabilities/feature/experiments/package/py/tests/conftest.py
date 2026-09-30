"""Stub ``db`` and ``env`` so template-zone helpers are importable in package tests.

Some tests exercise template functions (``_artifact_path``, ``_read_experiment_file``, etc.)
that import ``db.*`` and ``env.*`` at module level.  We inject lightweight stubs so those
functions can run without a database or a generated app.
"""

import sys
import types
from pathlib import Path

# --- stub the ``db`` package tree before anything tries to import it ----------------------

_db = types.ModuleType("db")
_db.get_session_maker = lambda: None  # type: ignore[attr-defined]

_db_accessors = types.ModuleType("db.accessors")
_db_accessors_experiment = types.ModuleType("db.accessors.experiment")
for _name in (
    "create_experiment",
    "upsert_artifact",
    "get_experiment",
    "get_referenced_artifacts",
):
    setattr(_db_accessors_experiment, _name, None)

_db_models = types.ModuleType("db.models")
_db_models_experiment = types.ModuleType("db.models.experiment")

for _name in (
    "Experiment",
    "ExperimentArtifact",
    "ExperimentResult",
    "ActiveExperiment",
    "Artifact",
):
    setattr(_db_models_experiment, _name, type(_name, (), {}))

sys.modules.setdefault("db", _db)
sys.modules.setdefault("db.accessors", _db_accessors)
sys.modules.setdefault("db.accessors.experiment", _db_accessors_experiment)
sys.modules.setdefault("db.models", _db_models)
sys.modules.setdefault("db.models.experiment", _db_models_experiment)

# --- stub ``env`` -------------------------------------------------------------------------

_env_mod = types.ModuleType("env")
_env_base = types.ModuleType("env._base")


class _FakeBaseEnv:
    pass


_env_base.BaseEnv = _FakeBaseEnv  # type: ignore[attr-defined]
sys.modules.setdefault("env", _env_mod)
sys.modules.setdefault("env._base", _env_base)

# --- add template source directories to sys.path -----------------------------------------

_conftest_dir = Path(__file__).resolve()
_TEMPLATE = _conftest_dir.parents[1] / ".." / ".." / "template" / "packages" / "py"
_TEMPLATE = _TEMPLATE.resolve()

if not _TEMPLATE.is_dir():
    _p = _conftest_dir.parent
    while _p != _p.parent:
        if _p.name == "_capability_package_tests":
            _TEMPLATE = _p.parent / "packages" / "py"
            break
        _p = _p.parent

for _pkg in ("evals", "db"):
    _src = _TEMPLATE / _pkg / "src"
    if _src.is_dir() and str(_src) not in sys.path:
        sys.path.insert(0, str(_src))
