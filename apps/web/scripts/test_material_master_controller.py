#!/usr/bin/env python3
"""Task 1 RED contracts for the planned Canonical NVL Master Controller.

These tests intentionally describe the Task 2+ server-side foundation before it
exists. Keep audit utility tests GREEN; keep controller contracts RED until the
migration/RPC/controller is implemented.
"""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
MIGRATIONS = ROOT / "supabase/migrations"
SKU_COST_PAGE = ROOT / "src/pages/SkuCostsManagement.tsx"
GOODS_RECEIPT_DIALOG = ROOT / "src/components/dialogs/GoodsReceiptDetailsDialog.tsx"
PURCHASE_ORDERS_PAGE = ROOT / "src/pages/PurchaseOrders.tsx"
PURCHASE_ORDER_DETAILS = ROOT / "src/components/dialogs/PurchaseOrderDetailsDialog.tsx"
PURCHASE_ORDER_HOOK = ROOT / "src/hooks/usePurchaseOrders.ts"
GOODS_RECEIPT_HOOK = ROOT / "src/hooks/useGoodsReceipts.ts"
MATCH_DELIVERY_NOTE = ROOT / "supabase/functions/match-delivery-note/index.ts"
SCAN_SKU_COST_SHEET = ROOT / "supabase/functions/scan-sku-cost-sheet/index.ts"
AUDIT_SCRIPT = SCRIPTS / "material_master/audit_material_master.py"
ROLLBACK_SMOKE = SCRIPTS / "material_master/material_master_rollback_smoke.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected source file: {path}"
    return path.read_text(encoding="utf-8")


def migration_sql() -> str:
    chunks: list[str] = []
    assert MIGRATIONS.exists(), f"Missing migrations directory: {MIGRATIONS}"
    for path in sorted(MIGRATIONS.glob("*.sql")):
        chunks.append(f"\n-- {path.name}\n")
        chunks.append(path.read_text(encoding="utf-8"))
    return "\n".join(chunks)


def split_sql_statements(sql: str) -> list[str]:
    """Split SQL on statement semicolons outside strings/comments."""
    statements: list[str] = []
    buf: list[str] = []
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    dollar_tag: str | None = None
    i = 0
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            buf.append(ch)
            if ch == "*" and nxt == "/":
                buf.append(nxt)
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue
        if dollar_tag:
            if sql.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
            else:
                buf.append(ch)
                i += 1
            continue
        if not in_single and not in_double:
            if ch == "-" and nxt == "-":
                buf.extend([ch, nxt])
                in_line_comment = True
                i += 2
                continue
            if ch == "/" and nxt == "*":
                buf.extend([ch, nxt])
                in_block_comment = True
                i += 2
                continue
            match = re.match(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$", sql[i:])
            if match:
                dollar_tag = match.group(0)
                buf.append(dollar_tag)
                i += len(dollar_tag)
                continue
        if ch == "'" and not in_double:
            buf.append(ch)
            if in_single and nxt == "'":
                buf.append(nxt)
                i += 2
                continue
            in_single = not in_single
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            buf.append(ch)
            i += 1
            continue
        if ch == ";" and not in_single and not in_double:
            statement = "".join(buf).strip()
            if statement:
                statements.append(statement.lower())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        statements.append(tail.lower())
    return statements


def future_controller_sql() -> str:
    """Return only the future Task 2 controller SQL, not legacy migrations.

    Task 1 contracts should stay RED because the Task 2 foundation is absent;
    they must not pass or fail because an unrelated historical migration happens
    to mention a table/column name somewhere else in the repo.
    """
    chunks: list[str] = []
    assert MIGRATIONS.exists(), f"Missing migrations directory: {MIGRATIONS}"
    task2_markers = ("resolve_canonical_material", "material_resolution_requests")
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        lowered = text.lower()
        if any(marker in lowered for marker in task2_markers):
            chunks.append(f"\n-- {path.name}\n{text}")
    sql = "\n".join(chunks).lower()
    assert sql, "Missing Task 2 canonical material controller foundation SQL"
    return sql


def future_controller_statements() -> list[str]:
    return split_sql_statements(future_controller_sql())


def statement_adds_column(table: str, column: str, statements: list[str]) -> bool:
    table_ref = rf'(public\.)?"?{re.escape(table)}"?'
    column_ref = rf'"?{re.escape(column)}"?'
    create_re = re.compile(rf"create\s+table(?:\s+if\s+not\s+exists)?\s+{table_ref}[\s\S]*\b{column_ref}\b")
    alter_re = re.compile(rf"alter\s+table(?:\s+if\s+exists)?\s+{table_ref}[\s\S]*add\s+column(?:\s+if\s+not\s+exists)?\s+{column_ref}\b")
    return any(create_re.search(stmt) or alter_re.search(stmt) for stmt in statements)


def statement_preserves_table(table: str, statements: list[str]) -> bool:
    table_ref = rf'(public\.)?"?{re.escape(table)}"?'
    return any(re.search(rf"\b{table_ref}\b[\s\S]*canonical_material_id", stmt) for stmt in statements)


def statement_writes_table(table: str, statements: list[str]) -> bool:
    table_ref = rf'(public\.)?"?{re.escape(table)}"?'
    dml_re = re.compile(rf"\b(update\s+{table_ref}|delete\s+from\s+{table_ref}|insert\s+into\s+{table_ref}|truncate\s+(?:table\s+)?{table_ref})\b")
    return any(dml_re.search(stmt) for stmt in statements)


def strip_sql_comments(sql: str) -> str:
    """Remove SQL comments while preserving quoted/dollar-quoted function bodies."""
    out: list[str] = []
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False
    dollar_tag: str | None = None
    i = 0
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if in_line_comment:
            if ch == "\n":
                out.append(ch)
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 2
            else:
                if ch == "\n":
                    out.append(ch)
                i += 1
            continue
        if dollar_tag:
            if sql.startswith(dollar_tag, i):
                out.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
            else:
                out.append(ch)
                i += 1
            continue
        if not in_single and not in_double:
            if ch == "-" and nxt == "-":
                in_line_comment = True
                i += 2
                continue
            if ch == "/" and nxt == "*":
                in_block_comment = True
                i += 2
                continue
            match = re.match(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$", sql[i:])
            if match:
                dollar_tag = match.group(0)
                out.append(dollar_tag)
                i += len(dollar_tag)
                continue
        if ch == "'" and not in_double:
            out.append(ch)
            if in_single and nxt == "'":
                out.append(nxt)
                i += 2
                continue
            in_single = not in_single
            i += 1
            continue
        if ch == '"' and not in_single:
            in_double = not in_double
            out.append(ch)
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out).lower()



def sql_function_body(sql: str, function_name: str) -> str:
    uncommented = strip_sql_comments(sql)
    pattern = re.compile(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(function_name)}\s*\([\s\S]*?\)[\s\S]*?as\s+(\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)(?P<body>[\s\S]*?)\1\s*;"
    )
    match = pattern.search(uncommented)
    assert match, f"Missing function body for {function_name}"
    return strip_sql_comments(match.group("body"))


