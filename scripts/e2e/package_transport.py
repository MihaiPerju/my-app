"""Exercise npm-package acquisition and compare it with git vendoring."""

from __future__ import annotations

import json
import os
import re
import shutil
import tomllib
from pathlib import Path

from e2e_harness import APP_NAME, REGISTRY_ROOT, check, installed_capability_ids, run
from local_npm_registry import LocalNpmRegistry, rewrite_descriptor_source

PACKAGE_WORKDIR_NAME = "package-transport"
# This reaches both npm manifests and generated Python requirements. Keep it valid npm SemVer AND
# PEP 440; an arbitrary npm-only suffix such as `-e2e` makes the generated pyproject unparseable.
PACKAGE_VERSION = "0.0.0-rc0"
GENERATED_SURFACE_SKIP_DIRS = {".git", ".mistral", ".nx", ".venv", "node_modules"}
# The CLI deliberately rewrites package dependency specs, registry configuration, and resolved
# locks for the acquisition transport. npm also strips package-root `README.md`/`AGENTS.md`; core no
# longer owns either generated document, so a stale git-rendered `AGENTS.md` is transport metadata.
# Their existence may differ; only source paths are compared strictly.
TRANSPORT_SPECIFIC_CONTENT = {
    ".vscode/settings.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "pyproject.toml",
}
TRANSPORT_SPECIFIC_PATHS = {"apps/web/.env", "AGENTS.md", "uv.lock"}


def package_app_path(workdir: Path) -> Path:
    """Keep both transports' project name equal so their rendered templates are comparable."""
    return workdir / PACKAGE_WORKDIR_NAME / APP_NAME


def kept_app_path(workdir: Path, *, packages_only: bool) -> Path:
    """Return the generated app that a retained E2E run should report."""
    return package_app_path(workdir) if packages_only else workdir / APP_NAME


def generated_source_files(root: Path) -> dict[str, bytes]:
    """Return generated source files, excluding acquisition/install implementation details."""
    files: dict[str, bytes] = {}
    for directory, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            name for name in dirnames if name not in GENERATED_SURFACE_SKIP_DIRS
        ]
        for filename in filenames:
            path = Path(directory, filename)
            files[path.relative_to(root).as_posix()] = path.read_bytes()
    return files


def comparable_content(path: str, content: bytes, *, shared_env_keys: set[bytes]) -> bytes:
    """Normalize dotenv order and compare only declarations both transports can install."""
    if path != ".env":
        return content
    values = {
        line.split(b"=", 1)[0]: line
        for line in content.splitlines()
        if b"=" in line and line.split(b"=", 1)[0] in shared_env_keys
    }
    return b"\n".join(values[key] for key in sorted(values))


def check_package_transport_equivalence(package_app: Path, git_app: Path) -> None:
    """Prove npm packaging produced the same application source surface as git vendoring."""
    package_files = generated_source_files(package_app)
    git_files = generated_source_files(git_app)
    shared_env_keys: set[bytes] = set()
    if ".env" in package_files and ".env" in git_files:
        package_env_keys = {
            line.split(b"=", 1)[0] for line in package_files[".env"].splitlines() if b"=" in line
        }
        git_env_keys = {
            line.split(b"=", 1)[0] for line in git_files[".env"].splitlines() if b"=" in line
        }
        shared_env_keys = package_env_keys & git_env_keys
    package_paths = set(package_files) - TRANSPORT_SPECIFIC_PATHS
    git_paths = set(git_files) - TRANSPORT_SPECIFIC_PATHS
    missing = sorted(git_paths - package_paths)
    unexpected = sorted(package_paths - git_paths)
    check(
        "package transport: complete generated file surface matches git transport",
        not missing and not unexpected,
        f"missing from package app: {missing}\nunexpected in package app: {unexpected}",
    )

    mismatched = sorted(
        path
        for path in package_paths & git_paths
        if path not in TRANSPORT_SPECIFIC_CONTENT
        and comparable_content(path, package_files[path], shared_env_keys=shared_env_keys)
        != comparable_content(path, git_files[path], shared_env_keys=shared_env_keys)
    )
    check(
        "package transport: generated template contents match git transport",
        not mismatched,
        "content differs:\n" + "\n".join(f"  {path}" for path in mismatched),
    )


