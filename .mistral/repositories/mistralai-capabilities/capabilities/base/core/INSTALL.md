# Install — `@mistralai-capabilities/base-core`

Core is the required application workspace shell. It provides static Bun and uv workspace roots,
NX project discovery, package-manager configuration, bootstrap scripts, shared app-local Python
packages, and the `capability-core` agent skill. Environment defaults come from the capability
manifest. Lockfiles are generated after installation rather than shipped.

## What Core contributes

- Root `package.json`, `pyproject.toml`, and `nx.json` files with composition-safe workspace globs.
- Registry configuration and `tools/uv.sh`, plus `tools/install.sh` for a repeatable workspace
  bootstrap.
- Shared `env`, `utils`, and `cli` Python packages for typed settings, logging, telemetry, Mistral
  client construction, and command discovery.
- Repository ignore files and cross-cutting shell helpers.

Core contains no application host or deployment target. Additional selected modules contribute
projects and commands through their own paths; NX discovers those projects from the generated tree.

## Environment

The generated environment includes the application name, logging format and level, Mistral API
endpoint and credential slot, and telemetry settings. When the FastAPI host is selected, telemetry
is enabled by default and sends application telemetry logs to
`https://api.mistral.ai/telemetry/v1/logs` when an application credential is present. Set
`TELEMETRY_ENABLED=false` in the environment or `.env` to opt out. `MISTRAL_API_KEY` is
intentionally empty until an application credential is supplied.

## Install

```bash
mistral apps capability add core
bun run lock
bun run install-all
```

`bun run lock` creates the Python lockfile. `bun run install-all` installs all present Python
workspace members and the Bun workspace. Use `bunx nx show projects` to inspect commands contributed
by the current composition.
