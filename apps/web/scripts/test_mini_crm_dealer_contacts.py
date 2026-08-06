#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
mini_crm = (ROOT / "src/pages/MiniCrm.tsx").read_text(encoding="utf-8")
create_customer_rpc_migration = (
    ROOT / "supabase/migrations/20260806135000_create_customer_with_dealer_contact.sql"
)


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
        ("Lưu thay đổi", "single main save action"),
    ]:
        assert_contains(mini_crm, needle, label)


def test_new_customer_setup_has_and_saves_otp_phone() -> None:
    for needle, label in [
        ("Số điện thoại nhận OTP đặt hàng", "new-customer OTP phone label"),
        ("setupDealerPhone", "new-customer OTP phone state"),
        ("SĐT nhận OTP không hợp lệ", "new-customer phone validation"),
        ("phone_normalized: normalizedSetupDealerPhone", "normalized new-customer phone payload"),
        ("customer_id: customerId", "new-customer contact relation"),
        ("create_mini_crm_customer_with_dealer_contact", "transactional customer/contact RPC"),
        ("setSetupDealerPhone(\"\")", "new-customer phone reset"),
    ]:
        assert_contains(mini_crm, needle, label)


def test_new_customer_contact_rpc_is_atomic_and_race_safe() -> None:
    assert create_customer_rpc_migration.exists(), "Missing transactional customer/contact migration"
    migration = create_customer_rpc_migration.read_text(encoding="utf-8")
    for needle, label in [
        ("create or replace function public.create_mini_crm_customer_with_dealer_contact", "RPC definition"),
        ("exception when unique_violation", "concurrent duplicate handling"),
        ("insert into public.mini_crm_customers", "customer insert"),
        ("insert into public.dealer_customer_contacts", "dealer contact insert"),
        ("revoke all on function public.create_mini_crm_customer_with_dealer_contact", "public execute revoke"),
        ("grant execute on function public.create_mini_crm_customer_with_dealer_contact", "authenticated execute grant"),
    ]:
        assert_contains(migration.lower(), needle.lower(), label)


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


def test_edit_dialog_shows_save_error_inline() -> None:
    assert_contains(mini_crm, "data-bmq-mini-crm-save-feedback", "inline save feedback inside edit dialog")
    assert_contains(mini_crm, 'role="alert"', "accessible save error alert")
    assert_contains(mini_crm, "Lưu thất bại", "save failure state")


if __name__ == "__main__":
    test_mini_crm_loads_dealer_contacts_with_customers()
    test_mini_crm_edit_dialog_has_dealer_contact_fields()
    test_new_customer_setup_has_and_saves_otp_phone()
    test_new_customer_contact_rpc_is_atomic_and_race_safe()
    test_mini_crm_saves_dealer_contacts_to_dedicated_table()
    test_customer_detail_shows_dealer_contacts()
    test_edit_dialog_shows_save_error_inline()
    print("mini CRM dealer contact static checks passed")
