#!/usr/bin/env python3
"""Contracts for server-authoritative dealer test-account isolation."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260827100000_dealer_test_account_isolation.sql"
SHARED = ROOT / "supabase/functions/_shared/dealer.ts"
CATALOG = ROOT / "supabase/functions/dealer-catalog/index.ts"
HISTORY = ROOT / "supabase/functions/dealer-order-history/index.ts"
WAREHOUSE = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
REVENUE = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
AUTH_VERIFY = ROOT / "supabase/functions/dealer-auth-verify/index.ts"
MINI_CRM = ROOT / "src/pages/MiniCrm.tsx"


class DealerTestAccountIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.migration = MIGRATION.read_text(encoding="utf-8") if MIGRATION.exists() else ""
        cls.sql = " ".join(cls.migration.lower().split())
        cls.shared = SHARED.read_text(encoding="utf-8")
        cls.catalog = CATALOG.read_text(encoding="utf-8")
        cls.history = HISTORY.read_text(encoding="utf-8")
        cls.warehouse = WAREHOUSE.read_text(encoding="utf-8")
        cls.revenue = REVENUE.read_text(encoding="utf-8")
        cls.portal = PORTAL.read_text(encoding="utf-8")
        cls.auth_verify = AUTH_VERIFY.read_text(encoding="utf-8")
        cls.mini_crm = MINI_CRM.read_text(encoding="utf-8")

    def test_schema_marks_exact_contact_and_orders_without_customer_wide_flag(self) -> None:
        self.assertIn("add column if not exists is_test boolean not null default false", self.sql)
        self.assertIn("84966998998", self.sql)
        self.assertIn("7f91aba5-9f55-495d-9db7-d52b1e3787b8", self.sql)
        self.assertIn("a2972d83-f60e-4f2f-ad5d-fcec67c11603", self.sql)
        self.assertIn("get diagnostics", self.sql)
        self.assertIn("if v_updated <> 1", self.sql)
        self.assertNotRegex(self.sql, r"alter table public\.mini_crm_customers[^;]+is_test")

    def test_database_derives_order_flag_and_rejects_contact_customer_mismatch(self) -> None:
        self.assertIn("derive_dealer_order_test_flag", self.sql)
        self.assertIn("before insert or update of contact_id, customer_id, is_test", self.sql)
        self.assertIn("new.is_test := coalesce(v_contact_is_test, false)", self.sql)
        self.assertIn("dealer_order_contact_customer_mismatch", self.sql)
        self.assertIn("security definer", self.sql)
        self.assertIn("set search_path = ''", self.sql)

    def test_contact_test_marker_is_server_derived_and_durable(self) -> None:
        self.assertIn("guard_dealer_test_contact", self.sql)
        self.assertIn("approved_dealer_test_contact_protected", self.sql)
        self.assertIn("new.is_test :=", self.sql)
        self.assertIn("before insert or update or delete", self.sql)
        self.assertIn('.eq("is_test", false)', self.mini_crm)
        self.assertIn("contact.is_test !== true", self.mini_crm)

    def test_atomic_submit_separates_test_and_real_duplicate_domains(self) -> None:
        self.assertIn("create or replace function public.submit_dealer_order_guarded", self.sql)
        self.assertIn("v_is_test boolean", self.sql)
        self.assertIn("c.is_test", self.sql)
        self.assertGreaterEqual(self.sql.count("o.is_test = v_is_test"), 2)
        self.assertIn("is_test", self.sql)
        self.assertIn("if not v_is_test then insert into public.dealer_order_notifications", self.sql)
        self.assertIn("auth.role() is distinct from 'service_role'", self.sql)

    def test_client_submission_idempotency_is_partitioned_by_test_domain(self) -> None:
        self.assertIn("drop index if exists public.dealer_orders_client_submission_uidx", self.sql)
        self.assertIn("on public.dealer_orders (customer_id, is_test, client_submission_id)", self.sql)
        idempotency_lookup = re.search(
            r"where o\.customer_id = p_customer_id\s+and o\.client_submission_id = p_client_submission_id(?P<body>.*?)limit 1",
            self.sql,
        )
        if idempotency_lookup is None:
            self.fail("missing client submission idempotency lookup")
        self.assertIn("o.is_test = v_is_test", idempotency_lookup.group("body"))

    def test_test_orders_cannot_create_operational_or_customer_outboxes(self) -> None:
        self.assertIn("suppress_test_dealer_order_notification", self.sql)
        self.assertIn("before insert or update of order_id", self.sql)
        self.assertIn("suppress_test_dealer_customer_confirmation", self.sql)
        self.assertIn("dealer_customer_order_confirmations", self.sql)
        self.assertIn("return null", self.sql)

    def test_claim_paths_and_legacy_rows_fail_closed_for_test_orders(self) -> None:
        self.assertIn("create or replace function public.claim_dealer_order_notifications", self.sql)
        self.assertIn("create or replace function public.claim_dealer_customer_order_confirmations", self.sql)
        self.assertIn("create or replace function public.claim_dealer_order_notification_by_id", self.sql)
        self.assertGreaterEqual(self.sql.count("o.is_test = false"), 4)
        self.assertIn("test_order_isolation", self.sql)
        self.assertIn("status = 'suppressed'", self.sql)

    def test_existing_tan_tao_test_reservations_are_neutralized_without_reversing_stock(self) -> None:
        self.assertIn("test_order_has_posted_tan_tao_movement", self.sql)
        self.assertIn("update public.tan_tao_warehouse_reservations", self.sql)
        self.assertIn("set status = 'cancelled'", self.sql)
        self.assertIn("update public.tan_tao_warehouse_documents", self.sql)
        self.assertIn("v_order.is_test", self.sql)

    def test_session_and_catalog_expose_only_server_derived_test_marker(self) -> None:
        self.assertIn("is_test?: boolean", self.shared)
        self.assertIn("phone_normalized, is_active, is_test", self.shared)
        self.assertIn("is_test: contact.is_test === true", self.shared)
        self.assertIn("publicCustomerProfile(sessionContext.customer, sessionContext.contact)", self.catalog)
        self.assertNotIn("body.is_test", self.catalog)
        self.assertIn('.from("dealer_customer_contacts")', self.auth_verify)
        self.assertIn("publicCustomerProfile(customer, contact)", self.auth_verify)

    def test_history_is_partitioned_by_session_contact_test_flag(self) -> None:
        self.assertIn("const isTestSession = sessionContext.contact?.is_test === true", self.history)
        self.assertGreaterEqual(self.history.count('.eq("is_test", isTestSession)'), 4)
        self.assertIn("p_is_test: isTestSession", self.history)
        self.assertIn("p_is_test boolean default false", self.sql)
        self.assertIn("o.is_test = p_is_test", self.sql)

    def test_revenue_and_operational_aggregates_fail_closed_for_test_orders(self) -> None:
        self.assertGreaterEqual(self.revenue.count('.eq("is_test", false)'), 2)
        self.assertIn("row.is_test === true", self.revenue)
        self.assertGreaterEqual(self.warehouse.count('.eq("is_test", false)'), 2)

    def test_portal_shows_persistent_test_account_warning(self) -> None:
        self.assertIn("is_test?: boolean", self.portal)
        self.assertIn('data-dealer-test-account="true"', self.portal)
        self.assertIn("Tài khoản thử nghiệm", self.portal)
        self.assertIn("không ghi nhận vận hành", self.portal)
        self.assertIn('data.customer?.is_test === true', self.portal)
        self.assertNotIn('setAuthMessage("Đã xác thực đại lý. Quý Khách Hàng có thể gửi đơn thật.")', self.portal)

    def test_new_security_definer_functions_are_not_browser_executable(self) -> None:
        function_names = re.findall(r"create or replace function public\.([a-z0-9_]+)\(", self.sql)
        self.assertTrue(function_names)
        for function_name in set(function_names):
            self.assertIn(f"revoke all on function public.{function_name}", self.sql)


if __name__ == "__main__":
    unittest.main()
