"""The payload-encryption config, resolved once and shared by both SDK entry points.

Encryption has two halves that must agree. The worker uses a codec built in
``mistralai.workflows.run_worker``; every other process uses the client-side hook. A worker on
``full`` with an unconfigured client fails silently, so both halves read this one config.
"""

import os
from functools import lru_cache

import structlog
from env.workflows import env as workflows_env
from mistralai.extra.workflows.encoding.config import PayloadEncryptionMode
from mistralai.workflows.core.config.config import PayloadEncryptionConfig
from pydantic import SecretStr

logger = structlog.get_logger("workflows.encryption")

_SDK_ENV_PREFIX = "TEMPORAL_PAYLOAD_ENCRYPTION__"
_AES_KEY_LENGTHS = (16, 24, 32)
# The development key every generated app starts with (the capability's `envVars`). It is public, so
# anything encrypted under it is readable by anyone.
_PUBLIC_DEV_KEY = "deadbeef" * 8


class EncryptionNotConfiguredError(RuntimeError):
    """Raised when encryption is requested but cannot be configured safely."""


def _refuse_sdk_env_vars() -> None:
    # The SDK reads TEMPORAL_PAYLOAD_ENCRYPTION__* itself, from a .env resolved against the
    # CWD at import time. Two mechanisms would make the effective mode depend on which one
    # wins, so any such name set is an error, not an override.
    stray = sorted(name for name in os.environ if name.upper().startswith(_SDK_ENV_PREFIX))
    if stray:
        raise EncryptionNotConfiguredError(
            f"{', '.join(stray)} is set, but this app configures payload encryption through "
            "WORKFLOWS_ENCRYPTION_MODE / _KEY / _PREVIOUS_KEY. Two sources would silently "
            "disagree — unset the TEMPORAL_PAYLOAD_ENCRYPTION__* names."
        )


def _hex_key(value: SecretStr | None, name: str) -> str | None:
    if value is None:
        return None
    raw = value.get_secret_value().strip()
    # The SDK feeds this to bytes.fromhex() and AESGCM(), which fail deep in a payload
    # round-trip. Validation here turns a bad key into a startup error.
    try:
        length = len(bytes.fromhex(raw))
    except ValueError as exc:
        raise EncryptionNotConfiguredError(f"{name} must be hex-encoded (64 hex chars for AES-256)") from exc
    if length not in _AES_KEY_LENGTHS:
        raise EncryptionNotConfiguredError(f"{name} must decode to 16, 24 or 32 bytes, got {length}")
    return raw


@lru_cache(maxsize=1)
def payload_encryption() -> PayloadEncryptionConfig | None:
    """The encryption config for this process, or ``None`` when encryption is off."""
    _refuse_sdk_env_vars()
    mode = workflows_env.workflows_encryption_mode
    if mode == "off":
        logger.warning("workflow payload encryption is off", mode=mode)
        return None

    main_key = _hex_key(workflows_env.workflows_encryption_key, "WORKFLOWS_ENCRYPTION_KEY")
    if main_key is None:
        raise EncryptionNotConfiguredError(
            f"WORKFLOWS_ENCRYPTION_MODE={mode} requires WORKFLOWS_ENCRYPTION_KEY. Generate one with: "
            "python -c 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM; "
            "print(AESGCM.generate_key(bit_length=256).hex())'"
        )
    previous_key = _hex_key(workflows_env.workflows_encryption_previous_key, "WORKFLOWS_ENCRYPTION_PREVIOUS_KEY")
    if main_key.lower() == _PUBLIC_DEV_KEY:
        # A warning, not a refusal: the key is the working default for local development.
        logger.warning(
            "WORKFLOWS_ENCRYPTION_KEY is the public development key; generate your own for any shared "
            "or deployed environment",
            mode=mode,
        )

    logger.info("workflow payload encryption enabled", mode=mode, key_rotation=previous_key is not None)
    # Every field is passed explicitly: this class is a BaseSettings, so an omitted one is read
    # from the bare, unprefixed MODE / MAIN_KEY / SECONDARY_KEY names.
    return PayloadEncryptionConfig(
        mode=PayloadEncryptionMode(mode),
        main_key=SecretStr(main_key),
        secondary_key=SecretStr(previous_key) if previous_key else None,
    )
