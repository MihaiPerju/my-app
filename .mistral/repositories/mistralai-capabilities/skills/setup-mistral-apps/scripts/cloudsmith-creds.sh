#!/usr/bin/env bash
# Usage: cloudsmith-creds.sh
# Make ~/.env.cloudsmith (CLOUDSMITH_USERNAME / CLOUDSMITH_PASSWORD) the one home of the Cloudsmith
# credentials, and wire it where installs read it:
#   - ~/.npmrc: the sdk-distribution _authToken, which `mistral apps init` needs;
#   - the shell rc: loads the file and exports MISTRAL_REGISTRY_TOKEN for generated apps.
# When the file is missing, it prompts in a new terminal window. It never prints a credential.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/terminal.sh
. "$here/lib/terminal.sh"

env_file="${HOME}/.env.cloudsmith"
npm_registry="//npm.cloudsmith.io/mistral-ai/sdk-distribution/"
begin="# >>> mistral-apps cloudsmith >>>"
end="# <<< mistral-apps cloudsmith <<<"

has_creds() {
  [[ -f "$env_file" ]] &&
    grep -qE '^CLOUDSMITH_USERNAME=.' "$env_file" &&
    grep -qE '^CLOUDSMITH_PASSWORD=.' "$env_file"
}

if ! has_creds; then
  if [[ "${1:-}" != --inline ]]; then
    open_in_terminal "$here/$(basename "$0")"
    echo "Opened a terminal window prompting for the Cloudsmith credentials."
    exit 0
  fi
  echo "Paste the Cloudsmith credentials (Bitwarden item: CLOUDSMITH_USERNAME / CLOUDSMITH_PASSWORD)."
  read -rp "CLOUDSMITH_USERNAME [token]: " user
  user="${user:-token}"
  password=""
  while [[ -z "$password" ]]; do
    read -rsp "CLOUDSMITH_PASSWORD (input hidden): " password
    echo
  done
  umask 077
  printf 'CLOUDSMITH_USERNAME=%q\nCLOUDSMITH_PASSWORD=%q\n' "$user" "$password" >"$env_file"
fi
chmod 600 "$env_file"

password="$(
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  printf '%s' "$CLOUDSMITH_PASSWORD"
)"
replace_line "${HOME}/.npmrc" "${npm_registry}:_authToken=" "${npm_registry}:_authToken=${password}"
chmod 600 "${HOME}/.npmrc"

# Replace any earlier block, and a literal MISTRAL_REGISTRY_TOKEN export, with one that loads the file.
rc="$(shell_rc)"
touch "$rc"
tmp="$(mktemp)"
awk -v b="$begin" -v e="$end" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip && $0 !~ /^export MISTRAL_REGISTRY_TOKEN=/
' "$rc" >"$tmp"
cat >>"$tmp" <<EOF
$begin
if [ -f "\$HOME/.env.cloudsmith" ]; then
  set -a; . "\$HOME/.env.cloudsmith"; set +a
  export MISTRAL_REGISTRY_TOKEN="\$CLOUDSMITH_PASSWORD"
fi
$end
EOF
cat "$tmp" >"$rc"
rm -f "$tmp"

echo "Cloudsmith credentials wired: ${env_file}, ~/.npmrc and ${rc}."
if [[ "${1:-}" == --inline ]]; then
  read -rp "Press Enter to close this window." _
fi
