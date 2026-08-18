#!/usr/bin/env python3
"""Task6 canonical NVL procurement controller contract tests.

Static contracts intentionally inspect executable SQL and changed Edge/UI paths.
They reject comment-only smoke templates and marker-only implementation.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260817170000_task6_procurement_material_controller.sql"
SMOKE = ROOT / "scripts/material_master/procurement_material_rollback_smoke.sql"
EDGE_CREATE_INVOICE = ROOT / "supabase/functions/create-invoice-from-pr/index.ts"
SHARED_CONTROLLER = ROOT / "supabase/functions/_shared/material-controller.ts"
PO_HOOK = ROOT / "src/hooks/usePurchaseOrders.ts"
PR_HOOK = ROOT / "src/hooks/usePaymentRequests.ts"
INVOICE_HOOK = ROOT / "src/hooks/useInvoices.ts"
CREATE_INVOICE_DIALOG = ROOT / "src/components/dialogs/CreateInvoiceFromRequestDialog.tsx"
ADD_INVOICE_DIALOG = ROOT / "src/components/dialogs/AddInvoiceDialog.tsx"
DRIVE_IMPORT_DIALOG = ROOT / "src/components/payment-requests/DriveImportProgressDialog.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"Missing required file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle}"


def assert_regex(text: str, pattern: str, label: str) -> None:
    assert re.search(pattern, text, re.I | re.S), f"Missing {label}: {pattern}"


def main() -> None:
    sql = read(MIGRATION)
    smoke = read(SMOKE)
    smoke_exec = uncommented(smoke)
    # SQL-only Task6 hardening: frontend/Edge contracts are covered by the parent slice and are intentionally
    # not asserted here because this subtask may only modify SQL and executable smoke contracts.

    for source in ["purchase_order", "payment_request", "invoice", "create_invoice_from_pr"]:
        assert_contains(sql, f"('{source}', 'shadow')", f"shadow config for {source}")

    for rpc in [
        "procurement_material_line_kind",
        "apply_procurement_line_material_resolution",
        "assert_procurement_materials_ready",
        "create_procurement_line_with_material_resolution",
        "update_procurement_document_with_material_controller",
        "approve_payment_request_with_material_controller",
        "update_purchase_order_status_with_material_controller",
        "create_invoice_with_material_controller",
        "create_invoice_from_payment_request",
    ]:
        assert_regex(sql, rf"create or replace function public\.{rpc}\s*\(", f"RPC {rpc}")

    assert "like '%nvl%'" not in sql.lower(), "product-name/category %nvl% heuristics must not be authoritative"
    assert_regex(sql, r"return 'unknown'", "unknown classification is explicit")
    assert_regex(sql, r"v_cost_type\s*=\s*'NVL'", "NVL classification predicate")
    assert_regex(sql, r"v_sku_type\s+in \('raw_material','nvl'\)", "raw SKU classification predicate")
    assert_regex(sql, r"v_sku_type\s+in \('finished_good'", "finished-good classification predicate")
    assert_regex(sql, r"v_cost_type\s+in \('OPEX','OTHER'", "service/non-material predicate")

    assert_regex(sql, r"current_user\s+(?:<>|is\s+distinct\s+from)\s+v_apply_owner[\s\S]*material_master\.procurement_line_resolution", "owner+GUC guard")
    assert "pg_get_functiondef" not in sql, "SECURITY DEFINER readiness/guard must not leak function source"
    assert_regex(sql, r"before insert or update of canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name\s+on public\.purchase_order_items", "PO protected insert/update guard")
    assert_regex(sql, r"on public\.payment_request_items", "PR protected guard")
    assert_regex(sql, r"on public\.invoice_items", "invoice protected guard")
    assert_regex(sql, r"material_resolution_status\s+not in \('resolved_exact'", "strict protected status validation")

    assert_regex(sql, r"guard_procurement_source_identity_history_mutation", "generic source identity/history guard function")
    assert_regex(sql, r"before update of product_name, product_code, unit, sku_id", "source identity drift update guards")
    assert_regex(sql, r"before delete on public\.purchase_order_items", "PO delete history guard")
    assert_regex(sql, r"before delete on public\.payment_request_items", "PR delete history guard")
    assert_regex(sql, r"before delete on public\.invoice_items", "invoice delete history guard")
    assert_regex(sql, r"raise exception 'procurement source identity is immutable once material evidence exists'", "identity drift fails 23514")
    assert_regex(sql, r"raise exception 'procurement source line with material evidence cannot be deleted'", "evidence delete fails 23514")

    edit_po = read(ROOT / "src/components/dialogs/EditPurchaseOrderDialog.tsx")
    edit_pr = read(ROOT / "src/components/dialogs/EditPaymentRequestDialog.tsx")
    typed_rpcs = read(ROOT / "src/lib/material-controller-rpcs.ts")
    invoices_hook = read(ROOT / "src/hooks/useInvoices.ts")
    for label, text, table in [
        ("PO edit", edit_po, "purchase_order_items"),
        ("PR edit", edit_pr, "payment_request_items"),
    ]:
        assert "updateProcurementDocumentWithMaterialController" in text, f"{label} must call typed atomic edit RPC"
        assert f'from("{table}")' not in text, f"{label} must not direct-DML {table}"
        assert ".delete()" not in text and ".insert(" not in text, f"{label} must not delete/reinsert lines"
        assert "Danh tính NVL/sản phẩm đã được chốt" in text, f"{label} immutable identity Vietnamese error"
    assert "update_procurement_document_with_material_controller" in typed_rpcs, "typed wrapper for atomic procurement edit RPC"
    assert "p_source_type" in typed_rpcs and "p_parent_patch" in typed_rpcs and "p_lines" in typed_rpcs, "typed wrapper exact RPC args"
    # Client/SQL boundary must use exact Postgres argument and response names.
    assert "p_reason" not in typed_rpcs and "p_invoice:" not in typed_rpcs
    assert "p_line:" in typed_rpcs and "p_parent:" in typed_rpcs and "p_actor_id:" in typed_rpcs
    assert "result.purchase_order_status" in typed_rpcs and "result.material_master" in typed_rpcs
    assert 'requireEnum(result.status, ["approved"]' in typed_rpcs
    for client_path in [
        ROOT / "src/hooks/usePurchaseOrders.ts",
        ROOT / "src/hooks/usePaymentRequests.ts",
        ROOT / "src/hooks/useInvoices.ts",
        ROOT / "src/components/payment-requests/DriveImportProgressDialog.tsx",
    ]:
        client = read(client_path)
        if "createProcurementLineWithMaterialResolution({" in client:
            assert "sourceType:" in client and "actorId" in client
    assert "useUpdateInvoiceItem" in invoices_hook and "updateProcurementDocumentWithMaterialController" in invoices_hook, "invoice item nonidentity edits use narrow server RPC"
    assert "useDeleteInvoiceItem" in invoices_hook and "throw new Error" in invoices_hook.split("useDeleteInvoiceItem", 1)[1], "invoice item delete fails closed"

    drive_import = read(ROOT / "src/components/payment-requests/DriveImportProgressDialog.tsx")
    add_invoice = read(ROOT / "src/components/dialogs/AddInvoiceDialog.tsx")
    assert drive_import.count("createInvoiceFromPaymentRequestWithMaterialController({") >= 2
    assert ".from('invoices')" not in drive_import and '.from("invoices")' not in drive_import
    assert "copyPRItemsToInvoice" not in drive_import and "invoice_created: true" not in drive_import
    assert "approvePaymentRequestWithMaterialController" in drive_import
    assert "data.payment_request_id" in add_invoice and "createInvoiceFromPaymentRequestWithMaterialController" in add_invoice
    assert '"create_invoice_from_payment_request"' in typed_rpcs
    for exact_arg in ["p_payment_request_id", "p_invoice_number", "p_invoice_date", "p_vat_amount", "p_notes", "p_payment_slip_url", "p_created_by"]:
        assert exact_arg in typed_rpcs

    assert_regex(sql, r"p_expected_material_id uuid default null", "expected material validation argument")
    assert_regex(sql, r"v_request_status\s+not in \('already_resolved','request_existing','request_created'\)", "request status validation")
    assert_regex(sql, r"v_request_resolution_status\s+not in \('resolved_existing','created_new'\)", "terminal request validation")
    assert_regex(sql, r"v_request_resolved_material_id is distinct from v_material_id", "request material equals resolver material")
    assert_regex(sql, r"assert_material_ready\(v_material_id, v_required_caps", "apply asserts readiness")

    assert_regex(sql, r"add column if not exists purchase_order_item_id", "schema-authoritative PR item to PO item FK")
    assert_regex(sql, r"insert into public\.goods_receipt_items[\s\S]*canonical_material_id[\s\S]*poi\.canonical_material_id", "PO to GR canonical copy")
    assert_regex(sql, r"insert into public\.payment_request_items[\s\S]*purchase_order_item_id[\s\S]*poi\.id[\s\S]*poi\.material_resolution_request_id", "PO to PR FK canonical copy")
    assert "pri.notes like" not in sql.lower(), "PO->PR carry must not use notes LIKE"
    assert_regex(sql, r"set_config\('material_master\.goods_receipt_item_resolution'", "PO->GR copy sets Task5 GUC")
    assert_regex(sql, r"set_config\('material_master\.procurement_line_resolution'", "protected PO/PR/invoice copies set Task6 GUC")
    assert_regex(sql, r"insert into public\.invoice_items[\s\S]*canonical_material_id[\s\S]*pr_item\.canonical_material_id", "PR to invoice canonical copy")
    assert_regex(sql, r"assert_procurement_materials_ready\(p_payment_request_id, 'create_invoice_from_pr'", "enforced blocker before invoice creation")
    assert_regex(sql, r"raise exception 'procurement_material_blocked_before_mutation", "fail closed enforced blocker")
    assert_regex(sql, r"p_created_by is not null and p_created_by is distinct from v_actor", "created_by spoofing blocked")
    assert "'invoices', 'edit'" not in sql, "do not invent/use broad invoices module permission"
    assert_regex(sql, r"'finance_cost', 'edit'", "invoice permission uses existing finance_cost scope")

    create_line = sql.split("create or replace function public.create_procurement_line_with_material_resolution", 1)[1].split("revoke execute on function public.create_procurement_line_with_material_resolution", 1)[0]
    assert "p_line jsonb" in create_line and "p_actor_id uuid" in create_line
    assert "actor spoofing is not allowed" in create_line
    assert "source_type must match source table exactly" in create_line
    assert "insert into public.purchase_order_items" in create_line and "canonical_material_id" not in create_line.split("insert into public.purchase_order_items", 1)[1].split("values", 1)[0]
    assert "insert into public.payment_request_items" in create_line and "material_resolution_status" not in create_line.split("insert into public.payment_request_items", 1)[1].split("values", 1)[0]
    assert "insert into public.invoice_items" in create_line and "material_resolution_request_id" not in create_line.split("insert into public.invoice_items", 1)[1].split("values", 1)[0]
    assert "apply_procurement_line_material_resolution" in create_line
    assert "response validation failed" in create_line

    approve = sql.split("create or replace function public.approve_payment_request_with_material_controller", 1)[1].split("revoke execute on function public.approve_payment_request_with_material_controller", 1)[0]
    assert approve.index("for update") < approve.index("assert_procurement_materials_ready") < approve.index("set status = 'approved'")
    assert "payment_request_approval" in approve
    assert "actor spoofing is not allowed" in approve
    assert "process_payment_request_skus" not in approve.lower(), "approval wrapper must not free-name auto-create SKU/master rows"

    assert_regex(sql, r"create trigger trg_guard_purchase_order_material_status_transition[\s\S]*before update of status on public\.purchase_orders", "PO status transition trigger")
    assert_regex(sql, r"material_master\.purchase_order_status_transition", "PO status row GUC")
    assert_regex(sql, r"create trigger trg_guard_payment_request_material_approval[\s\S]*before update of status, payment_method, approved_by, approved_at on public\.payment_requests", "payment approval trigger")
    assert_regex(sql, r"revoke execute on function public\.assert_procurement_materials_ready\(uuid, text, uuid\) from authenticated", "readiness direct auth revoked")

    manual_invoice = sql.split("create or replace function public.create_invoice_with_material_controller", 1)[1].split("revoke execute on function public.create_invoice_with_material_controller", 1)[0]
    assert "p_parent jsonb" in manual_invoice and "p_items jsonb" in manual_invoice
    assert "create_procurement_line_with_material_resolution('invoice_items'" in manual_invoice
    assert manual_invoice.index("insert into public.invoices") < manual_invoice.index("assert_procurement_materials_ready")
    assert "inventory_items" not in manual_invoice.lower() and "standard cost" not in manual_invoice.lower()

    # Runtime smoke is a separate executable file, not a migration comment template.
    assert "Executable rollback smoke template" not in sql
    for marker in [
        "BEGIN;",
        "ROLLBACK;",
        "exact_repeat_unknown_fuzzy_direct_dml",
        "create_procurement_line_with_material_resolution_raw_exact",
        "po_status_send_authority",
        "po_to_gr_carry",
        "pr_to_invoice_carry",
        "enforced_blocker_before_side_effects",
        "shadow_no_false_resolved",
        "manual_invoice_batch_no_inventory_or_standard_cost",
        "protected_history_ledger_counts_unchanged",
        "po_line_identity_drift_direct_update_fails",
        "po_line_delete_with_evidence_fails",
        "po_server_nonidentity_edit_preserves_history",
        "po_server_identity_edit_and_removal_fail_unchanged",
        "pr_server_identity_drift_fails",
        "invoice_item_history_delete_fails",
        "post_rollback_absence",
    ]:
        assert_contains(smoke_exec, marker, f"executable runtime smoke marker {marker}")
    for executable_probe in [
        "apply_procurement_line_material_resolution",
        "create_procurement_line_with_material_resolution",
        "approve_payment_request_with_material_controller",
        "update_purchase_order_status_with_material_controller",
        "create_invoice_with_material_controller",
        "ensure_purchase_order_receipt_queue",
        "create_invoice_from_payment_request",
        "update public.purchase_order_items set canonical_material_id",
        "raise exception 'direct authenticated DML unexpectedly succeeded'",
    ]:
        assert_contains(smoke_exec, executable_probe, f"runtime executable probe {executable_probe}")

    print("Task6 procurement material controller contracts passed")


if __name__ == "__main__":
    main()
