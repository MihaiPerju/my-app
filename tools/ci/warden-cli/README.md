# `@mistral/ci-warden-cli`

Small CLI used in CI to request tokens from Warden using Buildkite OIDC.

## Why

Instead of storing long-lived tokens in Buildkite secrets, this CLI:

1. Mints an OIDC token from Buildkite.
2. Sends the requested token payload to Warden.
3. Returns the token value.

## Usage

```bash
warden-cli github \
  --url https://warden.globalaegis.net \
  --repository dashboard \
  --perm contents:read
```

Multiple permissions can be passed by repeating `--perm`, or with comma-separated values:

```bash
warden-cli github \
  --repository dashboard \
  --perm contents:read \
  --perm pull_requests:write
```

```bash
warden-cli github \
  --repository dashboard \
  --perm contents:read,pull_requests:write
```

Bitwarden tokens are requested through the same Warden `/token` endpoint using a
Bitwarden payload:

```bash
warden-cli bitwarden \
  --url https://warden.globalaegis.net \
  --secret-id bitwarden-secret-id
```

### Named GitHub Apps

When Warden is configured with multiple GitHub Apps, pass `--app` to select
which registered app should mint the token:

```bash
warden-cli github \
  --url https://warden.globalaegis.net \
  --app release-bot \
  --repository dashboard \
  --perm contents:read
```

Omitting `--app` targets the server's default app.

## Environment Variables

- `WARDEN_URL` (or `WARDEN`): default Warden URL if `--url` is omitted.
- `WARDEN_AUDIENCE`: default OIDC audience if `--audience` is omitted.

You can also skip `--url` and pass `--endpoint` directly.

## Buildkite Example

```bash
export WARDEN_URL=https://warden.globalaegis.net

GH_TOKEN="$(
  warden-cli github \
    --repository dashboard \
    --perm contents:read
)"

git -c credential.helper= \
  -c http.https://github.com/.extraheader="AUTHORIZATION: bearer ${GH_TOKEN}" \
  ls-remote https://github.com/mistralai/dashboard.git
```

```bash
export WARDEN_URL=https://warden.globalaegis.net

BITWARDEN_TOKEN="$(
  warden-cli bitwarden \
    --secret-id bitwarden-secret-id
)"
```

## Output Modes

- `--format raw` (default): prints only the token.
- `--format env`: prints `<ENV_VAR>=<token>` (default var name is `GITHUB_TOKEN` for GitHub and `BITWARDEN_TOKEN` for Bitwarden).
- `--format json`: prints request metadata and response details.
- `--oidc-timeout-ms`: timeout for `buildkite-agent oidc request-token`.
- `--timeout-ms`: timeout for each Warden HTTP request attempt.
- `--retries`: retry attempts for transient Warden network/fetch failures (default: `2`).
- `--retry-delay-ms`: base retry delay in milliseconds (default: `1000`).
