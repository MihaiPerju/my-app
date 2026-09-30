import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from mistralai_capabilities.fastapi.hooks import FastAPIHookDiscoveryError, FastAPIHooks


def _forget(prefix: str) -> None:
    for name in [
        name for name in sys.modules if name == prefix or name.startswith(f"{prefix}.")
    ]:
        del sys.modules[name]


def _package(root: Path, dotted: str) -> Path:
    path = root
    for part in dotted.split("."):
        path /= part
        path.mkdir(exist_ok=True)
        (path / "__init__.py").write_text("")
    return path


def test_missing_and_empty_catalogs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(tmp_path))
    hooks = FastAPIHooks.discover("missing_hooks")
    assert hooks.configure_hooks == ()
    _package(tmp_path, "empty_hooks.configure")
    assert FastAPIHooks.discover("empty_hooks").configure_hooks == ()
    _forget("empty_hooks")


def test_discovery_is_lexical_ignores_private_and_caches_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    configure = _package(tmp_path, "sample.configure")
    (configure / "z.py").write_text("def configure(app): app.state.order.append('z')\n")
    (configure / "a.py").write_text("def configure(app): app.state.order.append('a')\n")
    (configure / "_private.py").write_text("raise RuntimeError('must not import')\n")
    metadata = _package(tmp_path, "sample.health.metadata")
    (metadata / "deployment.py").write_text(
        "calls = 0\ndef metadata():\n    global calls\n    calls += 1\n    return f'value-{calls}'\n"
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    hooks = FastAPIHooks.discover("sample")
    app = FastAPI()
    app.state.order = []
    hooks.configure(app)
    assert app.state.order == ["a", "z"]
    assert hooks.metadata_values == {"deployment": "value-1"}
    assert FastAPIHooks.compose(hooks).metadata_values == {"deployment": "value-1"}
    with pytest.raises(TypeError):
        hooks.metadata_values["x"] = "y"  # type: ignore[index]
    _forget("sample")


@pytest.mark.parametrize(
    "source,match",
    [("VALUE = 1\n", "does not declare"), ("configure = 1\n", "not callable")],
)
def test_malformed_declarations_fail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str, match: str
) -> None:
    configure = _package(tmp_path, "bad.configure")
    (configure / "broken.py").write_text(source)
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(FastAPIHookDiscoveryError, match=match):
        FastAPIHooks.discover("bad")
    _forget("bad")


def test_non_package_and_import_failure_are_wrapped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _package(tmp_path, "broken")
    (root / "configure.py").write_text("")
    monkeypatch.syspath_prepend(str(tmp_path))
    with pytest.raises(FastAPIHookDiscoveryError, match="module, not a package"):
        FastAPIHooks.discover("broken")
    _forget("broken")
    configure = _package(tmp_path, "explodes.configure")
    (configure / "bad.py").write_text("raise ValueError('boom')\n")
    with pytest.raises(FastAPIHookDiscoveryError, match="could not be imported: boom"):
        FastAPIHooks.discover("explodes")
    _forget("explodes")


def test_package_inspection_failures_are_wrapped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(_package: str) -> None:
        raise RuntimeError("broken package initializer")

    monkeypatch.setattr(
        "mistralai_capabilities.fastapi.hooks.importlib.util.find_spec", fail
    )

    with pytest.raises(
        FastAPIHookDiscoveryError, match="could not be inspected"
    ) as caught:
        FastAPIHooks.discover("broken")

    assert isinstance(caught.value.__cause__, RuntimeError)


@pytest.mark.parametrize("argument", ["report_checks", "readiness_checks"])
def test_duplicate_probe_names_are_rejected(argument: str) -> None:
    async def check() -> bool:
        return True

    with pytest.raises(FastAPIHookDiscoveryError, match="duplicate"):
        FastAPIHooks(**{argument: (("same", check), ("same", check))})


