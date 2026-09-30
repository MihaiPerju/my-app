"""Checks that need a generated app but do not need its full container stack."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from e2e_harness import (
    INFRA,
    REGISTRY_ROOT,
    capability_roots,
    check,
    infra_exit,
    installed_capability_ids,
    run,
    skip,
)

MINIMAL_APP_NAME = "e2eapp-workflows-minimal"
MINIMAL_CAPS = ",".join(
    [
        "mistralai-capabilities/backend/fastapi",
        "mistralai-capabilities/frontend/tanstack-start",
        "mistralai-capabilities/backend/workflows",
        "mistralai-capabilities/tooling/testing",
        "mistralai-capabilities/tooling/code-quality",
        "mistralai-capabilities/deployment/apps",
    ]
)
MINIMAL_EXPECTED_CAPABILITIES = sorted(
    [
        "mistralai-capabilities/backend/fastapi",
        "mistralai-capabilities/backend/workflows",
        "mistralai-capabilities/base/core",
        "mistralai-capabilities/feature/fastapi-tanstack-start",
        "mistralai-capabilities/feature/fastapi-workflows",
        "mistralai-capabilities/frontend/tanstack-start",
        "mistralai-capabilities/tooling/testing",
        "mistralai-capabilities/tooling/code-quality",
        "mistralai-capabilities/deployment/apps",
        "mistralai-capabilities/deployment/apps-fastapi",
    ]
)
MINIMAL_PYTEST_TARGETS = [
    "tests",
    "apps/api/tests",
    "apps/worker/tests",
    "packages/py/cli/tests",
]
CAPABILITY_PACKAGE_PY_SUITES = set(
    json.loads(
        (
            Path(__file__).resolve().parent / "capability-package-py-suites.json"
        ).read_text()
    )
)
MINIMAL_API_IMPORT_PROBE = """
import pkgutil

import api.main
import mistralai_capabilities
# No FEATURE toolkit may be installed here. The minimal app selects fastapi/web/workflows + apps:
# `fastapi` and `workflows` each ship a py toolkit and `fastapi` depends on `postgres` (a third),
# `web` is TS-only, and `apps` ships its own toolkit. Those four are the whole legitimate set;
# anything else means a capability was pulled in that nobody selected. This replaced a
# `find_spec("mistralai_capabilities.studio") is None` check when the feature namespace was flattened
# -- enumerating what IS installed also catches a stray toolkit.
installed = {module.name for module in pkgutil.iter_modules(mistralai_capabilities.__path__)}
assert installed <= {"fastapi", "postgres", "workflows", "apps"}, f"unselected capability toolkits are installed: {sorted(installed)}"
assert not [route for route in api.main.app.routes if getattr(route, "path", None) == "/mcp"]
"""
MINIMAL_API_HEALTH_PROBE = """
from api.main import app
from fastapi.testclient import TestClient

response = TestClient(app).get("/api/health")
assert response.status_code == 200, response.text
"""
# The worker builds this exact encoder at start whenever WORKFLOWS_ENCRYPTION_MODE is not `off`
# (the capability's default is `partial`). Without `cryptography` it raises ImportError, and only
# `search` used to bring it in transitively, so this runs in the minimal, search-free app.
MINIMAL_WORKER_ENCRYPTION_PROBE = """
from mistralai.extra.workflows.encoding.config import WorkflowEncodingConfig
from mistralai.extra.workflows.encoding.payload_encoder import PayloadEncoder
from mistralai_capabilities.workflows.encryption import payload_encryption

