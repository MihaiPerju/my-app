# Install — `@mistralai-capabilities/github-automation`

Adds the GitHub CI workflow, the Solutions security gate workflow, and a Renovate configuration.
CI jobs for TypeScript, agents, the Postgres contract, and the Docker Compose end-to-end run appear
only when the matching capability is installed.

## Prerequisites

- Sibling capabilities: `code-quality` and `testing`.
- Repository secrets:
  - `MISTRAL_REGISTRY_TOKEN` — pull token for the private package indexes; every CI job that syncs
    dependencies fails without it.
  - `MISTRAL_API_KEY` — only with `docker-compose`, for the end-to-end job.
- The repository must be allowed to use the security-gate action it references.
- Renovate enabled on the repository, to pick up `renovate.json`.

## Install

```bash
mistral apps capability add github-automation
```

Verify by opening a pull request and checking that the CI and security gate workflows run on it.
