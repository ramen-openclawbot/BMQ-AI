from __future__ import annotations

import contextlib
import http.client
import json
import logging
import threading

import pytest

from bmq_indra_ocr import ENGINE, VERSION
from bmq_indra_ocr.config import Config, load_config
from bmq_indra_ocr.server import make_server

TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz-0123456789"
DOCUMENT_TEXT = "SECRET DOCUMENT TEXT MUST NOT LEAK"


class FakeConverter:
    def __init__(self, pages=None, error: Exception | None = None) -> None:
        self.pages = pages if pages is not None else [_default_page()]
        self.error = error
        self.calls: list[tuple[str, int]] = []

    def convert(self, path: str, max_pages: int = 10):
        self.calls.append((path, max_pages))
        if self.error is not None:
            raise self.error
        return {"pages": self.pages}


class BlockingConverter(FakeConverter):
    def __init__(self) -> None:
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()

    def convert(self, path: str, max_pages: int = 10):
        self.started.set()
        self.release.wait(5)
        return super().convert(path, max_pages)


def _default_page() -> dict:
    return {
        "rotation": 90,
        "skew": 0.75,
        "source": "ocr",
        "text": "CÔNG TY TNHH BÁNH MÌ\nSố tiền: 1.250.000\nNgày 22/10/2026",
        "markdown": "| Nội dung | Số tiền |\n| --- | --- |\n| Bánh mì | 1.250.000 |",
        "lines": [
            {"box": [10, 20, 300, 60], "text": "CÔNG TY TNHH BÁNH MÌ", "conf": 0.96},
            {"box": [10, 80, 300, 120], "text": "Số tiền: 1.250.000", "conf": 0.9},
            {"box": [10, 140, 300, 180], "text": "Ngày 22/10/2026", "conf": 0.87},
        ],
        "width": 1200,
        "height": 1600,
        "timings": {"detect_ms": 12, "recognize_ms": 40},
    }


def _config(**overrides) -> Config:
    values = {
        "token": TOKEN,
        "port": 0,
        "threads": 2,
        "max_bytes": 12 * 1024 * 1024,
        "max_queue": 4,
        "model_dir": None,
    }
    values.update(overrides)
    return Config(**values)


@contextlib.contextmanager
def serve_server(converter: FakeConverter, **overrides):
    server = make_server(_config(**overrides), lambda: converter)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def request(
    port: int,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        try:
            decoded = json.loads(payload or b"{}")
        except json.JSONDecodeError:
            decoded = {}
        return response.status, decoded
    finally:
        connection.close()


def ocr_headers(content_type: str = "image/png", token: str | None = TOKEN) -> dict[str, str]:
    headers = {"Content-Type": content_type, "Content-Length": "3"}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def test_healthz_needs_no_auth_and_returns_engine_version():
    with serve_server(FakeConverter()) as port:
        status, body = request(port, "GET", "/healthz")
    assert status == 200
    assert body == {"ok": True, "engine": ENGINE, "version": VERSION}


def test_post_requires_the_exact_bearer_token():
    with serve_server(FakeConverter()) as port:
        missing, missing_body = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers(token=None))
        wrong, wrong_body = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers(token="wrong-" + TOKEN))
    assert missing == 401
    assert missing_body == {"error": "unauthorized"}
    assert wrong == 401
    assert wrong_body == {"error": "unauthorized"}


def test_gif_and_unknown_types_are_unsupported():
    with serve_server(FakeConverter()) as port:
        status, body = request(port, "POST", "/v1/ocr", body=b"GIF", headers=ocr_headers("image/gif"))
        unknown, _ = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers("text/plain"))
    assert status == 415
    assert body == {"error": "unsupported_type"}
    assert unknown == 415


def test_missing_content_length_is_411():
    with serve_server(FakeConverter()) as port:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.putrequest("POST", "/v1/ocr")
            connection.putheader("Authorization", f"Bearer {TOKEN}")
            connection.putheader("Content-Type", "image/png")
            connection.endheaders()
            response = connection.getresponse()
            status = response.status
            body = json.loads(response.read() or b"{}")
        finally:
            connection.close()
    assert status == 411
    assert body == {"error": "length_required"}


def test_oversize_body_is_413_without_conversion():
    converter = FakeConverter()
    with serve_server(converter, max_bytes=2) as port:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.putrequest("POST", "/v1/ocr")
            connection.putheader("Authorization", f"Bearer {TOKEN}")
            connection.putheader("Content-Type", "image/png")
            connection.putheader("Content-Length", "3")
            connection.endheaders()
            response = connection.getresponse()
            status = response.status
            body = json.loads(response.read() or b"{}")
        finally:
            connection.close()
    assert status == 413
    assert body == {"error": "too_large"}
    assert converter.calls == []


