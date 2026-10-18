from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from commerce_common.agent_sdk import TurnResult
from merchant_agent import ChangeKind, StagedChange

from bmq_merchant.auth import Owner
from bmq_merchant.backend import BmqStagedChange
from bmq_merchant.config import Settings, strip_anthropic_api_key
from bmq_merchant.server import create_app

USER_ID = "11111111-1111-4111-8111-111111111111"


def _change(change_id: str, status: str = "staged") -> BmqStagedChange:
    return BmqStagedChange(
        change_id=change_id,
        kind=ChangeKind.PRICE_UPDATE,
        status=status,
        summary="Đổi giá",
        items=[],
        created_at=datetime.now(timezone.utc),
        created_by="owner@bmq.vn",
    )


class FakeBackend:
    def __init__(self) -> None:
        self.changes: dict[str, StagedChange] = {
            "change-1": _change("change-1"),
            "change-2": _change("change-2"),
        }

    async def get_pending_changes(self, session: Any) -> list[StagedChange]:
        return [
            change
            for change in self.changes.values()
            if change.status in {"staged", "approved"}
        ]

    async def approve_change(self, change_id: str, decided_by: str) -> StagedChange:
        change = self.changes[change_id]
        updated = change.model_copy(update={"status": "approved"})
        self.changes[change_id] = updated
        return updated

    async def apply_change(self, session: Any, change_id: str) -> StagedChange:
        change = self.changes[change_id]
        updated = change.model_copy(update={"status": "applied"})
        self.changes[change_id] = updated
        return updated

    async def discard_change(self, session: Any, change_id: str) -> StagedChange:
        change = self.changes[change_id]
        updated = change.model_copy(update={"status": "discarded"})
        self.changes[change_id] = updated
        return updated


class FakeClient:
    def __init__(self) -> None:
        self.entered = False
        self.closed = False

    async def __aenter__(self) -> "FakeClient":
        self.entered = True
        return self

    async def __aexit__(self, *_: Any) -> None:
        self.closed = True


class FakeToolset:
    pass


async def owner_verifier(_: str | None) -> Owner:
    return Owner(user_id=USER_ID, email="owner@bmq.vn")


def _app(
    settings: Settings,
    fake: FakeBackend,
    captured: dict[str, Any],
    *,
    turn_runner: Any,
) -> Any:
    def options_factory(**kwargs: Any) -> Any:
        captured["options_kwargs"] = kwargs
        return object(), FakeToolset()

    return create_app(
        settings,
        backend_factory=lambda: fake,
        options_factory=options_factory,
        client_factory=lambda _: FakeClient(),
        turn_runner=turn_runner,
        owner_verifier=owner_verifier,
    )


def test_health(settings: Settings) -> None:
    fake = FakeBackend()
    app = _app(settings, fake, {}, turn_runner=_unused_turn)
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "model": "claude-haiku-5-5"}


async def _unused_turn(client: Any, text: str, *, toolset: Any = None) -> TurnResult:
    return TurnResult(text="unused")


