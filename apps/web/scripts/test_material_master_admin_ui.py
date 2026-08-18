#!/usr/bin/env python3
"""Task 4 Canonical NVL Master admin UI/RBAC contracts."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
APP_ROUTES = SRC / "components/AppRoutes.tsx"
SIDEBAR = SRC / "components/layout/Sidebar.tsx"
LANGUAGE = SRC / "contexts/LanguageContext.tsx"
USER_MGMT = SRC / "hooks/useUserManagement.ts"
AUTH = SRC / "contexts/AuthContext.tsx"
HOOK = SRC / "hooks/useMaterialMaster.ts"
PAGE = SRC / "pages/material-master/MaterialMasterAdmin.tsx"
QUEUE = SRC / "pages/material-master/ReconciliationQueue.tsx"
DASHBOARD = SRC / "pages/material-master/ControllerDashboard.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing expected file: {path}"
    return path.read_text(encoding="utf-8")


def test_material_master_route_sidebar_translations_and_rbac_fail_closed():
    routes = read(APP_ROUTES)
    sidebar = read(SIDEBAR)
    language = read(LANGUAGE)
    user_mgmt = read(USER_MGMT)
    auth = read(AUTH)

    assert 'const MaterialMasterAdmin = lazy(() => import("@/pages/material-master/MaterialMasterAdmin"));' in routes
    assert 'path="/material-master"' in routes
    assert 'moduleKey="material_master"' in routes
    assert "Quản trị NVL chuẩn" in routes
    assert re.search(r"material_master[\s\S]{0,160}<Suspense", routes)

    assert 'labelKey: "materialMaster"' in sidebar
    assert 'path: "/material-master"' in sidebar
    assert 'moduleKey: "material_master"' in sidebar
    operations = sidebar.split('section: "operations"', 1)[1]
    assert operations.index('labelKey: "skuCosts"') < operations.index('labelKey: "materialMaster"') < operations.index('labelKey: "suppliers"')

    assert "materialMaster: string;" in language
    assert 'materialMaster: "Canonical materials"' in language
    assert 'materialMaster: "NVL chuẩn"' in language

    assert '{ key: "material_master", labelEn: "Canonical Materials", labelVi: "Quản trị NVL chuẩn" }' in user_mgmt
    assert re.search(r"ALL_MODULE_KEYS\s*=\s*\[[\s\S]*\"material_master\"", user_mgmt)
    for role in ("staff", "viewer"):
        view_body = re.search(rf"DEFAULT_VIEW[\s\S]*?{role}: \[([^\]]*)\]", user_mgmt).group(1)
        edit_body = re.search(rf"DEFAULT_EDIT[\s\S]*?{role}: \[([^\]]*)\]", user_mgmt).group(1)
        assert "material_master" not in view_body
        assert "material_master" not in edit_body
    assert "material_master" not in auth.split("const viewerRows = [", 1)[1].split("].map", 1)[0]
    assert "perm?.can_view ?? false" in auth
    assert "perm?.can_edit ?? false" in auth


def test_material_master_page_contract_markers_edit_mode_reason_version_and_queue():
    page = read(PAGE)
    queue = read(QUEUE)

    for marker in [
        "data-bmq-material-master-admin",
        'data-bmq-material-master-rbac="material_master"',
        "data-bmq-material-master-light-ui",
        "data-bmq-material-master-mobile-cards",
        "data-bmq-material-master-explicit-edit-mode",
        "data-bmq-material-master-resolution-queue",
        "data-bmq-material-master-no-raw-ids",
        "data-bmq-material-master-audit-timeline",
    ]:
        assert marker in page

    assert "useAuth()" in page
    assert "canAccessModule(\"material_master\")" in page
    assert "canEditModule(\"material_master\")" in page
    assert "Bật chế độ sửa" in page
    assert "setEditMode(false)" in page
    assert re.search(r"const canMutate\s*=\s*canEdit\s*&&\s*editMode", page)
    assert "reason.trim()" in page
    assert "Lý do" in page and "bắt buộc" in page
    assert "expected_version" in page
    assert "update_canonical_material" in page
    assert "create_canonical_material" in page
    assert "Mã NVL không đổi" in page
    assert "Không thao tác trực tiếp DML" in page
    assert "Bí danh" in page and "Sản phẩm NCC" in page and "Mapping Q7" in page and "Audit" in page
    assert "ReconciliationQueue" in page
    assert "fuzzy" in page.lower() and "không tự chọn" in page.lower()
    assert "Raw UUID" not in page
    assert "audit ID" in page or "Sao chép ID" in page
    assert "data-task3-reconciliation-queue" in queue


def test_material_master_hook_uses_read_only_queries_and_audited_rpcs_only():
    hook = read(HOOK)
    page = read(PAGE)
    combined = hook + "\n" + page

    for table in [
        "sku_cogs_materials",
        "sku_cogs_material_aliases",
        "material_scoped_aliases",
        "material_supplier_products",
        "material_price_history",
        "material_unit_conversions",
        "material_resolution_requests",
        "material_master_audit_logs",
        "suppliers",
        "kitchen_inventory_items",
        "product_skus",
    ]:
        assert f'"{table}"' in hook

    for rpc in [
        "create_canonical_material",
        "update_canonical_material",
        "confirm_material_resolution",
    ]:
        assert f'.rpc("{rpc}"' in hook
    assert 'assert_material_ready' not in hook, "browser UI must not use readiness RPC as a mutation/create shortcut"

    controller_tables = [
        "sku_cogs_materials",
        "sku_cogs_material_aliases",
        "material_scoped_aliases",
        "material_supplier_products",
        "material_price_history",
        "material_unit_conversions",
        "material_resolution_requests",
    ]
    for table in controller_tables:
        assert not re.search(rf'\.from\("{table}"\)[\s\S]{{0,220}}\.(insert|update|delete|upsert)\(', combined), f"direct DML found for {table}"

    assert "as any" not in hook
    assert "unknown as MaterialMasterDb" in hook
    assert "p_expected_version" in hook
    assert "p_patch" in hook
    assert "p_reason" in hook
    assert "reason.trim()" in hook
    assert "throw new Error" in hook


def test_task4_uses_exact_task2_schema_columns_and_rejects_removed_columns():
    hook = read(HOOK)
    page = read(PAGE)
    combined = hook + "\n" + page

    expected_selects = [
        '"id, material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active, created_by, created_at, updated_at, category, brand, specification, updated_by, version"',
        '"id, material_id, alias_name, normalized_alias, source, active, created_by, created_at"',
        '"id, material_id, supplier_id, source_type, alias_name, normalized_alias, approved, active, metadata, created_at"',
        '"id, material_id, supplier_id, supplier_product_code, supplier_product_name, purchase_unit, base_unit, approved, active, created_at"',
        '"id, material_id, supplier_product_id, price, price_unit, normalized_base_unit_price, effective_from, effective_to, approved, created_at"',
        '"id, material_id, from_unit, to_unit, factor, effective_from, effective_to, approved, active, created_at"',
        '"id, material_id, action, reason, actor_id, old_values, new_values, safe_payload, created_at"',
        '"id, name"',
    ]
    for select in expected_selects:
        assert select in hook

    forbidden_schema_terms = [
        "base_unit?:",
        "status: MaterialStatus",
        " spec:",
        "price_value",
        "currency",
        "supplier_name",
        "evidence",
        "changes:",
        "p_spec:",
        "p_status",
        " expected_version:",
    ]
    for term in forbidden_schema_terms:
        assert term not in combined, f"forbidden/removed schema or RPC term still present: {term}"


def test_task4_exact_rpc_contracts_and_functional_resolution_queue():
    hook = read(HOOK)
    page = read(PAGE)
    queue = read(QUEUE)

    assert "p_specification" in hook
    assert "p_expected_version" in hook
    assert re.search(r"p_patch:\s*patch", hook)
    assert "canonical_name" in hook and "default_unit" in hook and "specification" in hook
    assert "active" in hook
    assert "resolve_existing" in hook
    assert 'payload.action === "resolve_existing"' in hook and '"resolved_existing"' in hook
    assert 'payload.action === "create_new"' in hook and '"created_new"' in hook
    assert "reject" in hook
    assert "p_create_payload" in hook
    assert "p_alias_payload" in hook
    assert "p_supplier_product_payload" in hook
    assert "validateRpcResponse" in hook
    assert "selected.version" in page and "selected.version > 0" in page
    assert "Cần tải lại để có version hợp lệ" in page
    assert "createFields" in page and "material_code" in page and "canonical_name" in page and "default_unit" in page and "specification" in page
    assert "manual_selection" in hook and 'confidence: "confirmed"' in hook
    assert 'field_name: "material_master_admin"' in hook
    assert "setMaterialId(\"\")" in page
    assert "setCreateFields" in page
    assert "fuzzy candidates never preselected" in page.lower()

    queue_match = re.search(r"function ReconciliationQueue\(([^)]*)\)", queue)
    assert queue_match is not None
    assert "canMutate" in queue_match.group(1)
    assert "link_approved_material_resolution" in queue
    assert "exactEvidenceReady && canMutate" in queue
    assert "<ReconciliationQueue canMutate={canMutate}" in page


def test_material_master_mobile_and_no_raw_uuid_primary_labels():
    page = read(PAGE)
    assert "md:hidden" in page
    assert "hidden md:block" in page or "hidden overflow-x-auto md:block" in page
    assert "canonical_name" in page
    assert "material_code" in page
    assert "default_unit" in page
    assert "copyMaterialId" in page
    assert "truncateId" in page
    primary_label_area = page.split("data-bmq-material-master-no-raw-ids", 1)[1].split("data-bmq-material-master-audit-timeline", 1)[0]
    assert ">{row.id}<" not in primary_label_area
    assert ".id}</" not in primary_label_area


def test_task9_controller_shadow_dashboard_and_safe_queue_source_filter():
    hook = read(HOOK)
    page = read(PAGE)
    queue = read(QUEUE)
    dashboard = read(DASHBOARD)
    combined = hook + "\n" + page + "\n" + queue + "\n" + dashboard

    assert "ControllerDashboard" in page
    assert '<TabsTrigger value="controller">Controller shadow</TabsTrigger>' in page
    assert '<TabsContent value="controller"' in page
    assert 'data-bmq-material-master-controller-shadow-dashboard' in dashboard
    assert 'data-bmq-material-master-source-filter' in dashboard
    assert 'useMaterialMasterRolloutDashboard' in hook
    assert '.rpc("get_material_master_rollout_dashboard"' in hook
    assert 'MaterialMasterRolloutDashboardRow' in hook
    for field in [
        "source_type",
        "mode",
        "queue_total_count",
        "queue_pending_count",
        "queue_resolved_count",
        "queue_blocked_count",
        "oldest_queue_created_at",
        "latest_queue_created_at",
        "ready_for_enforcement",
        "blockers",
    ]:
        assert field in hook, f"missing dashboard RPC field {field}"

    assert 'sourceDisplayName("kitchen_inventory")' in dashboard
    assert "Q7 / kho bếp" in dashboard
    assert "q7_config" not in combined.lower(), "must not introduce a second q7 config source"
    assert 'sourceFilter' in page and 'onSourceFilterChange' in page
    assert 'sourceFilter={sourceFilter}' in page
    assert 'sourceFilter?: string' in queue
    assert 'row.source_type !== sourceFilter' in queue or 'row.source_table !== sourceFilter' in queue

    assert "fuzzy/AI chỉ là gợi ý" in dashboard
    assert "chỉ exact alias/code/name đã duyệt mới auto-resolve" in dashboard
    assert "không preselect" in dashboard.lower()
    assert "read-only" in dashboard.lower() or "chỉ đọc" in dashboard.lower()
    assert "confirm_material_resolution" in dashboard

    forbidden_dml = re.compile(r'\.from\("(?:sku_cogs_materials|material_resolution_requests|material_scoped_aliases|material_supplier_products)"\)[\s\S]{0,260}\.(?:insert|update|delete|upsert)\(')
    assert not forbidden_dml.search(dashboard), "dashboard must not write controller/config tables"
