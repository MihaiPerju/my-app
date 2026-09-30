---
name: capability-core
description: Maintain the required Bun/uv workspace shell, NX project discovery, bootstrap tools, and shared app-local Python packages. Use when editing workspace roots, registry-safe package-manager configuration, typed settings, logging, telemetry, the Mistral client seam, or CLI command discovery.
---

# Core

Core is the required workspace shell. It owns only application-wide substrate: Bun and uv workspace
roots, NX project discovery, bootstrap tools, and the shared `env`, `utils`, and `cli` Python
packages. Application modules add their own files and projects without changing this shell.

## Where things live

| Path | What |
| --- | --- |
| `package.json` | Root Bun workspace, shared catalog entries, singleton overrides, and workspace-wide commands. Member paths stay as globs so the manifest works for every composition. |
| `pyproject.toml` | Root uv workspace, deterministic index selection, cross-platform lock requirements, and dependency overrides. |
| `nx.json` | Shared target defaults. Projects are discovered from `project.json` files present in the generated app. |
| `tools/uv.sh` | Runs uv with deterministic public-index defaults and clears ambient settings that would change resolution. Audience-specific authentication is projected only when required. |
| `tools/install.sh` | Verifies the pinned Bun version, installs all present Python workspace members, installs the Bun workspace, enables optional hooks when their configuration exists, then runs `tools/gen-types.sh` when `fastapi-tanstack-start` ships it (the scaffold's web client is generated for the full registry; commit the regenerated one). |
| `tools/lib.sh` | Small sourced-shell helpers for skip reporting and required-tool checks. |
| `tools/docker/sync-python-workspace.sh` | Reproducible dependency, runtime, and development sync phases for container builds. |
| `packages/py/env/` | Typed application settings with a shared `.env`-loading base. |
| `packages/py/utils/` | Shared logging, telemetry, and Mistral client utilities. |
| `packages/py/cli/` | Typer application that discovers command modules contributed to `cli.commands`. |
| `.npmrc.hbs` / `.npmrc.example` | Audience-specific scoped npm registry configuration generated from the registry definition. |

## Extend

- Add a setting to the smallest shared concern module only when every composition needs it. Keep
  `BaseEnv` independent and let process environment values override the root `.env`.
- Add an application command as one module under `cli.commands`, exposing a `typer.Typer` named
  `app`. The shared entry point discovers and mounts modules; it does not enumerate them.
- Keep workspace members as globs. A literal optional member makes package-manager startup fail when
  that member is absent.
- Put host, feature, persistence, orchestration, and development-tool files in the module that owns
  them rather than in Core.

## Public-safety contract

The canonical source should remain audience-neutral. Configuration that must differ by package
source is projected in the release staging directory from parsed structure or typed registry data;
do not add prose redaction or a duplicate template. Public artifacts must not name non-public
capabilities, private package identities, credential architecture, or internal namespaces.
