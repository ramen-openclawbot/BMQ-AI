from __future__ import annotations

import re
from pathlib import Path

MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "web"
    / "supabase"
    / "migrations"
    / "20261102180000_merchant_agent.sql"
)

PROCUREMENT_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "web"
    / "supabase"
    / "migrations"
    / "20261102290000_merchant_analysis_procurement_views.sql"
)

PROCUREMENT_VIEWS = (
    "purchase_orders_v",
    "purchase_order_lines_v",
    "suppliers_v",
    "payment_requests_v",
    "goods_receipts_v",
    "goods_receipt_lines_v",
)


def migration_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").lower()


def procurement_sql() -> str:
    return PROCUREMENT_MIGRATION.read_text(encoding="utf-8").lower()


def view_block(sql: str, view: str) -> str:
    marker = f"create or replace view merchant_analysis.{view} as"
    start = sql.index(marker)
    end = sql.index(";", start)
    return sql[start:end]


def test_staged_changes_has_rls_and_owner_policy() -> None:
    sql = migration_sql()
    assert "alter table public.merchant_staged_changes enable row level security" in sql
    assert "merchant_staged_changes_owner_select" in sql
    assert "public.has_role(auth.uid(), 'owner')" in sql


def test_three_rpcs_are_service_role_only() -> None:
    sql = migration_sql()
    for signature in (
        "public.merchant_analysis_query(text, integer)",
        "public.merchant_apply_price_change(uuid)",
        "public.merchant_apply_announcement(uuid)",
    ):
        assert f"revoke all on function {signature}" in sql
        assert f"grant execute on function {signature}" in sql
    assert sql.count("to service_role;") >= 3
    assert "grant execute on function public.merchant_analysis_query" in sql
    assert "to anon" not in sql.replace("from public, anon, authenticated", "")


def test_merchant_analyst_is_limited_to_analysis_schema() -> None:
    sql = migration_sql()
    assert "create role merchant_analyst nologin" in sql
    assert "revoke all on schema public from merchant_analyst" in sql
    assert "revoke all on all tables in schema public from merchant_analyst" in sql
    assert "grant usage on schema merchant_analysis to merchant_analyst" in sql
    for view in (
        "dealer_orders_v",
        "dealer_order_lines_v",
        "revenue_lines_v",
        "skus_v",
        "dealer_prices_v",
    ):
        assert f"grant select on merchant_analysis.{view} to merchant_analyst" in sql
    assert "set local role merchant_analyst" in sql
    assert "set local search_path = merchant_analysis" in sql


def test_analysis_query_is_read_only_and_bounded() -> None:
    sql = migration_sql()
    assert "set local transaction_read_only = on" in sql
    assert "set local statement_timeout = '5s'" in sql
    assert "least(greatest(coalesce(p_max_rows, 200), 1), 1000)" in sql
    assert "information_schema" in sql
    assert "pg_" in sql
    assert "position(';' in v_body) > 0" in sql


def test_views_filter_test_and_cancelled_orders() -> None:
    sql = migration_sql()
    assert sql.count("d.is_test = false") >= 2
    assert sql.count("d.status <> 'cancelled'") >= 2
    assert "r.approval_status = 'approved'" in sql


def test_apply_rpcs_lock_and_are_idempotent() -> None:
    sql = migration_sql()
    assert sql.count("for update") >= 2
    assert sql.count("if v_change.status = 'applied' then") >= 2
    assert "merchant_apply_price_change" in sql
    assert "mini_crm_customer_price_list" in sql
    assert "dealer_announcements" in sql


def test_procurement_views_exist_and_are_granted_to_analyst() -> None:
    sql = procurement_sql()
    for view in PROCUREMENT_VIEWS:
        assert f"create or replace view merchant_analysis.{view} as" in sql
        assert (
            f"grant select on merchant_analysis.{view} to merchant_analyst" in sql
        )


def test_suppliers_view_has_no_bank_or_contact_columns() -> None:
    block = view_block(procurement_sql(), "suppliers_v")
    for column in (
        "bank_account_name",
        "address",
        "phone",
        "email",
        "contract_url",
        "description",
        "created_by",
    ):
        assert column not in block


def test_procurement_views_are_not_granted_to_anon_or_authenticated() -> None:
    sql = procurement_sql()
    assert "to anon" not in sql
    assert "to authenticated" not in sql
    assert "to public" not in sql
