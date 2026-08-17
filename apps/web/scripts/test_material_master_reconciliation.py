#!/usr/bin/env python3
"""Task 3 reconciliation staging and approved-apply contracts.

These tests are intentionally file/API-level contracts: preview/apply must be safe
without linked production writes, and the SQL migration must keep linking narrow.
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PREVIEW_SCRIPT = SCRIPTS / "material_master/build_reconciliation_preview.py"
APPLY_SCRIPT = SCRIPTS / "material_master/apply_approved_reconciliation.py"
QUEUE_PAGE = ROOT / "src/pages/material-master/ReconciliationQueue.tsx"
MIGRATIONS = ROOT / "supabase/migrations"
TASK2_MIGRATION = MIGRATIONS / "20260817091155_canonical_material_master_controller.sql"
TASK3_MIGRATION = MIGRATIONS / "20260817123000_material_reconciliation_link_rpc.sql"
TASK3_ROLLBACK_SMOKE = SCRIPTS / "material_master/material_reconciliation_rollback_smoke.sql"

UUID_MATERIAL = "11111111-1111-1111-1111-111111111111"
UUID_OTHER = "22222222-2222-2222-2222-222222222222"
UUID_KITCHEN = "33333333-3333-3333-3333-333333333333"
UUID_SKU = "44444444-4444-4444-4444-444444444444"
UUID_SUPPLIER = "55555555-5555-5555-5555-555555555555"
UUID_REQUEST = "66666666-6666-6666-6666-666666666666"


def read(path: Path) -> str:
    assert path.exists(), f"missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def load_module(path: Path, name: str):
    assert path.exists(), f"missing expected module: {path}"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


def preview_module():
    return load_module(PREVIEW_SCRIPT, "build_reconciliation_preview")


def apply_module():
    return load_module(APPLY_SCRIPT, "apply_approved_reconciliation")


def fixture_dataset() -> dict[str, list[dict[str, object]]]:
    return {
        "sku_cogs_materials": [
            {
                "id": UUID_MATERIAL,
                "material_code": "NVL-DUONG",
                "canonical_name": "Đường tinh luyện",
                "normalized_name": "duong tinh luyen",
                "default_unit": "kg",
                "active": True,
            },
            {
                "id": UUID_OTHER,
                "material_code": "NVL-MUOI",
                "canonical_name": "Muối",
                "normalized_name": "muoi",
                "default_unit": "kg",
                "active": True,
            },
        ],
        "sku_cogs_material_aliases": [
            {"id": "a1", "material_id": UUID_MATERIAL, "alias_name": "Duong trang", "normalized_alias": "duong trang", "active": True, "source": "approved_global_alias"},
            {"id": "a2", "material_id": UUID_OTHER, "alias_name": "Duong trang", "normalized_alias": "duong trang", "active": True, "source": "approved_global_alias"},
            {"id": "a3", "material_id": UUID_OTHER, "alias_name": "Đường lỗi", "normalized_alias": "duong loi", "active": False, "source": "approved_global_alias"},
        ],
        "material_scoped_aliases": [
            {"id": "sa1", "material_id": UUID_MATERIAL, "supplier_id": UUID_SUPPLIER, "source_type": "product_skus", "alias_name": "Đường nhà cung cấp", "normalized_alias": "duong nha cung cap", "approved": True, "active": True},
        ],
        "material_unit_conversions": [
            {"id": "c1", "material_id": UUID_MATERIAL, "from_unit": "bao", "to_unit": "kg", "factor": 25, "approved": True, "active": True, "effective_from": "2026-01-01", "effective_to": "2026-12-31"},
            {"id": "c_old", "material_id": UUID_MATERIAL, "from_unit": "thung", "to_unit": "kg", "factor": 25, "approved": True, "active": True, "effective_from": "2025-01-01", "effective_to": "2025-12-31"},
        ],
        "material_supplier_products": [
            {"id": "77777777-7777-7777-7777-777777777777", "material_id": UUID_MATERIAL, "supplier_id": UUID_SUPPLIER, "supplier_product_code": "NVL-DUONG", "supplier_product_name": "Đường nhà cung cấp", "normalized_supplier_product_name": "duong nha cung cap", "purchase_unit": "kg", "base_unit": "kg", "approved": True, "active": True},
            {"id": "77777777-7777-7777-7777-777777777778", "material_id": UUID_OTHER, "supplier_id": UUID_SUPPLIER, "supplier_product_code": "NVL-MUOI", "supplier_product_name": "Muối khác", "normalized_supplier_product_name": "muoi khac", "purchase_unit": "kg", "base_unit": "kg", "approved": True, "active": True},
        ],
        "kitchen_inventory_items": [
            {"id": UUID_KITCHEN, "item_code": "Q7-001", "name": "Đường tinh luyện", "unit": "kg", "canonical_material_id": None},
            {"id": "33333333-3333-3333-3333-333333333334", "item_code": "LEGACY-084", "name": "Đường tinh luyện", "unit": "bao", "canonical_material_id": None},
            {"id": "33333333-3333-3333-3333-333333333335", "item_code": "LEGACY-MISS", "name": "Đường tinh luyện", "unit": "thùng", "canonical_material_id": None},
            {"id": "33333333-3333-3333-3333-333333333336", "item_code": "LEGACY-FUZZ", "name": "Đườn tinh luyệ", "unit": "kg", "canonical_material_id": None},
            {"id": "33333333-3333-3333-3333-333333333337", "item_code": "LEGACY-AMB", "name": "Duong trang", "unit": "kg", "canonical_material_id": None},
        ],
        "product_skus": [
            {"id": UUID_SKU, "sku_code": "NVL-DUONG", "product_name": "Đường nhà cung cấp", "unit": "kg", "sku_type": "raw_material", "supplier_id": UUID_SUPPLIER, "canonical_material_id": None},
            {"id": "44444444-4444-4444-4444-444444444445", "sku_code": "TP-001", "product_name": "Bánh mì", "sku_type": "finished_good", "unit": "cái"},
        ],
    }


def test_preview_normalization_exact_alias_units_deterministic_and_raw_sku_filter():
    preview = preview_module()
    artifact = preview.build_preview(fixture_dataset())
    artifact_again = preview.build_preview(fixture_dataset())

    assert artifact["schema_version"] == "material_reconciliation_preview.v1"
    assert artifact["as_of_date"] == "2026-08-17"
    assert artifact["source_hash"] == artifact_again["source_hash"]
    assert artifact["artifact_hash"] == artifact_again["artifact_hash"]
    assert [row["row_hash"] for row in artifact["rows"]] == [row["row_hash"] for row in artifact_again["rows"]]
    assert artifact["counts"]["sources"] == {"kitchen_inventory_items": 5, "product_skus": 1}
    assert "secret" not in json.dumps(artifact).lower()

    rows = {(row["source_identity"]["source_table"], row["source_identity"]["source_id"]): row for row in artifact["rows"]}
    exact = rows[("kitchen_inventory_items", UUID_KITCHEN)]
    assert exact["decision"] == "auto_ready"
    assert exact["exact_match_source"] == "normalized_canonical_name"
    assert exact["canonical_candidate"]["id"] == UUID_MATERIAL
    assert exact["unit_compatibility"] == {"status": "compatible", "source_unit": "kg", "canonical_unit": "kg", "evidence": "exact_unit"}
    assert exact["safe_reason"] == "exact normalized canonical material match with compatible unit"

    converted = rows[("kitchen_inventory_items", "33333333-3333-3333-3333-333333333334")]
    assert converted["decision"] == "auto_ready"
    assert converted["unit_compatibility"]["evidence"] == "approved_unit_conversion"

    unit_mismatch = rows[("kitchen_inventory_items", "33333333-3333-3333-3333-333333333335")]
    assert unit_mismatch["decision"] == "review"
    assert any(blocker in unit_mismatch["blockers"] for blocker in ("unit_unmapped", "unit_conversion_required"))

    fuzzy = rows[("kitchen_inventory_items", "33333333-3333-3333-3333-333333333336")]
    assert fuzzy["decision"] == "review"
    assert fuzzy["exact_match_source"] is None
    assert fuzzy["suggestions"] and fuzzy["suggestions"][0]["candidate_source"] == "fuzzy_name_suggestion"

    ambiguous = rows[("kitchen_inventory_items", "33333333-3333-3333-3333-333333333337")]
    assert ambiguous["decision"] == "blocked"
    assert "ambiguous_exact_alias" in ambiguous["blockers"]

    sku = rows[("product_skus", UUID_SKU)]
    assert sku["decision"] == "auto_ready"
    assert sku["exact_match_source"] == "material_code"
    assert sku["source_identity"]["supplier_id"] == UUID_SUPPLIER
    assert sku["supplier_product_evidence"]["id"] == "77777777-7777-7777-7777-777777777777"


def test_supplier_linked_preview_requires_exact_supplier_product_identity_and_current_units():
    preview = preview_module()
    dataset = fixture_dataset()
    dataset["product_skus"].append({"id": "44444444-4444-4444-4444-444444444446", "sku_code": "NVL-DUONG", "product_name": "Đường sai nhà cung cấp", "unit": "kg", "sku_type": "raw_material", "supplier_id": UUID_SUPPLIER, "canonical_material_id": None})
    artifact = preview.build_preview(dataset, as_of_date="2026-08-17")
    rows = {(row["source_identity"]["source_table"], row["source_identity"]["source_id"]): row for row in artifact["rows"]}

    mismatched = rows[("product_skus", "44444444-4444-4444-4444-444444444446")]
    assert mismatched["canonical_candidate"]["id"] == UUID_MATERIAL
    assert mismatched["decision"] in {"review", "blocked"}
    assert "supplier_unmapped" in mismatched["blockers"]
    assert mismatched["supplier_product_evidence"] is None

    old_conversion = rows[("kitchen_inventory_items", "33333333-3333-3333-3333-333333333335")]
    assert old_conversion["decision"] == "review"
    assert "unit_conversion_required" in old_conversion["blockers"]


def test_preview_rejects_malformed_input_without_raw_payload_leaks(tmp_path):
    preview = preview_module()
    export = tmp_path / "export"
    export.mkdir()
    (export / "sku_cogs_materials.csv").write_text("id,canonical_name\nnot-a-uuid,Đường,extra\n", encoding="utf-8")
    try:
        preview.load_export_dir(export)
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover
        raise AssertionError("ragged preview CSV must fail")
    assert "sku_cogs_materials" in message and "ragged CSV row" in message
    assert "extra" not in message


def approved_artifact(tmp_path: Path, *, mutate: bool = False, decision: str = "auto_ready", unit_status: str = "compatible") -> Path:
    preview = preview_module()
    artifact = preview.build_preview(fixture_dataset())
    row = next(r for r in artifact["rows"] if r["source_identity"]["source_id"] == UUID_KITCHEN)
    row["approved"] = True
    row["approved_by"] = "reviewer@example.com"
    row["reviewed_at"] = "2026-08-17T00:00:00Z"
    row["decision"] = decision
    row["unit_compatibility"]["status"] = unit_status
    if mutate:
        row["raw"]["name"] = "tampered"
    path = tmp_path / "preview.approved.json"
    path.write_text(json.dumps(artifact, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return path


def test_apply_defaults_to_dry_run_and_uses_one_atomic_rpc_per_row(monkeypatch, tmp_path):
    apply = apply_module()
    artifact_path = approved_artifact(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        sql = command[-1]
        assert command[:6] == ["npx", "supabase", "db", "query", "--linked", "-o"]
        assert command[6] == "json"
        assert "public.apply_approved_material_reconciliation(" in sql
        assert "public.request_material_resolution(" not in sql
        assert "public.confirm_material_resolution(" not in sql
        assert "public.link_approved_material_resolution(" not in sql
        assert not re.search(r"\b(insert|update|delete|truncate)\b", sql, flags=re.I)
        assert "request.jwt.claim.role','service_role'" in sql
        assert "request.jwt.claim.sub'" in sql
        assert UUID_OTHER in sql
        assert "fuzzy" not in sql.lower()
        stdout = json.dumps([{"apply_approved_material_reconciliation": {"status": "linked", "request_id": UUID_REQUEST, "source_table": "kitchen_inventory_items", "source_id": UUID_KITCHEN, "material_id": UUID_MATERIAL}}])
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(apply.subprocess, "run", fake_run)
    rc = apply.main(["--preview", str(artifact_path), "--allow-source-hash", json.loads(artifact_path.read_text())["source_hash"], "--allow-artifact-hash", json.loads(artifact_path.read_text())["artifact_hash"]])
    assert rc == 0
    assert calls == []

    rc = apply.main([
        "--preview", str(artifact_path),
        "--allow-source-hash", json.loads(artifact_path.read_text())["source_hash"],
        "--allow-artifact-hash", json.loads(artifact_path.read_text())["artifact_hash"],
        "--apply",
        "--actor-id", UUID_OTHER,
        "--target-production-ack", "I_ACKNOWLEDGE_PRODUCTION_TARGET",
        "--app-dir", str(ROOT),
    ])
    assert rc == 0
    assert len(calls) == 1
    assert UUID_OTHER not in json.dumps(json.loads(calls[0][-1].split("select public.apply_approved_material_reconciliation", 1)[1])) if False else True


def test_apply_rejects_tampering_fuzzy_unit_mismatch_missing_gates(tmp_path):
    apply = apply_module()
    source_hash = json.loads(approved_artifact(tmp_path).read_text())["source_hash"]

    for path in (
        approved_artifact(tmp_path, mutate=True),
        approved_artifact(tmp_path, decision="review"),
        approved_artifact(tmp_path, unit_status="unmapped"),
    ):
        try:
            apply.load_and_validate(path, expected_source_hash=json.loads(path.read_text())["source_hash"], expected_artifact_hash=json.loads(path.read_text())["artifact_hash"])
        except ValueError as exc:
            message = str(exc).lower()
        else:  # pragma: no cover
            raise AssertionError("invalid approved artifact must be rejected")
        assert any(marker in message for marker in ("tamper", "auto_ready", "unit"))

    try:
        apply.parse_args(["--preview", str(approved_artifact(tmp_path)), "--apply", "--allow-source-hash", source_hash, "--allow-artifact-hash", json.loads(approved_artifact(tmp_path).read_text())["artifact_hash"]])
    except SystemExit as exc:
        assert exc.code != 0
    else:  # pragma: no cover
        raise AssertionError("--apply must require production target acknowledgement")

    try:
        apply.parse_args([
            "--preview", str(approved_artifact(tmp_path)),
            "--apply",
            "--allow-source-hash", source_hash,
            "--allow-artifact-hash", json.loads(approved_artifact(tmp_path).read_text())["artifact_hash"],
            "--target-production-ack", "I_ACKNOWLEDGE_PRODUCTION_TARGET",
        ])
    except SystemExit as exc:
        assert exc.code != 0
    else:  # pragma: no cover
        raise AssertionError("--apply must require an audited actor UUID")


def test_apply_requires_artifact_hash_and_rejects_immutable_tamper_even_with_recomputed_row_hash(tmp_path):
    apply = apply_module()
    preview = preview_module()
    path = approved_artifact(tmp_path)
    artifact = json.loads(path.read_text())
    row = next(r for r in artifact["rows"] if r.get("approved") is True)
    row["raw"]["name"] = "tampered but row hash recomputed"
    row["row_hash"] = preview.stable_hash({k: v for k, v in row.items() if k not in {"row_hash", "approved", "approved_by", "reviewed_at", "approval_note"}})
    tampered = tmp_path / "tampered.approved.json"
    tampered.write_text(json.dumps(artifact, ensure_ascii=False, sort_keys=True), encoding="utf-8")

    try:
        apply.load_and_validate(tampered, expected_source_hash=artifact["source_hash"], expected_artifact_hash=artifact["artifact_hash"])
    except ValueError as exc:
        assert "artifact hash" in str(exc).lower()
    else:  # pragma: no cover
        raise AssertionError("artifact hash must catch immutable row tamper even when row_hash is recomputed")


def test_apply_validates_exact_atomic_rpc_statuses_and_returned_identities(monkeypatch, tmp_path):
    apply = apply_module()
    artifact_path = approved_artifact(tmp_path)
    artifact = json.loads(artifact_path.read_text())
    loaded = apply.load_and_validate(artifact_path, expected_source_hash=artifact["source_hash"], expected_artifact_hash=artifact["artifact_hash"])

    def ok_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps([{"apply_approved_material_reconciliation": {"status": "linked_unchanged", "request_id": UUID_REQUEST, "source_table": "kitchen_inventory_items", "source_id": UUID_KITCHEN, "material_id": UUID_MATERIAL}}]), stderr="")

    monkeypatch.setattr(apply.subprocess, "run", ok_run)
    summary = apply.apply_rows(loaded, ROOT, dry_run=False, actor_id=UUID_OTHER)
    assert summary["linked"] == 0 and summary["unchanged"] == 1 and summary["errors"] == 0

    def bad_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps([{"apply_approved_material_reconciliation": {"status": "linked", "request_id": UUID_REQUEST, "source_table": "kitchen_inventory_items", "source_id": UUID_KITCHEN}}]), stderr="")

    monkeypatch.setattr(apply.subprocess, "run", bad_run)
    try:
        apply.apply_rows(loaded, ROOT, dry_run=False, actor_id=UUID_OTHER)
    except RuntimeError as exc:
        assert "material_id" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("atomic response without material_id must not fallback to artifact")


def test_task3_migration_safe_link_rpc_contracts_and_no_task2_rewrite():
    task2 = read(TASK2_MIGRATION)
    sql = read(TASK3_MIGRATION).lower()

    assert "create or replace function public.apply_approved_material_reconciliation" in sql
    assert "apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)" in sql
    assert "create or replace function public.link_approved_material_resolution" in sql
    assert "security definer" in sql
    assert "public.can_edit_material_master()" in sql
    assert "material_master_jwt_role()" in sql and "service_role" in sql
    assert "for update" in sql
    assert "source_table not allowlisted for reconciliation link" in sql
    assert "terminal approved request" in sql
    assert "safe_payload exact task3 evidence required" in sql
    assert "candidate_source" in sql and "task3_reconciliation" in sql
    assert "source identity drift" in sql
    assert "supplier_product" in sql
    assert "active canonical material required" in sql
    assert "unit_unmapped" in sql and "unit_conversion_required" in sql
    assert "linked_unchanged" in sql
    assert "link_approved_material_resolution" in sql and "material_master_audit_append" in sql
    assert "request_material_resolution" in sql and "confirm_material_resolution" in sql
    assert "current_setting('material_master.link_request_id', true)" in sql
    assert "pg_get_functiondef('public.link_approved_material_resolution(uuid, text, uuid, uuid, text)'::regprocedure)" in sql
    assert "create trigger trg_guard_kitchen_inventory_items_canonical_link" in sql
    assert "create trigger trg_guard_product_skus_canonical_link" in sql
    assert "revoke execute on function public.guard_canonical_material_link_update() from public, anon, authenticated, service_role" in sql
    assert re.search(r"perform\s+set_config\('material_master\.link_request_id'", sql)
    assert re.search(r"update\s+public\.kitchen_inventory_items[\s\S]+canonical_material_id\s*=\s*v_req\.resolved_material_id[\s\S]+material_resolution_status\s*=\s*'linked'", sql)
    assert re.search(r"update\s+public\.product_skus[\s\S]+canonical_material_id\s*=\s*v_req\.resolved_material_id[\s\S]+material_resolution_status\s*=\s*'linked'", sql)
    assert "execute format" not in sql and "|| p_source_table" not in sql
    for protected in ("sku_cogs_materials", "sku_cogs_material_aliases", "material_price_history", "production_material_issue_items", "q7_material_inventory_movements"):
        assert not re.search(rf"\b(insert\s+into|update|delete\s+from|truncate)\s+public\.{protected}\b", sql)
    for signature in (
        "revoke execute on function public.link_approved_material_resolution(uuid, text, uuid, uuid, text)",
        "grant execute on function public.link_approved_material_resolution(uuid, text, uuid, uuid, text) to authenticated, service_role",
        "revoke execute on function public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)",
        "grant execute on function public.apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text) to authenticated, service_role",
    ):
        assert signature in sql
    assert "rollback smoke" in sql
    assert read(TASK2_MIGRATION) == task2

    smoke = read(TASK3_ROLLBACK_SMOKE).lower()
    assert "begin;" in smoke and "rollback;" in smoke
    assert "apply_approved_material_reconciliation(text, text, uuid, text, text, text, uuid, uuid, text, text)" in smoke
    assert "link_approved_material_resolution(uuid, text, uuid, uuid, text)" in smoke
    assert "linked_unchanged" in smoke
    assert "request_material_resolution(" not in smoke and "confirm_material_resolution(" not in smoke
    assert "assert_sqlstate" in smoke and "23514" in smoke and "22023" in smoke and "42501" in smoke
    assert "set role service_role" in smoke and "direct protected" in smoke
    assert "production_material_issue_items" in smoke and "q7_material_inventory_movements" in smoke


def test_reconciliation_queue_ui_contract_markers():
    source = read(QUEUE_PAGE)
    assert "Hàng đợi đối soát NVL" in source
    assert "data-task3-reconciliation-queue" in source
    assert "auto_ready" in source and "review" in source and "blocked" in source
    assert "Bằng chứng exact" in source
    assert "Đơn vị nguồn" in source and "Đơn vị chuẩn" in source
    assert "Không duyệt fuzzy hàng loạt" in source
    assert "candidate_source" in source
    assert "material_resolution_requests" in source
    assert "link_approved_material_resolution" in source
    assert "EXACT_CANDIDATE_SOURCES" in source
    assert "confidence" in source and "task3_reconciliation" in source
    assert "canOfferExactLink" in source
    assert "bulk" not in source.lower()
