"""The vendor-to-contract mappers.

Each test pins one shape the platform can send that our published schema does not describe, and
the answer we give the caller instead.
"""

import logging

import pytest
from mistralai_capabilities.fastapi_workflows_auth.schemas import _status


def test_a_documented_status_passes_through() -> None:
    assert _status("RUNNING") == "RUNNING"


def test_a_status_the_platform_never_sent_stays_absent() -> None:
    """Absent and unrecognised are different answers; only one of them is a drift signal."""
    assert _status(None) is None


def test_a_non_string_is_absent_rather_than_UNKNOWN() -> None:
    """Speakeasy's `Unset` sentinel arrives as an object, and it means 'omitted', not 'strange'."""
    assert _status(object()) is None


def test_an_unrecognised_status_becomes_UNKNOWN_rather_than_failing_validation(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Closing the literal is what would otherwise turn a new platform state into a 500."""
    with caplog.at_level(logging.WARNING, logger="mistralai_capabilities.fastapi_workflows_auth.schemas"):
        assert _status("PAUSED_BY_ADMIN") == "UNKNOWN"

    assert "PAUSED_BY_ADMIN" in caplog.text


def test_UNKNOWN_on_the_wire_is_left_alone() -> None:
    """It is in the published set, so it round-trips without being treated as drift."""
    assert _status("UNKNOWN") == "UNKNOWN"