def trigger_function_body(sql: str, function_name: str) -> str:
    uncommented = strip_sql_comments(sql)
    pattern = re.compile(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(function_name)}\s*\(\s*\)[\s\S]*?as\s+(\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$)(?P<body>[\s\S]*?)\1\s*;"
    )
    match = pattern.search(uncommented)
    assert match, f"Missing trigger function body for {function_name}"
    return strip_sql_comments(match.group("body"))


def assert_lock_before_overlap_exists(body: str, required_fragments: tuple[str, ...]) -> None:
    lock_pos = body.find("pg_catalog.pg_advisory_xact_lock")
    exists_pos = body.find("exists")
    assert lock_pos >= 0, "overlap trigger must use transaction-scoped advisory lock"
    assert exists_pos >= 0, "overlap trigger must retain overlap EXISTS check"
    assert lock_pos < exists_pos, "advisory xact lock must be taken before overlap EXISTS check"
    assert "pg_advisory_lock" not in body, "session advisory locks must not be used"
    assert "pg_catalog.hashtextextended" in body
    for fragment in required_fragments:
        assert fragment in body


def load_audit_module():
    assert AUDIT_SCRIPT.exists(), f"Missing audit utility: {AUDIT_SCRIPT}"
    spec = importlib.util.spec_from_file_location("audit_material_master", AUDIT_SCRIPT)
    assert spec and spec.loader, f"Cannot import audit utility from {AUDIT_SCRIPT}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


# ----------------------------- GREEN audit utility tests -----------------------------


def test_audit_normalizes_vietnamese_text_deterministically():
    audit = load_audit_module()

    assert audit.normalize_vietnamese_key("  Bơ  TH Đặc-Biệt!!! ") == "bo th dac biet"
    assert audit.normalize_vietnamese_key("Đường\u0300 tinh  luyện") == "duong tinh luyen"
    assert audit.normalize_vietnamese_key(None) == ""


