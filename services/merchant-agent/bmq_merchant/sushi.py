"""Client for the existing ``bmq-analytics`` Sushi chat backend.

Sushi keeps its own authentication and data scoping: the caller forwards the
owner's Supabase access token and ``bmq-analytics`` checks the owner itself.
This module only shapes the documented request and defensively normalizes the
answer/provenance it gets back.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Settings

SUSHI_TIMEOUT_SECONDS = 45.0
MAX_QUESTION_CHARS = 2000
MAX_IMAGES = 8

PAGE_ROUTE = "/merchant-agent"
PAGE_LABEL = "Trợ lý quản trị"


class SushiError(RuntimeError):
    """A short, user-facing Sushi failure (never carries credentials)."""


@dataclass(frozen=True, slots=True)
class SushiAnswer:
    answer: str
    details: str | None = None
    images: list[Any] = field(default_factory=list)
    cost_block: Any = None
    citations: list[Any] = field(default_factory=list)
    lane: str | None = None


def _error_code(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    code = body.get("code")
    if isinstance(code, str):
        return code
    error = body.get("error")
    if isinstance(error, str):
        return error
    if isinstance(error, dict):
        nested = error.get("code")
        if isinstance(nested, str):
            return nested
    return ""


def _details(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _images(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    return list(value[:MAX_IMAGES])


def _citations(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def parse_sushi_response(body: Any) -> SushiAnswer:
    """Parse the documented Sushi response without trusting its shape."""

    if not isinstance(body, dict):
        raise SushiError("Sushi chưa trả lời được")
    answer = body.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise SushiError("Sushi chưa trả lời được")
    provenance = body.get("provenance")
    if not isinstance(provenance, dict):
        provenance = {}
    lane = provenance.get("lane")
    return SushiAnswer(
        answer=answer.strip(),
        details=_details(provenance.get("details")),
        images=_images(provenance.get("images")),
        cost_block=provenance.get("costBlock"),
        citations=_citations(provenance.get("citations")),
        lane=lane if isinstance(lane, str) else None,
    )


async def ask_sushi(
    question: str,
    owner_token: str,
    conversation_id: str,
    settings: Settings,
    http: httpx.AsyncClient | None = None,
) -> SushiAnswer:
    """Ask Sushi one question as the current owner.

    ``http`` is injectable for tests; when omitted a bounded one-shot client is
    used.  The owner token is forwarded only to ``bmq-analytics``.
    """

    text = (question or "").strip()[:MAX_QUESTION_CHARS]
    if not text:
        raise SushiError("Câu hỏi không được để trống")
    if not owner_token:
        raise SushiError("phiên hết hạn")

    payload = {
        "language": "vi",
        "question": text,
        "conversationId": conversation_id,
        "page": {
            "route": PAGE_ROUTE,
            "label": PAGE_LABEL,
            "filters": {},
        },
        "history": [],
    }
    headers = {
        "Authorization": f"Bearer {owner_token}",
        "apikey": settings.auth_api_key,
        "Accept-Language": "vi",
        "Content-Type": "application/json",
    }
    url = f"{settings.supabase_url}/functions/v1/bmq-analytics"
    timeout = httpx.Timeout(SUSHI_TIMEOUT_SECONDS)
    client = http or httpx.AsyncClient(timeout=timeout)
    try:
        response = await client.post(
            url,
            headers=headers,
            json=payload,
            timeout=timeout,
        )
    except httpx.TimeoutException as exc:
        raise SushiError("Sushi chưa trả lời được") from exc
    except httpx.HTTPError as exc:
        raise SushiError("Sushi chưa trả lời được") from exc
    finally:
        if http is None:
            await client.aclose()

    if response.status_code == 401:
        raise SushiError("phiên hết hạn")
    if (
        response.status_code == 503
        and _error_code(response) == "ai_quota_exhausted"
    ):
        raise SushiError("hết hạn mức AI")
    if response.status_code >= 400:
        raise SushiError("Sushi chưa trả lời được")
    try:
        body = response.json()
    except ValueError as exc:
        raise SushiError("Sushi chưa trả lời được") from exc
    return parse_sushi_response(body)
