#!/usr/bin/env python3
"""Static contract for 20261102220000_purchase_pattern_flags.sql.

Checks that the reconciliation view keeps all existing labels and columns, adds
the four purchase-pattern labels with the expected thresholds and windows, and
computes them in one SECURITY DEFINER function (a materialized set-based
pattern_lines CTE) that applies the payment_requests read permission once.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261102220000_purchase_pattern_flags.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()

OLD_LABELS = (
    "po_overpaid",
    "po_over_requested",
    "pr_twin_created",
    "paid_without_bank_evidence",
    "paid_without_receipt",
    "receipt_confirmed_delivery_pending",
    "invoice_zero_amount",
    "jev_possible_duplicate",
)
NEW_LABELS = (
    "price_above_usual",
    "quantity_above_usual",
    "ordered_before_cycle",
    "new_supplier_for_item",
)

print("== view shape and grants ==")
assert "create or replace view public.finance_reconciliation_flags" in LOWER
assert "with (security_invoker = true)" in LOWER, "view must stay security_invoker"
assert (
    "left join public.finance_reconciliation_reviews r on r.flag_key = f.flag_key" in LOWER
), "review join must remain"
assert (
    "revoke all on public.finance_reconciliation_flags from public, anon;" in LOWER
), "view must be revoked from public and anon"
assert (
    "grant select on public.finance_reconciliation_flags to authenticated;" in LOWER
), "view must be selectable by authenticated"
for column in (
    "f.flag_key",
    "f.label",
    "f.priority",
    "f.category",
    "f.entity_type",
    "f.entity_id",
    "f.entity_ref",
    "f.supplier_id",
    "f.supplier_name",
    "f.group_key",
    "f.amount",
    "f.evidence",
    "f.detected_at",
    "r.status as review_status",
    "r.note as review_note",
):
    assert column in LOWER, f"final select must keep {column}"

print("== existing labels are preserved ==")
for label in OLD_LABELS:
    assert f"'{label}'" in MIGRATION, f"missing existing label {label}"

print("== four new labels and pending-only current lines ==")
for label in NEW_LABELS:
    assert f"'{label}'" in MIGRATION, f"missing new label {label}"
assert "where pr.status::text = 'pending'" in LOWER, "current lines must be pending only"

print("== windows and thresholds ==")
assert "interval '365 days'" in LOWER, "history must be limited to 365 days"
assert "1.15" in MIGRATION, "price threshold 1.15 missing"
assert "1.25" in MIGRATION, "price high threshold 1.25 missing"
assert ">= 2 *" in MIGRATION, "quantity threshold 2 missing"
assert ">= 3 *" in MIGRATION, "quantity high threshold 3 missing"
assert "< 0.5 *" in MIGRATION, "cycle threshold 0.5 missing"
assert "median_gap >= 7" in MIGRATION, "cycle rule must only cover items bought every >= 7 days"

print("== set-based materialized pattern lines ==")
assert "pattern_lines as materialized" in LOWER, "pattern_lines must be materialized"
assert MIGRATION.count("public.normalize_stock_item_name(") == 1, (
    "normalize_stock_item_name must be evaluated once, inside pattern_lines"
)
assert "cross join lateral" not in LOWER, "new baselines must not be correlated per row"
assert "percentile_cont(0.5)" in LOWER, "medians must be computed with percentile_cont"

print("== definer function with the payment_requests read permission ==")
FUNCTIONS = re.findall(r"create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)", LOWER)
assert FUNCTIONS == ["finance_purchase_pattern_flag_rows"], f"unexpected functions {FUNCTIONS}"
fn = LOWER[LOWER.index("create or replace function public.finance_purchase_pattern_flag_rows"):LOWER.index("create or replace view")]
assert "security definer" in fn and "set search_path = public, pg_temp" in fn, "function must be a pinned definer"
assert "stable" in fn, "function must be stable"
assert "public.has_role(v_uid, 'owner'::app_role)" in fn, "owner must be allowed"
assert "public.has_module_permission(v_uid, 'payment_requests'::text, 'view'::text)" in fn, (
    "payment_requests view permission must be required"
)
assert "then\n    return;" in fn, "callers without the permission must get no rows"
assert (
    "revoke all on function public.finance_purchase_pattern_flag_rows() from public, anon;" in LOWER
), "function must be revoked from public and anon"
assert (
    "grant execute on function public.finance_purchase_pattern_flag_rows() to authenticated, service_role;" in LOWER
), "function must be executable by authenticated and service_role"
view = LOWER[LOWER.index("create or replace view"):]
assert "from public.finance_purchase_pattern_flag_rows() pp" in view, "view must append the function rows"
assert "pattern_lines" not in view, "baselines must not run inside the security_invoker view"

print("== additive-only migration ==")
for forbidden in ("create table", "create trigger", "alter table"):
    assert forbidden not in LOWER, f"migration must not contain {forbidden!r}"

print("purchase pattern flags contract passed")
