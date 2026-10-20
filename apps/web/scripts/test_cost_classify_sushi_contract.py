#!/usr/bin/env python3
"""Static contract checks for Sushi cost classification.

These checks never connect to a database or Supabase and never run the
migration. They guard that 20261102320000_cost_classify_sushi.sql:
  * replaces every existing constraint check with the old values plus exactly
    the new Sushi value;
  * adds the cost switch / threshold / cap and the worker secret row;
  * writes only through a SECURITY DEFINER, service_role-only RPC that skips
    manual_override / approved, enforces the daily cap and writes both audit
    trails;
  * captures a human override of a Sushi row in robot_feedback;
  * exposes the candidate and feedback readers to service_role only;
  * schedules the four 05:00-05:45 Asia/Saigon runs idempotently;
  * never runs INSERT/UPDATE/DELETE on a business table at migration top level.
"""
from __future__ import annotations

import pathlib
import re

MIGRATION = pathlib.Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20261102320000_cost_classify_sushi.sql"

CLASSIFICATION_OLD = {"rule", "supplier_mapping", "item_mapping", "sku_mapping", "manual_override", "fallback"}
FEEDBACK_OLD = {"alias", "catalog_merge", "catalog_class", "finance_duplicate", "routing", "debt_mark"}
AUTO_ACTIONS_OLD = {"alias", "catalog_class"}
AUDIT_OLD = {"created_by_backfill", "updated_by_rule_refresh", "manual_override", "review_approved", "review_rejected"}


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def function_sql(sql: str, signature: str) -> str:
    start = sql.index(signature)
    end = sql.index("$$;", start) + len("$$;")
    return sql[start:end]


def constraint_values(sql: str, constraint: str) -> set[str]:
    start = sql.index(f"add constraint {constraint}")
    end = sql.index(");", start)
    return set(re.findall(r"'([^']+)'", sql[start:end]))


