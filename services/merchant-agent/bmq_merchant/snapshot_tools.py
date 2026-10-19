"""Agent SDK tool exposing the deterministic revenue snapshot engine.

The tool reuses the same engine as the ``/v1/chat`` fast path, so the model
never has to add revenue numbers itself.  It deliberately imports the shared
tool wrappers from ``warehouse_tools`` instead of duplicating them.
"""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import SdkMcpTool

from .config import Settings
from .warehouse_tools import (
    _append_ui,
    _compact_json,
    _ok,
    _safe_tool,
)

SNAPSHOT_TOOL_NAME = "bmq_revenue_snapshot"
SNAPSHOT_TOOL_DESCRIPTION = (
    "Snapshot doanh thu từ đầu tháng so với tháng trước theo kênh, kèm cờ "
    "bất thường và hành động đề xuất; dùng khi chủ doanh nghiệp hỏi tình "
    "hình/bất thường doanh thu tháng này"
)
SNAPSHOT_TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "language": {
            "type": "string",
            "description": "Ngôn ngữ tóm tắt, mặc định vi",
        }
    },
    "additionalProperties": False,
}


def build_snapshot_tools(
    chat_session: Any,
    settings: Settings,
) -> list[SdkMcpTool[Any]]:
    """Build the revenue snapshot tool for one chat session."""

    @_safe_tool(
        SNAPSHOT_TOOL_NAME,
        SNAPSHOT_TOOL_DESCRIPTION,
        SNAPSHOT_TOOL_SCHEMA,
    )
    async def revenue_snapshot_tool(args: dict[str, Any]) -> dict[str, Any]:
        result = await chat_session.backend.revenue_snapshot()
        block = result["block"]
        payload = block["payload"]
        _append_ui(chat_session, block)
        return _ok(f"{result['text']}\n{_compact_json(payload)}")

    return [revenue_snapshot_tool]
