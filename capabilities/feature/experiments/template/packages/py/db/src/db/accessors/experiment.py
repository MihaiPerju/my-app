"""Accessors for the experiment / experiment_result / active_experiment / artifact tables.

An experiment is ``{feature, name, config, [artifact names]}``. Identity is ``(feature, name)``.
``config`` is a free-form dict stored as-is; the referenced artifacts are listed in the
``experiment_artifact`` join and their content lives in ``artifact`` (keyed by name).
"""

import uuid
from datetime import UTC, datetime
from typing import Any, NamedTuple

from sqlalchemy import delete, literal, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from db.hashing import artifact_hash, experiment_definition_hash
from db.models.experiment import ActiveExperiment, Artifact, Experiment, ExperimentArtifact, ExperimentResult


async def get_experiment(session: AsyncSession, *, feature: str, name: str) -> Experiment | None:
    return await session.get(Experiment, (feature, name))


async def list_experiments(session: AsyncSession, *, feature: str, name: str | None = None) -> list[Experiment]:
    statement = select(Experiment).where(col(Experiment.feature) == feature)
    if name is not None:
        statement = statement.where(col(Experiment.name) == name)
    statement = statement.order_by(col(Experiment.created_at).desc())
    result = await session.execute(statement)
    return list(result.scalars().all())


async def list_artifact_names(session: AsyncSession, *, feature: str, name: str) -> list[str]:
    """The artifact names an experiment references, sorted for a stable order."""
    result = await session.execute(
        select(ExperimentArtifact.artifact_name)
        .where(col(ExperimentArtifact.feature) == feature, col(ExperimentArtifact.name) == name)
        .order_by(col(ExperimentArtifact.artifact_name))
    )
    return [row[0] for row in result.all()]


async def get_referenced_artifacts(session: AsyncSession, *, feature: str, name: str) -> list[Artifact]:
    """The full artifact rows an experiment references, joined from the link table."""
    result = await session.execute(
        select(Artifact)
        .join(ExperimentArtifact, col(Artifact.name) == col(ExperimentArtifact.artifact_name))
        .where(col(ExperimentArtifact.feature) == feature, col(ExperimentArtifact.name) == name)
        .order_by(col(Artifact.name))
    )
    return list(result.scalars().all())


async def resolve_experiment_snapshot(
    session: AsyncSession, *, feature: str, name: str
) -> tuple[Experiment, list[Artifact]] | None:
    """Atomically read an experiment and its referenced artifacts.

    Acquires a FOR SHARE lock on the experiment row so a concurrent reseed
    cannot modify the definition between the two queries.
    """
    result = await session.execute(
        select(Experiment)
        .where(col(Experiment.feature) == feature, col(Experiment.name) == name)
        .with_for_update(read=True)
    )
    experiment = result.scalars().first()
    if experiment is None:
        return None
    artifacts = await get_referenced_artifacts(session, feature=feature, name=name)
    return experiment, artifacts


async def create_experiment(
    session: AsyncSession,
    *,
    feature: str,
    name: str,
    config: dict[str, Any],
    artifact_names: list[str],
) -> Experiment:
    """Upsert an experiment ``(feature, name)`` with its config and referenced artifact names.

    Re-defining an existing ``(feature, name)`` overwrites its config in place and re-points its
    artifact links (delete-then-insert) so the definition always reflects the latest call. The
    referenced artifacts must already exist in the ``artifact`` table (upsert them first).
    """
    unique_artifact_names = list(dict.fromkeys(artifact_names))
    digest = experiment_definition_hash(config, unique_artifact_names)
    try:
        async with session.begin_nested():
            found = Experiment(
                feature=feature, name=name, config=config, definition_hash=digest, created_at=datetime.now(UTC)
            )
            session.add(found)
            await session.flush()
    except IntegrityError:
        found = await session.get(Experiment, (feature, name))
        if found is None:
            raise
        found.config = config
        found.definition_hash = digest
        session.add(found)
    await session.execute(
        delete(ExperimentArtifact).where(
            col(ExperimentArtifact.feature) == feature, col(ExperimentArtifact.name) == name
        )
    )
    await session.flush()
    for artifact_name in unique_artifact_names:
        session.add(ExperimentArtifact(feature=feature, name=name, artifact_name=artifact_name))
    await session.flush()
    await session.refresh(found)
    return found