def test_audit_aggregates_in_memory_fixture_without_mutating_or_needing_network():
    audit = load_audit_module()
    dataset = {
        "sku_cogs_materials": [
            {"id": "m1", "material_code": "NVL-BO-TH", "canonical_name": "Bơ TH", "active": True},
            {"id": "m2", "material_code": "NVL-BO-CU", "canonical_name": "Bơ cũ", "active": False},
            {"id": "m3", "material_code": "NVL-MUOI", "canonical_name": "Muối", "active": True},
        ],
        "sku_cogs_material_aliases": [
            {"id": "a1", "material_id": "m1", "alias_name": "Bơ tươi TH", "active": True},
            {"id": "a2", "material_id": "m2", "alias_name": "Bơ cũ", "active": False},
        ],
        "sku_formulations": [
            {"id": "f1", "sku_id": "s1", "canonical_material_id": "m1", "ingredient_name": "Bơ TH"},
            {"id": "f2", "sku_id": "s1", "canonical_material_id": None, "ingredient_name": "Muối"},
        ],
        "kitchen_inventory_items": [
            {"id": "k1", "item_code": "Q7-001", "name": "Bơ TH", "standard_unit_cost": 0, "product_sku_id": None},
            {"id": "k2", "item_code": "NVL-002", "name": "Đường", "standard_unit_cost": 12000, "product_sku_id": "sku2"},
            {"id": "k3", "item_code": "CCDC-001", "name": "Khay", "standard_unit_cost": 5000, "product_sku_id": None, "active": False},
            {"id": "k4", "item_code": "NVL-BO-LEGACY", "name": "Bơ TH", "standard_unit_cost": 9000, "product_sku_id": "sku1"},
            {"id": "k5", "item_code": "Q7_002", "name": "Tên không chứa marker", "standard_unit_cost": 1000, "product_sku_id": None},
            {"id": "k6", "item_code": "Q7003", "name": "Compact code", "standard_unit_cost": 1000, "product_sku_id": None},
            {"id": "k7", "item_code": "NVL-004", "name": "contains q7 in name only", "standard_unit_cost": 1000, "product_sku_id": None},
            {"id": "k8", "normalized_key": "q7-material:nvl-x", "item_code": "NVL-005", "name": "semantic prefix", "standard_unit_cost": 1000, "product_sku_id": None},
        ],
        "product_skus": [
            {"id": "sku1", "sku_type": "raw_material", "product_name": "Bơ TH", "supplier_id": "sup1"},
            {"id": "sku2", "sku_type": "raw_material", "product_name": "Đường tinh luyện", "supplier_id": None},
            {"id": "sku3", "sku_type": "finished_good", "product_name": "Bánh", "supplier_id": "sup2"},
        ],
        "supplier_product_aliases": [
            {"id": "sa1", "supplier_id": "sup1", "active": True},
            {"id": "sa2", "supplier_id": "sup1", "active": False},
        ],
    }

    summary = audit.build_summary(dataset)

    assert summary["canonical_materials"] == {"total": 3, "active": 2}
    assert summary["active_aliases"] == 1
    assert summary["formulations"]["total"] == 2
    assert summary["formulations"]["canonical_coverage"] == {"mapped": 1, "missing": 1, "percent": 50.0}
    assert summary["kitchen_items"]["total"] == 8
    assert summary["kitchen_items"]["q7"] == 4
    assert summary["kitchen_items"]["non_q7"] == 4
    assert summary["kitchen_link_gaps"] == 6
    assert summary["zero_cost_items"] == {"count": 1, "examples": [{"id": "k1", "name": "Bơ TH", "item_code": "Q7-001"}]}
    assert summary["raw_skus"] == {"total": 2, "with_supplier": 1, "without_supplier": 1}
    assert summary["supplier_alias_count"] == 1
    combined_duplicates = summary["combined_identity_duplicate_name_groups"]
    assert combined_duplicates["count"] == 1
    bo_th = combined_duplicates["examples"][0]
    assert bo_th["normalized_name"] == "bo th"
    assert bo_th["count"] == 4
    assert {(row["source"], row["table"], row["id"], row.get("code")) for row in bo_th["examples"]} == {
        ("canonical_material", "sku_cogs_materials", "m1", "NVL-BO-TH"),
        ("kitchen_inventory_item", "kitchen_inventory_items", "k1", "Q7-001"),
        ("kitchen_inventory_item", "kitchen_inventory_items", "k4", "NVL-BO-LEGACY"),
        ("raw_product_sku", "product_skus", "sku1", None),
    }
    kitchen_duplicates = summary["kitchen_duplicate_name_groups"]
    assert kitchen_duplicates["count"] == 1
    assert kitchen_duplicates["examples"][0]["normalized_name"] == "bo th"
    assert {row["id"] for row in kitchen_duplicates["examples"][0]["examples"]} == {"k1", "k4"}
    assert "normalized_duplicate_name_groups" not in summary


def test_audit_csv_string_booleans_parse_explicit_values_without_truthy_string_fallback():
    audit = load_audit_module()

    true_values = ["true", "1", "yes", "on", "TRUE", "Yes", True, 1]
    false_values = ["false", "0", "no", "off", "", None, "FALSE", "Off", False, 0]

    for value in true_values:
        assert audit.truthy_active({"active": value}) is True
    for value in false_values:
        assert audit.truthy_active({"active": value}) is False

    assert audit.truthy_active({}) is True
    assert audit.truthy_active({"active": "archived"}) is False
    assert audit.active_count([{"active": "true"}, {"active": "false"}, {}, {"active": "archived"}]) == 2


def test_audit_zero_cost_uses_first_present_cost_field_not_truthiness():
    audit = load_audit_module()
    dataset = {
        "kitchen_inventory_items": [
            {"id": "standard-zero", "standard_unit_cost": 0, "unit_cost": 100, "unit_price": 200},
            {"id": "standard-nonzero", "standard_unit_cost": 5, "unit_cost": 0, "unit_price": 0},
            {"id": "unit-cost-zero", "unit_cost": 0, "unit_price": 200},
            {"id": "unit-cost-nonzero", "unit_cost": 7, "unit_price": 0},
            {"id": "unit-price-zero", "unit_price": 0},
            {"id": "unit-price-nonzero", "unit_price": 9},
        ],
    }

    summary = audit.build_summary(dataset)

    assert summary["zero_cost_items"]["count"] == 3
    assert [row["id"] for row in summary["zero_cost_items"]["examples"]] == [
        "standard-zero",
        "unit-cost-zero",
        "unit-price-zero",
    ]


