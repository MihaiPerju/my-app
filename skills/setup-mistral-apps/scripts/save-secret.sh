#!/usr/bin/env bash
# Usage: save-secret.sh <VAR>
# Prompt for a secret in a new terminal window and save it as <VAR> in ~/.env.mistral-apps (mode
# 600), which the user's shell rc loads. The rc itself never holds a secret: it may be readable by
# others or committed to a dotfiles repository.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/terminal.sh
. "$here/lib/terminal.sh"

var="${1:-}"
if [[ ! "$var" =~ ^[A-Z_][A-Z0-9_]*$ ]] || [[ $# -gt 2 ]] || [[ -n "${2:-}" && "$2" != --inline ]]; then
  echo "Usage: $(basename "$0") <VAR>" >&2
  exit 2
fi

if [[ "${2:-}" != --inline ]]; then
  open_in_terminal "$here/$(basename "$0")" "$var"
  echo "Opened a terminal window prompting for ${var}."
  exit 0
fi

value=""
while [[ -z "$value" ]]; do
  read -rsp "Paste your ${var} (input hidden): " value
  echo
done

env_file="${HOME}/.env.mistral-apps"
begin="# >>> mistral-apps secrets >>>"
end="# <<< mistral-apps secrets <<<"

(umask 077 && touch "$env_file")
chmod 600 "$env_file"
replace_line "$env_file" "export ${var}=" "$(printf 'export %s=%q' "$var" "$value")"

# Drop any earlier block, and a literal export of this secret, then load the file from the rc.
rc="$(shell_rc)"
touch "$rc"
tmp="$(mktemp)"
awk -v b="$begin" -v e="$end" -v x="export ${var}=" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  !skip && index($0, x) != 1
' "$rc" >"$tmp"
cat >>"$tmp" <<EOF
$begin
[ -f "\$HOME/.env.mistral-apps" ] && . "\$HOME/.env.mistral-apps"
$end
EOF
cat "$tmp" >"$rc"
rm -f "$tmp"

echo "${var} saved to ${env_file}, loaded from ${rc}. Restart your coding agent from a new shell to pick it up."
read -rp "Press Enter to close this window." _
