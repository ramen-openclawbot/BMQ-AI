#!/usr/bin/env python3
"""Static contract checks for the BMQ finance module phase 1 migration.

No database or Supabase connection is used. The checks guard the read-only
shape of the five public JSON RPCs, their explicit grants, the controlled
revenue filter, the unclassified routing, the no-plug AP foot, and the
required English driver/accrual wording.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102450000_finance_module.sql"

RPCS = {
    "finance_pnl": ("p_from date", "p_to date"),
    "finance_variance": ("p_month date",),
    "finance_ap_rollforward": ("p_month date",),
    "finance_accrual_schedule": ("p_month date",),
    "finance_close_checklist": ("p_month date",),
}

CONFIG_TABLES = {
    "public.finance_report_settings",
    "public.finance_accrual_policies",
}


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def function_block(sql: str, name: str) -> tuple[str, str]:
    """Return (header, body) for a create-or-replace function using $$ quotes."""
    marker = f"function public.{name}("
    start = sql.find(marker)
    assert_true(start >= 0, f"missing function public.{name}")
    end = sql.find("$$;", start)
    assert_true(end >= 0, f"missing $$ terminator for public.{name}")
    block = sql[start:end]
    body_start = block.find("as $$")
    assert_true(body_start >= 0, f"missing AS $$ for public.{name}")
    return block[:body_start], block[body_start + len("as $$"):]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    sql = read(MIGRATION)
    lower = sql.lower()

    # --- configuration tables, RLS, and singleton seed ----------------------
    assert_true(
        "create table if not exists public.finance_report_settings" in lower,
        "migration must create finance_report_settings",
    )
    assert_true(
        "id boolean primary key default true check (id)" in lower,
        "finance_report_settings must be a boolean singleton",
    )
    assert_true(
        "create table if not exists public.finance_accrual_policies" in lower,
        "migration must create finance_accrual_policies",
    )
    assert_true(
        "references public.cost_categories(code)" in lower,
        "accrual policy category_code must reference cost_categories(code)",
    )
    for policy in (
        ("RENT", "C1_WAREHOUSE_RENT"),
        ("ELECTRICITY", "C2_ELECTRICITY"),
        ("GAS", "C4_GAS"),
        ("TELECOM", "C5_TELECOM"),
        ("SOCIAL_INS", "C7_SOCIAL_INSURANCE"),
        ("PAYROLL", "C6_PAYROLL"),
    ):
        assert_true(
            f"('{policy[0]}'" in sql and f"'{policy[1]}'" in sql,
            f"missing accrual policy seed {policy[0]} -> {policy[1]}",
        )
    assert_true(
        "basis_method in ('trailing_3m_avg', 'payroll_last_month')" in lower,
        "basis_method must be constrained to the two supported methods",
    )
    for table in ("finance_report_settings", "finance_accrual_policies"):
        assert_true(
            f"alter table public.{table} enable row level security" in lower,
            f"{table} must enable RLS",
        )
        assert_true(
            f"revoke all on public.{table} from public, anon, authenticated" in lower,
            f"{table} must revoke direct client writes",
        )
        assert_true(
            f"grant select on public.{table} to authenticated" in lower,
            f"{table} must be selectable by authenticated",
        )
        assert_true(
            f"grant all on public.{table} to service_role" in lower,
            f"{table} must be writable by service_role",
        )

    # --- private access helper ---------------------------------------------
    helper_header, helper_body = function_block(sql, "finance_can_view")
    assert_true("security definer" in helper_header.lower(), "finance_can_view must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in helper_header.lower(),
        "finance_can_view must pin search_path",
    )
    for predicate in (
        "public.has_role(p_user, 'owner')",
        "public.has_module_permission(p_user, 'finance_cost', 'view')",
        "public.has_module_permission(p_user, 'finance_revenue', 'view')",
    ):
        assert_true(predicate.lower() in helper_body.lower(), f"finance_can_view missing {predicate}")

    # --- five public RPC signatures and bodies -----------------------------
    bodies: list[str] = []
    for name, params in RPCS.items():
        header, body = function_block(sql, name)
        visible = f"function public.{name}({', '.join(params)})"
        assert_true(visible in header.lower(), f"{name} must have signature {visible}")
        assert_true("security definer" in header.lower(), f"{name} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in header.lower(),
            f"{name} must pin search_path",
        )
        assert_true(
            re.search(
                r"\bbegin\s+if not public\.finance_can_view\(auth\.uid\(\)\) then\s+"
                r"raise exception 'insufficient_privilege'",
                body.lower(),
            )
            is not None,
            f"{name} must start with the finance_can_view check",
        )
        bodies.append(body)
        assert_true(
            re.search(
                rf"revoke all on function public\.{name}\s*\([^;]*?\)\s+from\s+public,\s*anon;",
                lower,
            )
            is not None,
            f"{name} must revoke public and anon execute",
        )
        assert_true(
            re.search(
                rf"grant execute on function public\.{name}\s*\([^;]*?\)\s+"
                r"to\s+authenticated,\s*service_role;",
                lower,
            )
            is not None,
            f"{name} must grant execute to authenticated and service_role",
        )

    # --- grants never include anon -----------------------------------------
    assert_true(
        re.search(r"grant\s+execute\s+on\s+function[^;]*\bto\b[^;]*\banon\b", lower)
        is None,
        "no function may be granted to anon",
    )

    # --- write lock-down ----------------------------------------------------
    # Strip dollar-quoted function bodies, then allow only the two config seeds
    # at top level. No function body may write at all.
    top_level = re.sub(r"as\s+\$\$.*?\$\$;", "", sql, flags=re.S | re.I)
    writes = re.findall(
        r"\b(insert\s+into|update|delete\s+from)\s+([a-zA-Z0-9_.\"]+)",
        top_level,
        flags=re.I,
    )
    for verb, target in writes:
        assert_true(
            target.lower() in CONFIG_TABLES,
            f"unexpected top-level write: {verb} {target}",
        )
    assert_true(
        all(
            re.search(r"\b(insert|update|delete)\b", body, flags=re.I) is None
            for body in bodies
        ),
        "public RPC bodies must not contain insert/update/delete",
    )

    # --- controlled revenue filter -----------------------------------------
    assert_true(
        "d.status in ('controlled', 'trusted')" in lower,
        "revenue must use controlled/trusted source documents",
    )
    assert_true(
        "l.approval_status = 'approved'" in lower,
        "revenue must require approval_status approved",
    )

    # --- unclassified routing ----------------------------------------------
    assert_true(
        "d.category_code = 'unmapped_review'" in lower,
        "UNMAPPED_REVIEW must be routed explicitly",
    )
    assert_true(
        "coalesce(cc.is_active, false) = false" in lower,
        "inactive categories must be detected",
    )
    assert_true(
        "then 'unclassified'" in lower,
        "UNMAPPED_REVIEW and inactive categories must route to unclassified",
    )
    for label in (
        "Bread purchased (finished)",
        "Meat & offal",
        "Pork floss & fillings",
        "Dairy, butter & eggs",
        "Dry goods & spices",
        "Fresh produce",
        "Packaging & labels",
        "Delivery",
        "Kiosk rent",
        "Marketing",
        "Platform fees",
        "Warehouse & kitchen rent",
        "Electricity",
        "Water & waste",
        "Gas",
        "Internet & phone",
        "Payroll",
        "Social insurance",
        "Repairs & maintenance",
        "Tools & cleaning",
        "One-off & relocation",
        "Bank fees, tax & other",
        "Construction & fit-out",
        "Equipment",
    ):
        assert_true(label in sql, f"missing English leaf label: {label}")

    # --- capex stays outside EBITDA ----------------------------------------
    assert_true(
        "when parent.code = 'd_investment' then 'capex'" in lower,
        "D_INVESTMENT must map to capex",
    )
    assert_true(
        "gross_profit - coalesce(selling, 0) - coalesce(operating, 0) - coalesce(unclassified, 0)" in lower,
        "EBITDA must subtract only the operating sections",
    )
    assert_true(
        "jsonb_build_object('revenue', 1, 'cogs', -1, 'selling', -1, 'operating', -1, 'unclassified', -1)"
        in lower,
        "variance EBITDA driver signs must exclude capex",
    )

    # --- variance wording and no plugged AP foot ---------------------------
    assert_true(
        "Driver unclear — flag for controller." in sql,
        "variance must emit the deterministic unclear-driver text",
    )
    assert_true("abs(v_diff) < 1" in lower, "AP foot must use a strict abs(diff) < 1 test")
    assert_true(
        "unexplained_delta" in lower,
        "AP foot must report unexplained_delta",
    )
    assert_true(
        "v_closing_computed := v_opening + v_additions - v_payments - v_adjustments" in lower,
        "closing_computed must be the formula, not a plug",
    )
    assert_true(
        "v_closing_computed := v_closing_actual" not in lower,
        "closing_computed must never be assigned closing_actual",
    )

    # --- accrual status -----------------------------------------------------
    assert_true(
        "'draft — not posted'" in sql,
        "accrual policies must carry status draft — not posted",
    )
    assert_true(
        "reverses on day 1 of next period" in lower,
        "auto-reversing accruals must state the reversal in the memo",
    )

    print("finance module contract: OK")


if __name__ == "__main__":
    main()
