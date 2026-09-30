"""Behavioral tests for the docker-compose NX targets and their backing ``tools/compose.sh``.

The invoke task module became ``tools/compose.sh`` (subcommand dispatch) plus a ``compose`` NX
project (``tasks/compose/project.json``). These pin the same contracts the pre-migration monolith
did: the public target surface — the migration must not rename ``up``/``down``/``smoke``/…, and the
Docker image build is now ``build-images`` (a bare ``build`` would collide with the inferred TS
build) — and that ``init`` runs precisely the steps the shipped ``compose.init.yaml`` declares. The
step discovery is exercised through the real shell (``init-steps``) in a synthetic tree, so the test
drives the code the app actually runs — not a reimplementation of it.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
COMPOSE_SH = REPO / "tools" / "compose.sh"
PROJECT = json.loads((REPO / "tasks" / "compose" / "project.json").read_text())
BASH = shutil.which("bash") or "/bin/bash"

# The public target names this capability owns. Every name is unchanged from the invoke module
# except the Docker image build, which is `build-images` here.
EXPECTED_TARGETS = {"up", "down", "dev", "dev-down", "build-images", "logs", "smoke", "init"}


def test_project_exposes_exactly_its_compose_targets() -> None:
    assert set(PROJECT["targets"]) == EXPECTED_TARGETS
    for target in PROJECT["targets"].values():
        assert target["executor"] == "nx:run-commands"
        assert "tools/compose.sh" in target["options"]["command"]


def test_init_steps_reads_the_compose_init_root_in_order(tmp_path) -> None:
    # `init` derives its step list from the `init-<step>` services the rendered compose.init.yaml
    # declares, in file (dependency) order; the trailing `init` aggregator carries no suffix and is
    # excluded. `init-steps` prints that list and runs nothing, so we can assert it directly.
    init_root = tmp_path / "deploy" / "compose" / "compose.init.yaml"
    init_root.parent.mkdir(parents=True)
    init_root.write_text(
        "name: app\n"
        "services:\n"
        "  init-migrations:\n"
        '    command: ["sh", "-c", "python -m cli migrations"]\n'
        "  init-guardrail:\n"
        '    command: ["sh", "-c", "python -m cli guardrail"]\n'
        "  init:\n"  # the aggregator barrier: no `init-` suffix, so it is not a step
        '    command: ["true"]\n'
    )
    result = subprocess.run(
        [BASH, str(COMPOSE_SH), "init-steps"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.split() == ["migrations", "guardrail"]


# A stand-in `docker`: records each argv (NUL-separated, one call per line), lists one image for
# `compose config --images`, reports that image's ID from `image-id`, and on `compose build` writes
# a new ID when REBUILD is set, as a build that changed the image would.
_FAKE_DOCKER = """#!{bash}
printf '%s\\0' "$@" >> calls
printf '\\n' >> calls
case " $* " in
  *" config --images "*) echo app-image ;;
  *" image inspect "*) cat image-id ;;
  *" build "*) if [ -n "${{REBUILD:-}}" ]; then echo sha256:new > image-id; fi ;;
