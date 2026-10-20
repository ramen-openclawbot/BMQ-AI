"""Read-only Agent SDK tool that turns a document code into an open button.

The model passes the PR/PO/GR code it is answering about; the backend resolves
it to the row UUID and the tool appends a ``doc_link`` UI block the chat renderer
can turn into a button.  The tool never writes and never builds a path from
untrusted input: the path prefix comes from a fixed per-kind table.
"""

from __future__ import annotations

import re
from typing import Any

from claude_agent_sdk import SdkMcpTool

from .config import Settings
from .warehouse_tools import (
    _append_ui,
    _compact_json,
    _error,
    _ok,
    _safe_tool,
    _ToolInputError,
)

DOCUMENT_LINK_TOOL_NAME = "bmq_document_link"
DOCUMENT_KINDS = {
    "pr": "/payment-requests",
    "po": "/purchase-orders",
    "gr": "/goods-receipts",
}
DOCUMENT_CODE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

DOCUMENT_LINK_TOOL_DESCRIPTION = (
    "Mở một phiếu cụ thể bằng đúng mã phiếu để chủ doanh nghiệp bấm nút mở "
    "phiếu. Dùng khi câu trả lời nói về một PR (đề nghị thanh toán), PO (đơn "
    "mua hàng) hoặc phiếu nhập cụ thể. kind: pr, po, gr; code là mã phiếu "
    "(tối đa 64 ký tự chữ/số/-/_), không phân biệt hoa thường."
)

DOCUMENT_LINK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(DOCUMENT_KINDS)},
        "code": {
            "type": "string",
            "description": "Mã phiếu chính xác, tối đa 64 ký tự",
        },
    },
    "required": ["kind", "code"],
    "additionalProperties": False,
}


def doc_link_block(
    kind: str,
    code: str,
    document_id: str,
    title: str,
) -> dict[str, Any] | None:
    """Build the renderer block for one already-resolved document."""

    prefix = DOCUMENT_KINDS.get(kind)
    if prefix is None or not document_id or not code:
        return None
    return {
        "component": "doc_link",
        "version": 1,
        "payload": {
            "kind": kind,
            "code": code,
            "id": document_id,
            "title": title,
            "path": f"{prefix}?id={document_id}",
        },
    }


def _document_args(args: dict[str, Any]) -> tuple[str, str]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"kind", "code"}
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    kind = args.get("kind")
    if kind not in DOCUMENT_KINDS:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: kind phải là pr, po hoặc gr"
        )
    code = args.get("code")
    if not isinstance(code, str) or not DOCUMENT_CODE_PATTERN.fullmatch(code):
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: mã phiếu chỉ gồm chữ, số, '-' hoặc '_' "
            "và tối đa 64 ký tự"
        )
    return kind, code


def build_document_link_tools(
    chat_session: Any,
    settings: Settings,
) -> list[SdkMcpTool[Any]]:
    """Build the document-link tool for one chat session."""

    del settings

    @_safe_tool(
        DOCUMENT_LINK_TOOL_NAME,
        DOCUMENT_LINK_TOOL_DESCRIPTION,
        DOCUMENT_LINK_SCHEMA,
    )
    async def document_link_tool(args: dict[str, Any]) -> dict[str, Any]:
        kind, code = _document_args(args)
        document = await chat_session.backend.document_link(kind, code)
        if document is None:
            return _error(f"không tìm thấy phiếu {code}")
        block = doc_link_block(
            kind,
            str(document.get("code") or code),
            str(document["id"]),
            str(document.get("title") or code),
        )
        if block is None:
            return _error(f"không tìm thấy phiếu {code}")
        _append_ui(chat_session, block)
        return _ok(_compact_json(block["payload"]))

    return [document_link_tool]
