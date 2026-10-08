#!/usr/bin/env python3
"""Contracts for the manual per-dealer order lock (đại lý nợ công nợ)."""
from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261009150000_dealer_order_lock.sql"
SHARED_LOCK = ROOT / "supabase/functions/_shared/dealer-order-lock.ts"
SHARED_LOCK_TEST = ROOT / "supabase/functions/_shared/dealer-order-lock.test.ts"
SHARED_DEALER = ROOT / "supabase/functions/_shared/dealer.ts"
AUTH_START = ROOT / "supabase/functions/dealer-auth-start/index.ts"
AUTH_VERIFY = ROOT / "supabase/functions/dealer-auth-verify/index.ts"
CATALOG = ROOT / "supabase/functions/dealer-catalog/index.ts"
HISTORY = ROOT / "supabase/functions/dealer-order-history/index.ts"
SUBMIT = ROOT / "supabase/functions/dealer-order-submit/index.ts"
SESSION_STATUS = ROOT / "supabase/functions/dealer-session-status/index.ts"
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
HOOK = ROOT / "src/hooks/useDealerOrderLock.ts"
TYPES = ROOT / "src/integrations/supabase/types.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


class DealerOrderLockContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.migration = read(MIGRATION)
        cls.sql = " ".join(cls.migration.lower().split())
        cls.shared_lock = read(SHARED_LOCK)
        cls.shared_lock_test = read(SHARED_LOCK_TEST)
        cls.shared_dealer = read(SHARED_DEALER)
        cls.auth_start = read(AUTH_START)
        cls.auth_verify = read(AUTH_VERIFY)
        cls.catalog = read(CATALOG)
        cls.history = read(HISTORY)
        cls.submit = read(SUBMIT)
        cls.session_status = read(SESSION_STATUS)
        cls.portal = read(PORTAL)
        cls.hook = read(HOOK)
        cls.types = read(TYPES)

    # -- migration ---------------------------------------------------------
    def test_migration_adds_customer_lock_and_session_reason_columns(self) -> None:
        for marker, label in (
            ("add column if not exists order_locked boolean not null default false", "order_locked column"),
            ("add column if not exists order_locked_at timestamptz", "order_locked_at column"),
            ("add column if not exists order_locked_by uuid", "order_locked_by column"),
            ("add column if not exists order_lock_reason text", "order_lock_reason column"),
            ("alter table public.dealer_sessions", "dealer_sessions alter"),
            ("add column if not exists revoked_reason text", "revoked_reason column"),
        ):
            self.assertIn(marker, self.sql, f"missing {label}")
        self.assertNotRegex(self.sql, r"drop policy|create policy", "migration must not change RLS policies")

    def test_migration_function_is_security_definer_with_locked_search_path(self) -> None:
        for marker in (
            "create or replace function public.set_dealer_order_lock",
            "p_customer_id uuid",
            "p_locked boolean",
            "p_reason text default null",
            "returns jsonb",
            "security definer",
            "set search_path = public, pg_temp",
        ):
            self.assertIn(marker, self.sql)

    def test_migration_requires_owner_or_crm_edit_permission(self) -> None:
        for marker in (
            "public.has_role(auth.uid(), 'owner')",
            "public.has_module_permission(auth.uid(), 'crm', 'edit')",
            "insufficient_privilege",
            "errcode = '42501'",
        ):
            self.assertIn(marker, self.sql)

    def test_migration_locks_customer_row_and_handles_missing_customer(self) -> None:
        self.assertIn("for update", self.sql)
        self.assertIn("customer_not_found", self.sql)
        self.assertIn("errcode = 'p0002'", self.sql)

    def test_migration_revokes_sessions_with_order_locked_reason_only_when_locking(self) -> None:
        self.assertIn("update public.dealer_sessions", self.sql)
        self.assertIn("revoked_reason = 'order_locked'", self.sql)
        self.assertIn("revoked_at is null", self.sql)
        # unlock branch clears the customer fields and never revokes sessions
        self.assertIn("order_locked = false", self.sql)
        self.assertIn("order_locked_at = null", self.sql)
        self.assertIn("order_locked_by = null", self.sql)
        self.assertIn("order_lock_reason = null", self.sql)

    def test_migration_writes_one_audit_row_with_reason_and_revoked_count(self) -> None:
        for marker in (
            "insert into public.audit_logs (actor_id, action, target_id, metadata)",
            "'dealer_order_lock'",
            "'dealer_order_unlock'",
            "'reason'",
            "'revoked_session_count'",
        ):
            self.assertIn(marker, self.sql)

    def test_migration_returns_expected_shape_and_grants(self) -> None:
        for marker in ("'customer_id'", "'order_locked'", "'revoked_sessions'"):
            self.assertIn(marker, self.sql)
        self.assertIn(
            "revoke all on function public.set_dealer_order_lock(uuid, boolean, text) from public, anon",
            self.sql,
        )
        self.assertIn(
            "grant execute on function public.set_dealer_order_lock(uuid, boolean, text) to authenticated, service_role",
            self.sql,
        )

    # -- shared contract ---------------------------------------------------
    def test_shared_lock_module_exports_code_message_and_pure_helpers(self) -> None:
        for marker in (
            'export const DEALER_ORDER_LOCKED_CODE = "dealer_order_locked"',
            "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng.",
            "export function isDealerOrderLocked",
            "export function dealerOrderLockedResponseBody",
        ):
            self.assertIn(marker, self.shared_lock)
        self.assertIn("dealer-order-lock.ts", self.shared_lock_test)

    def test_shared_dealer_session_resolution_includes_order_locked(self) -> None:
        self.assertIn("order_locked?: boolean | null", self.shared_dealer)
        self.assertIn("order_locked)", self.shared_dealer)
        self.assertIn("resolveDealerSessionWithLock", self.shared_dealer)
        self.assertIn("customer?.order_locked === true", self.shared_dealer)
        # After unlock, a session revoked by the old lock must not keep reporting "locked".
        self.assertNotIn('revoked_reason === "order_locked"', self.shared_dealer)

    # -- auth start / verify ----------------------------------------------
    def test_auth_start_skips_otp_for_locked_customer(self) -> None:
        for marker in (
            "order_locked)",
            "isDealerOrderLocked(activeCustomer)",
            "reason: DEALER_ORDER_LOCKED_CODE",
            "code: DEALER_ORDER_LOCKED_CODE",
            "otp_required: false",
            "message: DEALER_ORDER_LOCKED_MESSAGE",
        ):
            self.assertIn(marker, self.auth_start)
        lock_at = self.auth_start.index("isDealerOrderLocked(activeCustomer)")
        first_challenge_read = self.auth_start.index('from("dealer_otp_challenges")')
        self.assertLess(lock_at, first_challenge_read, "lock check must run before any OTP challenge work")

    def test_auth_verify_refuses_locked_customer(self) -> None:
        self.assertIn("order_locked", self.auth_verify)
        self.assertIn("isDealerOrderLocked(customer)", self.auth_verify)
        self.assertIn("dealerOrderLockedResponseBody()", self.auth_verify)
        self.assertIn(", 423)", self.auth_verify)

    # -- dealer endpoints --------------------------------------------------
    def test_catalog_history_and_submit_use_lock_aware_resolution(self) -> None:
        for name, source in (("catalog", self.catalog), ("history", self.history), ("submit", self.submit)):
            self.assertIn("resolveDealerSessionWithLock", source, f"{name} lock-aware resolution")
            self.assertIn("dealerOrderLockedResponseBody()", source, f"{name} locked body")
            self.assertIn(", 423)", source, f"{name} HTTP 423")
            self.assertNotIn("resolveDealerSession,", source, f"{name} must not use the lock-blind resolver")
            self.assertIn('from "../_shared/dealer-order-lock.ts"', source, f"{name} shared lock import")

    def test_submit_checks_lock_before_creating_an_order(self) -> None:
        lock_at = self.submit.index("resolveDealerSessionWithLock")
        self.assertLess(lock_at, self.submit.index('rpc("submit_dealer_order_guarded"'))
        self.assertLess(lock_at, self.submit.index("normalizeItems(body.items)"))

    def test_session_status_endpoint_returns_ok_locked_or_invalid(self) -> None:
        self.assertTrue(SESSION_STATUS.exists(), "missing dealer-session-status function")
        for marker in (
            "extractDealerSessionToken",
            "resolveDealerSessionWithLock",
            "dealerOrderLockedResponseBody()",
            ", 423)",
            "dealer_session_invalid",
            "{ ok: true }",
            "corsPreflightResponse",
        ):
            self.assertIn(marker, self.session_status)

    # -- portal ------------------------------------------------------------
    def test_portal_detects_lock_clears_session_and_shows_owner_message(self) -> None:
        for marker in (
            "dealer_order_locked",
            "orderLockedMessage",
            "data-bmq-dealer-order-locked",
            "isDealerOrderLockedPayload",
            "getFunctionErrorPayload",
            "handlePhoneChange",
            'setOrderLockedMessage("")',
        ):
            self.assertIn(marker, self.portal)
        self.assertIn('"dealer-session-status"', self.portal)

    def test_portal_polls_session_status_on_focus_visibility_and_60_seconds(self) -> None:
        for marker in (
            'window.addEventListener("focus"',
            'document.addEventListener("visibilitychange"',
            'document.visibilityState === "visible"',
            "60000",
            "window.clearInterval",
        ):
            self.assertIn(marker, self.portal)

    def test_portal_reads_submit_423_payload_code(self) -> None:
        submit_slice = self.portal.split('"dealer-order-submit"', 1)[1].split("const handleSubmitOrder", 1)[0]
        self.assertIn("getFunctionErrorPayload", submit_slice)
        self.assertIn("isDealerOrderLockedPayload", submit_slice)

    # -- hook + types ------------------------------------------------------
    def test_hook_calls_rpc_and_invalidates_customer_query(self) -> None:
        self.assertTrue(HOOK.exists(), "missing useDealerOrderLock hook")
        for marker in (
            "set_dealer_order_lock",
            "p_customer_id",
            "p_locked",
            "p_reason",
            "invalidateQueries",
            '"mini-crm-customers"',
        ):
            self.assertIn(marker, self.hook)

    def test_types_expose_new_columns_and_rpc(self) -> None:
        for marker in (
            "order_locked: boolean",
            "order_locked_at: string | null",
            "order_lock_reason: string | null",
            "revoked_reason: string | null",
            "set_dealer_order_lock",
        ):
            self.assertIn(marker, self.types)


if __name__ == "__main__":
    unittest.main()
