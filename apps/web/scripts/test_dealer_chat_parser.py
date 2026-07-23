#!/usr/bin/env python3
"""Static regression checks for the dealer chat order parser."""
from pathlib import Path

PORTAL = Path(__file__).resolve().parents[1] / "src/pages/DealerPortal.tsx"
portal = PORTAL.read_text(encoding="utf-8")


def assert_contains(needle: str, label: str) -> None:
    assert needle in portal, f"missing {label}: expected to find {needle!r}"


def test_tony_malformed_eth_dvc_alias_is_normalized() -> None:
    assert_contains('.replace(/ð/g, "d")', "Tony mail Ð/ð normalization")
    assert_contains('aliases: ["dvc", "đvc", "dong van cong", "đồng văn cống"]', "ĐVC route aliases")
    assert portal.index('.replace(/ð/g, "d")') < portal.index('.replace(/[^a-z0-9\\s]/g, " ")'), (
        "Ð/ð must be normalized before unsupported characters are removed"
    )


def test_dealer_parser_preserves_order_exchange_makeup_semantics() -> None:
    for needle, label in [
        ("orderedQuantity", "ordered quantity"),
        ("exchangeQuantity", "exchange quantity"),
        ("makeupQuantity", "makeup quantity"),
        ("const physicalQuantity = quantity + exchangeQuantity + makeupQuantity", "physical delivery quantity"),
    ]:
        assert_contains(needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