config = payload_encryption()
assert config is not None, "WORKFLOWS_ENCRYPTION_MODE resolved to off"
PayloadEncoder(WorkflowEncodingConfig(payload_encryption=config))
"""

# Every app-relative path the docker-compose capability family generates into a full app. Removing
# the ordinary docker-compose root deactivates its five derived integrations and must delete all of
# their pristine output (owner-aware orphan cleanup for rendered `.hbs`; plain vendored-file removal
# otherwise) except one user-edited root, which remains byte-for-byte as an unmanaged artifact.
COMPOSE_REMOVAL_ASSETS = [
    "deploy/compose/compose.yaml",
    "deploy/compose/compose.dev.yaml",
    "deploy/compose/compose.gateway.yaml",
    "deploy/compose/compose.init.yaml",
    "deploy/compose/compose.api.yaml",
    "deploy/compose/compose.api.dev.yaml",
    "deploy/compose/compose.web.yaml",
    "deploy/compose/compose.web.dev.yaml",
    "deploy/compose/compose.workflows.yaml",
    "deploy/compose/compose.workflows.dev.yaml",
    "deploy/compose/workflows.defaults.env",
    "deploy/compose/compose.postgres.yaml",
    "deploy/compose/compose.bucket.yaml",
    "deploy/docker/gateway/apisix.yaml",
    "deploy/docker/gateway/config.yaml",
    "deploy/docker/keycloak/realm.json",
    "deploy/docker/Dockerfile.gateway",
    "deploy/docker/Dockerfile.init",
    "tools/smoke.sh",
    "tasks/compose/project.json",
    "tools/compose.sh",
]


def supports_capability_remove(cli: str, app_dir: Path) -> bool:
    """Check the command's help text because older CLI versions exit zero for unknown commands."""
    ok, output = run([cli, "apps", "capability", "remove", "--help"], str(app_dir))
    return ok and "Remove installed capabilities from this app." in output


def check_capability_removal(cli: str, app_dir: Path) -> None:
    """Prove `capability remove docker-compose` cleans up its generated output.

    The full fixture directly selects ordinary roots only, so Compose integrations are present by
    activation rather than pinned as user selections. Removing docker-compose therefore deactivates
    those integrations atomically. Runs LAST because it deletes files used by runtime checks.
    The CLI mechanics are unit-covered in the Apps CLI; this asserts the composed registry result.
    """
    caps_file = app_dir / ".mistral" / "capabilities.json"
    if not caps_file.exists():
        skip("capability remove docker-compose (no generated app)")
        return
    installed = set(installed_capability_ids(app_dir))
    compose_id = "mistralai-capabilities/deployment/docker-compose"
    compose_integrations = {
        capability_id
        for capability_id in installed
        if capability_id.startswith("mistralai-capabilities/deployment/docker-compose-")
    }
    if compose_id not in installed:
        skip("capability remove docker-compose (not installed)")
        return
    if not supports_capability_remove(cli, app_dir):
        skip("capability remove docker-compose (unsupported by installed CLI)")
        return

    missing = [rel for rel in COMPOSE_REMOVAL_ASSETS if not (app_dir / rel).exists()]
    check(
        "docker-compose Compose output present before removal",
        not missing,
        "\n".join(f"  {rel}" for rel in missing),
    )

    # A file the user edited: the cleanup must keep it verbatim, not delete it with the pristine rest.
    edited = "deploy/compose/compose.yaml"
    edited_path = app_dir / edited
    edited_marker = "# e2e: hand edit, must survive docker-compose removal\n"
    edited_body = edited_path.read_text() + edited_marker
    edited_path.write_text(edited_body)

    removed, remove_out = run(
        [cli, "apps", "capability", "remove", compose_id, "--yes"], str(app_dir)
    )
    if not removed:
        if INFRA.search(remove_out):
            infra_exit(
                f"capability remove could not reach the registry:\n{remove_out[-1500:]}"
            )
        check(
            "mistral apps capability remove docker-compose", False, remove_out[-3000:]
        )
        return
    check("mistral apps capability remove docker-compose", True)

    still_installed = set(installed_capability_ids(app_dir))
    removed_ids = {compose_id, *compose_integrations}
    check(
        "docker-compose and its derived integrations leave the selection",
        still_installed == installed - removed_ids,
        f"expected removal: {sorted(removed_ids)}\nstill installed: {sorted(still_installed)}",
    )

    # Every pristine asset is gone; the hand-edited one is kept verbatim.
    survivors = [
        rel
        for rel in COMPOSE_REMOVAL_ASSETS
        if rel != edited and (app_dir / rel).exists()
    ]
    check(
        "removing docker-compose deletes its pristine generated output",
        not survivors,
        "these files were left behind:\n" + "\n".join(f"  {rel}" for rel in survivors),
    )
    check(
        "a user-modified Compose file is kept verbatim, not deleted",
        edited_path.exists() and edited_path.read_text() == edited_body,
        f"{edited} was deleted or altered on removal (owner-aware cleanup must keep modified files)",
    )


