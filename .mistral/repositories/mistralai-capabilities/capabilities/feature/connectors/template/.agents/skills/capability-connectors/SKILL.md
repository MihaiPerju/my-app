---
name: capability-connectors
description: The app's 15 external-service connectors (GitHub, Slack, Notion, Gmail, SharePoint, …), each an `agents.connector("<key>")` slot vendored as one file per connector, `apps/worker/src/worker/agents/connectors/<key>.py` (each exposing `connector`), that `assemble_harness` merges into the single orchestrator Harness. The Unified Harness has no subagents, so these are slots, not specialist subagents. Use when adding, removing, or renaming a connector, or when a connector will not route or its credentials never resolve.
---

# Connectors

Fifteen external-service connectors, one per service, each an `agents.connector("<key>")` slot the single orchestrator Harness owns directly. The Unified Harness backend has no subagents, so there is no per-connector specialist agent to delegate to: every slot is merged into one `agents.Harness` by `mistralai_capabilities.agents.assembly.assemble_harness`, which walks the one-file-per-connector modules this capability vendors and reads each module-level `connector`. Owns the connector slots only: not the orchestrator or agent project (`capability-agents`), not the workflows `connector()` durable-activity slot (`capability-workflows`), not credentials (the Mistral Connectors platform holds those).

## Where things live

| Path | What |
| --- | --- |
| `apps/worker/src/worker/agents/connectors/<key>.py` | One file per connector, 15 in all, each exposing a module-level `connector = agents.connector("<key>")`. `assemble_harness` walks the package by file presence and merges each `connector` into the orchestrator Harness's `connectors=`. |
| `apps/worker/tests/test_connectors.py` | Roster check: the assembled connector set is exactly the 15 expected keys (via `slot.connector_name`), no duplicates, and no `subagents/(studio)/(connectors)` tree remains. |
| `apps/worker/tests/agents/test_app.py` | `EXPECTED_CONNECTORS` (shipped by `capability-agents`) — the census: asserts every key reaches the assembled Harness via `{slot.connector_name for slot in app.harness.connectors}`. |

Keys: `atlassian` (Confluence+Jira), `box`, `github`, `gmail`, `google_calendar`, `google_drive`, `linear`, `notion`, `outlook`, `outlook_calendar`, `sharepoint`, `sharepoint_graph`, `sharepoint_online`, `slack`, `stripe`. Near-duplicate SharePoint/Outlook keys are distinct workspace-configured connectors, not typos.

## Add a connector

1. Create `connectors/<key>.py` exposing `connector = agents.connector("<key>")`, with an inline comment naming the service.
2. Add the same key to `EXPECTED_CONNECTOR_KEYS` in `apps/worker/tests/test_connectors.py`.
3. Add the same key to `EXPECTED_CONNECTORS` in `apps/worker/tests/agents/test_app.py` (shipped by `capability-agents`) — the assembled-Harness census.

`agents.connector("<key>")` takes no description or instructions: the model reaches every connector's tools directly on the one Harness, so there is no routing text to keep in sync. The `<key>` is the whole contract.

## Gotchas

- The key must match a connector already configured for the workspace; an unconfigured/misspelled key fails at first tool call, not load — passes the tests, breaks in conversation.
- There is no per-connector routing/description text anymore — the model sees the connectors' tools directly. If it calls the wrong service, that is an orchestrator-instructions concern (`capability-agents`), not a per-connector description one.
- `{GITHUB,SLACK,NOTION}_CONNECTOR_TOKEN` Helm env vars are placeholder plumbing; the `agents.connector` path never reads them.
