"""Typed settings for the experiment framework.

Master gate for the experiment surfaces (evaluate/promote/results). Feature-specific dataset
defaults are intentionally omitted from this slice: dataset selection is a per-feature concern that
arrives with the feature tracks, not the generic core.
"""

from env._base import BaseEnv


class Env(BaseEnv):
    experiments_enabled: bool = False


env = Env()
