"""Shared ``BaseSettings`` base for the per-service ``env`` modules.

Loads the repo-root ``.env`` (non-overriding, so real process env wins) and applies it to every
settings class in this package. The ``env`` package is a leaf that needs only ``pydantic-settings``
and ``python-dotenv``.
"""

from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "package.json").is_file() and (parent / "pyproject.toml").is_file():
            return parent
    return Path.cwd()


_ROOT_ENV_PATH = _find_repo_root() / ".env"

load_dotenv(dotenv_path=_ROOT_ENV_PATH, override=False)


class BaseEnv(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(_ROOT_ENV_PATH),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    @model_validator(mode="before")
    @classmethod
    def _blank_is_unset(cls, values: Any) -> Any:
        """Treat a blank value in the environment as absent, so the field's default applies.

        Empty strings from the CLI-generated ``.env`` represent optional settings. Drop the key
        instead of mapping it to ``None``: this holds for every field shape and keeps ``''`` from
        passing an ``is not None`` readiness check.
        """
        if not isinstance(values, dict):
            return values
        return {key: value for key, value in values.items() if not (isinstance(value, str) and not value.strip())}
