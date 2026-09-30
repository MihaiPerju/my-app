"""Experiment persistence: the named variant, its results, and the production pointer.

An experiment is defined by four things: a ``name``, a ``feature``, a free-form ``config`` dict, and
a list of artifacts referenced by name. Identity is the composite ``(feature, name)``: one row per
named definition. ``experiment_artifact`` is a pure join listing which artifacts an experiment
references (by ``artifact.name``); ``experiment_result`` and ``active_experiment`` reference the
experiment by its ``(feature, name)`` key.

``feature`` is an opaque string throughout: this layer is feature-agnostic and never branches on
its value.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, Column, DateTime, ForeignKey, ForeignKeyConstraint, Index, PrimaryKeyConstraint, String
from sqlmodel import Field, SQLModel


def _utc_timestamp() -> Any:
    """A timezone-aware, non-null timestamp column defaulting to ``now()``.

    Returns a fresh Field/Column on every call (SQLAlchemy requires a distinct Column instance per
    model attribute).
    """
    return Field(sa_column=Column(DateTime(timezone=True), nullable=False), default_factory=lambda: datetime.now(UTC))


class Experiment(SQLModel, table=True):
    __tablename__ = "experiment"

    feature: str = Field(primary_key=True, max_length=32)
    name: str = Field(primary_key=True, max_length=128)
    config: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    definition_hash: str = Field(default="", max_length=64)
    created_at: datetime = _utc_timestamp()


class ExperimentArtifact(SQLModel, table=True):
    """Join table: which artifacts (by name) an experiment references. One row per referenced artifact."""

    __tablename__ = "experiment_artifact"
    __table_args__ = (
        PrimaryKeyConstraint("feature", "name", "artifact_name", name="pk_experiment_artifact"),
        ForeignKeyConstraint(
            ["feature", "name"], ["experiment.feature", "experiment.name"], name="fk_experiment_artifact_experiment"
        ),
        Index("ix_experiment_artifact_name", "artifact_name"),
    )

    feature: str = Field(max_length=32)
    name: str = Field(max_length=128)
    artifact_name: str = Field(sa_column=Column(String(256), ForeignKey("artifact.name"), nullable=False))


class ExperimentResult(SQLModel, table=True):
    __tablename__ = "experiment_result"
    __table_args__ = (
        ForeignKeyConstraint(
            ["feature", "name"], ["experiment.feature", "experiment.name"], name="fk_experiment_result_experiment"
        ),
        Index("ix_experiment_result_experiment", "feature", "name"),
        Index("ix_experiment_result_created", "feature", "created_at"),
    )

    id: str = Field(primary_key=True, max_length=64)
    feature: str = Field(max_length=32)
    name: str = Field(max_length=128)
    dataset: str = Field(max_length=128)
    scores: dict[str, float] = Field(sa_column=Column(JSON, nullable=False))
    studio_run_id: str | None = Field(default=None, max_length=128)
    dataset_size: int = Field(default=0)
    passed: bool | None = Field(default=None)
    run_id: str = Field(default="", max_length=128)
    definition_hash: str = Field(default="", max_length=64)
    created_at: datetime = _utc_timestamp()


class ActiveExperiment(SQLModel, table=True):
    __tablename__ = "active_experiment"
    __table_args__ = (
        ForeignKeyConstraint(
            ["feature", "name"], ["experiment.feature", "experiment.name"], name="fk_active_experiment_experiment"
        ),
    )

    feature: str = Field(primary_key=True, max_length=32)
    name: str = Field(max_length=128)
    promoted_at: datetime = _utc_timestamp()
    promoted_by: str | None = Field(default=None, max_length=255)


class Artifact(SQLModel, table=True):
    __tablename__ = "artifact"

    name: str = Field(primary_key=True, max_length=256)
    hash: str = Field(max_length=64)
    type: str = Field(max_length=32)
    scope: str = Field(default="", max_length=128)
    content: dict[str, Any] = Field(sa_column=Column(JSON, nullable=False))
    created_at: datetime = _utc_timestamp()