def check_clean_scaffold_gates(app_dir: Path, uv_env: dict[str, str]) -> None:
    """Run the app's own gates that the harness's lint/type/test targets do not reach.

    A pristine scaffold must pass its own ``bun run check`` before anyone adds code. The shell and
    Dockerfile linters and the two coverage ratchets are part of that gate, and each failed on
    freshly generated apps (tools/lib.sh SC2148, hadolint DL3008/SC2155, the web floor measuring a
    vendored library). The linters need their own binaries, so a missing one is a SKIP, not a pass.
    """
    if shutil.which("shellcheck") is None:
        skip("nx run quality:lint-shell (shellcheck not installed)")
    else:
        ok, out = run(["bunx", "nx", "run", "quality:lint-shell"], str(app_dir), uv_env)
        check("nx run quality:lint-shell", ok, out[-2000:])

    if shutil.which("docker") is None or not run(["docker", "info"], str(app_dir))[0]:
        skip("nx run quality:lint-docker (no docker daemon)")
    else:
        ok, out = run(["bunx", "nx", "run", "quality:lint-docker"], str(app_dir), uv_env)
        check("nx run quality:lint-docker", ok, out[-2000:])

    ok, out = run(["bunx", "nx", "run", "testing:check"], str(app_dir), uv_env)
    check("nx run testing:check (Python and web coverage floors)", ok, out[-3000:])


def run_capability_package_tests(app_dir: Path, uv_env: dict[str, str]) -> None:
    """Run each installed capability's ``package/py/tests`` suite inside the generated app.

    These suites test the PUBLISHED package, but they never travel: ``package/`` is not vendored
    (that is ``template/``) and an installed dist ships ``src/`` only, so they run in no other tier.
    They also import capability dists and app-local packages -- ``from mistralai_capabilities.workflows.client import ...``,
    ``from db.models... import ...`` -- and rely on ``asyncio_mode = "auto"``, none of which exist
    outside a generated app. So the one place they resolve is here, after ``uv sync --all-packages``
    has installed both the app's workspace members and the capability dists they exercise.

    Each suite is copied under the app root -- not run in place -- so pytest locates the app's
    ``[tool.pytest.ini_options]`` (that is where ``asyncio_mode`` lives) and the co-located
    ``conftest.py`` / ``fakes.py`` / ``search_pg_support.py`` stay siblings that import by bare name.
    One process per capability, because two capabilities ship the same module basename
    (``test_schemas.py``) that pytest's default import mode would collide in a single invocation.
    """
    installed = installed_capability_ids(app_dir)
    dest_root = app_dir / "_capability_package_tests"
    suites: list[str] = []
    # Record an unexpected copy/IO error as a check failure rather than letting a raw traceback
    # escape, then remove the copies so later steps inspect exactly what the CLI produced.
    roots = capability_roots()
    try:
        for cap_id in installed:
            root = roots.get(cap_id)
            if root is None:
                continue
            src = root / "package" / "py" / "tests"
            if not src.is_dir():
                continue
            shutil.copytree(src, dest_root / cap_id)
            suites.append(cap_id)

        # Check each expected suite independently, not just `bool(suites)`: deleting or relocating
        # one suite while the others remain would otherwise leave that suite running nowhere.
        expected = sorted(CAPABILITY_PACKAGE_PY_SUITES & set(installed))
        missing = [cap_id for cap_id in expected if cap_id not in suites]
        check(
            "every expected capability package/py suite was discovered",
            not missing,
            f"missing {missing} (found {suites}); if a suite was intentionally removed, "
            "update scripts/e2e/capability-package-py-suites.json",
        )

        for cap_id in suites:
            ok, out = run(
                [
                    "uv",
                    "run",
                    "--no-sync",
                    "pytest",
                    f"_capability_package_tests/{cap_id}",
                    "-q",
                ],
                str(app_dir),
                uv_env,
            )
            check(f"capability package pytest: {cap_id}", ok, out[-3000:])
    except OSError as error:
        check(
            "capability package tests ran without a harness error", False, repr(error)
        )
    finally:
        shutil.rmtree(dest_root, ignore_errors=True)


