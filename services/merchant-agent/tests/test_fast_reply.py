from __future__ import annotations

import pytest

from bmq_merchant.fast_reply import fast_reply, fast_reply_group

EXPECTED_SUGGESTIONS = [
    "Snapshot doanh thu",
    "Doanh thu tháng này theo kênh",
    "PO hôm nay của nhà cung cấp nào?",
]


def _assert_group(message: str, group: str) -> None:
    assert fast_reply_group(message) == group
    reply = fast_reply(message)
    assert reply is not None
    assert set(reply) == {"text", "suggestions"}
    assert "BMQ Agent" in reply["text"]
    marker = {"greeting": "chào anh", "thanks": "vui được hỗ trợ", "help": "giúp anh:"}[group]
    assert marker in reply["text"]
    assert reply["suggestions"] == EXPECTED_SUGGESTIONS


@pytest.mark.parametrize(
    "message",
    [
        "Chào em!",
        "chào em",
        "CHAO EM",
        "  Chào   em  ",
        "👋 Chào em 👍",
        "Chào anh.",
        "chao",
        "Xin chào",
        "XIN CHAO!",
        "hi",
        "HELLO",
        "Alo",
        "chào buổi sáng",
        "Chào BMQ Agent!",
        "Chào em ạ",
        "chào buổi trưa",
    ],
)
def test_greeting_group(message: str) -> None:
    _assert_group(message, "greeting")


@pytest.mark.parametrize(
    "message",
    [
        "Cảm ơn!",
        "CẢM ƠN",
        "cam on",
        "Cảm ơn em!",
        "ok 👍",
        "OK!",
        "Oke.",
        "okay",
        "Được rồi",
        "duoc roi",
        "tốt",
        "TUYỆT!",
        "dạ",
        "Vâng ạ",
        "ừm",
        "đúng rồi",
        "thanks",
        "THANK YOU!",
        "Cảm ơn nhé",
        "cảm ơn em nha",
        "thanks nhé",
    ],
)
def test_thanks_ack_group(message: str) -> None:
    _assert_group(message, "thanks")


@pytest.mark.parametrize(
    "message",
    [
        "Em làm được gì?",
        "em lam duoc gi",
        "BẠN LÀM ĐƯỢC GÌ?",
        "giúp gì?",
        "Hướng dẫn!",
        "HELP",
        "trợ giúp",
        "BMQ Agent là gì?",
        "em là ai?",
    ],
)
def test_help_group(message: str) -> None:
    _assert_group(message, "help")


@pytest.mark.parametrize(
    "message",
    [
        "chào em, doanh thu hôm nay?",
        "ok gửi PO hôm nay",
        "cảm ơn, còn công nợ đại lý A?",
        "chào em nhé",
        "u",
        "ok nhưng để mai",
        "",
        "   ",
        "!!!",
        "snapshot doanh thu",
    ],
)
def test_non_exact_or_empty_messages_return_none(message: str) -> None:
    assert fast_reply(message) is None
    assert fast_reply_group(message) is None


def test_message_longer_than_limit_returns_none() -> None:
    message = "chào em " + "và rất nhiều điều khác nữa " * 2
    assert len(" ".join(message.casefold().split())) > 40
    assert fast_reply(message) is None


def test_snapshot_command_is_not_a_fast_reply() -> None:
    assert fast_reply("Snapshot doanh thu") is None
    assert fast_reply("snapshot doanh thu!") is None


def test_every_phrase_is_normalized_and_within_limit() -> None:
    from bmq_merchant.fast_reply import GROUPS, MAX_FAST_REPLY_CHARS

    for group, phrases in GROUPS.items():
        for phrase in phrases:
            assert len(phrase) <= MAX_FAST_REPLY_CHARS, phrase
            assert fast_reply_group(phrase) == group, phrase