def test_chat_uses_fake_sdk_and_returns_pending_changes(settings: Settings) -> None:
    captured: dict[str, Any] = {}

    async def fake_turn(client: Any, text: str, *, toolset: Any = None) -> TurnResult:
        captured["message"] = text
        captured["toolset"] = toolset
        return TurnResult(
            text="Xin chào anh",
            tool_calls=["get_business_snapshot"],
            ui=[{"component": "change_preview", "payload": {"change_id": "change-1"}}],
        )

    fake = FakeBackend()
    app = _app(settings, fake, captured, turn_runner=fake_turn)
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat",
            headers={"Authorization": "Bearer owner-token"},
            json={
                "session_id": "session-a",
                "message": "Doanh thu hôm nay?",
                "page": "/dashboard",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == "session-a"
    assert body["text"] == "Xin chào anh"
    assert body["tool_calls"] == ["get_business_snapshot"]
    assert body["pending_changes"][0]["change_id"] == "change-1"
    assert captured["message"].startswith("[Trang: /dashboard]\n")
    assert captured["options_kwargs"]["merchant_id"] == "bmq"
    assert captured["options_kwargs"]["operator"] == "owner@bmq.vn"


def test_approve_and_discard_endpoints(settings: Settings) -> None:
    captured: dict[str, Any] = {}

    async def fake_turn(client: Any, text: str, *, toolset: Any = None) -> TurnResult:
        return TurnResult(text="ok")

    fake = FakeBackend()
    app = _app(settings, fake, captured, turn_runner=fake_turn)
    headers = {"Authorization": "Bearer owner-token"}

    with TestClient(app) as client:
        approved = client.post("/v1/changes/change-1/approve", headers=headers)
        discarded = client.post("/v1/changes/change-2/discard", headers=headers)
        pending = client.get("/v1/changes", headers=headers)

    assert approved.status_code == 200
    assert approved.json()["status"] == "applied"
    assert discarded.status_code == 200
    assert discarded.json()["status"] == "discarded"
    assert pending.status_code == 200
    assert pending.json() == []


def test_anthropic_api_key_is_stripped(monkeypatch: pytest.MonkeyPatch, caplog: Any) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "never-log-this-value")
    with caplog.at_level(logging.WARNING):
        removed = strip_anthropic_api_key()

    assert removed is True
    assert "ANTHROPIC_API_KEY" not in os.environ
    assert "never-log-this-value" not in caplog.text
    assert "Claude Code" in caplog.text


