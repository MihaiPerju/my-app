---
name: setup-mistral-apps
description: Set up a machine for Mistral Apps — dev tools (bun, uv, Python, Docker, node, gh, playwright-cli), the `mistral` CLI and login, the Cloudsmith registry token, the `docstral` MCP, the review and engineering skills, and the Slack and Notion MCPs. Use when onboarding onto Mistral Apps or when one of those is missing.
---

# Setting up for Mistral Apps

Run the steps in order, skipping any whose done-check already passes. Hand the user anything that
needs them — a browser sign-in, an interactive picker, a secret — and run the check once they
confirm.

The shell rc is `~/.zshrc`, or `~/.bashrc` when `$SHELL` is bash. Steps write to it, so check through
`$SHELL -ic '…'`: your own environment predates them.

## 1. Dev tools

```bash
$SHELL -ic 'bash <this skill'"'"'s dir>/scripts/check-tools.sh'
```

It prints one line per tool; install each one that is not `ok`, then run it again.

| Tool | Install |
| --- | --- |
| `bun` = 1.4.0 | `curl -fsSL https://bun.sh/install \| bash -s bun-v1.4.0` (needs `unzip` on Linux); the same command fixes a `mismatch`. Generated apps pin this exact version, so never `bun upgrade`. A Homebrew bun tracks the latest release: `brew uninstall bun` first |
| `uv` ≥ 0.11.17 | `curl -LsSf https://astral.sh/uv/install.sh \| sh`. Outdated: `uv self update`, or `brew upgrade uv` for a Homebrew install |
| `python` 3.14 | `uv python install 3.14` |
| `node` ≥ 22.20.0 | `brew install node`, or the user's version manager (`nvm`, `fnm`, `mise`) when they have one |
| `playwright-cli` ≥ 0.1.21 | `npm install -g @playwright/cli@latest`, which also fixes `outdated`. It drives the user's Chrome; without one, `playwright-cli install-browser` |
| `gh` | `brew install gh`, or GitHub's apt/rpm repository (cli.github.com) on Linux; then the user runs `gh auth login` |
| `git` | `xcode-select --install` on macOS, the distro package on Linux |
| `docker`, `buildx` | The user installs Docker Desktop or OrbStack (macOS), or Docker Engine with the buildx plugin (Linux), and starts it |

The `bun` and `uv` installers add themselves to the shell rc. For Docker, `down` means the daemon is
not running (ask the user to start it) and `denied` that the user is outside the `docker` group
(`sudo usermod -aG docker "$USER"`, then a new login). Kubernetes tools (`helm`, `kubectl`, `k3d`, `kubeconform`)
are only needed once an app selects the `helm` or `k3d` capability.

Done when the script exits 0.

## 2. The `mistral` CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mistralai/cli/main/install.sh | bash
```

Append `export PATH="$HOME/.mistral/bin:$PATH"` to the shell rc unless it is there — the installer
only prints it. Then have the user run `mistral login`, which unlocks the feature-flagged
`mistral apps` subcommands.

Done when `$SHELL -ic 'mistral whoami'` prints the user's identity.

## 3. Cloudsmith credentials

Mistral Apps packages install from Cloudsmith's `sdk-distribution` index. The credentials live in
**`~/.env.cloudsmith`**, as `CLOUDSMITH_USERNAME` and `CLOUDSMITH_PASSWORD` (the entitlement token);
the team copy is the [Cloudsmith item in Bitwarden](https://vault.bitwarden.com/#/vault?organizationId=a5337b02-3b1e-4b88-837b-b0d100ce39d4&collectionId=4e395d98-4cd5-4779-98f3-b0d600e8efd7&action=view&itemId=ca23993b-52ec-4e7c-91fc-b4d000a36710). Without them, installs fail with a bare
401 that names no host.

```bash
bash <this skill's dir>/scripts/cloudsmith-creds.sh
```

When `~/.env.cloudsmith` is missing, the script opens a terminal window where the user pastes both
values, which keeps them out of your context; the user may instead save the Bitwarden item's content
as that file. Either way, the script then wires the file where installs read it: the
`sdk-distribution` token in `~/.npmrc` for `mistral apps init`, and a shell-rc block that loads the
file and exports `MISTRAL_REGISTRY_TOKEN`, from which a generated app's `tools/uv.sh` derives its npm
and uv credentials.

Done when `$SHELL -ic '[ -n "$MISTRAL_REGISTRY_TOKEN" ]' && echo set` prints `set` and
`grep -c 'npm.cloudsmith.io/mistral-ai/sdk-distribution/:_authToken=.' ~/.npmrc` is non-zero.

## 4. The `docstral` MCP

Serves the Mistral SDK docs to agents.

```bash
curl -fsSL https://docstral-mcp.solutions.mistralsol.com/install.sh | bash
```

Done when the installer reports success.

## 5. Skills

```bash
npx skills add -g https://github.com/cursor/plugins --skill thermo-nuclear-code-quality-review
npx skills add -g https://github.com/mattpocock/skills
npx skills add -g https://github.com/microsoft/playwright-cli --skill playwright-cli
```

The second may open a picker: keep `grilling` and `to-spec` selected, since `scope-usecase` runs
them.

Then, in the repo the user works in (skip when there is none), run `/setup-matt-pocock-skills`,
answering **local markdown** for the issue tracker unless the user asked otherwise, and the
recommended default elsewhere.

Done when `npx skills ls -g` lists `thermo-nuclear-code-quality-review`, `grilling`, `to-spec` and
`playwright-cli`, and in a repo, `/setup-matt-pocock-skills` has written its `## Agent skills` block
and `docs/agents/` files.

## 6. Slack and Notion MCPs

Ask whether to connect Slack and Notion, saying both are heavily recommended: `scope-usecase`
searches them for each use case's context. On a no, skip to *Restart*.

1. Open `https://console.mistral.ai/connectors?view=all` (`open`, or `xdg-open` on Linux) and wait for
   the user to confirm both connectors are set up.
2. If `$SHELL -ic '[ -n "$MISTRAL_API_KEY" ]' && echo set` prints nothing, open
   `https://console.mistral.ai/api-keys`, ask the user to create a key, and run
   `bash <this skill's dir>/scripts/save-secret.sh MISTRAL_API_KEY`. Re-run the check once they
   confirm.
3. Add both servers to the config of the agent CLI you are running in, the key read from the
   environment. For opencode (`opencode.json`, under `mcp`), with `notion_mistral` identical but for
   `/notion/` in the URL:

   ```json
   "slack_mistral": {
     "type": "remote",
     "url": "https://api.mistral.ai/v1/connectors-gateway/slack/mcp",
     "enabled": true,
     "oauth": false,
     "headers": { "Authorization": "Bearer {env:MISTRAL_API_KEY}" },
     "timeout": 120000
   }
   ```

   For Claude Code:

   ```bash
   for c in slack notion; do
     claude mcp add-json --scope user "${c}_mistral" \
       "{\"type\":\"http\",\"url\":\"https://api.mistral.ai/v1/connectors-gateway/${c}/mcp\",\"headers\":{\"Authorization\":\"Bearer \${MISTRAL_API_KEY}\"}}"
   done
   ```

   Any other CLI: a remote HTTP server per connector, that URL, the `Authorization: Bearer` header
   from `MISTRAL_API_KEY` as an env reference, a 120 s timeout.

Done when both servers are in the CLI's config.

## 7. Restart

Tell the user to quit the agent and relaunch it from a new terminal, so `PATH`, the tokens and the
MCPs load. Done when its MCP list shows `docstral`, plus `slack_mistral` and `notion_mistral` after a
yes to Slack and Notion.
