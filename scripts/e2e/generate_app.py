#!/usr/bin/env python3
"""Generate full and minimal applications and check their composed surfaces.

This is the stable entry point for the generated-app E2E. Focused checks live beside it in
``package_transport.py``, ``generated_app_checks.py``, and ``runtime_checks.py``; process execution,
result collection, and environment classification live in ``e2e_harness.py``.

The suite exercises both locally packed npm artifacts and git vendoring from the committed branch,
so a dirty tree is refused (``--allow-dirty`` overrides). Exit codes: 0 pass, 1 an assertion failed,
75 the environment failed. CI treats 75 as a required-check failure while retaining the distinct
code for local diagnosis.
"""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from e2e_harness import (
    APP_NAME,
    INFRA,
    REGISTRY_ROOT,
    capability_roots,
    check,
    finish,
    infra_exit,
    selection_root_capability_ids,
    installed_capability_ids,
    run,
    skip,
    uv_index_env,
)
from generated_app_checks import (
    check_capability_removal,
    check_chat_only_generated_app,
    check_clean_scaffold_gates,
    check_minimal_generated_app,
    run_capability_package_tests,
)
from fastapi_hook_matrix import check_fastapi_hook_selections
from package_transport import (
    check_package_generated_app,
    check_package_transport_equivalence,
    kept_app_path,
    package_app_path,
)
from runtime_checks import (
    check_compose_config,
    check_docker_builds,
    check_helm_chart,
    check_live_stack,
)

SENTINEL = re.compile(r"__[A-Z][A-Z0-9_]*__")
SKILL_REFERENCE = re.compile(r"(^|/)\.agents/skills/[^/]+/references/")
BINARY = re.compile(r"\.(png|jpg|jpeg|gif|ico|woff2?|ttf|lock|webp)$", re.IGNORECASE)


def walk_text_files(root: Path) -> list[Path]:
    """Return generated files while excluding installed and build-only trees."""
    skip_dirs = {"node_modules", ".git", ".mistral", ".venv", "dist"}
    out: list[Path] = []
    for path in root.rglob("*"):
        if any(part in skip_dirs for part in path.relative_to(root).parts):
            continue
        if path.is_file():
            out.append(path)
    return out


