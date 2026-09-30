"""Load an experiment (and the artifacts it references) into the DB from a seed folder.

A seed folder has two trees::

    <seed_root>/experiment/<...>.yaml   # one file per experiment
    <seed_root>/artifact/<...>.yaml     # one file per artifact

An experiment file is YAML with ``feature``, ``config`` (a free-form dict), and ``artifacts`` (a
list of artifact names). Its own ``name`` is derived from its path under ``experiment/`` (see
``seed_name_from_path``). Each referenced artifact name maps back to a file under ``artifact/``
(``prompt:classification:v1`` -> ``<seed_root>/artifact/prompt/classification/v1.<ext>``); that file
is YAML with ``type`` and ``content``.

Loading upserts every referenced artifact first (the experiment_artifact FK requires them to exist),
then upserts the experiment and re-points its artifact links. I/O lives here; the DB writes go
through the ``db`` accessors.
"""

from pathlib import Path
from typing import Any

import yaml
from db import get_session_maker
from db.accessors.experiment import create_experiment, upsert_artifact
from db.models.experiment import Experiment
from mistralai_capabilities.experiments.seed import seed_name_from_path

_SEED_EXTENSIONS = (".yaml", ".yml", ".json")


def _artifact_path(seed_root: Path, artifact_name: str) -> Path:
    """Resolve an artifact name (``prompt:classification:v1``) to its file under ``artifact/``."""
    parts = artifact_name.split(":")
    if not parts or not all(parts):
        raise ValueError(f"invalid artifact name: {artifact_name!r}")
    relative = Path(*parts)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"artifact name must not escape the seed directory: {artifact_name!r}")
    artifact_root = seed_root / "artifact"
    resolved_artifact_root = artifact_root.resolve()
    base = artifact_root / relative
    for extension in _SEED_EXTENSIONS:
        candidate = Path(f"{base}{extension}")
        if not candidate.resolve().is_relative_to(resolved_artifact_root):
            raise ValueError(f"artifact name must not escape the seed directory: {artifact_name!r}")
        if candidate.is_file():
            return candidate
    searched = ", ".join(f"{base}{extension}" for extension in _SEED_EXTENSIONS)
    raise FileNotFoundError(f"no seed file for artifact {artifact_name!r} (looked for: {searched})")


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"seed file {path} must be a YAML mapping, got {type(data).__name__}")
    return data


def _read_experiment_file(path: Path, seed_root: Path) -> tuple[str, str, dict[str, Any], list[str]]:
    """Parse an experiment seed file into ``(name, feature, config, artifact_names)``."""
    body = _load_yaml_mapping(path)
    feature = body.get("feature")
    if not isinstance(feature, str) or not feature:
        raise ValueError(f"experiment seed {path} must set a non-empty string 'feature'")
    artifacts = body.get("artifacts", [])
    if not isinstance(artifacts, list) or not all(isinstance(item, str) for item in artifacts):
        raise ValueError(f"experiment seed {path} 'artifacts' must be a list of artifact-name strings")
    config = body.get("config", {})
    if not isinstance(config, dict):
        raise ValueError(f"experiment seed {path} 'config' must be a mapping")
    name = seed_name_from_path(path.relative_to(seed_root).as_posix(), category="experiment")
    return name, feature, config, artifacts


def _read_artifact_file(path: Path, seed_root: Path) -> tuple[str, str, str, dict[str, Any]]:
    """Parse an artifact seed file into ``(name, type, scope, content)``."""
    body = _load_yaml_mapping(path)
    artifact_type = body.get("type")
    if not isinstance(artifact_type, str) or not artifact_type:
        raise ValueError(f"artifact seed {path} must set a non-empty string 'type'")
    scope = body.get("scope", "")
    if not isinstance(scope, str):
        raise ValueError(f"artifact seed {path} 'scope' must be a string")
    content = body.get("content", {})
    if not isinstance(content, dict):
        raise ValueError(f"artifact seed {path} 'content' must be a mapping")
    name = seed_name_from_path(path.relative_to(seed_root).as_posix(), category="artifact")
    return name, artifact_type, scope, content


def _resolve_experiment_path(seed_root: str | Path, experiment_file: str | Path) -> tuple[Path, Path]:
    """Return ``(root, exp_path)`` with both paths resolved, raising on traversal."""
    root = Path(seed_root).resolve()
    exp_path = Path(experiment_file)
    if not exp_path.is_absolute():
        exp_path = root / exp_path
    exp_path = exp_path.resolve()
    if not exp_path.is_relative_to(root):
        raise ValueError(f"experiment file must not escape the seed directory: {experiment_file!r}")
    return root, exp_path


async def load_experiment_from_seed(seed_root: str | Path, experiment_file: str | Path) -> Experiment:
    """Load one experiment and its referenced artifacts from a seed folder into the DB."""
    root, exp_path = _resolve_experiment_path(seed_root, experiment_file)

    name, feature, config, artifact_names = _read_experiment_file(exp_path, root)

    maker = get_session_maker()
    async with maker() as session:
        for artifact_name in dict.fromkeys(artifact_names):
            art_path = _artifact_path(root, artifact_name)
            art_name, art_type, art_scope, art_content = _read_artifact_file(art_path, root)
            await upsert_artifact(session, name=art_name, type=art_type, content=art_content, scope=art_scope)
        experiment = await create_experiment(
            session, feature=feature, name=name, config=config, artifact_names=artifact_names
        )
        await session.commit()
        return experiment