def check_minimal_generated_app(
    cli: str, workdir: Path, uv_env: dict[str, str]
) -> None:
    """Generate api+web+workflows and exercise its composition-independent surface."""
    app_dir = workdir / MINIMAL_APP_NAME
    ok, out = run(
        [
            cli,
            "apps",
            "init",
            MINIMAL_APP_NAME,
            "--registry-url",
            str(REGISTRY_ROOT),
            "--source",
            "git",
            "--caps",
            MINIMAL_CAPS,
        ],
        str(workdir),
    )
    if not ok:
        if INFRA.search(out):
            infra_exit(
                f"minimal generated app creation could not reach a registry:\n{out[-1500:]}"
            )
        check(f"mistral apps init --caps {MINIMAL_CAPS}", False, out[-3000:])
        return
    check(f"mistral apps init --caps {MINIMAL_CAPS}", True)

    installed = installed_capability_ids(app_dir)
    check(
        "minimal workflow app installs only api/web/workflows closure",
        installed == MINIMAL_EXPECTED_CAPABILITIES,
        f"expected {MINIMAL_EXPECTED_CAPABILITIES}\ninstalled {installed}",
    )

    # Only mistral-design-system maps the private npm scopes; core is public and must not.
    private_scopes = re.compile(r'^\s*(?:"@mistral(?:ai)?"\s*=|@mistral(?:ai)?:registry=)', re.M)
    scope_offenders = [
        name
        for name in (".npmrc", "bunfig.toml")
        if (app_dir / name).is_file() and private_scopes.search((app_dir / name).read_text())
    ]
    check(
        "minimal app (no design system) maps no private @mistral / @mistralai npm scope",
        not scope_offenders,
        f"private scope mapped in: {scope_offenders}",
    )

    probe_sources = {
        "Dockerfile.worker": app_dir / "deploy" / "docker" / "Dockerfile.worker",
    }
    probe_offenders = []
    stale_marker = "/".join(("/tmp", "-".join(("workflows", "ready"))))
    for label, path in probe_sources.items():
        source = path.read_text()
        if stale_marker in source:
            probe_offenders.append(f"{label}: uses stale workflows-ready marker")
        if "HEALTH_SERVER_HOST" not in source:
            probe_offenders.append(f"{label}: missing HEALTH_SERVER_HOST")
        if "HEALTH_SERVER_PORT" not in source:
            probe_offenders.append(f"{label}: missing HEALTH_SERVER_PORT")
        if "127.0.0.1:3001" not in source:
            probe_offenders.append(f"{label}: missing loopback health server address")
        if "/health" not in source:
            probe_offenders.append(f"{label}: missing SDK health endpoint")
        if "mistralai_capabilities" in source:
            probe_offenders.append(f"{label}: imports a capability toolkit")
    check(
        "minimal workflow app SDK health probes are composition-independent",
        not probe_offenders,
        "\n".join(probe_offenders),
    )

    # The minimal app has no feature routes, but its web workspace must still build and its route
    # tree must still generate with "/" reachable. Web needs bun, not uv, so run it before the
    # uv-gated checks below.
    web_install_ok, web_install_out = run(["bun", "install"], str(app_dir))
    if not web_install_ok and INFRA.search(web_install_out):
        infra_exit(
            f"minimal generated app bun install could not reach the registry:\n{web_install_out[-1500:]}"
        )
    check("minimal generated app bun install", web_install_ok, web_install_out[-2000:])
    if web_install_ok:
        build_ok, build_out = run(["bunx", "nx", "run", "web:build"], str(app_dir))
        if not build_ok and INFRA.search(build_out):
            infra_exit(
                f"minimal generated app web build could not reach a registry:\n{build_out[-1500:]}"
            )
        check("minimal generated app nx run web:build", build_ok, build_out[-2000:])
        if build_ok:
            route_tree = app_dir / "apps" / "web" / "src" / "routeTree.gen.ts"
            problems = []
            if not route_tree.exists():
                problems.append("no apps/web/src/routeTree.gen.ts was generated")
            else:
                tree = route_tree.read_text()
                if "__root" not in tree:
                    problems.append("generated route tree wires no root route (__root)")
                if "'/'" not in tree:
                    problems.append(
                        "generated route tree has no '/' route -- home is unreachable"
                    )
            check(
                "minimal generated app web builds a route tree with '/' reachable",
                not problems,
                "\n".join(problems),
            )
            # The tree is gitignored, so a fresh checkout has none until something runs Vite.
            # `web:gen-routes` is what the type-check depends on instead of a full build; it must
            # write the same file the build did.
            if route_tree.exists():
                built_tree = route_tree.read_text()
                route_tree.unlink()
                routes_ok, routes_out = run(
                    ["bunx", "nx", "run", "web:gen-routes", "--skip-nx-cache"],
                    str(app_dir),
                )
                check(
                    "minimal generated app web:gen-routes writes the build's route tree",
                    routes_ok
                    and route_tree.exists()
                    and route_tree.read_text() == built_tree,
                    routes_out[-2000:],
                )
            # With no feature route, `FeatureHref` is exactly "/" and a narrowed href is `never`,
            # which the type-aware lint rejects in a template literal. The full app always has
            # feature routes, so only this app types the shell the way a default (`--yes`) app does.
            ts_ok, ts_out = run(
                ["bunx", "nx", "run", "quality:check-ts"], str(app_dir)
            )
            check(
                "minimal generated app nx run quality:check-ts", ts_ok, ts_out[-3000:]
            )

    if not run(["uv", "--version"], str(app_dir))[0]:
        skip("minimal generated app uv lock / sync / pytest (uv not installed)")
        return

    lock_ok, lock_out = run(["uv", "lock"], str(app_dir), uv_env)
    if not lock_ok and INFRA.search(lock_out):
        infra_exit(
            f"minimal generated app uv lock could not resolve the workspace:\n{lock_out[-1500:]}"
        )
    check("minimal generated app uv lock", lock_ok, lock_out[-2000:])

    sync_ok, sync_out = run(["uv", "sync", "--all-packages"], str(app_dir), uv_env)
    if not sync_ok and INFRA.search(sync_out):
        infra_exit(
            f"minimal generated app uv sync could not reach the index:\n{sync_out[-1500:]}"
        )
    check("minimal generated app uv sync --all-packages", sync_ok, sync_out[-2000:])
    if not sync_ok:
        return

    check_minimal_generated_client(app_dir, uv_env)
    skip(
        "minimal generated app optional-feature root config tests (composition-dependent)"
    )

    minimal_api_env = {
        **uv_env,
        "MCP_APPS_ENABLED": "false",
        "TELEMETRY_ENABLED": "false",
    }
    import_ok, import_out = run(
        ["uv", "run", "--no-sync", "python", "-c", MINIMAL_API_IMPORT_PROBE],
        str(app_dir),
        minimal_api_env,
    )
    check(
        "minimal generated app imports API without studio or MCP App providers",
        import_ok,
        import_out[-2000:],
    )

    health_ok, health_out = run(
        ["uv", "run", "--no-sync", "python", "-c", MINIMAL_API_HEALTH_PROBE],
        str(app_dir),
        minimal_api_env,
    )
    check(
        "minimal generated app /api/health returns 200", health_ok, health_out[-2000:]
    )

    encryption_ok, encryption_out = run(
        ["uv", "run", "--no-sync", "python", "-c", MINIMAL_WORKER_ENCRYPTION_PROBE],
        str(app_dir),
        {
            **uv_env,
            "WORKFLOWS_ENCRYPTION_MODE": "partial",
            "WORKFLOWS_ENCRYPTION_KEY": "deadbeef" * 8,
        },
    )
    check(
        "minimal generated app (no search) builds the worker's payload-encryption codec",
        encryption_ok,
        encryption_out[-2000:],
    )

    test_ok, test_out = run(
        [
            "uv",
            "run",
            "--no-sync",
            "pytest",
            *MINIMAL_PYTEST_TARGETS,
            "-q",
        ],
        str(app_dir),
        uv_env,
    )
    check(
        "minimal generated app composition-independent pytest",
        test_ok,
        test_out[-2000:],
    )


