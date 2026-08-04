#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UI = ROOT / "src/pages/NppDebtManagement.tsx"
EXPORT = ROOT / "supabase/functions/export-npp-debt-sheet/index.ts"
PARSER = ROOT / "supabase/functions/revenue-monthly-parse-preview/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260804090000_customer_debt_period_adjustments.sql"


def require(text: str, marker: str, message: str) -> None:
    if marker not in text:
        raise AssertionError(f"{message}: missing {marker!r}")


def main() -> None:
    if not MIGRATION.exists():
        raise AssertionError("customer debt adjustment migration is missing")

    migration = MIGRATION.read_text()
    ui = UI.read_text()
    export = EXPORT.read_text()
    parser = PARSER.read_text()

    # Existing portal parser contract: direct dealers map to their own customer;
    # NPP route lines keep parent/child mapping and source ids for dedup/audit.
    require(parser, "customer_id: routeCustomerId || order.customer_id", "direct dealer customer mapping")
    require(parser, "parent_customer_id: routeCustomerId ? order.customer_id", "NPP parent mapping")
    require(parser, "dealer_order_id: order.id", "portal order audit identity")
    require(parser, "dealer_order_item_id: item.id", "portal item audit identity")

    # Period adjustment storage + audited, permission-gated write path.
    require(migration, "create table if not exists public.customer_debt_period_adjustments", "adjustment table")
    require(migration, "opening_balance_vnd numeric not null default 0", "zero opening default")
    require(migration, "amount_collected_vnd numeric not null default 0", "zero collected default")
    require(migration, "payment_due_date date", "nullable due date")
    require(migration, "unique (customer_id, period_from, period_to)", "one adjustment per customer period")
    require(migration, "revenue_ledger_lines_dealer_order_item_uidx", "portal ledger dedup index")
    require(migration, "raw_payload->>'dealer_order_item_id'", "portal item dedup key")
    require(migration, "approval_status = 'approved'", "dedup permits controlled overwrite after supersede")
    require(migration, "customer_debt_period_adjustment_audit_logs", "adjustment audit log")
    require(migration, "grant select on table public.customer_debt_period_adjustments to authenticated", "read grant")
    require(migration, "upsert_customer_debt_period_adjustment", "audited adjustment RPC")
    require(migration, "has_module_permission(v_actor, 'finance_revenue', 'edit')", "finance edit permission")
    require(migration, "revoke all on function public.upsert_customer_debt_period_adjustment", "RPC default deny")

    # UI only applies manual opening/collection/due fields to direct customers.
    require(ui, 'from("customer_debt_period_adjustments")', "adjustment query")
    require(ui, 'rpc("upsert_customer_debt_period_adjustment"', "adjustment save")
    require(ui, "Dư đầu kỳ", "opening balance field")
    require(ui, "Đã thu", "collected field")
    require(ui, "Hạn thanh toán", "due date field")
    require(ui, "openingBalance + totals.gross - amountCollected", "remaining debt formula")
    require(ui, "!isSelectedNpp", "direct-only adjustment UI guard")

    # Direct customer exports/emails must use the same debt formula; NPP flow remains separate.
    require(export, 'from("customer_debt_period_adjustments")', "export adjustment query")
    require(export, "openingBalance + gross - amountCollected", "export remaining debt formula")
    require(export, '["Dư đầu kỳ"', "export opening row")
    require(export, '["Đã thu"', "export collected row")
    require(export, '["CÔNG NỢ CÒN LẠI"', "export remaining row")

    print("OK: retail dealer debt adjustment contract")


if __name__ == "__main__":
    main()
