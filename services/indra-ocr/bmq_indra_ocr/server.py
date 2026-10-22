"""HTTP surface for the local Indra OCR service.

Only the Python standard library is used here. The Indra model is loaded once
by the caller (``indra_ocr.load``) and injected through ``converter_factory`` so
tests can run a real HTTP server with a fake converter.
"""

from __future__ import annotations

import hmac
import json
import logging
import threading
import time
import tempfile
from collections.abc import Callable, Mapping, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import ENGINE, VERSION
from .config import Config

LOGGER = logging.getLogger("bmq_indra_ocr")

SUPPORTED_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}

MAX_PAGES = 10

try:  # OpenCV is a transitive dependency of indra-ocr; keep the service usable without it.
    import cv2  # type: ignore
except Exception:  # pragma: no cover - depends on the local install
    cv2 = None  # type: ignore


def _value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _as_number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    try:
        number = float(str(value))
    except (TypeError, ValueError):
        return None
    return int(number) if number.is_integer() else number


def _normalize_box(box: Any) -> list[int | float] | None:
    if box is None:
        return None
    if isinstance(box, Mapping):
        values = [box.get("x0"), box.get("y0"), box.get("x1"), box.get("y1")]
    elif isinstance(box, Sequence) and not isinstance(box, (str, bytes)):
        values = list(box)
    else:
        values = [getattr(box, name, None) for name in ("x0", "y0", "x1", "y1")]
    numbers = [_as_number(item) for item in values[:4]]
    if len(numbers) != 4 or any(item is None for item in numbers):
        return None
    return numbers  # type: ignore[return-value]


def _normalize_line(line: Any) -> dict[str, Any]:
    return {
        "box": _normalize_box(_value(line, "box")),
        "text": str(_value(line, "text", "") or ""),
        "conf": _as_number(_value(line, "conf")),
    }


def _pages_of(result: Any) -> list[Any]:
    if isinstance(result, Mapping):
        pages = result.get("pages")
    else:
        pages = getattr(result, "pages", None)
    if pages is None and isinstance(result, Sequence) and not isinstance(result, (str, bytes)):
        pages = result
    # indra_ocr's Converter.convert yields (page_index, Page) pairs.
    return [
        item[1] if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], int) else item
        for item in (pages or [])
    ]


def _image_size(path: Path) -> tuple[int | None, int | None]:
    if cv2 is None:
        return None, None
    try:
        image = cv2.imread(str(path))
    except Exception:
        return None, None
    if image is None:
        return None, None
    height, width = image.shape[:2]
    return int(width), int(height)


def normalize_page(page: Any, *, is_pdf: bool, image_size: tuple[int | None, int | None]) -> dict[str, Any]:
    raw_lines = _value(page, "lines", None) or []
    lines = [_normalize_line(line) for line in raw_lines]

    line_count = _as_number(_value(page, "line_count"))
    if line_count is None:
        line_count = len(lines)

    mean_conf = _as_number(_value(page, "mean_conf"))
    if mean_conf is None and lines:
        confidences = [line["conf"] for line in lines if line["conf"] is not None]
        if confidences:
            mean_conf = sum(confidences) / len(confidences)

    if is_pdf:
        width, height = None, None
    else:
        width, height = image_size
        if width is None:
            width = _as_number(_value(page, "width"))
        if height is None:
            height = _as_number(_value(page, "height"))

    return {
        "rotation": _as_number(_value(page, "rotation")),
        "skew": _as_number(_value(page, "skew")),
        "source": _value(page, "source"),
        "text": str(_value(page, "text", "") or ""),
        "markdown": str(_value(page, "markdown", "") or ""),
        "line_count": int(line_count),
        "mean_conf": mean_conf,
        "lines": lines,
        "width": width,
        "height": height,
        "timings": _value(page, "timings"),
    }


class ServerState:
    """Converter plus the single-conversion lock and bounded waiter queue."""

    def __init__(self, config: Config, converter: Any) -> None:
        self.config = config
        self.converter = converter
        self._convert_lock = threading.Lock()
        self._queue_lock = threading.Lock()
        self._waiting = 0

    def acquire(self) -> bool:
        # A free converter is used immediately; only real contention queues.
        if self._convert_lock.acquire(blocking=False):
            return True
        with self._queue_lock:
            if self._waiting >= self.config.max_queue:
                return False
            self._waiting += 1
        try:
            self._convert_lock.acquire()
        finally:
            with self._queue_lock:
                self._waiting -= 1
        return True

    def release(self) -> None:
        self._convert_lock.release()


class OcrHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: ServerState) -> None:
        self.state = state
        super().__init__(address, OcrRequestHandler)


class OcrRequestHandler(BaseHTTPRequestHandler):
    server_version = f"{ENGINE}/{VERSION}"
    protocol_version = "HTTP/1.1"

    # Keep the default noisy access log off: every request logs exactly one
    # sanitized line through _finish().
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return

    @property
    def state(self) -> ServerState:
        return self.server.state  # type: ignore[attr-defined]

    def _write(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _finish(self, method: str, status: int, request_bytes: int, started: float) -> None:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        # Only method/path/status/size/timing: never headers, token or document text.
        LOGGER.info(
            "%s %s -> %s (%s bytes, %s ms)",
            method,
            self.path,
            status,
            request_bytes,
            elapsed_ms,
        )

    def _json(self, status: int, payload: dict[str, Any], *, method: str, request_bytes: int, started: float) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._write(status, body)
        self._finish(method, status, request_bytes, started)

    def do_GET(self) -> None:  # noqa: N802
        started = time.perf_counter()
        if self.path == "/healthz":
            self._json(
                200,
                {"ok": True, "engine": ENGINE, "version": VERSION},
                method="GET",
                request_bytes=0,
                started=started,
            )
            return
        self._json(404, {"error": "not_found"}, method="GET", request_bytes=0, started=started)

    def do_POST(self) -> None:  # noqa: N802
        started = time.perf_counter()
        if self.path != "/v1/ocr":
            self._json(404, {"error": "not_found"}, method="POST", request_bytes=0, started=started)
            return

        config = self.state.config

        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {config.token}"
        if not hmac.compare_digest(authorization.encode("utf-8"), expected.encode("utf-8")):
            self._json(401, {"error": "unauthorized"}, method="POST", request_bytes=0, started=started)
            return

        content_type = (self.headers.get("Content-Type", "") or "").split(";", 1)[0].strip().lower()
        suffix = SUPPORTED_TYPES.get(content_type)
        if suffix is None:
            self._json(415, {"error": "unsupported_type"}, method="POST", request_bytes=0, started=started)
            return

        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._json(411, {"error": "length_required"}, method="POST", request_bytes=0, started=started)
            return
        try:
            length = int(raw_length)
        except ValueError:
            self._json(411, {"error": "length_required"}, method="POST", request_bytes=0, started=started)
            return
        if length < 0:
            self._json(411, {"error": "length_required"}, method="POST", request_bytes=0, started=started)
            return
        if length > config.max_bytes:
            self._json(413, {"error": "too_large"}, method="POST", request_bytes=0, started=started)
            return

        body = self.rfile.read(length)

        is_pdf = content_type == "application/pdf"

        if not self.state.acquire():
            self._json(503, {"error": "busy"}, method="POST", request_bytes=length, started=started)
            return

        try:
            result, image_size = _convert(self.state.converter, body, suffix, is_pdf)
        except Exception:
            self._json(422, {"error": "unreadable"}, method="POST", request_bytes=length, started=started)
            return
        finally:
            self.state.release()

        pages = [
            normalize_page(page, is_pdf=is_pdf, image_size=image_size)
            for page in _pages_of(result)
        ]
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        self._json(
            200,
            {
                "engine": ENGINE,
                "version": VERSION,
                "ms": elapsed_ms,
                "pages": pages,
            },
            method="POST",
            request_bytes=length,
            started=started,
        )


def _convert(
    converter: Any,
    body: bytes,
    suffix: str,
    is_pdf: bool,
) -> tuple[Any, tuple[int | None, int | None]]:
    with tempfile.TemporaryDirectory(prefix="bmq-indra-ocr-") as folder:
        path = Path(folder) / f"page{suffix}"
        path.write_bytes(body)
        image_size = (None, None) if is_pdf else _image_size(path)
        result = converter.convert(str(path), max_pages=MAX_PAGES)
        # indra_ocr's convert is a lazy generator: read it while the temporary
        # file still exists and the conversion lock is still held.
        if (
            not isinstance(result, (Mapping, Sequence, str, bytes))
            and getattr(result, "pages", None) is None
        ):
            result = list(result)
    return result, image_size


def make_server(config: Config, converter_factory: Callable[[], Any]) -> OcrHTTPServer:
    """Build (but do not start) the HTTP server bound to 127.0.0.1."""
    converter = converter_factory()
    state = ServerState(config, converter)
    # The server is an HTTP server first; make_server is also used by tests.
    return OcrHTTPServer(("127.0.0.1", config.port), state)