esac
"""


def _compose_calls(tmp_path: Path, *args: str, dotenv: bool, rebuild: bool = False) -> list[list[str]]:
    """Run ``compose.sh`` against a fake ``docker``; return the argv of each lifecycle call."""
    fake = tmp_path / "bin" / "docker"
    fake.parent.mkdir()
    fake.write_text(_FAKE_DOCKER.format(bash=BASH))
    fake.chmod(0o755)
    (tmp_path / "image-id").write_text("sha256:old\n")
    if dotenv:
        (tmp_path / ".env").write_text("GATEWAY_PORT=19080\n")
    env = {"PATH": f"{fake.parent}:/usr/bin:/bin", "HOME": str(tmp_path)}
    if rebuild:
        env["REBUILD"] = "1"
    subprocess.run(
        [BASH, str(COMPOSE_SH), *args],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    calls = [line.strip("\0").split("\0") for line in (tmp_path / "calls").read_text().splitlines() if line]
    # The image probes around a dev build are bookkeeping, not lifecycle calls.
    return [call for call in calls if call[:2] != ["image", "inspect"] and call[-2:] != ["config", "--images"]]


def test_compose_reads_the_root_env_file(tmp_path) -> None:
    # Compose's project directory is deploy/compose, so without --env-file it never reads the root
    # .env and every port or project name set there is silently ignored.
    for sub in ("up", "down", "dev", "dev-down", "build-images", "logs"):
        run_dir = tmp_path / sub
        run_dir.mkdir()
        for call in _compose_calls(run_dir, sub, dotenv=True):
            assert call[:3] == ["compose", "--env-file", ".env"], (sub, call)


def test_compose_without_a_root_env_file_passes_none(tmp_path) -> None:
    [call] = _compose_calls(tmp_path, "up", dotenv=False)
    assert call == [
        "compose",
        "-f",
        "deploy/compose/compose.yaml",
        "up",
        "-d",
        "--build",
    ]


def test_dev_renews_dependency_volumes_only_after_a_rebuild(tmp_path) -> None:
    # A rebuilt dev image must not inherit the previous container's /app/.venv or node_modules
    # anonymous volume, or its new dependencies never arrive. When nothing was rebuilt, keep the
    # containers: renewing recreates every one of them.
    unchanged, rebuilt = tmp_path / "unchanged", tmp_path / "rebuilt"
    unchanged.mkdir()
    rebuilt.mkdir()

    build, up = _compose_calls(unchanged, "dev", dotenv=True)
    assert build[-1] == "build"
    assert up[-1] == "up"

    build, up = _compose_calls(rebuilt, "dev", dotenv=True, rebuild=True)
    assert up[-2:] == ["up", "--renew-anon-volumes"]


def test_dev_never_removes_orphans_unless_asked(tmp_path) -> None:
    # --remove-orphans deletes any container of the project this selection does not declare, so
    # it is opt-in. Extra arguments reach `docker compose`.
    default, asked = tmp_path / "default", tmp_path / "asked"
    default.mkdir()
    asked.mkdir()
    assert not any("--remove-orphans" in call for call in _compose_calls(default, "dev", dotenv=True))
    assert _compose_calls(asked, "dev", "--remove-orphans", dotenv=True)[-1][-1] == "--remove-orphans"


def test_env_asks_compose_for_its_interpolation_environment(tmp_path) -> None:
    # smoke.sh reads its ports from here, so it must be Compose's own view: the root .env through
    # --env-file, against the same runtime root as every other target.
    [call] = _compose_calls(tmp_path, "env", dotenv=True)
    assert call == [
        "compose",
        "--env-file",
        ".env",
        "-f",
        "deploy/compose/compose.yaml",
        "config",
        "--environment",
    ]


def _has_docker_compose() -> bool:
    if not shutil.which("docker"):
        return False
    probe = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True)
    return probe.returncode == 0


@pytest.mark.skipif(not _has_docker_compose(), reason="needs the docker compose CLI (no daemon)")
def test_env_parses_the_root_env_by_compose_rules(tmp_path) -> None:
    # Quotes, inline comments and `export` are Compose .env syntax. A hand-rolled `sed` read of .env
    # turned `API_PORT="13000"` into `"13000"` and kept `# moved` in the value, so smoke probed a
    # port Compose never published. The shell still outranks the file, as it does for Compose.
    root = tmp_path / "deploy" / "compose" / "compose.yaml"
    root.parent.mkdir(parents=True)
    root.write_text('services:\n  probe:\n    image: busybox\n    ports: ["${API_PORT:-3000}:80"]\n')
    (tmp_path / ".env").write_text(
        'API_PORT="13000" # moved\n'
        "WEB_PORT=13001 # moved\n"
        "export GATEWAY_PORT='19080'\n"
        "GATEWAY_OIDC_CLIENT_SECRET=s3cret#not-a-comment\n"
    )
    env = {key: value for key, value in os.environ.items() if not key.endswith("_PORT")}
    env.pop("GATEWAY_OIDC_CLIENT_SECRET", None)
    env["WEB_PORT"] = "23001"
    result = subprocess.run(
        [BASH, str(COMPOSE_SH), "env"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    assert values["API_PORT"] == "13000"
    assert values["WEB_PORT"] == "23001"
    assert values["GATEWAY_PORT"] == "19080"
    assert values["GATEWAY_OIDC_CLIENT_SECRET"] == "s3cret#not-a-comment"


SMOKE_SH = REPO / "tools" / "smoke.sh"

# A stand-in `docker` for smoke.sh: Compose's environment is the canned one below, and every other
# call fails, so the preflight stops the run before it builds or starts anything.
_FAKE_SMOKE_DOCKER = """#!{bash}
case " $* " in
  *" config --environment "*) printf 'API_PORT=13000\\nWEB_PORT=13001\\nGATEWAY_PORT=19080\\n' ;;
  *) exit 1 ;;
esac
"""


def test_smoke_probes_the_ports_compose_reports(tmp_path) -> None:
    fake = tmp_path / "docker"
    fake.write_text(_FAKE_SMOKE_DOCKER.format(bash=BASH))
    fake.chmod(0o755)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin", "HOME": str(tmp_path), "KEEP_UP": "1"}
    result = subprocess.run([BASH, str(SMOKE_SH)], env=env, capture_output=True, text=True)
    assert result.returncode != 0  # the fake fails the preflight on purpose
    assert "Ports: API=13000 WEB=13001" in result.stdout, result.stdout + result.stderr
    if "GATEWAY=" in result.stdout:
        assert "GATEWAY=19080" in result.stdout
