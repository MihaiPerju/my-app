"""Typed application settings.

Import a settings instance from its concern module, for example ``from env.mistral import env``.
Each module defines ``class Env(BaseEnv)`` and ``env = Env()``. The shared
:class:`env._base.BaseEnv` loads the repository-root ``.env`` without overriding process values.
"""

from env._base import BaseEnv

__all__ = ["BaseEnv"]
