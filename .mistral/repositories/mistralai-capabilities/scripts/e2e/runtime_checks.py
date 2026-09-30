"""Container, Helm, and live-health checks for a generated application."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from e2e_harness import APP_NAME, INFRA, check, infra_exit, run, skip, uv_index_env

DOCKER_INFRA = re.compile(
    r"401|403|ENOTFOUND|ETIMEDOUT|TLS handshake|i/o timeout", re.IGNORECASE
)


def wait_healthy(timeout: int = 300, interval: int = 5) -> tuple[bool, str]:
    """Poll the gateway-fronted API's /api/health until 200 with status:ok, or time out."""
    deadline = time.monotonic() + timeout
    last = 0
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:3000/api/health", timeout=10
            ) as resp:
                last = resp.status
                if (
                    resp.status == 200
                    and json.loads(resp.read().decode("utf-8", "replace")).get("status")
                    == "ok"
                ):
                    return True, "200 + status:ok"
        except urllib.error.HTTPError as err:
            last = err.code
        except Exception:  # noqa: BLE001 - not up yet; keep polling
            pass
        time.sleep(interval)
    return False, f"never 200+ok within {timeout}s (last={last})"


def boot_and_health(app_dir: Path) -> None:
    """Boot the full stack, confirm /api/health, and tear it down."""
    # A run-unique name isolates the worker's task queue on shared Temporal and the compose state.
    project_name = f"capability-e2e-{secrets.token_hex(3)}"
    boot_env: dict[str, str] = {
        **uv_index_env(),
        "COMPOSE_PROJECT_NAME": project_name,
    }
    env = {
        "COMPOSE_PROJECT_NAME": project_name,
        "DEPLOYMENT_NAME": project_name,
        "WORKFLOWS_ENCRYPTION_KEY": secrets.token_hex(32),
        "WORKFLOWS_ENCRYPTION_MODE": "full",
    }
    if os.environ.get("MISTRAL_API_KEY"):
        env["MISTRAL_API_KEY"] = os.environ["MISTRAL_API_KEY"]
    else:
        # Similarity seeding intentionally needs a live Mistral key. The smoke test does not run an
        # agent turn, so disable only that scanner when the optional credential is unavailable.
        env["GUARDRAIL_SIMILARITY_ENABLED"] = "false"
    (app_dir / ".env").write_text("".join(f"{key}={value}\n" for key, value in env.items()))

    compose = ["docker", "compose", "-f", "deploy/compose/compose.yaml"]
    try:
        # Plain BuildKit output preserves the failing RUN step instead of an opaque exit code.
        up_ok, up_out = run(
            ["bunx", "nx", "run", "compose:up"],
            str(app_dir),
            {**boot_env, "BUILDKIT_PROGRESS": "plain"},
        )
        if not up_ok:
            print(
                f"--- nx run compose:up output ({len(up_out)} chars) ---\n{up_out}\n--- end nx run compose:up output ---"
            )
            print(
                f"--- docker compose ps -a ---\n"
                f"{run([*compose, 'ps', '-a'], str(app_dir), boot_env)[1]}"
            )
            logs = run(
                [*compose, "logs", "--no-color", "--tail=150"], str(app_dir), boot_env
            )[1]
            print(f"--- docker compose logs (tail) ---\n{logs}")
            if INFRA.search(up_out):
                infra_exit(f"nx run compose:up could not build/start:\n{up_out[-1500:]}")
            check("nx run compose:up", False, up_out[-2500:])
            return
        check("nx run compose:up", True)

        healthy, detail = wait_healthy()
        if not healthy:
            logs = run(
                [*compose, "logs", "--no-color", "--tail=150"], str(app_dir), boot_env
            )[1]
            check("/api/health 200 + status:ok", False, f"{detail}\n{logs[-5000:]}")
        else:
            check("/api/health 200 + status:ok", True)
    finally:
        # This project name belongs only to this E2E run, so its volumes are disposable test output.
        run([*compose, "down", "--volumes", "--remove-orphans"], str(app_dir), boot_env)


