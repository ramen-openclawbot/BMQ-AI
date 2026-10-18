#!/usr/bin/env python3
"""Static contract for 20261102210000_q7_learning_scheduler_fix.sql.

The daily learning job must run without a JWT through a service-role wrapper,
the pack parser must require a real unit token, the pack size is learned only
from the item name (no fallback from order sizes), and learned lead times ignore
receipts more than 30 days after the PO. The weekly learning job must be gone
and the daily auto-purchase job must not be touched.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_PATH = ROOT / "supabase/migrations/20261102210000_q7_learning_scheduler_fix.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
LOWER = MIGRATION.lower()


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


print("== scheduled wrapper ==")
wrapper = function_block("run_q7_purchase_learning_scheduled")
wrapper_lower = wrapper.lower()
assert "security definer" in wrapper_lower, "wrapper must be security definer"
assert "set search_path = public, pg_temp" in wrapper_lower, "wrapper must pin search_path"
assert (
    "set_config('request.jwt.claim.role', 'service_role', true)" in wrapper
), "wrapper must set the service-role claim"
assert (
    "return public.learn_q7_purchase_parameters();" in wrapper
), "wrapper must call learn_q7_purchase_parameters"

assert (
    "revoke all on function public.run_q7_purchase_learning_scheduled() "
    "from public, anon, authenticated;" in MIGRATION
), "wrapper must be revoked from public, anon and authenticated"
assert (
    "grant execute on function public.run_q7_purchase_learning_scheduled() to service_role;" in MIGRATION
), "wrapper must be granted to service_role"
assert (
    "grant execute on function public.run_q7_purchase_learning_scheduled() to authenticated" not in MIGRATION
), "authenticated must not execute the scheduled wrapper"

print("== learning keeps its permission check ==")
learn = function_block("learn_q7_purchase_parameters")
learn_lower = learn.lower()
assert "actor_required" in learn, "learning must still reject a missing actor"
assert "q7_material_inventory_can_edit" in learn, "learning must keep the edit permission check"
assert "status', 'learned'" in learn or "'learned'" in learn, "learning must still return learned status"

print("== pack size only from the name, lead time capped ==")
assert "mode() within group" not in learn, "pack size must not fall back to the most frequent order size"
assert "v_pack_size := null;" in learn, "an unreadable name must leave the pack size empty"
assert "gr.receipt_date <= po.order_date + 30" in learn, "lead time must ignore receipts > 30 days after the PO"

print("== pack parser requires a unit token ==")
pack = function_block("q7_pack_from_name")
pack_lower = pack.lower()
assert "immutable" in pack_lower, "pack parser must stay immutable"
assert "security definer" in pack_lower, "pack parser must stay security definer"
assert "set search_path = public, pg_temp" in pack_lower, "pack parser must pin search_path"
assert "regexp_matches(" in pack, "pack parser must scan all matches"
assert re.search(r"regexp_matches\([^;]+?'g'\s*\)", pack, re.DOTALL), "pack parser must use the 'g' flag"
assert (
    "(kg|g|gr|gram|l|lit|ml|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi)"
    in pack
), "pack parser must require a known unit token"
assert "(?![[:alpha:]])" in pack, "unit token must be followed by a non-letter or end"
assert "return null;" in pack_lower, "pack parser must return null when nothing qualifies"

print("== daily schedule replaces the weekly learning job ==")
assert "jobname = 'q7-auto-purchase-learn-weekly'" in MIGRATION, "weekly job must be unscheduled"
assert "jobname = 'q7-auto-purchase-learn-daily'" in MIGRATION, "daily job must be unscheduled first"
assert "cron.unschedule" in LOWER, "migration must unschedule old jobs"
assert re.search(
    r"cron\.schedule\(\s*'q7-auto-purchase-learn-daily'\s*,\s*'30 22 \* \* \*'\s*,\s*"
    r"\$job\$\s*select public\.run_q7_purchase_learning_scheduled\(\);\s*\$job\$",
    MIGRATION,
    re.DOTALL,
), "migration must schedule the daily wrapper at 30 22 * * *"
assert "q7-auto-purchase-daily" not in MIGRATION, "the existing daily auto-purchase job must not be touched"

print("== additive-only migration ==")
for forbidden in ("create table", "alter table", "enabled = true"):
    assert forbidden not in LOWER, f"migration must not contain {forbidden!r}"

print("q7 learning scheduler contract passed")