def main() -> None:
    assert_true(MIGRATION.exists(), "migration 20261102320000_cost_classify_sushi.sql must exist")
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    flat = re.sub(r"\s+", " ", sql)

    # --- 1. constraint replacements keep every old value, add only the new one ---
    assert_true(
        "drop constraint if exists cost_line_classifications_classification_source_check" in sql,
        "must replace the classification_source check",
    )
    source_values = constraint_values(sql, "cost_line_classifications_classification_source_check")
    assert_true(source_values == CLASSIFICATION_OLD | {"sushi"}, f"classification_source values: {source_values}")

    feedback_values = constraint_values(sql, "robot_feedback_kind_check")
    assert_true(feedback_values == FEEDBACK_OLD | {"cost_category"}, f"robot_feedback kinds: {feedback_values}")

    auto_values = constraint_values(sql, "robot_auto_actions_kind_check")
    assert_true(auto_values == AUTO_ACTIONS_OLD | {"cost_category"}, f"robot_auto_actions kinds: {auto_values}")

    audit_values = constraint_values(sql, "cost_classification_audit_logs_action_check")
    assert_true(
        audit_values == AUDIT_OLD | {"created_by_sushi", "updated_by_sushi"},
        f"audit actions: {audit_values}",
    )

    # --- 2. robot_settings + worker secret ---
    for fragment in (
        "cost_threshold numeric not null default 0.95",
        "cost_daily_cap integer not null default 200",
        "cost_auto_enabled boolean not null default true",
    ):
        assert_true(fragment in sql, f"robot_settings must add {fragment}")
    assert_true("cost_threshold >= 0 and cost_threshold <= 1" in sql, "cost_threshold must be 0..1")
    assert_true("cost_daily_cap >= 0" in sql, "cost_daily_cap must be >= 0")

    assert_true("worker_secret uuid not null default gen_random_uuid()" in sql, "secret must be generated in SQL")
    assert_true(
        "insert into public.robot_worker_config (id) values ('sushi-cost') on conflict (id) do nothing" in sql,
        "must register the sushi-cost worker idempotently",
    )
    uuid_literal = re.search(
        r"'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'",
        sql,
    )
    assert_true(uuid_literal is None, "no hardcoded worker secret / uuid literal")

    # --- 3. the apply RPC ---
    apply_sql = function_sql(sql, "create or replace function public.robot_apply_cost_classification(")
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "auth.role()",
        "'service_role'",
        "manual_override",
        "review_status = 'approved'",
        "for update",
        "'cap_reached'",
        "kind = 'cost_category'",
        "count(*)",
        "v_settings.cost_daily_cap",
        "insert into public.cost_classification_audit_logs",
        "'created_by_sushi'",
        "'updated_by_sushi'",
        "insert into public.robot_auto_actions",
        "classification_source = 'sushi'",
        "classification_source = 'sushi',",
        "'needs_review'",
        "'suggested'",
        "unmapped_review",
        "normalize_stock_item_name",
        "p_probability",
        "p_note",
    ):
        assert_true(fragment in apply_sql, f"apply RPC must contain {fragment}")
    assert_true(
        "revoke all on function public.robot_apply_cost_classification(text, uuid, text, numeric, text) from public, anon, authenticated;"
        in flat,
        "apply RPC must be revoked from public/anon/authenticated",
    )
    assert_true(
        "grant execute on function public.robot_apply_cost_classification(text, uuid, text, numeric, text) to service_role;"
        in flat,
        "apply RPC must grant execute to service_role only",
    )
    assert_true(
        "grant execute on function public.robot_apply_cost_classification(text, uuid, text, numeric, text) to authenticated;"
        not in flat,
        "apply RPC must never be granted to authenticated",
    )
    assert_true(
        "grant execute on function public.robot_apply_cost_classification(text, uuid, text, numeric, text) to anon;"
        not in flat,
        "apply RPC must never be granted to anon",
    )

    # --- 4. the feedback trigger on a human manual_override ---
    trigger_sql = function_sql(sql, "create or replace function public.robot_feedback_from_cost_classification(")
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "old.classification_source <> 'sushi'",
        "new.classification_source <> 'manual_override'",
        "old.category_code is not distinct from new.category_code",
        "insert into public.robot_feedback",
        "'cost_category'",
        "on conflict do nothing",
        "source_table",
        "source_id",
        "normalize_stock_item_name",
    ):
        assert_true(fragment in trigger_sql, f"feedback trigger must contain {fragment}")
    assert_true("create trigger robot_feedback_cost_classification" in sql, "feedback trigger must exist")
    assert_true(
        "after update of classification_source, category_code on public.cost_line_classifications" in sql,
        "feedback trigger must fire when the source/category changes",
    )

    # --- 5. candidate and feedback readers ---
    candidates_sql = function_sql(sql, "create or replace function public.cost_classify_sushi_candidates(")
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "auth.role()",
        "payment_request_items",
        "invoice_items",
        "clc.id is null",
        "clc.classification_source in ('fallback', 'rule')",
        "clc.category_code = 'unmapped_review'",
        "clc.review_status <> 'approved'",
        "clc.classification_source <> 'manual_override'",
        "supplier_name",
        "product_name",
        "line_amount",
        "document_date",
        "subject_key",
        "order by c.document_date desc nulls last",
        "limit greatest(1, least(coalesce(p_limit, 50), 50))",
    ):
        assert_true(fragment in candidates_sql, f"candidate reader must contain {fragment}")

    feedback_sql = function_sql(sql, "create or replace function public.cost_classify_sushi_feedback(")
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "auth.role()",
        "p_subject_keys",
        "unnest",
        "robot_feedback",
        "kind = 'cost_category'",
        "limit 5",
    ):
        assert_true(fragment in feedback_sql, f"feedback reader must contain {fragment}")

    for signature, grant_signature in (
        ("public.cost_classify_sushi_candidates(int)", "public.cost_classify_sushi_candidates(int)"),
        ("public.cost_classify_sushi_feedback(text[])", "public.cost_classify_sushi_feedback(text[])"),
    ):
        assert_true(
            f"revoke all on function {signature} from public, anon, authenticated;" in flat,
            f"{signature} must be revoked from public/anon/authenticated",
        )
        assert_true(
            f"grant execute on function {grant_signature} to service_role;" in flat,
            f"{signature} must grant execute to service_role only",
        )
        assert_true(
            f"grant execute on function {grant_signature} to authenticated;" not in flat,
            f"{signature} must never be granted to authenticated",
        )

    # --- 6. the daily cron job is idempotent and uses the worker secret ---
    for fragment in (
        "'sushi-cost-classify-daily'",
        "'0,15,30,45 22 * * *'",
        "cron.unschedule",
        "cron.schedule",
        "net.http_post",
        "x-worker-secret",
        "public.robot_worker_config",
        "where id = 'sushi-cost'",
        "/functions/v1/cost-classify-sushi",
    ):
        assert_true(fragment in sql, f"cron job must contain {fragment}")
    assert_true(
        sql.index("cron.unschedule") < sql.index("cron.schedule"),
        "the job must unschedule the previous run before scheduling the new one",
    )

    # --- 7. no top-level DML on a business table ---
    without_functions = re.sub(
        r"create or replace function\s+public\.\w+\s*\(.*?\n\$\$;",
        "",
        sql,
        flags=re.S,
    )
    without_cron = re.sub(r"do \$schedule\$.*?\$schedule\$;", "", without_functions, flags=re.S)
    top_level_targets = set()
    for match in re.finditer(r"\b(?:insert into|update|delete from)\s+public\.(\w+)", without_cron):
        top_level_targets.add(match.group(1))
    assert_true(
        top_level_targets <= {"robot_worker_config"},
        f"top-level DML must only touch robot_worker_config, got {sorted(top_level_targets)}",
    )

    print("cost_classify_sushi contract: OK")


if __name__ == "__main__":
    main()
