# Install — `vscode`

Adds `.vscode/settings.json` and `.vscode/extensions.json`: Python support always, plus quality
(Ruff, ty, Oxc), Docker, and Helm settings and recommendations only when the matching capability is
installed.

## Prerequisites

- Sibling capabilities: `core`.

## Install

```bash
mistral apps capability add vscode
```

Verify by opening the repository in VS Code and accepting the recommended extensions.
