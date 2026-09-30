"""The drain sentinel is one path, spelled independently in two places that never meet.

``charts/api/values.yaml`` writes the file from a ``preStop`` hook; ``health.py`` reads it to
answer ``503 draining``. A mismatch fails silently: readiness keeps answering ``200 ready`` and the
load balancer keeps sending traffic to a dying pod.

This contract ships with the ``helm`` capability because the chart it guards is Helm-owned: a
composition without Helm vendors no chart, so a default ``api + testing`` app must not collect a
test that reads one. It reads the chart at import time.

The other half of the contract — ``api/routers/api/internal/health.py::DRAIN_SENTINEL`` — belongs to
the ``api`` capability, which Helm does not depend on: a Helm-only app ships the chart but no API
to read the sentinel, so there is nothing to keep in agreement. When ``api`` is absent the whole
module skips rather than failing to import, leaving the guard to the compositions that ship both
sides.
"""

import shlex
from pathlib import Path
from typing import Any

import pytest
import yaml

health = pytest.importorskip("api.routers.api.internal.health")
DRAIN_SENTINEL = health.DRAIN_SENTINEL

_REPO_ROOT = Path(__file__).resolve().parent.parent
_API_VALUES = _REPO_ROOT / "deploy/helm/app/charts/api/values.yaml"
_VALUES: dict[str, Any] = yaml.safe_load(_API_VALUES.read_text())


def test_the_prestop_hook_writes_the_path_the_app_reads() -> None:
    # Tokenised, not a substring: `/tmp/drain` is a prefix of `/tmp/draining`, so `in` would wave
    # through exactly the one-character rename this test exists to catch.
    tokens = shlex.split(" ".join(_VALUES["lifecycle"]["preStop"]["exec"]["command"]))

    assert "touch" in tokens
    assert tokens[tokens.index("touch") + 1] == str(DRAIN_SENTINEL)


def test_the_sentinel_lands_on_a_writable_volume() -> None:
    # The container rootfs is read-only, so a sentinel outside a declared tmpfs mount is a path
    # the hook cannot create — the same silent "never drains" failure, one step earlier.
    mounts = [volume["mountPath"] for volume in _VALUES["writableVolumes"]]

    assert any(DRAIN_SENTINEL.is_relative_to(mount) for mount in mounts)
