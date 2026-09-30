"""Generate and verify the FastAPI hook capability matrix."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from e2e_harness import INFRA, REGISTRY_ROOT, check, infra_exit, run

SELECTIONS = {
    "bare": "fastapi,apps",
    "postgres": "fastapi,postgres,apps",
    "workflows": "fastapi,workflows,apps",
    "auth": "fastapi,auth,apps",
    "full": "fastapi,auth,workflows,apps",
}

EXPECTED = {
    "bare": (("gateway_token",), (), (), (), (), ()),
    "postgres": (("gateway_token",), (), ("database",), ("database",), ("database",), ()),
    "workflows": (("gateway_token",), (), (), (), (), ("deployment",)),
    "auth": (("auth", "gateway_token"), (), ("database",), ("database",), ("database",), ()),
    "full": (
        ("auth", "gateway_token", "workflows_auth"),
        ("workflows_auth",),
        ("database",),
        ("database",),
        ("database",),
        ("deployment",),
    ),
}

_DISCOVERY_PROBE = """from fastapi.testclient import TestClient
from api.main import create_app
from mistralai_capabilities.fastapi.hooks import FastAPIHooks
h = FastAPIHooks.discover()
actual = (tuple(k for k, _ in h.configure_hooks), tuple(k for k, _ in h.startup_hooks), tuple(k for k, _ in h.shutdown_hooks), tuple(k for k, _ in h.report_checks), tuple(k for k, _ in h.readiness_checks), tuple(h.metadata_values))
assert actual == {expected}, actual
with TestClient(create_app()) as client:
    assert client.get('/api/health/live').status_code == 200
    assert client.get('/api/health/startup').status_code == 200
"""

_READINESS_PROBE = """import sys
from pathlib import Path
sys.path.insert(0, str(Path('apps/api/tests').resolve()))
from fastapi.testclient import TestClient
from api.main import create_app
from api.routers.api.internal.health import draining
from support.postgres import postgres_hooks
app = create_app(hooks=postgres_hooks(ready=False))
with TestClient(app) as client:
    response = client.get('/api/health/ready')
    assert response.status_code == 503 and response.json()['status'] == 'not_ready'
app = create_app(hooks=postgres_hooks(ready=False))
app.dependency_overrides[draining] = lambda: True
with TestClient(app) as client:
    response = client.get('/api/health/ready')
    assert response.status_code == 503 and response.json()['status'] == 'draining'
"""


def _prepare(
    fixture: tuple[str, Path], uv_env: dict[str, str]
) -> tuple[str, bool, str, bool, str]:
    name, app_dir = fixture
    lock_ok, lock_out = run(["uv", "lock"], str(app_dir), uv_env)
    if not lock_ok:
        return name, lock_ok, lock_out, False, ""
    sync_ok, sync_out = run(["uv", "sync", "--all-packages"], str(app_dir), uv_env)
    return name, lock_ok, lock_out, sync_ok, sync_out


def _probe(name: str, app_dir: Path, uv_env: dict[str, str]) -> None:
    probe_ok, probe_out = run(
        [
            "uv",
            "run",
            "--all-packages",
            "--no-sync",
            "python",
            "-c",
            _DISCOVERY_PROBE.format(expected=repr(EXPECTED[name])),
        ],
        str(app_dir),
        uv_env,
    )
    check(f"FastAPI hooks discovered: {name}", probe_ok, probe_out[-3000:])

    if name == "postgres":
        ready_ok, ready_out = run(
            [
                "uv",
                "run",
                "--all-packages",
                "--no-sync",
                "python",
                "-c",
                _READINESS_PROBE,
            ],
            str(app_dir),
            uv_env,
        )
        check("FastAPI readiness seam", ready_ok, ready_out[-3000:])

    if name == "bare":
        collect_ok, collect_out = run(
            [
                "uv",
                "run",
                "--all-packages",
                "--no-sync",
                "--with",
                "pytest",
                "pytest",
                "--collect-only",
                "apps/api/tests",
            ],
            str(app_dir),
            uv_env,
        )
        check(
            "bare FastAPI tests collect without optional imports",
            collect_ok,
            collect_out[-3000:],
        )


def check_fastapi_hook_selections(
    cli: str, workdir: Path, uv_env: dict[str, str]
) -> None:
    """Generate every hook closure, prepare them concurrently, then run uniform probes."""
    fixtures: list[tuple[str, Path]] = []
    for name, selection in SELECTIONS.items():
        app_name = f"e2eapp-fastapi-hooks-{name}"
        app_dir = workdir / app_name
        ok, out = run(
            [
                cli,
                "apps",
                "init",
                app_name,
                "--registry-url",
                str(REGISTRY_ROOT),
                "--source",
                "git",
                "--caps",
                selection,
            ],
            str(workdir),
        )
        check(f"mistral apps init FastAPI hooks: {name}", ok, out[-3000:])
        if ok:
            fixtures.append((name, app_dir))

    with ThreadPoolExecutor(max_workers=min(4, len(fixtures) or 1)) as executor:
        results = list(
            executor.map(lambda fixture: _prepare(fixture, uv_env), fixtures)
        )

    fixture_dirs = dict(fixtures)
    for name, lock_ok, lock_out, sync_ok, sync_out in results:
        if not lock_ok and INFRA.search(lock_out):
            infra_exit(
                f"FastAPI hook matrix uv lock could not resolve {name}:\n{lock_out[-1500:]}"
            )
        check(f"FastAPI hook matrix locks: {name}", lock_ok, lock_out[-3000:])
        if not lock_ok:
            continue
        if not sync_ok and INFRA.search(sync_out):
            infra_exit(
                f"FastAPI hook matrix uv sync could not install {name}:\n{sync_out[-1500:]}"
            )
        check(f"FastAPI hook matrix syncs: {name}", sync_ok, sync_out[-3000:])
        if sync_ok:
            _probe(name, fixture_dirs[name], uv_env)