def test_duplicate_metadata_names_are_rejected_by_compose() -> None:
    with pytest.raises(FastAPIHookDiscoveryError, match="duplicate metadata"):
        FastAPIHooks.compose(
            FastAPIHooks(metadata_values={"same": "a"}),
            FastAPIHooks(metadata_values={"same": "b"}),
        )


def test_configure_is_once_and_fail_fast() -> None:
    order: list[str] = []

    def fail(_app: FastAPI) -> None:
        order.append("a")
        raise RuntimeError("stop")

    def later(_app: FastAPI) -> None:
        order.append("b")

    hooks = FastAPIHooks(configure_hooks=(("b", later), ("a", fail)))
    app = FastAPI()
    with pytest.raises(RuntimeError, match="stop"):
        hooks.configure(app)
    assert order == ["a"]
    with pytest.raises(FastAPIHookDiscoveryError, match="already ran"):
        hooks.configure(app)
    with pytest.raises(FastAPIHookDiscoveryError, match="already ran"):
        hooks.configure(FastAPI())


@pytest.mark.asyncio
async def test_startup_is_once_and_shutdown_runs_reverse_after_partial_failure() -> (
    None
):
    order: list[str] = []

    async def start_a(_app: FastAPI) -> None:
        order.append("start-a")

    async def start_b(_app: FastAPI) -> None:
        raise RuntimeError("startup")

    async def stop_a(_app: FastAPI) -> None:
        order.append("stop-a")
        raise ValueError("a")

    async def stop_b(_app: FastAPI) -> None:
        order.append("stop-b")
        raise KeyError("b")

    hooks = FastAPIHooks(
        startup_hooks=(("b", start_b), ("a", start_a)),
        shutdown_hooks=(("a", stop_a), ("b", stop_b)),
    )
    app = FastAPI()
    hooks.configure(app)
    with pytest.raises(RuntimeError, match="startup"):
        await hooks.startup(app)
    with pytest.raises(FastAPIHookDiscoveryError, match="already attempted"):
        await hooks.startup(app)
    with pytest.raises(ExceptionGroup) as caught:
        await hooks.shutdown(app)
    assert order == ["start-a", "stop-b", "stop-a"]
    assert [type(error) for error in caught.value.exceptions] == [KeyError, ValueError]
    with pytest.raises(FastAPIHookDiscoveryError, match="already ran"):
        await hooks.shutdown(app)


@pytest.mark.asyncio
async def test_lifecycle_rejects_unconfigured_and_cross_app_calls() -> None:
    hooks = FastAPIHooks.empty()
    app = FastAPI()
    with pytest.raises(FastAPIHookDiscoveryError, match="have not run"):
        await hooks.startup(app)
    hooks.configure(app)
    with pytest.raises(FastAPIHookDiscoveryError, match="different app"):
        await hooks.startup(FastAPI())
    with pytest.raises(FastAPIHookDiscoveryError, match="startup attempt"):
        await hooks.shutdown(app)


@pytest.mark.asyncio
async def test_probe_failures_are_false_and_catalogs_are_separate(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def yes() -> bool:
        return True

    async def fail() -> bool:
        raise RuntimeError("probe")

    hooks = FastAPIHooks(
        report_checks=(("report", fail),), readiness_checks=(("ready", yes),)
    )
    assert await hooks.report() == {"report": False}
    assert await hooks.ready() == {"ready": True}
    assert "probe" in caplog.text


@pytest.mark.asyncio
async def test_probes_run_concurrently_and_preserve_catalog_order() -> None:
    started = 0
    both_started = asyncio.Event()

    async def probe(result: bool) -> bool:
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await both_started.wait()
        return result

    hooks = FastAPIHooks(
        report_checks=(("z", lambda: probe(False)), ("a", lambda: probe(True)))
    )

    assert await asyncio.wait_for(hooks.report(), timeout=1) == {"a": True, "z": False}