def test_startup_strips_api_key(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-survive")
    fake = FakeBackend()
    app = _app(settings, fake, {}, turn_runner=_unused_turn)
    with TestClient(app) as client:
        assert "ANTHROPIC_API_KEY" not in os.environ
        assert client.get("/health").status_code == 200


def test_cors_allows_only_configured_origin(settings: Settings) -> None:
    fake = FakeBackend()
    app = _app(settings, fake, {}, turn_runner=_unused_turn)
    with TestClient(app) as client:
        allowed = client.options(
            "/health",
            headers={
                "Origin": "https://ai.banhmique.vn",
                "Access-Control-Request-Method": "GET",
            },
        )
        denied = client.options(
            "/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://ai.banhmique.vn"
    assert "access-control-allow-origin" not in denied.headers


class _SushiOptions:
    def __init__(self) -> None:
        self.system_prompt = "BASE PROMPT"
        self.mcp_servers = {"merchant": object()}
        self.allowed_tools = ["mcp__merchant__get_business_snapshot"]


def test_ask_sushi_tool_queues_ui_and_refreshes_the_owner_token(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    from bmq_merchant import server as server_module
    from bmq_merchant.sushi import SushiAnswer

    captured: dict[str, Any] = {"tools": [], "asks": []}

    def fake_create_server(name: str, version: str = "1.0.0", tools: Any = None) -> Any:
        captured["server_name"] = name
        captured["tools"] = list(tools or [])
        return {"type": "sdk", "name": name}

    async def fake_ask(
        question: str,
        owner_token: str,
        conversation_id: str,
        settings: Settings,
        http: Any,
    ) -> SushiAnswer:
        captured["asks"].append(
            {
                "question": question,
                "token": owner_token,
                "conversation_id": conversation_id,
            }
        )
        return SushiAnswer(
            answer="Tổng công nợ nhà cung cấp là 10 triệu.",
            details="D" * 3500,
            images=[{"url": "https://img/1.jpg"}],
            cost_block={"mode": "example_line"},
            citations=[{"id": "cite-1"}],
            lane="supplier_debt",
        )

    monkeypatch.setattr(server_module, "create_sdk_mcp_server", fake_create_server)
    monkeypatch.setattr(server_module.sushi, "ask_sushi", fake_ask)

    def options_factory(**kwargs: Any) -> Any:
        captured["options_kwargs"] = kwargs
        options = _SushiOptions()
        captured["options"] = options
        return options, FakeToolset()

    async def fake_turn(client: Any, text: str, *, toolset: Any = None) -> TurnResult:
        captured["tool_result"] = await captured["tools"][0].handler(
            {"question": "Công nợ nhà cung cấp?"}
        )
        return TurnResult(
            text="Đã kiểm tra",
            ui=[{"component": "change_preview", "payload": {"change_id": "change-1"}}],
        )

    fake = FakeBackend()
    app = create_app(
        settings,
        backend_factory=lambda: fake,
        options_factory=options_factory,
        client_factory=lambda _: FakeClient(),
        turn_runner=fake_turn,
        owner_verifier=owner_verifier,
    )
    headers = {"Authorization": "Bearer owner-token-1"}
    with TestClient(app) as client:
        first = client.post(
            "/v1/chat",
            headers=headers,
            json={"session_id": "session-sushi", "message": "Hỏi Sushi"},
        )
        second = client.post(
            "/v1/chat",
            headers={"Authorization": "Bearer owner-token-2"},
            json={"session_id": "session-sushi", "message": "Hỏi lại"},
        )
        session = app.state.sessions["session-sushi"]
        assert session.pending_ui == []

    assert first.status_code == 200
    assert second.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["ui"][-1]["component"] == "sushi_answer"
    assert sum(
        block["component"] == "sushi_answer" for block in first_body["ui"]
    ) == 1
    assert sum(
        block["component"] == "sushi_answer" for block in second_body["ui"]
    ) == 1
    payload = first_body["ui"][-1]["payload"]
    assert payload["answer"] == "Tổng công nợ nhà cung cấp là 10 triệu."
    assert payload["images"] == [{"url": "https://img/1.jpg"}]
    assert payload["costBlock"] == {"mode": "example_line"}
    assert payload["citations"] == [{"id": "cite-1"}]
    assert payload["details"] == "D" * 3500
    assert [ask["token"] for ask in captured["asks"]] == [
        "owner-token-1",
        "owner-token-2",
    ]
    assert captured["asks"][0]["conversation_id"] == captured["asks"][1][
        "conversation_id"
    ]
    tool_text = captured["tool_result"]["content"][0]["text"]
    assert "Tổng công nợ nhà cung cấp là 10 triệu." in tool_text
    assert "D" * 3000 in tool_text
    assert "D" * 3001 not in tool_text
    options = captured["options"]
    assert captured["server_name"] == "bmq"
    assert "bmq" in options.mcp_servers
    assert options.mcp_servers["merchant"] is not None
    assert "mcp__bmq__ask_sushi" in options.allowed_tools
    assert options.system_prompt.startswith("BASE PROMPT")
    assert "mcp__bmq__ask_sushi" in options.system_prompt
    assert "VNAgent" in options.system_prompt
    assert "Sushi" not in options.system_prompt, "internal names stay out of the prompt text"


def test_ask_sushi_error_is_a_tool_error_without_ui(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    from bmq_merchant import server as server_module
    from bmq_merchant.sushi import SushiError

    captured: dict[str, Any] = {"tools": []}

    def fake_create_server(name: str, version: str = "1.0.0", tools: Any = None) -> Any:
        captured["tools"] = list(tools or [])
        return {"type": "sdk", "name": name}

    async def failing_ask(*args: Any, **kwargs: Any) -> Any:
        raise SushiError("Chưa lấy được số liệu này")

    monkeypatch.setattr(server_module, "create_sdk_mcp_server", fake_create_server)
    monkeypatch.setattr(server_module.sushi, "ask_sushi", failing_ask)

    def options_factory(**kwargs: Any) -> Any:
        return _SushiOptions(), FakeToolset()

    async def fake_turn(client: Any, text: str, *, toolset: Any = None) -> TurnResult:
        captured["tool_result"] = await captured["tools"][0].handler(
            {"question": "Công nợ?"}
        )
        return TurnResult(text="ok")

    app = create_app(
        settings,
        backend_factory=lambda: FakeBackend(),
        options_factory=options_factory,
        client_factory=lambda _: FakeClient(),
        turn_runner=fake_turn,
        owner_verifier=owner_verifier,
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/chat",
            headers={"Authorization": "Bearer owner-token"},
            json={"session_id": "session-sushi-error", "message": "Hỏi Sushi"},
        )

    assert response.status_code == 200
    assert response.json()["ui"] == []
    assert captured["tool_result"]["is_error"] is True
    assert captured["tool_result"]["content"][0]["text"] == "Chưa lấy được số liệu này"