def test_audit_rejects_ragged_csv_rows_with_table_and_file_context(tmp_path):
    audit = load_audit_module()
    export_dir = tmp_path / "export"
    export_dir.mkdir()
    bad_csv = export_dir / "sku_cogs_materials.csv"
    bad_csv.write_text("id,active\nm1,true,extra\n", encoding="utf-8")

    try:
        audit.load_export_dir(export_dir)
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("ragged CSV rows must be rejected")

    assert "sku_cogs_materials" in message
    assert str(bad_csv) in message
    assert "row 2" in message
    assert "ragged CSV row" in message


def test_audit_rejects_short_csv_rows_without_rejecting_explicit_empty_cells(tmp_path):
    audit = load_audit_module()
    export_dir = tmp_path / "export"
    export_dir.mkdir()
    short_csv = export_dir / "sku_cogs_materials.csv"
    short_csv.write_text("id,active\nm1\n", encoding="utf-8")

    try:
        audit.load_export_dir(export_dir)
    except ValueError as exc:
        message = str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("short CSV rows must be rejected")

    assert "sku_cogs_materials" in message
    assert str(short_csv) in message
    assert "row 2" in message
    assert "ragged CSV row" in message

    short_csv.write_text("id,active\nm1,\n", encoding="utf-8")
    dataset = audit.load_export_dir(export_dir)
    assert dataset["sku_cogs_materials"] == [{"id": "m1", "active": ""}]


def test_audit_linked_read_timeout_and_errors_are_sanitized(monkeypatch, tmp_path):
    audit = load_audit_module()

    def timeout_run(*args, **kwargs):
        assert kwargs["timeout"] == 60
        raise audit.subprocess.TimeoutExpired(cmd=args[0], timeout=kwargs["timeout"], output="secret-row", stderr="password=secret")

    monkeypatch.setattr(audit.subprocess, "run", timeout_run)
    try:
        audit.load_linked_data(tmp_path)
    except TimeoutError as exc:
        timeout_message = str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("linked timeout must raise a safe timeout error")

    assert "sku_cogs_materials" in timeout_message
    assert "timed out after 60s" in timeout_message
    assert "secret" not in timeout_message
    assert "password" not in timeout_message

    def failing_run(*args, **kwargs):
        return audit.subprocess.CompletedProcess(args=args[0], returncode=2, stdout='[{"id":"raw-db-row"}]', stderr="token=secret")

    monkeypatch.setattr(audit.subprocess, "run", failing_run)
    try:
        audit.load_linked_data(tmp_path)
    except RuntimeError as exc:
        error_message = str(exc)
    else:  # pragma: no cover - defensive
        raise AssertionError("linked CLI failure must raise a safe sanitized error")

    assert "sku_cogs_materials" in error_message
    assert "Supabase CLI exited with code 2" in error_message
    assert "raw-db-row" not in error_message
    assert "secret" not in error_message
    assert "token" not in error_message


def test_audit_cli_defaults_to_local_json_export_and_rejects_linked_without_flag(tmp_path):
    audit = load_audit_module()
    export_dir = tmp_path / "export"
    export_dir.mkdir()
    (export_dir / "sku_cogs_materials.json").write_text(
        json.dumps([{"id": "m1", "canonical_name": "Muối", "active": True}], ensure_ascii=False),
        encoding="utf-8",
    )

    local_result = audit.main(["--export-dir", str(export_dir)])
    assert local_result == 0

    try:
        audit.parse_args(["--linked"])
    except SystemExit as exc:
        assert exc.code != 0
    else:  # pragma: no cover - defensive
        raise AssertionError("--linked must require explicit confirmation to touch the network")


# ----------------------------- Expected RED controller contracts -----------------------------


def test_controller_rpc_preserves_stable_material_uuid_and_code_immutability():
    sql = future_controller_sql()

    assert "public.resolve_canonical_material" in sql
    assert "public.update_canonical_material" in sql
    assert re.search(r"raise\s+exception[^;]+material_code", sql, flags=re.S)
    assert re.search(r"raise\s+exception[^;]+canonical_material_id", sql, flags=re.S)
    assert "stable material" in sql or "immutable material" in sql


def test_controller_only_approved_exact_sources_can_resolve_exact():
    sql = future_controller_sql()

    assert "resolved_exact" in sql
    assert "approved_supplier_alias" in sql
    assert "approved_source_alias" in sql
    assert "approved_global_alias" in sql
    assert "normalized_name" in sql
    assert re.search(r"match_source[^;]+(material_code|code)", sql, flags=re.S)
    assert re.search(r"match_source[^;]+normalized_name", sql, flags=re.S)
    assert re.search(r"match_source[^;]+approved_supplier_alias", sql, flags=re.S)
    assert re.search(r"match_source[^;]+approved_source_alias", sql, flags=re.S)
    assert re.search(r"match_source[^;]+approved_global_alias", sql, flags=re.S)


