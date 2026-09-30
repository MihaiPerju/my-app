"""The `search_navigate` retrieval activity-tool, contributed to the orchestrator Harness.

The tool is the ``@agents.tool``-decorated activity in ``mistralai_capabilities.search.activities``;
this module re-exports it as the module-level ``tool`` that ``mistralai_capabilities.agents.assembly`` merges into the
single ``agents.Harness`` (one file per tool).
"""

from mistralai_capabilities.search.activities import search_navigate

tool = search_navigate