def main() -> None:
    keep = "--keep" in sys.argv
    with_docker = "--docker" in sys.argv
    with_boot = "--boot" in sys.argv
    allow_dirty = "--allow-dirty" in sys.argv
    package_only = "--package-only" in sys.argv
    python_only = "--python-only" in sys.argv

    cli = os.environ.get("MISTRAL_CLI", "mistral")
    if not run([cli, "--version"], str(REGISTRY_ROOT))[0]:
        infra_exit(f"`{cli}` is not runnable. Install the CLI or set MISTRAL_CLI.")

    dirty = run(["git", "status", "--porcelain"], str(REGISTRY_ROOT))[1].strip()
    if dirty and not allow_dirty:
        print("Refusing to run against a dirty tree.\n", file=sys.stderr)
        print(
            "The CLI vendors the COMMITTED branch, so these files would NOT be tested:\n",
            file=sys.stderr,
        )
        print(dirty, file=sys.stderr)
        print(
            "\nCommit them first (no push needed), or pass --allow-dirty to test HEAD anyway.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    workdir = Path(tempfile.mkdtemp(prefix="capability-e2e-"))
    app_dir = workdir / APP_NAME
    head = run(["git", "rev-parse", "--short", "HEAD"], str(REGISTRY_ROOT))[1].strip()
    print(f"registry {head} -> {app_dir}\n")

    try:
        declared = sorted(capability_roots())
        selected = selection_root_capability_ids()
        check_package_generated_app(cli, workdir, selected, declared)
        if package_only:
            raise SystemExit

        generated, generation_out = run(
            [
                cli,
                "apps",
                "init",
                APP_NAME,
                "--registry-url",
                str(REGISTRY_ROOT),
                "--source",
                "git",
                "--caps",
                ",".join(selected),
            ],
            str(workdir),
        )
        if not generated:
            if INFRA.search(generation_out):
                infra_exit(
                    f"generation could not reach a registry:\n{generation_out[-1500:]}"
                )
            check("mistral apps init --caps <all roots>", False, generation_out[-3000:])
            raise SystemExit  # nothing further can be checked
        check("mistral apps init --caps <all roots>", True)

        installed = installed_capability_ids(app_dir)
        check(
            f"all {len(declared)} capabilities installed",
            installed == declared,
            f"declared {declared}\ninstalled {installed}",
        )
        check_package_transport_equivalence(package_app_path(workdir), app_dir)

        # The private-scope mapping every later `bun install` depends on. npm strips a literal
        # `.npmrc` from package tarballs, so mistral-design-system ships a `.hbs` carrier.
        check(
            ".npmrc installed (private scopes resolvable)",
            (app_dir / ".npmrc").exists(),
            "no .npmrc in the generated app -- "
            "mistral-design-system/template/.npmrc.hbs was not installed",
        )

        files = walk_text_files(app_dir)
        text_files = [path for path in files if not BINARY.search(path.name)]

        # Skill references are prose that can quote upstream placeholder constants; they are not
        # files the CLI substitutes into.
        sentinels = [
            path
            for path in text_files
            if SKILL_REFERENCE.search(path.relative_to(app_dir).as_posix()) is None
            and SENTINEL.search(path.read_text(errors="replace"))
        ]
        check(
            "no unsubstituted __TOKEN__ sentinel",
            not sentinels,
            "\n".join(f"  {path.relative_to(app_dir)}" for path in sentinels),
        )

        unrendered = [path for path in files if path.suffix == ".hbs"]
        check(
            "no unrendered .hbs",
            not unrendered,
            "\n".join(f"  {path.relative_to(app_dir)}" for path in unrendered),
        )

        for expected in ("package.json", "pyproject.toml"):
            check(f"ships {expected}", (app_dir / expected).exists())

        if python_only:
            # Python-only mode: skip all JS/web/docker/helm checks, only do uv + Python tests
            installed_js = False
        else:
            installed_js, install_out = run(["bun", "install"], str(app_dir))
            if not installed_js and INFRA.search(install_out):
                infra_exit(
                    f"bun install could not reach the registry:\n{install_out[-1500:]}"
                )
            check("bun install", installed_js, install_out[-2000:])
            if installed_js:
                # Type-checking needs src/routeTree.gen.ts, which the web build generates.
                build_ok, build_out = run(["bunx", "nx", "run", "web:build"], str(app_dir))
                check("nx run web:build", build_ok, build_out[-2000:])
                if build_ok:
                    built_css = "".join(
                        path.read_text(encoding="utf-8", errors="ignore")
                        for path in (app_dir / "apps" / "web" / ".output").rglob("*.css")
                    )
                    check(
                        "web build emits @mistralai/ui design-system CSS (--sidebar-width)",
                        "--sidebar-width" in built_css,
                        "Tailwind emitted no @mistralai/ui utilities: the design-system stylesheet was "
                        "not injected into src/index.css, or its @source did not resolve the package "
                        "for this bun layout, so the app-shell sidebar renders at width 0 (see "
                        "capabilities/feature/mistral-design-system/template/apps/web/vite-plugins/).",
                    )
                    tree = (app_dir / "apps" / "web" / "src" / "routeTree.gen.ts").read_text()
                    check(
                        "the design system ships a not-found page, not a page of its own",
                        "'/$'" in tree and "'/design-system'" not in tree,
                        "routeTree.gen.ts should route unknown URLs to the shell's not-found page "
                        "(routes/_app/$.tsx) and have no /design-system page",
                    )
                quality_ok, quality_out = run(
                    ["bunx", "nx", "run", "quality:check-ts"], str(app_dir)
                )
                check("nx run quality:check-ts", quality_ok, quality_out[-2000:])
                # Only the JS web tests run here; uv is not synced yet, so nx runs web:test alone.
                web_test_ok, web_test_out = run(
                    ["bunx", "nx", "run", "web:test"], str(app_dir)
                )
                check("nx run web:test", web_test_ok, web_test_out[-2000:])

        # The generated app ships no uv.lock, so this resolves from scratch against its indexes.
        uv_env = uv_index_env()
        if not run(["uv", "--version"], str(app_dir))[0]:
            skip("uv lock / sync / nx targets (uv not installed)")
        else:
            lock_ok, lock_out = run(["uv", "lock"], str(app_dir), uv_env)
            if not lock_ok and INFRA.search(lock_out):
                infra_exit(
                    f"uv lock could not resolve the workspace:\n{lock_out[-1500:]}"
                )
            check("uv lock", lock_ok, lock_out[-2000:])

            sync_ok, sync_out = run(
                ["uv", "sync", "--all-packages"], str(app_dir), uv_env
            )
            if not sync_ok and INFRA.search(sync_out):
                infra_exit(f"uv sync could not reach the index:\n{sync_out[-1500:]}")
            check("uv sync --all-packages", sync_ok, sync_out[-2000:])

            if sync_ok:
                # `gen-types-check` catches schema changes whose generated OpenAPI/client artifacts
                # were not regenerated before the capability was shipped.
                if python_only:
                    # Run Python test targets directly via uv to avoid downloading Nx in python-only mode
                    # testing:test runs: bash tools/uv.sh run --no-sync pytest
                    # agents:test runs: bash tools/uv.sh run --no-sync pytest apps/worker/tests/agents
                    task_ok, task_out = run(
                        ["uv", "run", "--no-sync", "pytest"], str(app_dir), uv_env
                    )
                    check("pytest (testing:test equivalent)", task_ok, task_out[-2000:])
                    task_ok, task_out = run(
                        ["uv", "run", "--no-sync", "pytest", "apps/worker/tests/agents"],
                        str(app_dir),
                        uv_env,
                    )
                    check("pytest apps/worker/tests/agents (agents:test equivalent)", task_ok, task_out[-2000:])
                else:
                    nx_targets = (
                        "quality:lint",
                        "quality:fmt-check",
                        "quality:typecheck",
                        "testing:test",
                        "agents:test",
                        "agents:typecheck",
                        "fastapi-tanstack-start:gen-types-check",
                    )
                    for target in nx_targets:
                        task_ok, task_out = run(
                            ["bunx", "nx", "run", target], str(app_dir), uv_env
                        )
                        check(f"nx run {target}", task_ok, task_out[-2000:])
                    check_clean_scaffold_gates(app_dir, uv_env)

                run_capability_package_tests(app_dir, uv_env)

        if not python_only:
            check_minimal_generated_app(cli, workdir, uv_env)
            check_chat_only_generated_app(cli, workdir, uv_env)
            check_fastapi_hook_selections(cli, workdir, uv_env)
            check_docker_builds(app_dir, with_docker)
            check_helm_chart(app_dir)
            check_compose_config(app_dir)
            check_live_stack(app_dir, with_boot)
            # Last: this removes docker-compose and deletes its Compose output, so it must run after the
            # docker/helm/boot checks that read the full app.
            check_capability_removal(cli, app_dir)
    except SystemExit as error:
        if error.code not in (None, 0):
            raise
    finally:
        if keep:
            print(f"\nkept {kept_app_path(workdir, packages_only=package_only)}")
        else:
            shutil.rmtree(workdir, ignore_errors=True)

    finish()


if __name__ == "__main__":
    main()