def check_minimal_generated_client(app_dir: Path, uv_env: dict[str, str]) -> None:
    """The minimal app's own client gate passes once ``install-all`` has run.

    The scaffold ships the web client generated for the registry's full composition, because the CLI
    only copies files, so the full app is the one composition that can never notice a stale client.
    Every smaller app failed its own ``fastapi-tanstack-start:gen-types-check`` until
    ``tools/install.sh`` started regenerating it (``tools/gen-types.sh``). Run that step, then the app's own gates on the result:
    the drift check, and the web type-check against a client that lacks the unselected features.
    """
    install_sh = (app_dir / "tools" / "install.sh").read_text()
    check(
        "install-all regenerates the web API client (tools/install.sh runs tools/gen-types.sh)",
        "bash tools/gen-types.sh" in install_sh,
        "tools/install.sh no longer regenerates the client, so a pristine app fails "
        "fastapi-tanstack-start:gen-types-check",
    )
    regen_ok, regen_out = run(["bash", "tools/gen-types.sh"], str(app_dir), uv_env)
    check(
        "minimal generated app regenerates its web API client",
        regen_ok,
        regen_out[-2000:],
    )
    if not regen_ok:
        return
    sdk = (app_dir / "apps" / "web" / "src" / "api" / "generated" / "sdk.gen.ts").read_text()
    check(
        "minimal generated app client carries no unselected feature's operations",
        "chatListSessions" not in sdk and "health" in sdk,
        "the regenerated client still exports chat operations (or lost /api/health)",
    )
    for target in ("fastapi-tanstack-start:gen-types-check", "quality:check-ts"):
        task_ok, task_out = run(
            ["bunx", "nx", "run", target, "--skip-nx-cache"], str(app_dir), uv_env
        )
        check(
            f"minimal generated app nx run {target} (own client)",
            task_ok,
            task_out[-3000:],
        )


