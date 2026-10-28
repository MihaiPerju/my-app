#!/usr/bin/env python
"""Run the full local stack with the agent's MCP connector wired end-to-end.

`bunx nx run compose:dev` serves chat but cannot surface MCP apps locally: that needs Mistral's hosted
runtime to reach this app's localhost MCP server. This script starts a public tunnel to the gateway
(:9080), exports ``MCP_SERVER_URL=<url>/mcp``, and runs `bunx nx run compose:dev`. Ctrl-C tears down the
tunnel and dev stack.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# The tunnel must terminate on the GATEWAY, not the API. The API trusts the
# x-user-id header the gateway injects and verifies nothing itself, so exposing :3000
# publicly would let anyone on the internet name themselves any user. :9080 puts
# Keycloak in front of the same MCP endpoint.
TUNNEL_PORT = 9080
REPO_ROOT = Path(__file__).resolve().parent.parent
_URL_TIMEOUT_S = 30
_CLOUDFLARED_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def _log(message: str) -> None:
    print(f"[dev:agent] {message}", flush=True)  # noqa: T201 — intentional CLI feedback


def _start_cloudflared() -> tuple[subprocess.Popen[bytes], str | None]:
    log_path = REPO_ROOT / ".dev-agent-cloudflared.log"
    log = log_path.open("wb")
    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{TUNNEL_PORT}", "--no-autoupdate"],
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + _URL_TIMEOUT_S
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        match = _CLOUDFLARED_URL.search(log_path.read_text(errors="ignore"))
        if match:
            return proc, match.group(0)
        time.sleep(0.5)
    return proc, None


def _start_ngrok() -> tuple[subprocess.Popen[bytes], str | None]:
    proc = subprocess.Popen(
        ["ngrok", "http", str(TUNNEL_PORT), "--log=stdout"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + _URL_TIMEOUT_S
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen("http://localhost:4040/api/tunnels", timeout=2) as response:
                tunnels = json.load(response).get("tunnels") or []
            if tunnels:
                return proc, tunnels[0]["public_url"]
        except Exception:
            pass
        time.sleep(1)
    return proc, None


def _pick_tunnel() -> tuple[subprocess.Popen[bytes], str | None, str] | None:
    if shutil.which("cloudflared"):
        _log("starting cloudflared quick tunnel...")
        proc, url = _start_cloudflared()
        return proc, url, "cloudflared"
    if shutil.which("ngrok"):
        _log("starting ngrok tunnel...")
        proc, url = _start_ngrok()
        return proc, url, "ngrok"
    _log("No tunnel tool found. Install one, e.g. `brew install cloudflared` (no signup needed).")
    _log("Note: plain `bunx nx run compose:dev` already gives working chat — you only need this for MCP apps.")
    return None


def main() -> int:
    picked = _pick_tunnel()
    if picked is None:
        return 1
    tunnel, url, tool = picked

    if not url:
        _log(f"Could not obtain a public URL from {tool} within {_URL_TIMEOUT_S}s. Aborting.")
        _terminate(tunnel)
        return 1

    mcp_url = f"{url.rstrip('/')}/mcp"
    _log(f"tunnel up via {tool}: {url}")
    _log(f"MCP_SERVER_URL={mcp_url} — the API will register/repoint the connector on startup.")

    dev = subprocess.Popen(
        # `--no-sync` because this script is itself launched by `uv run --no-sync`, so the
        # workspace env is already current and a re-sync would need the private-registry token.
        ["bunx", "nx", "run", "compose:dev"],
        cwd=str(REPO_ROOT),
        env={**os.environ, "MCP_SERVER_URL": mcp_url, "MCP_APPS_ENABLED": "1"},
    )

    def _shutdown(*_: object) -> None:
        _log("shutting down dev stack and tunnel...")
        _terminate(dev)
        _terminate(tunnel)

    signal.signal(signal.SIGINT, lambda *_: (_shutdown(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (_shutdown(), sys.exit(0)))

    try:
        return dev.wait()
    finally:
        _shutdown()


def _terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
