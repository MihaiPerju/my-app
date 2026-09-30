# Install — `@mistralai-capabilities/feature-connectors`

Adds 15 external-service connectors (Atlassian, Box, GitHub, Gmail, Google Calendar/Drive, Linear,
Notion, Outlook +Calendar, SharePoint +Graph/Online, Slack, Stripe) to the agent orchestrator, one
file per connector under `apps/worker/src/worker/agents/connectors/`.

## Prerequisites

- Sibling capabilities: `core`, `agents`.
- The Mistral Connectors platform, with each connector key configured for your workspace. An
  unconfigured or misspelled key fails only when the model first calls that connector's tools, not
  at load or in tests; remove the files for connectors you do not use.
- Removing a connector file also means dropping its key from `EXPECTED_CONNECTOR_KEYS` in
  `apps/worker/tests/test_connectors.py` and from the connectors entry of `CAPABILITY_CONNECTORS` in
  `apps/worker/tests/agents/test_app.py`.

## Install

```bash
mistral apps capability add connectors
bun run install-all   # sync the new dependencies
```

Verify:

```bash
bunx nx run agents:typecheck
bunx nx run agents:test
bunx nx run testing:test   # includes apps/worker/tests/test_connectors.py
```