def test_task2_exact_rpc_signatures_and_status_vocabularies_match_approved_brief():
    sql = future_controller_sql()
    smoke = read(ROLLBACK_SMOKE).lower()

    exact_signatures = [
        "public.request_material_resolution(text,text,uuid,uuid,text,text,text,uuid,jsonb)",
        "public.create_canonical_material(text,text,text,text,text,text,text,uuid)",
        "public.update_canonical_material(uuid,int,jsonb,text,uuid)",
        "public.confirm_material_resolution(uuid,text,uuid,jsonb,jsonb,jsonb,text)",
        "public.assert_material_ready(uuid,text[],uuid,text,date)",
    ]
    for signature in exact_signatures:
        assert signature in sql, f"migration ACL/to_regprocedure must use exact signature {signature}"
        assert signature in smoke, f"rollback smoke must assert exact signature {signature}"

    for wrong_signature in [
        "public.request_material_resolution(text, text, text, text, uuid, text, text, text, jsonb)",
        "public.create_canonical_material(text, text, text, text, jsonb, text, text, text)",
        "public.confirm_material_resolution(uuid, text, uuid, jsonb, jsonb, text)",
    ]:
        assert wrong_signature.replace(" ", "") not in sql.replace(" ", "")

    for status in ("request_created", "request_existing", "already_resolved"):
        assert status in sql
    for resolution_status in ("pending", "resolved_existing", "created_new", "rejected"):
        assert resolution_status in sql
    for candidate_status in ("confirmation_needed", "ambiguous", "not_found"):
        assert candidate_status in sql
    for confirm_status in ("resolved_existing", "created_new", "rejected", "resolution_unchanged"):
        assert confirm_status in sql


def test_task2_root_columns_nullable_no_metadata_and_legacy_version_contract():
    sql = future_controller_sql()

    assert re.search(r"add\s+column\s+if\s+not\s+exists\s+version\s+integer(?!\s+not\s+null)(?!\s+default)", sql)
    assert "check (version is null or version > 0)" in sql
    assert "add column if not exists metadata" not in sql
    assert "metadata =" not in sql
    assert "version = coalesce(version, 0) + 1" in sql
    assert "coalesce(v_old.version, 0) <> p_expected_version" in sql
    assert "alias_created_for_old_name" in sql


def test_task2_effective_dated_prices_and_overlap_guards_match_approved_model():
    sql = future_controller_sql()
    smoke = read(ROLLBACK_SMOKE).lower()

    assert "price_type text not null" in sql
    assert "check (price_type in ('standard_cost','purchase_price'))" in sql
    assert "price numeric not null" in sql
    assert "normalized_base_unit_price numeric" in sql
    assert "source_id uuid" in sql
    assert not re.search(r"\bstandard_cost\s+numeric\b", sql)
    assert not re.search(r"\bpurchase_price\s+numeric\b", sql)
    assert not re.search(r"\bbase_unit_price\s+numeric\b", sql)
    assert "trg_material_price_history_reject_approved_overlap" in sql
    assert "trg_material_unit_conversions_reject_approved_overlap" in sql
    assert "daterange" in sql and "&&" in sql

    conversion_body = trigger_function_body(sql, "trg_material_unit_conversions_reject_approved_overlap")
    assert_lock_before_overlap_exists(
        conversion_body,
        (
            "material_unit_conversions_overlap:",
            "new.material_id",
            "lower(btrim(coalesce(new.from_unit, '')))",
            "lower(btrim(coalesce(new.to_unit, '')))",
        ),
    )
    price_body = trigger_function_body(sql, "trg_material_price_history_reject_approved_overlap")
    assert_lock_before_overlap_exists(
        price_body,
        (
            "material_price_history_overlap:",
            "new.material_id",
            "coalesce(new.supplier_product_id, '00000000-0000-0000-0000-000000000000'::uuid)",
            "new.price_type",
            "lower(btrim(coalesce(new.price_unit, '')))",
        ),
    )
    assert "btree_gist" not in sql
    assert "pg_advisory_xact_lock" in smoke
    assert "overlapping approved conversion" in smoke
    assert "overlapping approved price" in smoke


def test_task2_safe_payload_alias_uniqueness_acl_and_sequence_contracts():
    sql = future_controller_sql()
    smoke = read(ROLLBACK_SMOKE).lower()

    assert "where key in ('candidate_source','confidence','field_name')" in sql
    assert "source_column" not in sql and "parser" not in sql and "line_number" not in sql
    assert "source_type text not null" in sql
    assert "uq_material_scoped_aliases_source_active_approved" in sql
    assert "where supplier_id is null and active = true and approved = true" in sql
    assert "approved scoped alias already belongs to another canonical material" in sql
    assert "approved source alias already belongs to another canonical material" in sql
    assert "approved global alias already belongs to another canonical material" in sql
    assert "select last_value, is_called" in sql
    assert "setval('public.sku_cogs_materials_nvl_code_seq', greatest(v_max_code, v_last_value), true)" in sql
    assert "revoke insert, update, delete, truncate on public.sku_cogs_materials from service_role" in sql
    assert "revoke insert, update, delete, truncate on public.sku_cogs_material_aliases from service_role" in sql
    for probe in ("approved supplier scoped alias resolves", "approved source-scoped alias resolves", "approved global legacy alias resolves", "sequence collision"):
        assert probe in smoke