def check_docker_builds(app_dir: Path, enabled: bool) -> None:
    """Optionally build every generated image, including dependency-copy stages."""
    if not enabled:
        skip("docker build (pass --docker; ~15 min cold)")
        return
    if not run(["docker", "version"], str(app_dir))[0]:
        skip("docker build (no docker daemon)")
        return

    token = (
        os.environ.get("NODE_AUTH_TOKEN")
        or os.environ.get("MISTRAL_REGISTRY_TOKEN")
        or os.environ.get("GEMFURY_PULL_TOKEN")
        or ""
    )
    built: list[str] = []
    for image, target in (
        ("api", "api"),
        ("worker", "workflows"),
        ("init", "init"),
        ("web", "runtime"),
        ("gateway", ""),
    ):
        tag = f"capability-e2e-{image}:test"
        cmd = ["docker", "build", "-f", f"deploy/docker/Dockerfile.{image}"]
        if target:
            cmd += ["--target", target]
        cmd += [
            "--secret",
            "id=registry_token,env=NODE_AUTH_TOKEN",
            "-t",
            tag,
            ".",
        ]
        build_ok, build_out = run(cmd, str(app_dir), {"NODE_AUTH_TOKEN": token})
        if not build_ok and DOCKER_INFRA.search(build_out):
            infra_exit(
                f"docker build {image} could not reach a registry:\n{build_out[-1500:]}"
            )
        check(f"docker build {image}", build_ok, build_out[-2500:])
        if build_ok:
            built.append(tag)
    if built:
        run(["docker", "image", "rm", "-f", *built], str(app_dir))


def check_helm_chart(app_dir: Path) -> None:
    """Lint and render the generated Helm chart when Helm is installed."""
    chart = app_dir / "deploy" / "helm" / "app"
    if not chart.exists():
        check("helm chart present", False, f"no chart at {chart.relative_to(app_dir)}")
        return
    if not run(["helm", "version"], str(app_dir))[0]:
        skip("helm lint / template (helm not installed)")
        return

    lint_ok, lint_out = run(["helm", "lint", str(chart)], str(app_dir))
    check("helm lint", lint_ok, lint_out[-2000:])
    render_ok, render_out = run(
        ["helm", "template", APP_NAME, str(chart)], str(app_dir)
    )
    check("helm template", render_ok, render_out[-2000:])
    if render_ok:
        check(
            "the app name reaches rendered objects",
            f"app.kubernetes.io/name: {APP_NAME}" in render_out,
            "global.appName did not flow into the rendered manifests",
        )


# Host ports moved off every default, as a second app on the same host would set them in .env.
MOVED_PORTS = {
    "GATEWAY_PORT": "19080",
    "KEYCLOAK_PORT": "19081",
    "API_PORT": "19000",
    "WEB_PORT": "19001",
    "POSTGRES_PORT": "19032",
    "BUCKET_PORT": "19090",
    "BUCKET_CONSOLE_PORT": "19091",
}
CUSTOM_CLIENT_SECRET = "e2e-customised-client-secret"
EXPECTED_PUBLISHED = {
    "gateway": {"19080"},
    "keycloak": {"19081"},
    "api": {"19000"},
    "web": {"19001"},
    "postgres": {"19032"},
    "bucket": {"19090", "19091"},
}


