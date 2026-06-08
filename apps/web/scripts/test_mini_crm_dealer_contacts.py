#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
mini_crm = (ROOT / "src/pages/MiniCrm.tsx").read_text(encoding="utf-8")


def assert_contains(haystack: str, needle: str, label: str) -> None:
    assert needle in haystack, f"Missing {label}: {needle}"


def test_mini_crm_loads_dealer_contacts_with_customers() -> None:
    assert_contains(mini_crm, "dealer_customer_contacts(*)", "dealer contact relation in customer query")


def test_mini_crm_edit_dialog_has_dealer_contact_fields() -> None:
    for needle, label in [
        ("Liên hệ đại lý / SĐT đăng nhập OTP", "dealer contact section title"),
        ("Tên liên hệ", "contact name input label"),
        ("SĐT đăng nhập OTP", "OTP phone input label"),
        ("Số chính", "primary phone selector"),
        ("Đang hoạt động", "active phone selector"),
        ("+ Thêm SĐT", "add phone button"),
    ]:
        assert_contains(mini_crm, needle, label)


def test_mini_crm_saves_dealer_contacts_to_dedicated_table() -> None:
    for needle, label in [
        ("normalizeDealerContactPhone", "phone normalizer helper"),
        ('.from("dealer_customer_contacts")', "dealer_customer_contacts writes"),
        ("phone_normalized", "normalized phone payload"),
        ("is_primary", "primary flag payload"),
        ("is_active", "active flag payload"),
    ]:
        assert_contains(mini_crm, needle, label)


def test_customer_detail_shows_dealer_contacts() -> None:
    assert_contains(mini_crm, "SĐT dealer portal", "customer detail dealer phone label")
    assert_contains(mini_crm, "dealer_customer_contacts", "customer detail contact data source")


if __name__ == "__main__":
    test_mini_crm_loads_dealer_contacts_with_customers()
    test_mini_crm_edit_dialog_has_dealer_contact_fields()
    test_mini_crm_saves_dealer_contacts_to_dedicated_table()
    test_customer_detail_shows_dealer_contacts()
    print("mini CRM dealer contact static checks passed")