def check_package_generated_app(
    cli: str, workdir: Path, selected: list[str], expected: list[str]
) -> None:
    """Build release artifacts and generate from every ordinary capability root."""
    source_root = workdir / "package-source"
    shutil.copytree(
        REGISTRY_ROOT,
        source_root,
        ignore=shutil.ignore_patterns(
            ".git", ".omo", ".nx", ".venv", "dist", "node_modules", "__pycache__"
        ),
    )
    npm_cache = workdir / "npm-cache"

    with LocalNpmRegistry() as registry:
        prepared, prepare_out = run(
            ["bun", "scripts/release/prepare-publish.ts", PACKAGE_VERSION],
            str(source_root),
        )
        check(
            "package transport: prepare publish artifacts",
            prepared,
            prepare_out[-3000:],
        )
        if not prepared:
            return

        packed, pack_out = run(
            ["bun", "scripts/release/pack-all.ts", PACKAGE_VERSION],
            str(source_root),
            {"npm_config_cache": str(npm_cache)},
        )
        check("package transport: pack every capability", packed, pack_out[-3000:])
        if not packed:
            return

        plan_path = source_root / "dist" / "npm" / "publish-plan.json"
        plan = json.loads(plan_path.read_text())
        # The default index's variants (DEFAULT_PACKAGE_REGISTRY), whose pull token the runner holds.
        plan_entries = [
            entry for entry in plan if entry.get("registry") in (None, "cloudsmith")
        ]
        descriptor = next(
            entry
            for entry in plan_entries
            if entry["name"] == "@mistralai-capabilities/registry"
        )
        rewrite_descriptor_source(
            source_root / "dist" / "npm" / descriptor["tarball"],
            registry.url,
            f"git+file://{REGISTRY_ROOT}",
        )
        for entry in plan_entries:
            registry.add(source_root / "dist" / "npm" / entry["tarball"])

        package_workdir = workdir / PACKAGE_WORKDIR_NAME
        package_workdir.mkdir()
        app_dir = package_app_path(workdir)
        generated, generation_out = run(
            [
                cli,
                "apps",
                "init",
                APP_NAME,
                "--source",
                "npm",
                "--registry-url",
                registry.url,
                "--registry-package",
                "@mistralai-capabilities/registry",
                "--caps",
                ",".join(selected),
            ],
            str(package_workdir),
            {
                "BUN_INSTALL_CACHE_DIR": str(workdir / "bun-cache"),
                "npm_config_cache": str(npm_cache),
            },
        )
        check(
            "package transport: mistral apps init --source npm",
            generated,
            generation_out[-5000:],
        )
        if not generated:
            return

        installed = installed_capability_ids(app_dir)
        check(
            f"package transport: all {len(expected)} capabilities installed",
            installed == expected,
            f"selected {selected}\nexpected {expected}\ninstalled {installed}",
        )
        check(
            "package transport: stripped .npmrc is restored from its .hbs carrier",
            (app_dir / ".npmrc").is_file(),
        )
        check(
            "package transport: no git registry subtree was used",
            not (app_dir / ".mistral" / "repositories").exists(),
        )
        dependencies = json.loads((app_dir / "package.json").read_text()).get(
            "dependencies", {}
        )
        source_descriptor = json.loads((REGISTRY_ROOT / "registry.json").read_text())
        expected_dependencies = {
            f"@{source_descriptor['id']}/{capability['kind']}-{capability['id']}"
            for capability in source_descriptor["capabilities"]
            if "ts" in capability["packages"]
        }
        actual_dependencies = {
            name for name in dependencies if name.startswith("@mistralai-capabilities/")
        }
        check(
            "package transport: root npm manifest wires only declared TS capabilities",
            actual_dependencies == expected_dependencies,
            f"expected {sorted(expected_dependencies)}\nactual {sorted(actual_dependencies)}",
        )
        python_manifest = tomllib.loads((app_dir / "pyproject.toml").read_text())
        expected_python = {
            re.sub(
                r"[-_.]+",
                "-",
                f"{source_descriptor['id']}-{capability['kind']}-{capability['id']}".lower(),
            )
            for capability in source_descriptor["capabilities"]
            if "py" in capability["packages"]
        }
        actual_python = {
            re.split(r"[\s\[<>=!~;@]", requirement, maxsplit=1)[0]
            for requirement in python_manifest["project"]["dependencies"]
            if requirement.startswith("mistralai-capabilities-")
        }
        check(
            "package transport: root Python manifest wires all declared Python capabilities",
            actual_python == expected_python,
            f"expected {sorted(expected_python)}\nactual {sorted(actual_python)}",
        )
