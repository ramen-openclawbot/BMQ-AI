"""Deterministic replies for greetings, thanks and help questions.

The merchant chat host answers these fixed phrases itself, before the Agent SDK
turn, so a simple "Chào em" or "Cảm ơn" never spends a model call.  Matching is
exact after normalization: lowercase, Vietnamese accents removed (including
``đ``), punctuation/emoji stripped at both ends and whitespace collapsed.  A
message with extra content (for example ``chào em, doanh thu hôm nay?``) is not
a fast reply and continues to the normal AI turn.
"""

from __future__ import annotations

import unicodedata
from typing import Any

MAX_FAST_REPLY_CHARS = 40

FAST_REPLY_SUGGESTIONS = [
    "Snapshot doanh thu",
    "Doanh thu tháng này theo kênh",
    "PO hôm nay của nhà cung cấp nào?",
]

GREETING = frozenset(
    {
        "chao",
        "xin chao",
        "chao em",
        "chao ban",
        "chao anh",
        "chao chi",
        "chao moi nguoi",
        "chao bmq agent",
        "chao bmq",
        "chao agent",
        "hi",
        "hii",
        "hello",
        "helo",
        "hello bmq agent",
        "hi bmq agent",
        "alo",
        "hey",
        "good morning",
        "good afternoon",
        "chao buoi sang",
        "chao buoi chieu",
        "chao buoi toi",
        "chao buoi trua",
        "chao em a",
        "chao anh a",
        "chao chi a",
        "xin chao a",
    }
)

THANKS_ACK = frozenset(
    {
        "cam on",
        "cam on em",
        "cam on anh",
        "cam on ban",
        "cam on bmq agent",
        "cam on nhieu",
        "cam on nhe",
        "cam on nha",
        "cam on a",
        "cam on em nhe",
        "cam on em nha",
        "cam on anh nhe",
        "thanks nhe",
        "thanks nha",
        "thanks",
        "thanks em",
        "thanks anh",
        "thank you",
        "thank you em",
        "thank you so much",
        "ok",
        "oke",
        "okie",
        "okay",
        "ok em",
        "ok anh",
        "ok nhe",
        "ok nha",
        "duoc",
        "duoc roi",
        "duoc nhe",
        "tot",
        "tot roi",
        "tot qua",
        "tuyet",
        "tuyet voi",
        "qua tot",
        "da",
        "da vang",
        "vang",
        "vang a",
        "uh",
        "uhm",
        "um",
        "dung roi",
        "chuan",
    }
)

HELP = frozenset(
    {
        "em lam duoc gi",
        "ban lam duoc gi",
        "giup gi",
        "giup duoc gi",
        "em giup duoc gi",
        "ban giup duoc gi",
        "huong dan",
        "huong dan su dung",
        "help",
        "help me",
        "tro giup",
        "tro giup gi",
        "tro giup duoc gi",
        "bmq agent la gi",
        "bmq agent lam duoc gi",
        "bmq agent la ai",
        "em la ai",
        "ban la ai",
        "lam duoc gi",
        "co the lam gi",
        "ban co the lam gi",
        "em co the lam gi",
        "can giup gi",
        "co giup gi",
        "giup do",
    }
)

GROUPS: dict[str, frozenset[str]] = {
    "greeting": GREETING,
    "thanks": THANKS_ACK,
    "help": HELP,
}

_REPLIES: dict[str, dict[str, Any]] = {
    "greeting": {
        "text": (
            "BMQ Agent chào anh. Anh muốn xem doanh thu, đơn hàng hay công nợ?"
        ),
        "suggestions": FAST_REPLY_SUGGESTIONS,
    },
    "thanks": {
        "text": (
            "BMQ Agent rất vui được hỗ trợ anh. Anh cần xem thêm số liệu gì không?"
        ),
        "suggestions": FAST_REPLY_SUGGESTIONS,
    },
    "help": {
        "text": (
            "BMQ Agent giúp anh: doanh thu và đơn hàng; PO/PR và nhà cung cấp; "
            "công nợ đại lý; tồn kho; đọc ảnh bank slip."
        ),
        "suggestions": FAST_REPLY_SUGGESTIONS,
    },
}


def _strip_accents(value: str) -> str:
    text = value.casefold().replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def _is_edge_char(char: str) -> bool:
    if char.isspace():
        return True
    category = unicodedata.category(char)
    return category[0] in {"P", "S"} or category == "Cf"


def _normalize(message: Any) -> str:
    if not isinstance(message, str):
        return ""
    text = _strip_accents(message)
    text = " ".join(text.split())
    while text and _is_edge_char(text[0]):
        text = text[1:]
    while text and _is_edge_char(text[-1]):
        text = text[:-1]
    return " ".join(text.split())


def fast_reply_group(message: Any) -> str | None:
    """Return the matching group name (``greeting``/``thanks``/``help``) or None."""

    text = _normalize(message)
    if not text or len(text) > MAX_FAST_REPLY_CHARS:
        return None
    for group, phrases in GROUPS.items():
        if text in phrases:
            return group
    return None


def fast_reply(message: Any) -> dict[str, Any] | None:
    """Return ``{"text", "suggestions"}`` for an exact fixed phrase, else None."""

    group = fast_reply_group(message)
    if group is None:
        return None
    reply = _REPLIES[group]
    return {
        "text": str(reply["text"]),
        "suggestions": list(reply["suggestions"]),
    }
