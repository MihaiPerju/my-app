# Install — `apps`

Adds deployment to the Mistral Apps platform, which builds and runs the app. When the platform
gateway is in front of the app, Mistral API calls made on behalf of a caller use that caller's
short-lived token instead of the app's own key.

## Prerequisites

- Sibling capabilities: `core`. With `fastapi`, the token is wired into the API automatically.
- `MISTRAL_API_KEY`, used for work that belongs to no caller and whenever no gateway is present.

## Install

```bash
mistral apps capability add apps
bun run install-all   # sync the new dependencies
```

Verify locally with `mistral apps dev`, which runs the gateway in front of the app
(`--no-gateway` runs it bare, falling back to `MISTRAL_API_KEY`).
