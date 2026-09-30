from typing import Literal

from pydantic import SecretStr

from env._base import BaseEnv


class Env(BaseEnv):
    workflows_base_url: str = "https://api.mistral.ai"
    deployment_name: str | None = None

    workflows_encryption_mode: Literal["off", "partial", "full"] = "off"
    workflows_encryption_key: SecretStr | None = None
    workflows_encryption_previous_key: SecretStr | None = None

    activity_read_retry_max_attempts: int = 3
    activity_mutation_retry_max_attempts: int = 1
    activity_retry_backoff_coefficient: float = 2.0


env = Env()