CHAT_ONLY_APP_NAME = "e2eapp-chat-only"
# `deployment/apps` only because a selection must name one deployment; it adds nothing to the worker.
# `code-quality` for the chat web slice's `quality:check-ts` gate; it adds nothing to the worker either.
CHAT_ONLY_CAPS = ",".join(
    [
        "mistralai-capabilities/feature/chat",
        "mistralai-capabilities/tooling/code-quality",
        "mistralai-capabilities/deployment/apps",
    ]
)


def check_chat_web_without_speech(app_dir: Path) -> None:
    """Chat's web slice builds and passes its own tests with no speech installed.

    Chat names no other feature: side apps are child routes and dictation/read-aloud are chat
    extensions, all contributed by the capabilities that own them. Without speech the chat layout
    has no side-app route, the extensions glob matches nothing, and chat's tests must not need
    either. Web needs bun, not uv, so this runs before the uv-gated agents checks.
    """
    install_ok, install_out = run(["bun", "install"], str(app_dir))
    if not install_ok and INFRA.search(install_out):
        infra_exit(
            f"chat-only generated app bun install could not reach the registry:\n{install_out[-1500:]}"
        )
    check("chat-only generated app bun install", install_ok, install_out[-2000:])
    if not install_ok:
        return
    build_ok, build_out = run(["bunx", "nx", "run", "web:build"], str(app_dir))
    if not build_ok and INFRA.search(build_out):
        infra_exit(
            f"chat-only generated app web build could not reach a registry:\n{build_out[-1500:]}"
        )
    check("chat-only generated app nx run web:build", build_ok, build_out[-2000:])
    if build_ok:
        tree = (app_dir / "apps" / "web" / "src" / "routeTree.gen.ts").read_text()
        problems = []
        if "'/chat/'" not in tree:
            problems.append("the route tree has no chat layout index route ('/chat/')")
        check(
            "chat-only generated app routes chat with no side app",
            not problems,
            "\n".join(problems),
        )
    # Types and lint too: chat's code has to hold up with no speech files around it.
    quality_ok, quality_out = run(["bunx", "nx", "run", "quality:check-ts"], str(app_dir))
    check("chat-only generated app nx run quality:check-ts", quality_ok, quality_out[-2000:])
    test_ok, test_out = run(["bunx", "nx", "run", "web:test"], str(app_dir))
    check("chat-only generated app nx run web:test", test_ok, test_out[-2000:])


