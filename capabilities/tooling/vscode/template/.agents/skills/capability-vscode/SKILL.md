---
name: capability-vscode
description: The generated repo's VS Code workspace config — `.vscode/settings.json` and `.vscode/extensions.json`, whose extension recommendations and format-on-save wiring are rendered to match the capabilities installed alongside it. Use when VS Code picks the wrong Python interpreter, when Ruff/ty/Oxc format-on-save or a recommended extension is missing, when a newly added capability's editor support needs to appear here, or when deciding whether an editor setting belongs here or in `code-quality`.
---

# VS Code

Optional editor config: the two `.vscode/` files telling VS Code which extensions to recommend and how to format on save. Owns the editor's view only — no code, tasks, or tool config. Ruff/ty/Oxc rules live in `code-quality`, the workspace `.venv` is uv's, the web app is `tanstack-start`'s.

## Where things live

| Path | What |
| --- | --- |
| `.vscode/extensions.json` | Workspace extension recommendations VS Code prompts to install on open. |
| `.vscode/settings.json` | Python interpreter path + per-language formatter and format-on-save wiring. |

Both files are generated **once** at scaffold time from the selected capabilities (app sees plain JSON, not a template); each block is present only if its capability is:

| Capability present | `extensions.json` adds | `settings.json` adds |
| --- | --- | --- |
| always (via `core`) | `ms-python.python` | `python.defaultInterpreterPath` → `${workspaceFolder}/.venv/bin/python` |
| `code-quality` | `charliermarsh.ruff`, `astral-sh.ty` | `ty.importStrategy`/`ty.interpreter`, `[python]` Ruff format-on-save block |
| `code-quality` **and** `tanstack-start` | `oxc.oxc-vscode` | `[typescript]` + `[typescriptreact]` Oxc format-on-save blocks |
| `docker-compose` | `ms-azuretools.vscode-docker` | — |
| `helm` | `tim-koehler.helm-intellisense` | — |

## Add editor support for a capability

Rendering happens once, so adding a capability later does **not** retro-add its row — mirror its entry into both files by hand: add the extension id to `extensions.json`, and any `editor.*` / `[lang]` formatter block to `settings.json`. Only editor-only settings belong here; a tool's real config does not (Ruff/ty in `pyproject.toml` under `code-quality`, Oxc with `tanstack-start`, tasks/runtime with `core`).

## Gotchas

- `python.defaultInterpreterPath` pins the editor to uv's root `.venv`; if imports/IntelliSense resolve wrong, check this — editor and CLI must share one env.
- Oxc is the nested case: appears only where `code-quality` **and** `tanstack-start` overlap.