def test_queue_limit_zero_answers_busy_while_the_lock_is_held():
    converter = BlockingConverter()
    with serve_server(converter, max_queue=0) as port:
        first_result: dict[str, tuple[int, dict]] = {}

        def first_request() -> None:
            first_result["value"] = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers())

        thread = threading.Thread(target=first_request, daemon=True)
        thread.start()
        assert converter.started.wait(5), "first conversion never started"
        busy_status, busy_body = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers())
        converter.release.set()
        thread.join(10)

    assert busy_status == 503
    assert busy_body == {"error": "busy"}
    assert first_result["value"][0] == 200


def test_success_shape_includes_rotation_line_count_mean_conf_and_lines():
    with serve_server(FakeConverter()) as port:
        status, body = request(port, "POST", "/v1/ocr", body=b"PNGDATA", headers=ocr_headers("image/png"))

    assert status == 200
    assert body["engine"] == ENGINE
    assert body["version"] == VERSION
    assert isinstance(body["ms"], int)
    assert len(body["pages"]) == 1
    page = body["pages"][0]
    assert page["rotation"] == 90
    assert page["skew"] == 0.75
    assert page["source"] == "ocr"
    assert page["line_count"] == 3
    assert page["mean_conf"] == pytest.approx((0.96 + 0.9 + 0.87) / 3)
    assert page["lines"][0]["box"] == [10, 20, 300, 60]
    assert page["lines"][0]["text"] == "CÔNG TY TNHH BÁNH MÌ"
    assert page["lines"][0]["conf"] == 0.96
    assert body["pages"][0]["timings"] == {"detect_ms": 12, "recognize_ms": 40}


class GeneratorConverter(FakeConverter):
    """Like indra_ocr: convert() lazily yields (index, Page) and reads the file while iterating."""

    def convert(self, path: str, max_pages: int = 10):
        self.calls.append((path, max_pages))

        def pages():
            from pathlib import Path
            from types import SimpleNamespace

            assert Path(path).exists(), "the upload must still exist while pages are read"
            page = _default_page()
            lines = [SimpleNamespace(**line) for line in page.pop("lines")]
            yield 0, SimpleNamespace(**page, lines=lines)

        return pages()


def test_lazy_indra_style_converter_returns_its_pages():
    with serve_server(GeneratorConverter()) as port:
        status, body = request(port, "POST", "/v1/ocr", body=b"PNGDATA", headers=ocr_headers("image/png"))
    assert status == 200
    assert len(body["pages"]) == 1
    assert body["pages"][0]["rotation"] == 90
    assert body["pages"][0]["lines"][0]["text"] == "CÔNG TY TNHH BÁNH MÌ"


def test_pdf_pages_have_null_width_and_height():
    with serve_server(FakeConverter()) as port:
        status, body = request(port, "POST", "/v1/ocr", body=b"%PDF-1.4", headers=ocr_headers("application/pdf"))
    assert status == 200
    assert body["pages"][0]["width"] is None
    assert body["pages"][0]["height"] is None


def test_unreadable_document_is_422():
    converter = FakeConverter(error=ValueError("cannot decode"))
    with serve_server(converter) as port:
        status, body = request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers())
    assert status == 422
    assert body == {"error": "unreadable"}


def test_token_and_document_text_never_appear_in_logs(caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.DEBUG, logger="bmq_indra_ocr")
    converter = FakeConverter()
    converter.pages = [{**_default_page(), "text": DOCUMENT_TEXT}]
    with serve_server(converter) as port:
        request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers())
        request(port, "POST", "/v1/ocr", body=b"abc", headers=ocr_headers(token="wrong-" + TOKEN))

    captured = caplog.text
    assert f"POST /v1/ocr -> 200" in captured
    assert TOKEN not in captured
    assert DOCUMENT_TEXT not in captured
    assert "Authorization" not in captured
    assert "Bearer" not in captured


def test_config_refuses_missing_or_short_token():
    with pytest.raises(Exception):
        load_config({})
    with pytest.raises(Exception):
        load_config({"INDRA_OCR_TOKEN": "too-short"})
    config = load_config(
        {
            "INDRA_OCR_TOKEN": TOKEN,
            "INDRA_OCR_PORT": "9000",
            "INDRA_OCR_THREADS": "2",
            "INDRA_OCR_MAX_BYTES": "1024",
            "INDRA_OCR_MAX_QUEUE": "0",
        }
    )
    assert config.port == 9000
    assert config.threads == 2
    assert config.max_bytes == 1024
    assert config.max_queue == 0