def test_confirm_material_resolution_fails_closed_after_alias_conflict_races_and_reuses_same_material_aliases():
    sql = future_controller_sql()
    body = sql_function_body(sql, "confirm_material_resolution")
    smoke = read(ROLLBACK_SMOKE).lower()

    required_messages = (
        "approved scoped alias conflict after insert race",
        "approved source alias conflict after insert race",
        "approved global alias conflict after insert race",
        "approved alias insert returned no id after conflict re-read",
    )
    for message in required_messages:
        assert message in body, f"confirm_material_resolution must raise fail-closed message: {message}"

    branches = (
        ("supplier_id = v_req.supplier_id", "material_scoped_aliases"),
        ("source_type = lower(btrim(v_req.source_type))", "material_scoped_aliases"),
        ("normalized_alias = v_alias", "sku_cogs_material_aliases"),
    )
    for key_fragment, table in branches:
        returning_pos = body.find("returning id into", body.find(key_fragment))
        assert returning_pos >= 0, f"{key_fragment} branch must keep conflict RETURNING id"
        reread_pos = body.find(f"from public.{table}", returning_pos)
        assert reread_pos > returning_pos, f"{key_fragment} branch must re-read unique key after null RETURNING"
        raise_pos = body.find("using errcode='23505'", reread_pos)
        assert raise_pos > reread_pos, f"{key_fragment} branch must raise 23505 after conflict re-read finds other material or no row"

    # The final request update must be guarded so a non-empty alias can never resolve with no alias id.
    fail_closed_pos = body.find("approved alias insert returned no id after conflict re-read")
    update_pos = body.rfind("update public.material_resolution_requests")
    assert 0 <= fail_closed_pos < update_pos


def test_confirm_material_resolution_reuses_same_material_supplier_product_business_key_without_broad_catch():
    sql = future_controller_sql()
    body = sql_function_body(sql, "confirm_material_resolution")
    smoke = read(ROLLBACK_SMOKE).lower()

    assert "on conflict (supplier_id, normalized_supplier_product_name, (lower(btrim(purchase_unit)))) where active = true do nothing" in body
    assert "returning id into v_supplier_product_id" in body
    insert_pos = body.find("insert into public.material_supplier_products")
    reread_pos = body.find("from public.material_supplier_products", insert_pos)
    assert reread_pos > insert_pos, "supplier product business-key conflict must re-read the active row"
    assert "supplier product normalized name/unit already belongs to another material" in body
    assert "supplier product insert returned no id after conflict re-read" in body
    assert "when unique_violation" not in body[insert_pos:], "do not broadly catch unique violations; item-code conflicts must propagate"

    request_update_pos = body.rfind("update public.material_resolution_requests")
    assert 0 <= reread_pos < request_update_pos
    assert "resolved_supplier_product_id=v_supplier_product_id" in body

    assert "same-material supplier product normalized name/unit reuses existing id" in smoke


def test_task2_final_blockers_static_contracts_for_ready_scope_ids_acl_and_owner_seed():
    sql = future_controller_sql()
    smoke = read(ROLLBACK_SMOKE).lower()

    assert "on conflict (user_id, module_key) do nothing" in sql
    assert "on conflict (user_id, module_key) do update" not in sql
    assert "resolved_scoped_alias_id" in sql
    assert "resolved_global_alias_id" in sql
    assert "resolved_supplier_product_id" in sql
    assert "resolution_unchanged" in sql
    assert re.search(r"resolution_unchanged[\s\S]+coalesce\(v_req\.resolved_scoped_alias_id,\s*v_req\.resolved_global_alias_id\)", sql)

    assert "supplier_id uuid references public.suppliers(id) on delete restrict" in sql
    assert "supplier_id uuid references public.suppliers(id) on delete set null" not in sql
    uncommented_sql = strip_sql_comments(sql)
    supplier_product_unique_pattern = re.compile(
        r"create\s+unique\s+index(?:\s+if\s+not\s+exists)?\s+\S*\s*"
        r"on\s+public\.material_supplier_products\s*\(\s*"
        r"supplier_id\s*,\s*normalized_supplier_product_name\s*,\s*lower\s*\(\s*btrim\s*\(\s*purchase_unit\s*\)\s*\)\s*\)"
        r"[\s\S]*?where\s+active\s*=\s*true",
        flags=re.S,
    )
    assert supplier_product_unique_pattern.search(uncommented_sql), (
        "active supplier products must have a real partial unique index on "
        "supplier_id + normalized supplier product name + normalized purchase unit"
    )
    assert "duplicate active supplier product normalized name/unit" in smoke
    assert "different purchase unit may coexist" in smoke
    assert "supplier product duplicate normalized name/unit should have failed" in smoke
    assert "23505" in smoke or "unique_violation" in smoke
    assert "uq_material_supplier_products_active_code" in sql
    assert "material_scoped_aliases_source_type_normalized" in sql
    assert "material_resolution_requests_source_type_normalized" in sql
    assert "check (source_type = lower(btrim(source_type)))" in sql
    assert "v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '')" in sql
    assert "lower(btrim(coalesce(p_source_type, '')))" in sql
    assert "lower(btrim(v_req.source_type))" in sql

    for blocker in ("missing_standard_cost", "missing_purchase_price", "missing_q7_mapping"):
        assert blocker in sql
    assert "standard_cost_unmapped" not in sql
    assert "purchase_price_unmapped" not in sql
    assert "q7_material_issue_material_mappings" in sql
    assert "unsupported_capability" in sql
    assert "material_id', p_material_id" in sql
    ready_function = next(
        stmt for stmt in split_sql_statements(sql)
        if "create or replace function public.assert_material_ready" in stmt
    )
    price_branch = ready_function.split("elsif v_cap in ('price','standard_cost','purchase_price')", 1)[1].split("elsif v_cap = 'q7_mapping'", 1)[0]
    assert "ph.supplier_product_id is null" in price_branch
    assert "join public.material_supplier_products sp on sp.id = ph.supplier_product_id" not in price_branch
    assert re.search(
        r"ph\.supplier_product_id\s+is\s+null[\s\S]+or[\s\S]+exists\s*\([\s\S]+from\s+public\.material_supplier_products\s+sp[\s\S]+sp\.id\s*=\s*ph\.supplier_product_id[\s\S]+sp\.supplier_id\s*=\s*p_supplier_id[\s\S]+sp\.active\s*=\s*true[\s\S]+sp\.approved\s*=\s*true",
        price_branch,
    ), "readiness must accept global price rows and supplier-specific prices only for the requested approved active supplier product"

    for fn in (
        "trg_material_unit_conversions_reject_approved_overlap()",
        "trg_material_price_history_reject_approved_overlap()",
        "trg_material_master_audit_append_only()",
        "trg_guard_canonical_material_identity()",
        "trg_validate_canonical_material_fk_active()",
    ):
        assert f"revoke execute on function public.{fn} from public, anon, authenticated, service_role" in sql
        assert f"has_function_privilege('authenticated', 'public.{fn}', 'execute')" in smoke
        assert f"has_function_privilege('service_role', 'public.{fn}', 'execute')" in smoke


