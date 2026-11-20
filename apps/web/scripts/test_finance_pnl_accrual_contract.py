#!/usr/bin/env python3
"""Static contract checks for the accrual P&L phase 1 migration.

No database connection is used. The checks guard the read-only shape of
public.finance_pnl_accrual(date), its finance permission gate, the accrual
sources, the estimate flags/totals, and the requirement that the migration
contains no INSERT/UPDATE/DELETE against a business table.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_GLOB = "*_finance_pnl_accrual.sql"
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob(MIGRATION_GLOB))
NET_PROFIT_MIGRATION_GLOB = "*_finance_net_profit_adjustments.sql"
NET_PROFIT_MIGRATIONS = sorted(
    (ROOT / "supabase" / "migrations").glob(NET_PROFIT_MIGRATION_GLOB)
)
DRYRUN = ROOT / "supabase" / "tests" / "finance_pnl_accrual_dryrun.sql"
PRINT_SCRIPT = ROOT / "scripts" / "print_finance_pnl_accrual.mjs"
VERIFY_SCRIPT = ROOT / "scripts" / "verify_finance_pnl_accrual_live.sh"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def migration_sql() -> str:
    assert_true(len(MIGRATIONS) == 1, f"expected one {MIGRATION_GLOB}, found {len(MIGRATIONS)}")
    return read(MIGRATIONS[0])


def net_profit_migration_sql() -> str:
    assert_true(
        len(NET_PROFIT_MIGRATIONS) == 1,
        f"expected one {NET_PROFIT_MIGRATION_GLOB}, found {len(NET_PROFIT_MIGRATIONS)}",
    )
    return read(NET_PROFIT_MIGRATIONS[0])


def function_block(sql: str, name: str, args: str) -> tuple[str, str]:
    marker = f"function public.{name}({args})"
    start = sql.find(marker)
    assert_true(start >= 0, f"missing function public.{name}({args})")
    end = sql.find("$$;", start)
    assert_true(end >= 0, f"missing $$ terminator for public.{name}")
    block = sql[start:end]
    body_start = block.find("as $$")
    assert_true(body_start >= 0, f"missing AS $$ for public.{name}")
    return block[:body_start], block[body_start + len("as $$"):]


def test_migration_is_single_additive_read_only_file() -> None:
    sql = migration_sql()
    lower = sql.lower()

    assert_true("create table" not in lower, "migration must not create tables")
    assert_true("drop table" not in lower, "migration must not drop tables")
    assert_true("truncate" not in lower, "migration must not truncate tables")

    # The only allowed data-changing statements in this task are none. Function
    # creation, grants and comments are schema metadata, not business writes.
    dml = re.findall(
        r"\b(insert\s+into|update\s+[a-z_\"]|delete\s+from|merge\s+into)\b",
        lower,
    )
    assert_true(not dml, f"migration must not write business data, found {dml}")

    assert_true(
        "revoke all on function public.finance_pnl_accrual(date) from public, anon" in lower,
        "public execute must be revoked from public and anon",
    )
    assert_true(
        "grant execute on function public.finance_pnl_accrual(date) to authenticated, service_role" in lower,
        "authenticated/service_role must be able to execute the RPC",
    )
    assert_true(
        re.search(r"grant\s+(insert|update|delete|all)\s+on\s+table", lower) is None,
        "migration must not grant table writes",
    )


def test_public_rpc_contract_and_permission_gate() -> None:
    sql = migration_sql()
    header, body = function_block(sql, "finance_pnl_accrual", "p_month date")
    lower_header = header.lower()

    assert_true("returns jsonb" in lower_header, "finance_pnl_accrual must return jsonb")
    assert_true("security definer" in lower_header, "finance_pnl_accrual must be SECURITY DEFINER")
    assert_true("stable" in lower_header, "finance_pnl_accrual must be STABLE")
    assert_true(
        "set search_path = public, pg_temp" in lower_header,
        "finance_pnl_accrual must pin search_path",
    )
    assert_true(
        re.search(
            r"begin\s+if not public\.finance_can_view\(auth\.uid\(\)\) then\s+"
            r"raise exception 'insufficient_privilege'",
            body.lower(),
        )
        is not None,
        "finance_pnl_accrual must begin with the finance_can_view owner/finance gate",
    )
    assert_true(
        re.search(r"if p_month is null then", body.lower()) is not None,
        "finance_pnl_accrual must reject a null month",
    )


def test_revenue_is_reused_from_finance_month_lines() -> None:
    sql = migration_sql()
    lower = sql.lower()
    assert_true(
        "from public.finance_month_lines(v_start, v_end) ml" in lower,
        "revenue must be read from finance_month_lines",
    )
    assert_true(
        "where ml.section = 'revenue'" in lower,
        "only the finance_month_lines revenue section may feed revenue",
    )
    assert_true(
        "'revenue_ledger'::text as source" in lower,
        "revenue lines must expose the revenue_ledger source",
    )


def test_goods_receipts_accrue_by_receipt_date_once() -> None:
    sql = migration_sql()
    lower = sql.lower()
    for fragment in (
        "from public.goods_receipts gr",
        "gr.receipt_date between p_from and p_to",
        "pr.status::text = 'rejected'",
        "pr.status::text in ('approved', 'pending')",
        "pr.status::text as pr_status",
        "from public.payment_request_items pri",
        "public.goods_receipt_items gri",
        "coalesce(gri.actual_quantity, gri.quantity, 0)",
        "'goods_receipt'::text as source",
        "'accrued on receipt date from pending payment request '",
        "where rl.pr_id is null",
        "gri.canonical_material_id",
        "cost_item_alias_mappings",
    ):
        assert_true(fragment in lower, f"missing receipt accrual fragment: {fragment}")

    assert_true(
        "left join lateral (" in lower and "limit 1" in lower,
        "a receipt must resolve at most one linked approved/pending payment request",
    )
    assert_true(
        "count(distinct x->>'source_id')" in lower,
        "goods receipt output must count distinct receipt source ids",
    )
    assert_true(
        "'rejected_excluded'" in lower,
        "goods_receipts block must report rejected receipts",
    )


def test_approved_requests_without_receipt_are_not_double_counted() -> None:
    sql = migration_sql()
    lower = sql.lower()
    assert_true(
        "'approved_request_without_receipt'::text as source" in lower,
        "approved requests without a receipt need their own source",
    )
    assert_true(
        "from public.goods_receipts gr" in lower
        and "gr.payment_request_id = pr.id" in lower
        and "gr.id = pr.goods_receipt_id" in lower,
        "request-month expenses must exclude requests linked to a goods receipt",
    )
    assert_true(
        "where not rb.is_tuyet_anh" in lower,
        "Tuyết Anh request lines must be excluded from the request-month source",
    )


def test_tuyet_anh_bread_uses_sent_order_snapshot_and_prices() -> None:
    sql = migration_sql()
    lower = sql.lower()
    for fragment in (
        "from public.dealer_order_notifications n",
        "n.notification_type = 'production_bread_order'",
        "n.status = 'sent'",
        "n.digest_date between p_from and p_to",
        "{supplier,billable_quantity}",
        "{vietjet,quantity}",
        "latest_bread_prices",
        "pri.product_name ~* 'lớn'",
        "pri.product_name ~* 'que'",
        "pri.product_name ~* 'tươi'",
        "pri.product_name ~* 'vi[eệ]t[[:space:]]*jet'",
        "pr.status::text <> 'rejected'",
        "status_rank",
        "pr.request_number",
        "'supplier_bread_order'::text as source",
        "excluded_payment_request_amount",
        "variance_vs_paid",
    ):
        assert_true(fragment in lower, f"missing bread accrual fragment: {fragment}")
    assert_true(
        "~* 'tuy[ếệe]t[[:space:]]*anh'" in lower,
        "Tuyết Anh supplier lines must be excluded by supplier identity",
    )
    assert_true(
        "from ' || coalesce(qp.request_number" in lower
        and "from ' || coalesce(vp.request_number" in lower,
        "bread line notes must name the payment request used for the price",
    )


def test_payroll_period_and_last_month_estimate_rules() -> None:
    sql = migration_sql()
    lower = sql.lower()
    for fragment in (
        "from public.payroll_bn_payslips ps",
        "from public.salary_payouts sp",
        "sp.status <> 'cancelled'",
        "finance_pnl_accrual_payroll_family",
        "current_payout_families",
        "current_payslip_employees",
        "current_payslip_period_families",
        "prior_payout_families_missing",
        "payroll_last_month",
        "payout family missing",
        "'payroll_period'::text",
        "is_estimate",
        "prior_payslip_groups",
    ):
        assert_true(fragment in lower, f"missing payroll fragment: {fragment}")


def test_periodic_accrual_policies_and_trailing_average() -> None:
    sql = migration_sql()
    lower = sql.lower()
    assert_true(
        "from public.finance_accrual_policies" in lower,
        "periodic accruals must read finance_accrual_policies",
    )
    for code in ("RENT", "ELECTRICITY", "GAS", "TELECOM", "SOCIAL_INS", "PAYROLL"):
        assert_true(code in sql, f"missing accrual policy code {code}")
    assert_true(
        "code in ('rent', 'electricity', 'gas', 'telecom', 'social_ins')" in lower,
        "the periodic loop must cover only the five configured cost policies",
    )
    policy_loop = lower.split(
        "code in ('rent', 'electricity', 'gas', 'telecom', 'social_ins')", 1
    )[1].split("loop", 1)[0]
    assert_true(
        "'payroll'" not in policy_loop,
        "PAYROLL must be handled by the payroll branch, not the periodic loop",
    )
    assert_true(
        "trailing 3m average" in lower,
        "periodic accruals must document the trailing 3m average",
    )
    assert_true(
        "'source', 'accrual_policy'" in lower
        and "'source_id', v_policy.code" in lower,
        "periodic accruals must use source accrual_policy",
    )


def test_totals_inventory_and_estimate_contract() -> None:
    sql = migration_sql()
    lower = sql.lower()
    for total_key in (
        "revenue",
        "cogs",
        "gross_profit",
        "gross_margin",
        "selling",
        "operating",
        "unclassified",
        "ebitda",
        "ebitda_margin",
        "estimate_total",
        "estimate_lines",
    ):
        assert_true(
            f"'{total_key}'" in lower,
            f"missing totals key {total_key}",
        )
    assert_true(
        "revenue - cogs - selling - operating - unclassified as ebitda" in lower,
        "EBITDA must be gross profit minus selling, operating and unclassified",
    )
    assert_true(
        "'inventory', jsonb_build_object(" in lower
        and "'status', 'not_counted'" in lower
        and "'note', 'chưa trừ chênh lệch tồn kho'" in lower,
        "inventory block must be not_counted with the phase 2 note",
    )
    assert_true(
        "'sections', v_sections" in lower,
        "result must expose the five P&L sections",
    )


def test_existing_finance_functions_are_not_modified() -> None:
    sql = migration_sql()
    lower = sql.lower()
    assert_true(
        re.search(r"create\s+or\s+replace\s+function\s+public\.finance_pnl\s*\(", lower) is None,
        "finance_pnl must not be replaced",
    )
    assert_true(
        re.search(r"create\s+or\s+replace\s+function\s+public\.finance_month_lines\s*\(", lower) is None,
        "finance_month_lines must not be replaced",
    )
    assert_true(
        re.search(r"create\s+or\s+replace\s+function\s+public\.finance_accrual_schedule\s*\(", lower) is None,
        "finance_accrual_schedule must not be replaced",
    )


def test_body_only_live_dryrun_contract() -> None:
    assert_true(DRYRUN.exists(), f"missing {DRYRUN.name}")
    sql = read(DRYRUN)
    lower = sql.lower()
    assert_true("begin;" not in lower, "dry run must not open a transaction itself")
    assert_true("rollback;" not in lower, "dry run must not roll back itself")
    assert_true(
        "set transaction read only" not in lower,
        "dry run must leave transaction control to the verify script",
    )
    assert_true(
        "request.jwt.claim.sub" in lower and "from public.user_roles" in lower,
        "dry run must set the request JWT subject from user_roles",
    )
    assert_true(
        "public.finance_pnl_accrual('2026-10-01')" in lower,
        "dry run must exercise October 2026",
    )
    assert_true(
        "finance_month_lines('2026-10-01', '2026-10-31')" in lower,
        "dry run must reconcile revenue with finance_month_lines",
    )
    for threshold in ("100000", "100000000", "115000000", "80000000", "1230", "2300"):
        assert_true(threshold in sql, f"dry run is missing threshold {threshold}")
    assert_true(
        "source_line_id" in lower and "having count(*) > 1" in lower,
        "dry run must guard duplicate goods receipt source lines",
    )
    assert_true(
        "gross_profit" in lower and "ebitda" in lower,
        "dry run must assert gross profit and EBITDA arithmetic",
    )
    assert_true(
        "lương bh gh" in lower and "lương lẻ bếp tân tạo" in lower,
        "dry run must assert both missing payout families",
    )
    assert_true(
        "'not_counted'" in lower and "'chưa trừ chênh lệch tồn kho'" in lower,
        "dry run must assert the inventory status/note",
    )


def test_verify_script_is_transaction_wrapped_and_cleans_up() -> None:
    assert_true(VERIFY_SCRIPT.exists(), f"missing {VERIFY_SCRIPT.name}")
    source = read(VERIFY_SCRIPT)
    lower = source.lower()
    assert_true("begin;" in lower, "verify script must start a transaction")
    assert_true("rollback;" in lower, "verify script must roll back")
    assert_true("commit;" not in lower, "verify script must never commit")
    assert_true(
        "20261119085657_finance_pnl_accrual.sql" in source
        and "finance_net_profit_adjustments.sql" in source
        and "finance_pnl_accrual_dryrun.sql" in source,
        "verify script must combine both migrations and the body-only check",
    )
    assert_true(
        "supabase db query" in source and "--linked" in source,
        "verify script must run through the linked Supabase project",
    )
    assert_true(
        "finance_manual_adjustments" in source
        and "finance_manual_adjustment_save" in source
        and "finance_manual_adjustment_void" in source
        and "finance_manual_adjustment_month_lines" in source,
        "verify script must assert the new table/functions are gone",
    )
    assert_true(
        "proname like 'finance_pnl_accrual%'" not in source,
        "verify script must not require the pre-existing finance_pnl_accrual* functions to be absent",
    )


def test_print_script_is_read_only_and_calls_the_rpc() -> None:
    assert_true(PRINT_SCRIPT.exists(), f"missing {PRINT_SCRIPT.name}")
    source = read(PRINT_SCRIPT)
    assert_true(
        "finance_pnl_accrual" in source,
        "print script must call finance_pnl_accrual",
    )
    assert_true("2026-10-01" in source, "print script must default to October 2026")
    for write_method in (".insert(", ".update(", ".delete(", ".upsert("):
        assert_true(
            write_method not in source,
            f"print script must not call {write_method}",
        )


def test_manual_adjustment_table_rls_and_no_direct_write_policy() -> None:
    lower = net_profit_migration_sql().lower()

    assert_true(
        "create table if not exists public.finance_manual_adjustments" in lower,
        "new migration must create finance_manual_adjustments",
    )
    for fragment in (
        "id uuid primary key default gen_random_uuid()",
        "kind text not null",
        "'opex',",
        "'depreciation',",
        "'interest',",
        "'other_below_ebitda',",
        "'cit',",
        "'revenue_deduction'",
        "category_code text",
        "label text not null",
        "period_from date not null",
        "period_to date not null",
        "total_amount numeric not null check (total_amount > 0)",
        "source_ref text",
        "note text",
        "status text not null default 'active'",
        "created_by uuid",
        "created_at timestamptz not null default now()",
        "updated_at timestamptz not null default now()",
        "period_from <= period_to",
        "extract(day from period_from) = 1",
        "extract(day from period_to) = 1",
    ):
        assert_true(fragment in lower, f"missing finance_manual_adjustments fragment: {fragment}")

    assert_true(
        "alter table public.finance_manual_adjustments enable row level security" in lower,
        "finance_manual_adjustments must enable RLS",
    )
    assert_true(
        "using (public.finance_can_view_self())" in lower,
        "manual adjustment SELECT must use the self-only finance_can_view_self()",
    )
    assert_true(
        "grant execute on function public.finance_can_view(uuid) to authenticated" not in lower
        and "grant execute on function public.finance_can_view_self() to authenticated" in lower,
        "only the self-only wrapper may be opened to authenticated",
    )

    policies = re.findall(r"create policy.*?;", lower, re.S)
    assert_true(bool(policies), "finance_manual_adjustments needs a SELECT policy")
    assert_true(
        any("for select" in policy and "finance_can_view_self()" in policy for policy in policies),
        "finance_manual_adjustments needs the finance_can_view SELECT policy",
    )
    assert_true(
        not any(
            re.search(r"\bfor\s+(insert|update|delete|all)\b", policy)
            for policy in policies
        ),
        "finance_manual_adjustments must not have direct INSERT/UPDATE/DELETE policies",
    )
    assert_true(
        re.search(
            r"grant\s+(insert|update|delete|all)\s+on\s+public\.finance_manual_adjustments\s+to\s+authenticated",
            lower,
        )
        is None,
        "authenticated must not receive direct write grants on finance_manual_adjustments",
    )


def test_manual_adjustment_rpc_permission_contract() -> None:
    sql = net_profit_migration_sql()
    lower = sql.lower()

    save_header, save_body = function_block(
        sql,
        "finance_manual_adjustment_save",
        "p_id uuid, p_kind text, p_category_code text, p_label text, p_period_from date, p_period_to date, p_total_amount numeric, p_source_ref text, p_note text",
    )
    save_lower = save_body.lower()
    assert_true("returns jsonb" in save_header.lower(), "save RPC must return jsonb")
    assert_true("security definer" in save_header.lower(), "save RPC must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in save_header.lower(),
        "save RPC must pin search_path",
    )
    for fragment in (
        "public.has_role",
        "'owner'",
        "public.has_module_permission",
        "'finance_cost'",
        "'finance_revenue'",
        "'edit'",
        "insufficient_privilege",
        "created_by",
        "auth.uid()",
        "insert into public.finance_manual_adjustments",
        "update public.finance_manual_adjustments",
        "period_from",
        "total_amount",
        "cost_categories",
    ):
        assert_true(fragment in save_lower, f"save RPC is missing {fragment}")

    void_header, void_body = function_block(
        sql, "finance_manual_adjustment_void", "p_id uuid"
    )
    void_lower = void_body.lower()
    assert_true("returns jsonb" in void_header.lower(), "void RPC must return jsonb")
    assert_true("security definer" in void_header.lower(), "void RPC must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in void_header.lower(),
        "void RPC must pin search_path",
    )
    for fragment in (
        "public.has_role",
        "'owner'",
        "public.has_module_permission",
        "'finance_cost'",
        "'finance_revenue'",
        "'edit'",
        "insufficient_privilege",
        "update public.finance_manual_adjustments",
        "status = 'void'",
    ):
        assert_true(fragment in void_lower, f"void RPC is missing {fragment}")

    assert_true(
        "grant execute on function public.finance_manual_adjustment_save(uuid, text, text, text, date, date, numeric, text, text) to authenticated, service_role"
        in lower,
        "save RPC must be executable by authenticated",
    )
    assert_true(
        "grant execute on function public.finance_manual_adjustment_void(uuid) to authenticated, service_role"
        in lower,
        "void RPC must be executable by authenticated",
    )


def test_manual_adjustment_month_allocation_contract() -> None:
    sql = net_profit_migration_sql()
    header, body = function_block(
        sql, "finance_manual_adjustment_month_lines", "p_month date"
    )
    lower = body.lower()
    assert_true("returns table" in header.lower(), "month helper must return a table")
    assert_true("stable" in header.lower(), "month helper must be STABLE")
    assert_true("security definer" in header.lower(), "month helper must be SECURITY DEFINER")
    for fragment in (
        "from public.finance_manual_adjustments a",
        "a.status = 'active'",
        "a.period_from <=",
        "a.period_to >=",
        "month_count",
        "month_index",
        "round(a.total_amount / a.month_count, 0)",
        "a.month_index = a.month_count",
        "a.total_amount",
        "order by a.period_from",
    ):
        assert_true(fragment in lower, f"month helper is missing {fragment}")


def test_net_profit_totals_and_below_ebitda_contract() -> None:
    lower = net_profit_migration_sql().lower()
    for total_key in (
        "depreciation",
        "ebit",
        "interest",
        "other_below_ebitda",
        "ebt",
        "cit",
        "cit_is_estimate",
        "net_profit",
        "net_margin",
    ):
        assert_true(f"'{total_key}'" in lower, f"missing new totals key {total_key}")

    for fragment in (
        "v_ebit := v_ebitda - v_depreciation",
        "v_ebt := v_ebit - v_interest - v_other_below",
        "v_net_profit := v_ebt - v_cit",
        "greatest(v_ebt, 0) * v_cit_rate",
        "from public.finance_report_settings",
        "0.20",
        "below_ebitda",
        "then 'depreciation'",
        "then 'interest'",
        "then 'other_below'",
        "then 'cit'",
        "'source', 'manual_adjustment'",
        "'is_estimate', false",
        "a.kind = 'opex'",
        "a.category_code = v_policy.category_code",
    ):
        assert_true(fragment in lower, f"P&L extension is missing {fragment}")


def test_new_migration_writes_only_manual_adjustments() -> None:
    sql = net_profit_migration_sql()
    clean = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    clean = re.sub(r"--[^\n]*", "", clean)
    clean = re.sub(r"\bfor\s+update\b", "", clean, flags=re.I)

    dml = re.compile(
        r"\b(insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_.\"]*)",
        re.I,
    )
    targets = [match.group(2).strip('"').lower() for match in dml.finditer(clean)]
    assert_true(bool(targets), "new migration should write through its RPCs")
    assert_true(
        all(
            target in ("public.finance_manual_adjustments", "finance_manual_adjustments")
            for target in targets
        ),
        f"new migration may only write finance_manual_adjustments, found {targets}",
    )

    blocks = re.findall(r"as \$\$(.*?)\$\$;", clean, re.S)
    body_text = "\n".join(blocks)
    body_targets = [
        match.group(2).strip('"').lower() for match in dml.finditer(body_text)
    ]
    assert_true(
        targets == body_targets,
        "new migration must perform its writes inside RPC bodies",
    )
    assert_true(
        re.search(r"grant\s+(insert|update|delete|all)\s+on\s+table", clean) is None,
        "new migration must not grant direct table writes",
    )


def test_dryrun_covers_manual_bhxh_and_net_profit() -> None:
    sql = read(DRYRUN)
    lower = sql.lower()
    for fragment in (
        "finance_manual_adjustment_save",
        "finance_manual_adjustment_void",
        "c7_social_insurance",
        "96955830",
        "13850832",
        "13850833",
        "2026-04-01",
        "2026-10-01",
        "cit_is_estimate",
        "net_profit",
        "ebit",
        "ebt",
        "below_ebitda",
    ):
        assert_true(fragment in lower, f"dry run is missing manual-adjustment fragment {fragment}")
