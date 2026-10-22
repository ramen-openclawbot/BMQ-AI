"""Run the Indra OCR service: python -m bmq_indra_ocr."""

from __future__ import annotations

import logging
import signal
import sys
import threading
from types import FrameType

from . import ENGINE, VERSION
from .config import Config, ConfigError, load_config
from .server import LOGGER, make_server


def _configure_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger = logging.getLogger("bmq_indra_ocr")
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)


def _converter_factory(config: Config):
    def load_converter():
        import indra_ocr

        return indra_ocr.load(
            threads=config.threads,
            furniture=True,
            path=config.model_dir or None,
        )

    return load_converter


def main() -> int:
    _configure_logging()
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"{ENGINE}: refusing to start: {exc}", file=sys.stderr)
        return 2

    server = make_server(config, _converter_factory(config))
    LOGGER.info("%s %s listening on 127.0.0.1:%s", ENGINE, VERSION, config.port)

    def _handle_signal(signum: int, _frame: FrameType | None) -> None:
        LOGGER.info("received signal %s, shutting down", signum)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