def test_task2_final_blockers_rollback_smoke_runtime_probes():
    smoke = read(ROLLBACK_SMOKE).lower()
    assert "ready response contract and blockers" in smoke
    assert "material_id" in smoke and "missing_standard_cost" in smoke and "missing_q7_mapping" in smoke
    assert "mixed-case source scope normalizes" in smoke
    assert "duplicate casing cannot create separate approved alias" in smoke
    assert "idempotent terminal ids" in smoke
    assert "alias_id" in smoke and "supplier_product_id" in smoke
    assert "approved global standard cost satisfies readiness" in smoke
    assert "supplier_product_id, price_type, price, price_unit" in smoke
    assert "values (v_material_id, null, 'standard_cost'" in smoke
    assert "missing_standard_cost should clear after approved global standard cost" in smoke


def test_controller_never_allows_fuzzy_or_ai_candidate_as_resolved_exact():
    sql = future_controller_sql()

    assert "resolved_exact" in sql
    assert "fuzzy" in sql or "ai_candidate" in sql or "ai_suggested" in sql or "confirmation_needed" in sql
    assert re.search(
        r"(fuzzy|ai_candidate|ai_suggested|candidate)[\s\S]+(confirmation_needed|ambiguous|not_found|blocking|fail_closed|fail-closed)",
        sql,
        flags=re.S,
    ) or re.search(
        r"(confirmation_needed|ambiguous|not_found|blocking|fail_closed|fail-closed)[\s\S]+(fuzzy|ai_candidate|ai_suggested|candidate)",
        sql,
        flags=re.S,
    ), "fuzzy/AI candidate branch must fail closed instead of auto-approving canonical material"


def test_controller_runtime_smoke_proves_candidate_resolution_fails_closed():
    assert ROLLBACK_SMOKE.exists(), "Missing Task 2 rollback runtime smoke for material resolution"
    smoke = read(ROLLBACK_SMOKE).lower()
    assert "resolve_canonical_material" in smoke
    assert "resolved_exact" in smoke
    assert "fuzzy" in smoke or "candidate" in smoke or "not_found" in smoke


def test_controller_fail_closed_statuses_and_idempotent_resolution_request():
    sql = future_controller_sql()

    for status in (
        "resolved_exact",
        "confirmation_needed",
        "ambiguous",
        "not_found",
        "inactive",
        "unit_unmapped",
        "supplier_unmapped",
    ):
        assert status in sql
    assert "material_resolution_requests" in sql
    assert re.search(r"request_key\s+text", sql, flags=re.S)
    assert re.search(
        r"(unique\s*\([^)]*request_key[^)]*\)|request_key[^,;\n]+unique|unique\s+index[^;]+request_key)",
        sql,
        flags=re.S,
    )
    assert "extensions.digest" in sql
    assert "sha256" in sql
    for source_fact in ("source_type", "source_table", "source_id", "source_line_id", "supplier_id", "raw_name", "raw_code", "raw_unit"):
        assert source_fact in sql
    assert re.search(r"on\s+conflict\s*\(\s*request_key\s*\)", sql, flags=re.S)
    assert "do update" in sql or "do nothing" in sql


