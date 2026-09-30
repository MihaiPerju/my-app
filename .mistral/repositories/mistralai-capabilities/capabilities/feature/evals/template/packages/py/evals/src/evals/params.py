"""The parameters one evaluation run takes, shared across every eval track."""

from typing import Any

from pydantic import BaseModel, Field


class EvalParams(BaseModel):
    """What any track needs to run: its cases, judge, run label, and whether to stay offline.

    The fields, types, and defaults are the same on every track, so they live here once. A track
    subclasses this only to word the ``dataset`` and ``judge_model`` descriptions for its domain.
    """

    dataset: list[dict[str, Any]] = Field(default_factory=list, description="Cases to run; empty uses the seed set.")
    judge_model: str = Field(default="mistral-small-latest", description="Model for the LLM-judge scorer.")
    system_name: str = Field(default="default", description="System label recorded on the run.")
    local: bool = Field(default=True, description="When true, skip AI Studio upload (fast offline iteration).")
