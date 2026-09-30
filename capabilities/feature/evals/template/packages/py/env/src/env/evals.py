"""Typed settings for the scheduled agent-evaluation run.

The evaluation workflows themselves take their dataset and thresholds from the
``evals`` package; these settings only control whether the recurring run exists,
when it fires, and how its results are labelled.
"""

from env._base import BaseEnv


class Env(BaseEnv):
    eval_schedule_enabled: bool = False
    eval_schedule_id: str = "mistralai-capabilities-agent-eval"
    eval_cron: str = "0 3 * * *"
    eval_local: bool = False
    eval_system_name: str = "scheduled"


env = Env()