def test_history_snapshot_tables_preserve_document_formulation_and_q7_material_snapshots():
    historical_statements = split_sql_statements(migration_sql())
    future_statements = future_controller_statements()
    historical_table_columns = {
        "sku_cogs_version_formulations": ("canonical_material_id", "material_code", "ingredient_name", "unit", "unit_price"),
        "production_material_issue_items": ("material_code", "ingredient_name", "unit", "unit_cost"),
        "kfm_daily_material_issue_items": ("canonical_material_id", "material_code", "ingredient_name", "unit", "unit_cost"),
    }

    for table, columns in historical_table_columns.items():
        assert any(re.search(rf"\b(public\.)?{table}\b", stmt) for stmt in historical_statements), (
            f"{table} must exist in historical migrations before Task 2 contracts can protect it"
        )
        for column in columns:
            assert statement_adds_column(table, column, historical_statements), (
                f"historical migrations must already define {table}.{column}"
            )
        assert not statement_writes_table(table, future_statements), (
            f"future controller SQL must not INSERT/UPDATE/DELETE/TRUNCATE historical snapshot table {table}"
        )


def test_operational_line_tables_are_planned_to_store_canonical_material_id():
    statements = future_controller_statements()
    planned_new_link_tables = [
        "kitchen_inventory_items",
        "product_skus",
        "purchase_order_items",
        "goods_receipt_items",
        "payment_request_items",
        "invoice_items",
    ]

    for table in planned_new_link_tables:
        assert statement_adds_column(table, "canonical_material_id", statements), (
            f"{table} must add canonical_material_id in the same ALTER/CREATE statement"
        )

    assert not statement_adds_column("sku_cogs_version_formulations", "canonical_material_id", statements)
    assert not statement_adds_column("production_material_issue_items", "canonical_material_id", statements)
    assert not statement_adds_column("kfm_daily_material_issue_items", "canonical_material_id", statements)


def test_enforcement_is_server_side_not_ui_only_for_sku_cost_and_procurement_writes():
    sql = future_controller_sql()
    sources = {
        "sku_cost_page": read(SKU_COST_PAGE),
        "goods_receipt_dialog": read(GOODS_RECEIPT_DIALOG),
        "purchase_orders_page": read(PURCHASE_ORDERS_PAGE),
        "purchase_order_details": read(PURCHASE_ORDER_DETAILS),
        "purchase_order_hook": read(PURCHASE_ORDER_HOOK),
        "goods_receipt_hook": read(GOODS_RECEIPT_HOOK),
        "match_delivery_note": read(MATCH_DELIVERY_NOTE),
        "scan_sku_cost_sheet": read(SCAN_SKU_COST_SHEET),
    }

    assert "resolve_canonical_material" in sql
    assert "trg_" in sql and "canonical_material" in sql
    # Document current write surfaces without making the contract depend on exact formatting.
    assert any("sku_formulations" in text for text in sources.values())
    assert any("purchase_order_items" in text for text in sources.values())
    assert any("goods_receipt_items" in text for text in sources.values())
    # Once green, source write paths should route through RPC/Edge/controller rather than trusting UI validation only.
    for name, text in sources.items():
        if any(table in text for table in ("sku_formulations", "purchase_order_items", "goods_receipt_items")):
            assert "resolve_canonical_material" in text or "canonical_material_id" in text, (
                f"{name} must pass canonical material identity to the server-side controller"
            )


def test_scan_sku_cost_sheet_returns_pending_resolution_instead_of_client_side_exact_guess():
    source = read(SCAN_SKU_COST_SHEET)

    assert "resolve_canonical_material" in source
    assert "resolved_exact" in source
    assert "resolution_request_id" in source
    assert "material_resolution_status" in source or "resolution_status" in source
    assert re.search(r"(confirmation_needed|ambiguous|not_found|inactive|unit_unmapped|supplier_unmapped|unresolved)", source)
    assert re.search(r"(block|blocking|422|409|throw new Error|success:\s*false)", source)


def test_match_delivery_note_uses_controller_for_supplier_alias_resolution_not_fuzzy_acceptance():
    source = read(MATCH_DELIVERY_NOTE)

    assert "resolve_canonical_material" in source
    assert "supplier_id" in source
    assert "raw_unit" in source or "deliveryUnit" in source or "unit" in source
    assert "resolution_request_id" in source
    assert "material_resolution_status" in source or "resolution_status" in source or "blocking" in source
    assert "resolved_exact" in source
    assert re.search(r"(extractedItems|extracted\.items|for\s*\([^)]*extracted|forEach\([^)]*extracted|map\([^)]*extracted)", source)
    assert re.search(r"(nameSimilarity|similarity)[\s\S]+(match|receipt|purchase_order|document)", source, flags=re.S)
    assert re.search(r"(canonical_material_id|resolved_exact)[\s\S]+resolve_canonical_material", source, flags=re.S) or re.search(
        r"resolve_canonical_material[\s\S]+(canonical_material_id|resolved_exact)", source, flags=re.S
    )


if __name__ == "__main__":
    raise SystemExit("Run with pytest so expected RED contract failures are reported clearly.")
