# shellcheck shell=bash
# Helpers shared by the secret prompts. Source it; it defines functions only.

# open_in_terminal <script> [args…]: run `bash <script> [args…] --inline` in a new terminal window,
# so the user types secrets there and they never pass through the calling agent's context.
open_in_terminal() {
  local args=("$@" --inline) term
  case "$(uname -s)" in
    Darwin)
      osascript - "${args[@]}" >/dev/null <<'APPLESCRIPT'
on run argv
  set cmd to "bash"
  repeat with a in argv
    set cmd to cmd & " " & quoted form of (a as text)
  end repeat
  tell application "Terminal"
    do script cmd & "; exit"
    activate
  end tell
end run
APPLESCRIPT
      ;;
    Linux)
      for term in x-terminal-emulator gnome-terminal konsole xterm; do
        command -v "$term" >/dev/null || continue
        case "$term" in
          gnome-terminal) "$term" -- bash "${args[@]}" & ;;
          *) "$term" -e bash "${args[@]}" & ;;
        esac
        return 0
      done
      echo "No terminal emulator found: run 'bash ${args[*]}' in a terminal." >&2
      return 1
      ;;
    *)
      echo "Unsupported platform: run 'bash ${args[*]}' in a terminal." >&2
      return 1
      ;;
  esac
}

# The user's shell rc: ~/.bashrc for bash, ~/.zshrc otherwise.
shell_rc() {
  case "$(basename "${SHELL:-zsh}")" in
    bash) echo "${HOME}/.bashrc" ;;
    *) echo "${HOME}/.zshrc" ;;
  esac
}

# replace_line <file> <fixed-prefix> <line>: drop lines containing the prefix, append the line.
# Rewrites in place, so a symlinked file keeps pointing where it did.
replace_line() {
  local file="$1" prefix="$2" line="$3" tmp
  touch "$file"
  tmp="$(mktemp)"
  grep -vF -- "$prefix" "$file" >"$tmp" || true
  printf '%s\n' "$line" >>"$tmp"
  cat "$tmp" >"$file"
  rm -f "$tmp"
}
