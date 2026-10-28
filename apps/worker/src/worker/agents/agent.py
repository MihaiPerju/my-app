"""Root orchestrator: the single Unified Harness `agents.Agent` the worker promotes.

The Unified Harness backend has no subagents, so this is one agent. Its `Harness` is assembled in code
from whatever capabilities are installed -- search tools, the 15 connector slots, the guardrail hook
-- discovered from the contribution packages (see `mistralai_capabilities.agents.assembly`). `instructions.md` is the
prompt seed; `workflows/agents.py` may override it from the AI Studio prompt registry at promotion
time.
"""

from pathlib import Path

from env.agents import env as agents_env
from mistralai.agents import agents
from mistralai_capabilities.agents.assembly import assemble_harness

from worker.agents import connectors, hooks, mcps, tools

_INSTRUCTIONS = (Path(__file__).resolve().parent / "instructions.md").read_text(encoding="utf-8")

agent = agents.Agent(
    model=agents_env.orchestrator_model,
    name="app-orchestrator",
    description=(
        "Orchestrates the Mistral Studio feature tools plus external-service connectors and synthesizes their results."
    ),
    instructions=_INSTRUCTIONS,
    harness=assemble_harness(tools=tools, connectors=connectors, hooks=hooks, mcps=mcps),
)
