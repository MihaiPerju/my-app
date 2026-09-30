"""Settings for the orchestrator agent: its model, and sourcing its system prompt from the AI Studio registry.

``agent/instructions.md`` stays the seed, fallback, and the human-edited source. This adds the
option to let a registry version win at promotion time, so an optimizer can ship a prompt with no
image rebuild. Off by default. Enabling it adds a network call to worker startup, so it uses a
short timeout and always falls back to the file when the registry is unreachable.
"""

from pydantic import Field

from env._base import BaseEnv
from env.app import env as app_env


class Env(BaseEnv):
    # The model the orchestrator runs on. A setting so a workspace that is rate-limited on the
    # default can switch without editing the vendored `agent.py`.
    orchestrator_model: str = "mistral-medium-3-5"

    # The off switch, and the default. On means: resolve the alias below at promotion time and
    # use it when it answers; fall back to instructions.md when it does not.
    prompt_registry_enabled: bool = False

    # The registry object's stable name. Shared by the prompts command (which writes it) and the
    # agent promotion (which reads it), so they must agree — hence one setting, not two. Derived
    # from APP_NAME so two apps never share a registry object when the variable is unset.
    prompt_registry_name: str = f"{app_env.app_name}-orchestrator"

    # Which version the worker runs. `production` is moved by a human promoting a candidate;
    # point a staging deployment at `candidate` to run what GEPA last proposed.
    prompt_registry_alias: str = "production"

    # Deliberately tight. This is on the worker's startup path, and the fallback is a file that
    # is already correct — so waiting is worth less here than booting.
    prompt_registry_timeout_seconds: float = Field(default=5.0, gt=0)


env = Env()
