#!/usr/bin/env python3
"""Static contract checks for the Jev duplicate scan feature.

These checks never connect to a database or Supabase and never call Jev. They
guard that the additive migration creates the per-pair table with explicit RLS
and grants and the owner-only review RPC, that the reconciliation view keeps its
seven existing labels and adds jev_possible_duplicate, that the edge function
uses the zero-data-retention TypeSafe gateway contract with a server-side key
only, that dry_run has no write path, that no trigger or cron is added, and that
the client types / lib / hook are wired.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"
FUNCTIONS = ROOT / "supabase" / "functions"
FN = FUNCTIONS / "finance-jev-duplicate-scan"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"
TYPES = ROOT / "src" / "integrations" / "supabase" / "types.ts"
CONFIG = ROOT / "supabase" / "config.toml"

MIGRATION = MIGRATIONS / "20261011150000_finance_jev_duplicate_checks.sql"
SMOKE = TESTS / "finance_jev_duplicate_prod_smoke.sql"

OLD_LABELS = (
    "po_overpaid",
    "po_over_requested",
    "pr_twin_created",
    "paid_without_bank_evidence",
    "paid_without_receipt",
    "receipt_confirmed_delivery_pending",
    "invoice_zero_amount",
)
NEW_LABEL = "jev_possible_duplicate"

COLUMNS = (
    "id",
    "pair_key",
    "pr_older",
    "pr_newer",
    "supplier_id",
    "amount_older",
    "amount_newer",
    "days_apart",
    "state_hash",
    "p_same",
    "relation",
    "relation_prob",
    "relation_confidence",
    "status",
    "model",
    "prompt_version",
    "checked_at",
    "review_decision",
    "review_note",
    "reviewed_by",
    "reviewed_at",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    smoke = read(SMOKE)
    jev = read(FN / "jev.ts")
    handler = read(FN / "handler.ts")
    index = read(FN / "index.ts")
    candidates = read(FN / "candidates.ts")
    state = read(FN / "state.ts")
    policy = read(FN / "policy.ts")
    store = read(FN / "store.ts")
    flags_lib = read(LIB / "finance-reconciliation-flags.ts")
    hook = read(HOOKS / "useJevDuplicateScan.ts")
    types = read(TYPES)
    config = read(CONFIG)
    lower = migration.lower()

    # --- migration name and per-pair table ----------------------------------
    assert_true(
        MIGRATION.name == "20261011150000_finance_jev_duplicate_checks.sql",
        "migration file must keep its timestamped name",
    )
    assert_true(
        "create table if not exists public.finance_jev_duplicate_checks" in lower,
        "migration must create public.finance_jev_duplicate_checks",
    )
    for column in COLUMNS:
        assert_true(column in lower, f"table must declare the {column} column")
    assert_true("pair_key text not null unique" in lower, "pair_key must be unique and not null")
    assert_true(
        "references public.payment_requests(id)" in lower,
        "pr_older / pr_newer must reference payment_requests(id)",
    )
    assert_true(
        "references public.suppliers(id)" in lower,
        "supplier_id must reference suppliers(id)",
    )
    assert_true(
        "check (status in ('auto_clear', 'needs_review', 'auto_flag'))" in lower
        or "check (status in ('auto_clear','needs_review','auto_flag'))" in lower,
        "status must be constrained to the three Jev states",
    )
    assert_true(
        "review_decision in ('same_purchase', 'different_purchase')" in lower
        or "review_decision in ('same_purchase','different_purchase')" in lower,
        "review_decision must be constrained to the two CEO decisions",
    )

    # --- RLS + explicit grants ---------------------------------------------
    assert_true(
        "alter table public.finance_jev_duplicate_checks enable row level security" in lower,
        "table must enable row level security",
    )
    assert_true(
        "revoke all on public.finance_jev_duplicate_checks from public, anon, authenticated" in lower,
        "table must revoke direct client writes",
    )
    assert_true(
        "grant select on public.finance_jev_duplicate_checks to authenticated" in lower,
        "table must grant select to authenticated",
    )
    assert_true(
        "create policy finance_jev_duplicate_checks_select" in lower,
        "table must define a select policy",
    )
    assert_true(
        "public.has_module_permission((select auth.uid()), 'payment_requests', 'view')" in lower,
        "select policy must allow the payment_requests view permission",
    )

    # --- owner-only SECURITY DEFINER review RPC ----------------------------
    assert_true(
        "function public.review_jev_duplicate_check(" in lower,
        "migration must define review_jev_duplicate_check",
    )
    assert_true("security definer" in lower, "the review RPC must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in lower,
        "the review RPC must set search_path = public, pg_temp",
    )
    assert_true(
        "has_role(v_actor, 'owner')" in lower,
        "the review RPC must be owner-only",
    )
    assert_true(
        "revoke all on function public.review_jev_duplicate_check" in lower,
        "the review RPC must revoke default execute",
    )
    assert_true(
        "grant execute on function public.review_jev_duplicate_check" in lower,
        "the review RPC must grant execute explicitly",
    )

    # --- view: seven old labels + the new one, same columns ----------------
    assert_true(
        "create or replace view public.finance_reconciliation_flags" in lower,
        "migration must CREATE OR REPLACE the flag view",
    )
    assert_true("security_invoker = true" in lower, "flag view must stay security_invoker")
    assert_true(
        "grant select on public.finance_reconciliation_flags to authenticated" in lower,
        "flag view must be selectable by authenticated",
    )
    for label in OLD_LABELS:
        assert_true(f"'{label}'" in migration, f"flag view must keep the {label} label")
    assert_true(f"'{NEW_LABEL}'" in migration, "flag view must emit the new jev_possible_duplicate label")
    assert_true(
        "'jev_possible_duplicate:' || c.pair_key" in migration,
        "new flag_key must be jev_possible_duplicate:<pair_key>",
    )
    assert_true(
        "c.status in ('auto_flag', 'needs_review')" in migration,
        "new view branch must only show auto_flag / needs_review rows",
    )
    assert_true(
        "c.review_decision is distinct from 'different_purchase'" in migration,
        "a different_purchase decision must hide the new label",
    )
    assert_true("c.pr_newer as entity_id" in migration, "entity_id must be pr_newer")
    assert_true("prn.request_number as entity_ref" in migration, "entity_ref must be the newer request number")
    assert_true(
        "'supplier:' || coalesce(c.supplier_id::text, '') as group_key" in migration,
        "group_key must be supplier:<supplier_id>",
    )
    for evidence_key in (
        "'older_request'",
        "'newer_request'",
        "'p_same'",
        "'relation'",
        "'days_apart'",
        "'amount_older'",
        "'amount_newer'",
        "'status'",
    ):
        assert_true(evidence_key in migration, f"evidence must carry {evidence_key}")

    # --- no trigger, no cron, no business mutation --------------------------
    assert_true("returns trigger" not in lower, "migration must not create a trigger function")
    assert_true("create trigger" not in lower, "migration must not create a trigger")
    assert_true("cron.schedule" not in lower, "migration must not schedule cron")
    assert_true("pg_cron" not in lower, "migration must not use pg_cron")
    for forbidden in (
        "update public.payment_requests",
        "update public.payment_allocations",
        "update public.payments",
        "update public.purchase_orders",
        "update public.goods_receipts",
        "update public.invoices",
        "delete from public.payment_requests",
        "delete from public.payment_allocations",
        "delete from public.payments",
        "delete from public.purchase_orders",
        "delete from public.goods_receipts",
        "delete from public.invoices",
    ):
        assert_true(forbidden not in lower, f"migration must not mutate business data ({forbidden})")

    # --- edge function: verified gateway contract, server-side key ---------
    assert_true(
        'https://ai-gateway.vercel.sh/v1/evaluate' in jev,
        "jev transport must use the AI Gateway evaluate endpoint",
    )
    assert_true('"typesafe-ai/jev"' in jev, "jev transport must pin the typesafe-ai/jev model")
    assert_true("zeroDataRetention: true" in jev, "provider options must set zeroDataRetention: true")
    assert_true('only: ["typesafe-ai"]' in jev, "provider options must restrict the provider")
    assert_true(
        'type: "noul"' in jev and 'type: "choice"' in jev,
        "the two independent questions must be one noul and one choice",
    )
    assert_true("JEV_MAX_TIMEOUT_MS = 4000" in jev, "each Jev call must be capped at 4000 ms")
    assert_true("createJevCircuit" in jev, "jev transport must have a circuit breaker")
    assert_true(
        'Deno.env.get("AI_GATEWAY_API_KEY")' in index,
        "the AI Gateway key must be read from the server environment in index.ts",
    )
    assert_true(
        "AI_GATEWAY_API_KEY" not in jev,
        "the transport must receive the key as a parameter, not read the environment itself",
    )
    assert_true("serviceRole" in index, "index.ts must use the server-side service role for fixed reads")
    assert_true(
        'Deno.env.get("BMQ_JEV_KILL_SWITCH") === "true"' in index,
        "index.ts must honour the Jev kill switch",
    )

    # --- dry_run has no write path, run upserts by pair_key -----------------
    assert_true(
        'if (input.mode === "run" && rows.length > 0)' in handler,
        "the only write must be guarded by run mode",
    )
    assert_true("upsertChecks" in handler, "run mode must upsert the Jev result")
    assert_true(
        'summary.items = items' in handler,
        "items must only be returned for dry_run",
    )
    for review in ("review_decision", "review_note", "reviewed_by", "reviewed_at"):
        assert_true(
            f"{review}:" not in handler,
            f"the upsert row must not include {review}",
        )
    assert_true(
        'upsert(rows, { onConflict: "pair_key" })' in store,
        "the sink must upsert by pair_key",
    )

    # --- candidate rules and state privacy ----------------------------------
    assert_true("CANDIDATE_AMOUNT_TOLERANCE = 0.05" in candidates, "candidate tolerance must be 5%")
    assert_true("CANDIDATE_MAX_DAYS_APART = 45" in candidates, "candidate max days apart must be 45")
    assert_true("CANDIDATE_MAX_LIMIT = 100" in candidates, "candidate batch limit must be 100")
    assert_true("rejected" in candidates, "candidates must exclude rejected phiếu")
    assert_true("purchase_order_id === right.purchase_order_id" in candidates, "same PO must never pair")
    assert_true("stateHash" in state and "SHA-256" in state, "state hash must be SHA-256")
    for field in (
        "supplier_name",
        "request_number",
        "created_date",
        "total_amount",
        "description",
        "po_number",
        "goods_receipt_number",
        "invoice_number",
        "product_name",
        "unit_price",
        "line_total",
    ):
        assert_true(field in state, f"state must name the {field} field")
    for forbidden in ('"bank_account"', "bankAccount", '"account_number"', '"email"', '"image_url"', '"created_by"'):
        assert_true(forbidden not in state, f"state must not contain {forbidden}")
    assert_true("autoFlag: 0.85" in policy, "auto_flag threshold must be 0.85")
    assert_true("autoClear: 0.15" in policy, "auto_clear threshold must be 0.15")
    assert_true("relationSamePurchase: 0.6" in policy, "relation threshold must be 0.6")
    assert_true(
        "temporary" in policy.lower() and "not calibrated" in policy.lower(),
        "the policy must state the thresholds are provisional and uncalibrated",
    )

    # --- smoke applies the migration inline and covers the cases -----------
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true(migration.strip() in smoke, "smoke must inline the migration byte-for-byte")
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "rls_disabled",
        "rls_policy_missing",
        "anon_insert_grant",
        "a_auto_flag_missing",
        "b_diff_purchase_still_visible",
        "c_same_purchase_missing",
        "d_auto_clear_visible",
        "e_label_missing",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "review_jev_duplicate_check" in smoke,
        "smoke must exercise the owner review RPC",
    )

    # --- config, types, lib and hook ----------------------------------------
    assert_true(
        "[functions.finance-jev-duplicate-scan]" in config,
        "config.toml must declare the finance-jev-duplicate-scan function",
    )
    assert_true(
        "finance_jev_duplicate_checks:" in types,
        "types.ts must declare the finance_jev_duplicate_checks table",
    )
    assert_true(
        "review_jev_duplicate_check:" in types,
        "types.ts must declare the review_jev_duplicate_check RPC",
    )
    assert_true(NEW_LABEL in flags_lib, "the flags lib must know the new label")
    assert_true("Jev nghi chi trùng" in flags_lib, "the flags lib must name the new label in Vietnamese")
    assert_true("export function useRunJevDuplicateScan" in hook, "hook must export useRunJevDuplicateScan")
    assert_true("export function useReviewJevDuplicate" in hook, "hook must export useReviewJevDuplicate")
    assert_true('"finance-jev-duplicate-scan"' in hook, "hook must call the scan function")
    assert_true('"review_jev_duplicate_check"' in hook, "hook must call the review RPC")
    assert_true("invalidateQueries" in hook, "hook must invalidate the flag query")

    print("PASS: finance Jev duplicate scan contracts hold")


if __name__ == "__main__":
    main()
