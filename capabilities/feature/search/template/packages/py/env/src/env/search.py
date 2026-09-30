from typing import Literal

from env._base import BaseEnv


class Env(BaseEnv):
    search_backend: Literal["local", "postgres", "vespa"] = "postgres"
    search_max_atoms_per_source: int = 2000
    search_agent_max_iterations: int = 10
    search_agent_tool_budget: int = 20
    search_agent_context_budget: int = 40
    search_agent_per_source_budget: int = 8
    search_agent_compact_threshold: int = 120000
    # Vespa connection — only read when SEARCH_BACKEND=vespa.
    vespa_endpoint: str = ""
    vespa_query_port: int = 18080
    vespa_config_port: int = 19072
    vespa_app_name: str = "mistralai-capabilities-search"


env = Env()