async def record_result(
    session: AsyncSession,
    *,
    feature: str,
    name: str,
    dataset: str,
    scores: dict[str, float],
    studio_run_id: str | None,
    dataset_size: int,
    passed: bool | None,
    run_id: str,
    definition_hash: str = "",
) -> ExperimentResult:
    if not definition_hash:
        exp = await get_experiment(session, feature=feature, name=name)
        if exp is not None:
            definition_hash = exp.definition_hash
    row = ExperimentResult(
        id=str(uuid.uuid4()),
        feature=feature,
        name=name,
        dataset=dataset,
        scores=scores,
        studio_run_id=studio_run_id,
        dataset_size=dataset_size,
        passed=passed,
        run_id=run_id,
        definition_hash=definition_hash,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def list_results(
    session: AsyncSession,
    *,
    feature: str,
    name: str | None = None,
    dataset: str | None = None,
    after_created_at: datetime | None = None,
    after_id: str | None = None,
    limit: int,
) -> list[ExperimentResult]:
    statement = (
        select(ExperimentResult)
        .where(col(ExperimentResult.feature) == feature)
        .order_by(col(ExperimentResult.created_at).desc(), col(ExperimentResult.id).desc())
        .limit(limit)
    )
    if name is not None:
        statement = statement.where(col(ExperimentResult.name) == name)
    if dataset is not None:
        statement = statement.where(col(ExperimentResult.dataset) == dataset)
    if (after_created_at is None) != (after_id is None):
        raise ValueError("after_created_at and after_id must both be provided or both omitted")
    if after_created_at is not None and after_id is not None:
        statement = statement.where(
            tuple_(col(ExperimentResult.created_at), col(ExperimentResult.id))
            < tuple_(literal(after_created_at), literal(after_id))
        )
    result = await session.execute(statement)
    return list(result.scalars().all())


async def latest_result_for(
    session: AsyncSession, *, feature: str, name: str, dataset: str | None = None
) -> ExperimentResult | None:
    statement = (
        select(ExperimentResult)
        .where(col(ExperimentResult.feature) == feature, col(ExperimentResult.name) == name)
        .order_by(col(ExperimentResult.created_at).desc(), col(ExperimentResult.id).desc())
        .limit(1)
    )
    if dataset is not None:
        statement = statement.where(col(ExperimentResult.dataset) == dataset)
    result = await session.execute(statement)
    return result.scalars().first()


class ComparisonSide(NamedTuple):
    experiment: Experiment | None
    result: ExperimentResult | None
    definition_changed: bool


class ExperimentComparison(NamedTuple):
    a: ComparisonSide
    b: ComparisonSide


async def compare_experiments(
    session: AsyncSession,
    *,
    feature: str,
    name_a: str,
    name_b: str,
    dataset: str | None = None,
) -> ExperimentComparison:
    """Pair two experiments with their latest results.

    Each side exposes ``experiment``, ``result``, and ``definition_changed``.
    ``definition_changed`` is ``True`` when the result's ``definition_hash``
    differs from the experiment's current hash — i.e. the experiment was
    re-seeded after the result was recorded.
    """
    exp_a = await get_experiment(session, feature=feature, name=name_a)
    exp_b = await get_experiment(session, feature=feature, name=name_b)
    res_a = await latest_result_for(session, feature=feature, name=name_a, dataset=dataset) if exp_a else None
    res_b = await latest_result_for(session, feature=feature, name=name_b, dataset=dataset) if exp_b else None
    return ExperimentComparison(
        a=ComparisonSide(exp_a, res_a, bool(exp_a and res_a and exp_a.definition_hash != res_a.definition_hash)),
        b=ComparisonSide(exp_b, res_b, bool(exp_b and res_b and exp_b.definition_hash != res_b.definition_hash)),
    )


async def get_active(session: AsyncSession, *, feature: str) -> tuple[ActiveExperiment, Experiment] | None:
    pointer = await session.get(ActiveExperiment, feature)
    if pointer is None:
        return None
    experiment = await get_experiment(session, feature=feature, name=pointer.name)
    if experiment is None:
        return None
    return pointer, experiment


async def active_experiment(
    session: AsyncSession, *, feature: str, fall_back_to_recent: bool = False
) -> Experiment | None:
    """The promoted experiment for ``feature``, or None when none is promoted.

    With ``fall_back_to_recent=True``, when no experiment has been promoted for ``feature`` (no
    ``active_experiment`` row), return the most recently created experiment for that feature instead
    (``list_experiments`` orders ``created_at`` descending). Returns None only when the feature has
    no experiments at all.
    """
    active = await get_active(session, feature=feature)
    if active is not None:
        return active[1]
    if not fall_back_to_recent:
        return None
    rows = await list_experiments(session, feature=feature)
    return rows[0] if rows else None


async def set_active(session: AsyncSession, *, feature: str, name: str, promoted_by: str | None) -> ActiveExperiment:
    now = datetime.now(UTC)
    try:
        async with session.begin_nested():
            pointer = ActiveExperiment(feature=feature, name=name, promoted_at=now, promoted_by=promoted_by)
            session.add(pointer)
            await session.flush()
    except IntegrityError:
        pointer = await session.get(ActiveExperiment, feature)
        if pointer is None:
            raise
        pointer.name = name
        pointer.promoted_at = now
        pointer.promoted_by = promoted_by
    await session.commit()
    await session.refresh(pointer)
    return pointer


async def get_artifact(session: AsyncSession, name: str) -> Artifact | None:
    return await session.get(Artifact, name)


async def list_artifacts_by_scope(session: AsyncSession, *, scope: str) -> list[Artifact]:
    """Every artifact carrying ``scope`` (the free-text 'what to use where' tag), name-sorted."""
    result = await session.execute(select(Artifact).where(col(Artifact.scope) == scope).order_by(col(Artifact.name)))
    return list(result.scalars().all())


async def upsert_artifact(
    session: AsyncSession, *, name: str, type: str, content: dict[str, Any], scope: str = ""
) -> Artifact:
    digest = artifact_hash(type, content)
    try:
        async with session.begin_nested():
            row = Artifact(
                name=name, hash=digest, type=type, scope=scope, content=content, created_at=datetime.now(UTC)
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            return row
    except IntegrityError:
        existing = await session.get(Artifact, name)
        if existing is None:
            raise
        if existing.hash != digest:
            raise ValueError(
                f"artifact {name!r} already exists with different content; use a versioned name instead"
            ) from None
        if existing.scope != scope:
            existing.scope = scope
            await session.flush()
        return existing
