"""Typed settings for the nightly feedback harvest and the prompt optimization it feeds.

Two recurring jobs: the harvest turns yesterday's thumbs up/down into a curated dataset, and the
optimizer searches for a prompt that would have earned better ones. The harvest is a Studio read,
so it needs both its own flag and the ``env.observability`` read flag. The optimizer fires weekly
because a GEPA run is expensive.
"""

from pydantic import Field

from env._base import BaseEnv


class Env(BaseEnv):
    feedback_harvest_enabled: bool = False
    feedback_harvest_schedule_id: str = "mistralai-capabilities-feedback-harvest"

    # 04:00 UTC, an hour after the seeded agent evaluation at 03:00, so the two scheduled runs
    # do not contend for the same judge-model quota.
    feedback_harvest_cron: str = "0 4 * * *"

    # The window each run reads. 24h matches the cadence; anything larger re-reads ratings that
    # a previous run already judged and re-files them into a second dataset.
    feedback_harvest_window_hours: int = Field(default=24, ge=1, le=168)

    # The evaluation_name written by apps/api/.../chat/feedback.py. A frozen wire identifier in
    # both directions: the emitter names the row and the harvest filters on that exact string,
    # so changing one without the other silently harvests nothing.
    feedback_evaluation_name: str = "user_feedback"

    # The judge that decides whether a rating is *relevant* — i.e. whether the answer really
    # was as good or as bad as the user said. Small by default: this is a triage pass over a
    # day of ratings, not the scoring that follows.
    feedback_judge_model: str = "mistral-small-latest"

    # Ratings the judge scores at or above this are kept. Below it they are dropped as
    # unreliable — a thumbs-down on a correct answer teaches the optimizer the wrong lesson,
    # which is the entire reason this loop has a judge in it rather than importing raw votes.
    feedback_relevance_threshold: float = Field(default=0.5, ge=0.0, le=1.0)

    # A floor on dataset size. Below this the harvest still writes the dataset (it is the
    # record of what the day produced) but skips the evaluation, because a run over three
    # records reports noise with a confident-looking number.
    feedback_min_records_to_evaluate: int = Field(default=10, ge=1)

    feedback_dataset_name_prefix: str = "chat-feedback"
    feedback_project_name: str = "Chat feedback"

    feedback_optimize_enabled: bool = False
    feedback_optimize_schedule_id: str = "mistralai-capabilities-prompt-optimization"

    # Sundays at 05:00 UTC — after a full week of harvests have accumulated.
    feedback_optimize_cron: str = "0 5 * * 0"

    # GEPA's search budget. Every iteration is a full evaluation run of the real agent, so this
    # multiplies cost directly; the defaults mirror the SDK guide's worked example.
    feedback_optimize_iterations: int = Field(default=8, ge=1)
    feedback_optimize_pareto_size: int = Field(default=3, ge=1)
    feedback_optimize_minibatch_size: int = Field(default=5, ge=1)
    feedback_optimize_holdout: float = Field(default=0.2, ge=0.0, lt=1.0)
    feedback_optimize_patience: int = Field(default=3, ge=1)
    feedback_optimize_random_seed: int = 42

    # Cheap diagnosis, bold rewrites — the split the optimization guide recommends.
    feedback_optimize_reflection_model: str = "mistral-small-latest"
    feedback_optimize_mutation_model: str = "mistral-large-latest"


env = Env()
