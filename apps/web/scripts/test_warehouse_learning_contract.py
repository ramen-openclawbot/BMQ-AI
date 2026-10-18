#!/usr/bin/env python3
"""Static contract for 20261102240000_warehouse_learning_tan_tao.sql.

The Tân Tạo learner must be one set-based pass over the shared purchase lines
(each purchase counted once), gated exactly like the Q7 learner, and it must
write only public.warehouse_item_learning. The scheduler must run both learners
independently through the service-role claim and be executable by service_role
only. The daily cron job 'warehouse-learn-daily' replaces the Q7-only learning
job. The office-order snapshot must convert receipt quantities like the stock
ledger and must return a 'learned' object per item.

This is a static check: it never touches a database.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261102240000_warehouse_learning_tan_tao.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()
FLAT = re.sub(r"\s+", " ", MIGRATION).strip()


def function_block(name: str) -> str:
    match = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\(",
        MIGRATION,
        re.IGNORECASE,
    )
    assert match, f"missing function public.{name}"
    tail = MIGRATION[match.start():]
    end = tail.find("\n$$;")
    assert end != -1, f"unterminated function public.{name}"
    return tail[:end]


print("== table shape ==")
table_match = re.search(
    r"create\s+table\s+if\s+not\s+exists\s+public\.warehouse_item_learning\s*\((.*?)\n\);",
    MIGRATION,
    re.IGNORECASE | re.DOTALL,
)
assert table_match, "missing table public.warehouse_item_learning"
table = re.sub(r"\s+", " ", table_match.group(1))
assert "id uuid primary key default gen_random_uuid()" in table
assert "location text not null check (location in ('tan_tao'))" in table
assert (
    "kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade"
    in table
), "item FK must cascade"
assert (
    "learned_supplier_id uuid references public.suppliers(id) on delete set null" in table
), "supplier FK must set null"
assert "learned_pack_size numeric(18,4)" in table
assert "learned_pack_label text" in table
assert (
    "learned_lead_time_days integer check (learned_lead_time_days is null or learned_lead_time_days between 0 and 30)"
    in table
), "lead time must be null or 0..30"
assert "learned_cycle_days numeric(8,2)" in table
assert "learned_order_qty numeric(18,3)" in table
assert "learned_daily_usage numeric(18,3)" in table
assert "receipt_days integer not null default 0" in table
assert "last_receipt_date date" in table
assert "learned_at timestamptz not null default now()" in table
assert "unique (location, kitchen_inventory_item_id)" in table, "one row per item and location"

print("== RLS, one select policy, grants ==")
assert "alter table public.warehouse_item_learning enable row level security;" in FLAT
policies = re.findall(r"create\s+policy\s+(\w+)", MIGRATION, re.IGNORECASE)
assert len(policies) == 1, f"exactly one policy expected, got {policies}"
policy_match = re.search(r"create\s+policy.*?;", MIGRATION, re.IGNORECASE | re.DOTALL)
assert policy_match, "unterminated select policy"
policy = re.sub(r"\s+", " ", policy_match.group(0)).lower()
assert "for select" in policy, "the only policy must be select"
assert "to authenticated" in policy, "the select policy must target authenticated"
assert "public.has_role(auth.uid(), 'owner'::app_role)" in policy
assert "public.has_module_permission(auth.uid(), 'inventory', 'view')" in policy
assert "public.has_module_permission(auth.uid(), 'q7_material_inventory', 'view')" in policy
assert "for insert" not in LOWER, "no insert policy"
assert "for update" not in LOWER, "no update policy"
assert "for delete" not in LOWER, "no delete policy"
assert (
    "revoke all on table public.warehouse_item_learning from public, anon, authenticated;"
    in FLAT
)
assert "grant select on table public.warehouse_item_learning to authenticated;" in FLAT
assert "grant all on table public.warehouse_item_learning to service_role;" in FLAT

print("== Tân Tạo learner: permission, source, filters ==")
learner = function_block("learn_tan_tao_purchase_parameters")
learner_lower = learner.lower()
assert "language plpgsql" in learner_lower
assert "security definer" in learner_lower, "learner must be security definer"
assert "set search_path = public, pg_temp" in learner_lower, "learner must pin search_path"
assert "coalesce(auth.role(), '') <> 'service_role'" in learner, "learner must keep the service-role bypass"
assert "raise exception 'actor_required' using errcode = '42501'" in learner
assert "public.has_role(v_actor, 'owner'::app_role)" in learner
assert "public.has_module_permission(v_actor, 'inventory', 'edit')" in learner
assert "raise exception 'insufficient_privilege' using errcode = '42501'" in learner
assert "loop" not in learner_lower, "learner must be set-based, no per-item loop"
assert (
    "public.q7_purchase_usage_purchase_lines(current_date - 120, current_date)"
    in learner
), "learner must read the shared purchase lines for the last 120 days"
assert "l.book_qty is not null" in learner
assert "l.book_qty > 0" in learner
assert "coalesce(kii.pastry_q7, false) = false" in learner, "pastry Q7 items must be excluded"
assert (
    "coalesce(kii.item_class, 'raw_material') in ('raw_material', 'packaging_supply')"
    in learner
), "only raw material and packaging items qualify"
assert "kii.active is true" in learner and "kii.merged_into_id is null" in learner
assert "public.q7_pack_from_name(kii.name, kii.unit)" in learner, "pack must come from the item name"
assert "between 0 and 30" in learner, "lead time window must be 0..30 days"
assert "gr.receipt_date >= current_date - 120" in learner, "lead time uses 120 days of receipts"
assert "l.doc_date >= current_date - 90" in learner, "supplier uses 90 days of purchases"
assert "percentile_cont(0.5)" in learner, "medians must be used"
assert "round(ds.median_day_qty::numeric, 3)" in learner, "order qty is the rounded median day qty"
assert "round(gs.median_gap::numeric, 1)" in learner, "cycle is the rounded median gap"
assert "ds.receipt_days >= 3" in learner, "cycle only when there are three receipt days"
assert "round(ls.median_lead::numeric)::integer" in learner, "lead time is the rounded median"
assert (
    "greatest(30, current_date - ds.first_date + 1)" in FLAT
), "daily usage uses the receipt span with a 30-day floor"

print("== Tân Tạo learner: upsert and stale delete ==")
assert "on conflict (location, kitchen_inventory_item_id) do update set" in learner
for column in (
    "learned_supplier_id",
    "learned_pack_size",
    "learned_pack_label",
    "learned_lead_time_days",
    "learned_cycle_days",
    "learned_order_qty",
    "learned_daily_usage",
    "receipt_days",
    "last_receipt_date",
):
    assert f"{column} = excluded.{column}" in learner, f"upsert must update {column}"
assert "learned_at = now()" in learner, "upsert must refresh learned_at"
assert "delete from public.warehouse_item_learning" in learner, "stale Tân Tạo rows must be deleted"
assert "w.location = 'tan_tao'" in learner
assert "not (w.kitchen_inventory_item_id = any (v_item_ids))" in FLAT
assert "'status', 'learned'" in learner
assert "'location', 'tan_tao'" in learner
assert "'items_updated', v_updated" in FLAT
assert "'items_removed', v_removed" in FLAT

print("== learner grants ==")
assert (
    "revoke all on function public.learn_tan_tao_purchase_parameters() from public, anon;"
    in FLAT
)
assert (
    "grant execute on function public.learn_tan_tao_purchase_parameters() to authenticated, service_role;"
    in FLAT
)

print("== scheduler: service-role claim, independent learners ==")
scheduler = function_block("run_warehouse_learning_scheduled")
scheduler_lower = scheduler.lower()
assert "language plpgsql" in scheduler_lower
assert "security definer" in scheduler_lower
assert "set search_path = public, pg_temp" in scheduler_lower
assert (
    "perform set_config('request.jwt.claim.role', 'service_role', true);" in scheduler
), "scheduler must set the service-role claim"
assert "public.learn_q7_purchase_parameters()" in scheduler
assert "public.learn_tan_tao_purchase_parameters()" in scheduler
assert (
    scheduler.count("exception when others then") == 2
), "each learner must have its own exception block"
assert scheduler.count("'status', 'error', 'error', sqlerrm") == 2, "both failures must be captured"
assert "'q7', v_q7" in scheduler
assert "'tan_tao', v_tan_tao" in scheduler
assert "'ran_at', now()" in scheduler
assert (
    "revoke all on function public.run_warehouse_learning_scheduled() from public, anon, authenticated;"
    in FLAT
)
assert (
    "grant execute on function public.run_warehouse_learning_scheduled() to service_role;"
    in FLAT
)
assert (
    "grant execute on function public.run_warehouse_learning_scheduled() to authenticated"
    not in MIGRATION
), "authenticated must not execute the scheduled wrapper"

print("== cron: daily warehouse learning replaces the Q7-only job ==")
assert "cron.unschedule" in LOWER
assert (
    "jobname in ('q7-auto-purchase-learn-daily', 'warehouse-learn-daily')" in FLAT
), "both old and current learning jobs must be unscheduled"
assert re.search(
    r"cron\.schedule\(\s*'warehouse-learn-daily'\s*,\s*'30 22 \* \* \*'\s*,\s*"
    r"\$job\$\s*select public\.run_warehouse_learning_scheduled\(\);\s*\$job\$",
    MIGRATION,
    re.DOTALL,
), "migration must schedule warehouse-learn-daily at 30 22 * * *"
assert "q7-auto-purchase-daily" not in MIGRATION, "the auto-purchase job must not be mentioned"
assert "enabled = true" not in LOWER, "nothing may enable auto purchase"

print("== snapshot: effective quantity and unit conversion ==")
snapshot = function_block("get_office_order_snapshot")
assert re.search(
    r"public\.get_office_order_snapshot\s*\(\s*p_location text\s*\)\s*"
    r"returns\s+jsonb\s+language\s+plpgsql\s+stable\s+security\s+definer\s+"
    r"set\s+search_path\s*=\s*public,\s*pg_temp",
    snapshot,
    re.IGNORECASE,
), "snapshot signature and properties must stay identical"
assert "public.material_master_jwt_role()" in snapshot, "snapshot must keep its permission check"
assert "not_authenticated" in snapshot
assert (
    "public.goods_receipt_effective_quantity(gi.actual_quantity, gi.quantity, gi.ordered_quantity, gr.status::text)"
    in snapshot
), "receipt quantities must use the effective quantity"
assert "public.stock_unit_line_factor(rl.unit, i.unit)" in snapshot, "the line-unit factor must be used"
assert "public.stock_unit_pack_factor(rl.raw_name, rl.unit, i.unit)" in snapshot, (
    "the pack-name factor must be used"
)
assert (
    "coalesce(public.stock_unit_line_factor(rl.unit, i.unit), public.stock_unit_pack_factor(rl.raw_name, rl.unit, i.unit), a.conversion_factor, 1)"
    in FLAT
), "line unit -> pack name -> alias factor"
assert "coalesce(gi.raw_product_name, gi.product_name) as raw_name" in FLAT
assert "unit_factors" not in snapshot, "a joined per-pair factor CTE made the snapshot 9 s; call the factor inline"

print("== snapshot: learned object per location ==")
assert "'learned', case" in snapshot
assert snapshot.count("'source', 'q7'") == 1, "Q7 learned source"
assert snapshot.count("'source', 'tan_tao'") == 1, "Tân Tạo learned source"
assert "public.q7_purchase_item_settings qs" in snapshot
assert "public.warehouse_item_learning wl" in snapshot
assert "wl.location = 'tan_tao'" in snapshot
assert "'supplier_id', qs.learned_supplier_id" in snapshot
assert "'pack_size', qs.learned_pack_size" in snapshot
assert "'lead_time_days', qs.learned_lead_time_days" in snapshot
assert "'safety_days', qs.learned_safety_days" in snapshot
assert "'supplier_id', wl.learned_supplier_id" in snapshot
assert "'cycle_days', wl.learned_cycle_days" in snapshot
assert "'order_qty', wl.learned_order_qty" in snapshot
assert "'daily_usage', wl.learned_daily_usage" in snapshot
assert "'receipt_days', wl.receipt_days" in snapshot
assert "then null" in snapshot, "an item without a learned row must return null"

print("== snapshot grants stay identical ==")
assert "revoke all on function public.get_office_order_snapshot(text) from public, anon;" in FLAT
assert (
    "grant execute on function public.get_office_order_snapshot(text) to authenticated, service_role;"
    in FLAT
)

print("warehouse learning Tân Tạo contract passed")
