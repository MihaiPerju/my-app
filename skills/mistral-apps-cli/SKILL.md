---
name: mistral-apps-cli
description: The `mistral apps` CLI — install and log in, `init`, `capability add`/`remove`, `registry update`, `dev`. Use when running a `mistral apps` command or when one fails.
---

# The `mistral apps` CLI

`mistral apps` assembles an app from **capabilities** pulled from a **registry**. `--help` at any depth
is the source of truth for flags; this skill carries the model and the failure modes.

**Commit before every command.** Several rewrite files in place and leave the app half-written on
failure; on a clean tree, `git checkout -- .` is a complete undo.

## Install and log in

```bash
curl -fsSL https://raw.githubusercontent.com/mistralai/cli/main/install.sh | bash
export PATH="$HOME/.mistral/bin:$PATH"   # persist it in the shell rc
mistral login                            # browser sign-in: hand it to the user; --device when headless
```

Only `init` is ungated. `capability`, `registry` and `dev` are feature-flagged per identity and
answer `Unknown subcommand` (or are missing from `--help`) until you are logged in or
`MISTRAL_API_KEY` is exported. A refreshed flag snapshot applies from the next run, so run the
command twice.

Packages install from Cloudsmith, whose credentials live in `~/.env.cloudsmith`; `init` reads the
token from `~/.npmrc` and the app from `MISTRAL_REGISTRY_TOKEN`. `setup-mistral-apps` wires both.
Without them, `init` fails on a bare 401 that names no host.

Done when `mistral whoami` prints an identity and `mistral apps capability --help` prints usage.

## The model

A capability contributes `package/` (a library; with a git registry the app resolves it live from
the vendored copy), `template/` (files copied into the app at install time, then yours), or both.
`core` is the one required capability; `default` ones are preselected and removable.

| Path in the app | Holds |
| --- | --- |
| `.mistral/registries.json` | the pin: registry URL, `ref`, `sha` |
| `.mistral/capabilities.json` | the installed set — the real record |
| `.mistral/repositories/<registry>/` | the vendored registry: each capability's `capability.json`, `INSTALL.md`, `CHANGELOG.md`, `template/`, `package/` |
| `apps.json` | the serve-able modules (`api`, `worker`, `web`) |

Change `.mistral/` only through the CLI; everything else is the app's.

The registry is `https://github.com/mistralai/mistralai-capabilities` (private).
`unsupported registry descriptor: expected descriptorVersion 3` means you pointed at the archived
`mistralai-solutions/solutions-capabilities`.

## Create an app

```bash
git ls-remote --tags --sort=-v:refname <registry-url> | head -3
mistral apps init <app> --registry-url '<registry-url>.git#<tag>' --source git --yes
```

- **Always pass `#<tag>`.** Without it, `init` takes the ref from a saved default or
  `MISTRAL_APPS_REGISTRY_REF`, which may be dead (`The ref "…" no longer exists`).
- `--yes` takes the defaults; `--caps a,b` replaces them with the dependency closure of exactly what
  you name.
- A failed `init` deletes its directory, so retrying is safe. It exits 0 despite `uv lock failed` or
  `bun install failed`: read its warnings, and recover with `bun run install-all` (causes in
  `create-usecase` *Pitfalls*).
- The `.agents/skills/getting-started/SKILL.md` it prints does not exist (a CLI bug). Orient from
  `.agents/skills/capability-<id>/SKILL.md`, one per installed capability.

Done when `mistral apps capability list` shows each capability installed and the scaffold is
committed.

## Add or remove a capability

```bash
mistral apps capability list          # --json for an `installed` boolean, --tags a,b to filter
mistral apps capability add <id>
mistral apps capability remove <id>   # prompts about dependents
```

Before `add`, satisfy the prerequisites in the capability's `INSTALL.md`: it installs cleanly, then
fails at runtime on a missing service or env var. A failed `add` leaves the app half-written —
`git checkout -- .`, fix the cause, retry.

Done when the capability shows installed, its prerequisites hold, and `git status` shows only
expected files.

## Update the registry pin

```bash
mistral apps registry update --ref <tag>   # git registries; `capability update` is npm-only
```

It is a `git subtree pull` (clean tree required) that moves the pin and the vendored registry, **not**
the templates already in the app. Close that gap by hand: list what moved with
`git -C .mistral/repositories/<registry> log --oneline <old-tag>..<new-tag>`, then apply the
`### Breaking` section of each changed capability's `CHANGELOG.md`. Commit this alone: the next
`capability add` re-vendors at the new tag and can overwrite customized files.

Done when `.mistral/registries.json` reads the new tag and every new `### Breaking` item is applied.

## Run and troubleshoot

`mistral apps dev` is **not** the local stack: it runs the `apps.json` modules on the host on their
declared ports (`3000`/`3001`, moving to a free one when taken) without reading `API_PORT` /
`WEB_PORT`, starts no Postgres, Keycloak or gateway, and runs `uv` bare. Behind `auth` nothing
injects `x-user-id`, so `/api/v1` refuses every call. Use `bunx nx run compose:dev` (see
`create-usecase` *Run*). `apps.json declares no modules` means nothing installed is serve-able, not a
fault.

- **`init` hangs after `Loaded … registry`**: with `commit.gpgsign=true` its `git commit` waits on
  a signer that needs interaction (a passphrase or approval prompt), and interrupting deletes the
  app. Run
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false mistral apps init …`.
- **`init` targets the wrong registry**: `MISTRAL_APPS_REGISTRY_URL` / `_REF` in the environment are
  defaults. Pass `#<tag>`, or run under `env -u MISTRAL_APPS_REGISTRY_URL -u MISTRAL_APPS_REGISTRY_REF`.

Authoring a capability (`capability init`, `registry build`, `registry check`) is
[`write-mistral-apps-capability`](../write-mistral-apps-capability/SKILL.md).