def check_compose_config(app_dir: Path) -> None:
    """Render the dev Compose project with moved ports, the way tools/compose.sh passes .env."""
    root = app_dir / "deploy" / "compose" / "compose.dev.yaml"
    if not root.exists():
        skip("compose config with moved ports (docker-compose not installed)")
        return
    if not run(["docker", "compose", "version"], str(app_dir))[0]:
        skip("compose config with moved ports (docker compose not available)")
        return
    env_file = app_dir / ".e2e-ports.env"
    # Quoted values and inline comments are Compose .env syntax a user may well write.
    env_file.write_text(
        "".join(f'{key}="{value}" # moved\n' for key, value in MOVED_PORTS.items())
        + f"GATEWAY_OIDC_CLIENT_SECRET={CUSTOM_CLIENT_SECRET}\n"
    )
    # Drop inherited values, since a shell variable outranks --env-file: the file must decide.
    inherited = {"COMPOSE_PROJECT_NAME", "GATEWAY_OIDC_CLIENT_SECRET", *MOVED_PORTS}
    try:
        proc = subprocess.run(
            ["docker", "compose", "--env-file", str(env_file), "-f", str(root), "config", "--format", "json"],
            cwd=str(app_dir),
            env={key: value for key, value in os.environ.items() if key not in inherited},
            capture_output=True,
            text=True,
        )
    finally:
        env_file.unlink(missing_ok=True)
    ok, out = proc.returncode == 0, proc.stdout if proc.returncode == 0 else proc.stdout + proc.stderr
    check("compose config renders with moved ports", ok, out[-2000:])
    if not ok:
        return
    project = json.loads(out[out.index("{") :])
    services = project.get("services", {})
    problems: list[str] = []
    if project.get("name") != APP_NAME:
        problems.append(f"project name {project.get('name')!r}, expected {APP_NAME!r}")
    for name, expected in EXPECTED_PUBLISHED.items():
        if name not in services:
            continue
        published = {str(port.get("published")) for port in services[name].get("ports", [])}
        if published != expected:
            problems.append(f"{name} publishes {sorted(published)}, expected {sorted(expected)}")
    for name, service in services.items():
        image = service.get("image", "")
        if image.endswith(":local") and image != f"{APP_NAME}-init:local":
            problems.append(f"{name} image {image!r} is not namespaced by the project")
    if "keycloak" in services:
        if services["keycloak"].get("environment", {}).get("GATEWAY_PORT") != "19080":
            problems.append("keycloak does not receive GATEWAY_PORT for the realm redirect URIs")
        # The gateway authenticates with the .env secret, so the imported client must carry it too.
        for name in ("keycloak", "gateway"):
            secret = services.get(name, {}).get("environment", {}).get("GATEWAY_OIDC_CLIENT_SECRET")
            if secret != CUSTOM_CLIENT_SECRET:
                problems.append(f"{name} GATEWAY_OIDC_CLIENT_SECRET {secret!r} does not follow .env")
        if "api" in services:
            cors = services["api"].get("environment", {}).get("CORS_ORIGIN")
            if cors != "http://localhost:19080":
                problems.append(f"api CORS_ORIGIN {cors!r} does not follow GATEWAY_PORT")
        realm = json.loads((app_dir / "deploy" / "docker" / "keycloak" / "realm.json").read_text())
        if realm.get("realm") != APP_NAME:
            problems.append(f"realm {realm.get('realm')!r} is not named after the app")
        client_secrets = [
            str(client.get("secret")) for client in realm.get("clients", []) if not client.get("publicClient")
        ]
        if not client_secrets or not all(
            secret.startswith("${GATEWAY_OIDC_CLIENT_SECRET_JSON:") for secret in client_secrets
        ):
            problems.append(f"realm client secrets {client_secrets} do not read GATEWAY_OIDC_CLIENT_SECRET_JSON")
    check(
        "two apps can share a host: project, init image, ports, realm follow the app and .env",
        not problems,
        "\n".join(problems),
    )


def check_live_stack(app_dir: Path, enabled: bool) -> None:
    """Optionally boot the generated stack and verify its gateway health endpoint."""
    if not enabled:
        skip("boot + health (pass --boot)")
    elif not run(["docker", "version"], str(app_dir))[0]:
        skip("boot + health (no docker daemon)")
    elif not run(["uv", "--version"], str(app_dir))[0]:
        skip("boot + health (uv not installed)")
    else:
        boot_and_health(app_dir)
