import asyncio
from pathlib import Path

import pytest
from cli.commands import migrations


class _Ping:
    def __init__(self, results: list[bool]) -> None:
        self._results = iter(results)
        self.timeouts: list[float] = []

    async def __call__(self, timeout_s: float) -> bool:
        self.timeouts.append(timeout_s)
        return next(self._results)


def _set_fast_readiness_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_timeout_seconds", 30)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_successes", 3)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_interval_seconds", 0.5)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_ping_timeout_seconds", 1.25)


def test_database_readiness_requires_consecutive_successes(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_fast_readiness_env(monkeypatch)
    ping = _Ping([True, False, True, True, True])
    sleeps: list[float] = []

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    asyncio.run(migrations._wait_for_database_readiness(ping=ping, sleep=sleep, monotonic=lambda: 0.0))

    assert ping.timeouts == [1.25, 1.25, 1.25, 1.25, 1.25]
    assert sleeps == [0.5, 0.5, 0.5, 0.5]


def test_database_readiness_times_out(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_timeout_seconds", 1)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_successes", 2)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_interval_seconds", 0.4)
    monkeypatch.setattr(migrations.init_env, "init_migrations_db_ready_ping_timeout_seconds", 0.1)
    ping = _Ping([False, False, False])
    clock = iter([0.0, 0.0, 0.5, 1.1])

    async def sleep(_seconds: float) -> None:
        return None

    with pytest.raises(migrations.DatabaseReadinessTimeoutError, match="2 consecutive"):
        asyncio.run(migrations._wait_for_database_readiness(ping=ping, sleep=sleep, monotonic=lambda: next(clock)))


def test_main_waits_for_database_readiness_before_running_alembic(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "alembic.ini").write_text("[alembic]\n", encoding="utf-8")
    order: list[object] = []

    async def wait() -> None:
        order.append("wait")

    def upgrade(_config: object, revision: str) -> None:
        order.append(("upgrade", revision))

    monkeypatch.setattr(migrations, "_wait_for_database_readiness", wait)
    monkeypatch.setattr(migrations, "_db_project_dir", lambda: tmp_path)
    monkeypatch.setattr(migrations.command, "upgrade", upgrade)

    migrations.main()

    assert order == ["wait", ("upgrade", "heads")]


def test_has_no_revisions_is_advisory_and_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(_config: object) -> object:
        raise RuntimeError("script location is missing")

    monkeypatch.setattr(migrations.ScriptDirectory, "from_config", staticmethod(boom))
    assert migrations._has_no_revisions(migrations.Config()) is False

    class _Empty:
        def walk_revisions(self) -> object:
            return iter(())

    monkeypatch.setattr(migrations.ScriptDirectory, "from_config", staticmethod(lambda _c: _Empty()))
    assert migrations._has_no_revisions(migrations.Config()) is True

    class _One:
        def walk_revisions(self) -> object:
            return iter(("0001",))

    monkeypatch.setattr(migrations.ScriptDirectory, "from_config", staticmethod(lambda _c: _One()))
    assert migrations._has_no_revisions(migrations.Config()) is False


def test_main_reports_an_empty_migration_set(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "alembic.ini").write_text("[alembic]\n", encoding="utf-8")
    events: list[str] = []

    async def wait() -> None:
        return None

    monkeypatch.setattr(migrations, "_wait_for_database_readiness", wait)
    monkeypatch.setattr(migrations, "_db_project_dir", lambda: tmp_path)
    monkeypatch.setattr(migrations.command, "upgrade", lambda _config, _revision: None)
    monkeypatch.setattr(migrations, "_has_no_revisions", lambda _config: True)
    monkeypatch.setattr(migrations.logger, "info", lambda event, **_kw: events.append(event))

    migrations.main()

    assert events == ["no_migrations_present"]
