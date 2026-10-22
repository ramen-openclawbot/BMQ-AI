"""Configuration for the local Indra OCR service.

Values come from the environment so the token is never stored in code. The
service refuses to start without a token of at least 24 characters.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

MIN_TOKEN_LENGTH = 24
DEFAULT_PORT = 8792
DEFAULT_THREADS = 4
DEFAULT_MAX_BYTES = 12 * 1024 * 1024
DEFAULT_MAX_QUEUE = 4


class ConfigError(ValueError):
    """Raised when the environment does not describe a runnable service."""


@dataclass(frozen=True)
class Config:
    token: str
    port: int = DEFAULT_PORT
    threads: int = DEFAULT_THREADS
    max_bytes: int = DEFAULT_MAX_BYTES
    max_queue: int = DEFAULT_MAX_QUEUE
    model_dir: str | None = None


def _int_value(
    env: Mapping[str, str],
    name: str,
    default: int,
    *,
    minimum: int,
) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}")
    return value


def load_config(env: Mapping[str, str] | None = None) -> Config:
    """Read and validate the service configuration."""
    source = os.environ if env is None else env

    token = (source.get("INDRA_OCR_TOKEN") or "").strip()
    if len(token) < MIN_TOKEN_LENGTH:
        raise ConfigError(
            f"INDRA_OCR_TOKEN is required and must be at least {MIN_TOKEN_LENGTH} characters"
        )

    port = _int_value(source, "INDRA_OCR_PORT", DEFAULT_PORT, minimum=0)
    if port > 65535:
        raise ConfigError("INDRA_OCR_PORT must be <= 65535")

    model_dir = (source.get("INDRA_OCR_MODEL_DIR") or "").strip() or None

    return Config(
        token=token,
        port=port,
        threads=_int_value(source, "INDRA_OCR_THREADS", DEFAULT_THREADS, minimum=1),
        max_bytes=_int_value(source, "INDRA_OCR_MAX_BYTES", DEFAULT_MAX_BYTES, minimum=1),
        max_queue=_int_value(source, "INDRA_OCR_MAX_QUEUE", DEFAULT_MAX_QUEUE, minimum=0),
        model_dir=model_dir,
    )
