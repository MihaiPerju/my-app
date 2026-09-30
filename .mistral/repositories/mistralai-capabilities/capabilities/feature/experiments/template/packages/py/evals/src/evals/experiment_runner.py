"""Feature-agnostic helpers for the experiment evaluation path.

An experiment is ``{feature, name, config, [artifact names]}``. What lives here is the generic core:

- ``resolve_experiment`` — read an experiment by ``(feature, name)`` and return its free-form
  ``config`` plus the content of every artifact it references (keyed by artifact name). DB-only.
- the request / plan / result models the orchestration passes around.

``feature`` is an opaque string throughout; nothing here branches on its value or knows about any
particular feature.
"""

from dataclasses import dataclass, field
from typing import Any

from db import get_session_maker
from db.accessors.experiment import resolve_experiment_snapshot
from pydantic import BaseModel


@dataclass
class ResolvedExperiment:
    """An experiment resolved for a run: its config, its referenced artifact contents, and a client.

    ``config`` is the experiment's free-form dict, as stored. ``artifacts`` maps each referenced
    artifact name to its content dict. ``client`` is an in-memory-only convenience (a live SDK
    client) that MUST never be persisted back into ``config`` or an artifact.
    """

    config: dict[str, Any] = field(default_factory=dict)
    artifacts: dict[str, dict[str, Any]] = field(default_factory=dict)
    client: Any = None


class EvaluateExperimentRequest(BaseModel):
    feature: str
    experiment_name: str
    dataset: str | None = None
    local: bool = False
    collection_name: str | None = None


class ScoreFromRunExperimentRequest(BaseModel):
    """Re-score a prior feature run's persisted outputs against the experiment's gold dataset."""

    feature: str
    experiment_name: str
    collection_name: str | None = None
    source_run_id: str | None = None
    source_config_digest: str | None = None
    dataset: str | None = None


class ExperimentPlan(BaseModel):
    """Everything an evaluation run needs, resolved once in the parent workflow."""

    feature: str
    experiment_name: str
    dataset_name: str
    records: list[dict] = []
    config: dict[str, Any] = {}
    artifacts: dict[str, dict[str, Any]] = {}


class EvaluateExperimentResult(BaseModel):
    feature: str
    experiment_name: str
    dataset: str
    scores: dict[str, float] = {}
    passed: bool | None = None
    dataset_size: int = 0
    run_id: str = ""
    studio_run_id: str | None = None


async def resolve_experiment(feature: str, name: str, *, client: Any) -> tuple[Any, ResolvedExperiment]:
    """Resolve an experiment by ``(feature, name)``, DB-only.

    Reads the experiment row (for its free-form ``config``) and the content of every artifact it
    references, keyed by artifact name. An unknown ``(feature, name)`` is a permanent input error
    (``ValueError``).
    """
    maker = get_session_maker()
    async with maker() as session:
        snapshot = await resolve_experiment_snapshot(session, feature=feature, name=name)
        if snapshot is None:
            raise ValueError(
                f"no experiment named {name!r} for feature {feature!r} (define it via create/seed before resolving it)"
            )
        experiment, artifacts = snapshot

    resolved = ResolvedExperiment(
        config=dict(experiment.config),
        artifacts={artifact.name: artifact.content for artifact in artifacts},
        client=client,
    )
    return experiment, resolved