def check_chat_only_generated_app(
    cli: str, workdir: Path, uv_env: dict[str, str]
) -> None:
    """Generate chat without search/connectors/guardrailing and run the agents project's gate on it.

    The full app always carries search, connectors and guardrailing, so it cannot notice an agents
    check that assumes them: the census once hard-coded their contributions and `agents:test`
    failed on every smaller selection. Chat is the smallest selection that installs `agents`.
    """
    app_dir = workdir / CHAT_ONLY_APP_NAME
    ok, out = run(
        [
            cli,
            "apps",
            "init",
            CHAT_ONLY_APP_NAME,
            "--registry-url",
            str(REGISTRY_ROOT),
            "--source",
            "git",
            "--caps",
            CHAT_ONLY_CAPS,
        ],
        str(workdir),
    )
    if not ok:
        if INFRA.search(out):
            infra_exit(
                f"chat-only generated app creation could not reach a registry:\n{out[-1500:]}"
            )
        check(f"mistral apps init --caps {CHAT_ONLY_CAPS}", False, out[-3000:])
        return
    check(f"mistral apps init --caps {CHAT_ONLY_CAPS}", True)

    check_chat_web_without_speech(app_dir)

    if not run(["uv", "--version"], str(app_dir))[0]:
        skip("chat-only generated app agents gate (uv not installed)")
        return
    lock_ok, lock_out = run(["uv", "lock"], str(app_dir), uv_env)
    if not lock_ok and INFRA.search(lock_out):
        infra_exit(
            f"chat-only generated app uv lock could not resolve the workspace:\n{lock_out[-1500:]}"
        )
    check("chat-only generated app uv lock", lock_ok, lock_out[-2000:])
    sync_ok, sync_out = run(["uv", "sync", "--all-packages"], str(app_dir), uv_env)
    if not sync_ok and INFRA.search(sync_out):
        infra_exit(
            f"chat-only generated app uv sync could not reach the index:\n{sync_out[-1500:]}"
        )
    check("chat-only generated app uv sync --all-packages", sync_ok, sync_out[-2000:])
    if not sync_ok:
        return

    # The commands the agents project's `test` and `typecheck` nx targets run, read from its
    # project.json so this check follows the targets rather than a copy of them.
    targets = json.loads(
        (app_dir / "apps/worker/src/worker/agents/project.json").read_text()
    )["targets"]
    for target in ("test", "typecheck"):
        command = targets[target]["options"]["command"].split()
        # `bash tools/uv.sh run ...` only adds index credentials, which uv_env already carries.
        if command[:2] == ["bash", "tools/uv.sh"]:
            command = ["uv", *command[2:]]
        target_ok, target_out = run(command, str(app_dir), uv_env)
        check(
            f"chat-only generated app agents:{target}", target_ok, target_out[-2000:]
        )
