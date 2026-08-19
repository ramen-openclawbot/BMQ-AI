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
SYSTEM_STATUS_PAGE = SRC / "pages/material-master/MaterialMasterSystemStatus.tsx"


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
    assert 'const MaterialMasterSystemStatus = lazy(() => import("@/pages/material-master/MaterialMasterSystemStatus"));' in routes
    assert 'path="/material-master"' in routes
    assert 'path="/material-master/system-status"' in routes
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
        "data-bmq-material-master-tap-to-edit",
        "data-bmq-material-master-resolution-queue",
        "data-bmq-material-master-no-raw-ids",
        "data-bmq-material-master-audit-timeline",
    ]:
        assert marker in page

    assert "useAuth()" in page
    assert "canAccessModule(\"material_master\")" in page
    assert "canEditModule(\"material_master\")" in page
    assert "Sửa tên & đơn vị" not in page
    assert "editMode" not in page
    assert re.search(r"const canMutate\s*=\s*canEdit", page)
    assert "openMaterialEditor" in page
    assert 'if (canEdit) setDialog("edit")' in page
    assert 'setDialog("edit")' in page
    assert "Chọn NVL để xác nhận NCC" in page
    assert "Điều chỉnh thông tin NVL" in page
    assert "max-h-[90dvh]" in page and "overflow-y-auto" in page
    assert "Sửa NVL đang chọn" not in page
    assert 'key={`edit-${selected.id}-${selected.version}`}' in page
    assert "materialFormValues(selected)" in page
    assert "reason.trim()" in page
    assert "Lý do thay đổi" in page
    assert "Vui lòng ghi lý do để lưu lịch sử chỉnh sửa." in page
    assert "selected.version" in page
    assert "Mã NVL không đổi" in page
    assert "Danh mục nguyên vật liệu từ Giá vốn" in page
    assert "Giá vốn là nguồn gốc của danh mục NVL." in page
    for business_tab in [
        "NVL từ Giá vốn",
        "Sản phẩm sử dụng",
        "Phiếu xuất kho Q7",
        "NCC & Duyệt chi",
        "Cần xác nhận",
    ]:
        assert business_tab in page
    assert "data-bmq-material-master-business-tabs" in page
    assert "data-bmq-material-master-supporting-details" in page
    assert "row.canonical_material_id === selected.id" in page
    assert "function linkBadge" in page and '"Đã liên kết"' in page and '"Chưa liên kết"' in page
    assert "setActiveTab(\"queue\")" not in page
    assert "openConfirmationQueue" not in page
    assert "Đi tới Cần xác nhận" not in page
    assert "Tên gọi khác" in page and "Giá mua & quy đổi" in page and "Lịch sử chỉnh sửa" in page
    for forbidden_user_copy in ["Canonical NVL Master", "Controller shadow", "Mapping Q7", "Audit timeline", "Sao chép ID chi tiết"]:
        assert forbidden_user_copy not in page
    assert "ReconciliationQueue" in page
    assert "gợi ý" in page.lower() and "không tự chọn" in page.lower()
    assert "Raw UUID" not in page
    assert "audit ID" not in page and "Sao chép ID" not in page
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


def test_cogs_links_use_explicit_fk_and_section_errors_are_business_safe():
    hook = read(HOOK)
    page = read(PAGE)

    assert "product_skus!sku_formulations_sku_id_fkey(sku_code, product_name, sku_type)" in hook
    assert 'product_skus!inner(sku_code, product_name, sku_type)' not in hook
    assert "sectionErrorLabels" in page
    assert 'cogsLinks: "Sản phẩm sử dụng"' in page
    assert '`${section}: ${message}`' not in page
    assert "Không tải được dữ liệu" in page


def test_task4_uses_exact_task2_schema_columns_and_rejects_removed_columns():
    hook = read(HOOK)
    page = read(PAGE)
    combined = hook + "\n" + page

    expected_selects = [
        '"id, material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active, created_by, created_at, updated_at, category, brand, specification, updated_by, version"',
        '"id, material_id, alias_name, normalized_alias, source, active, created_by, created_at"',
        '"id, material_id, supplier_id, source_type, alias_name, normalized_alias, approved, active, metadata, created_at"',
        '"id, material_id, supplier_id, supplier_product_code, supplier_product_name, purchase_unit, base_unit, approved, active, created_at"',
        '"id, material_id, supplier_product_id, price_type, price, price_unit, normalized_base_unit_price, effective_from, effective_to, approved, created_at"',
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
    assert "Phiên bản NVL chưa sẵn sàng" in page
    assert "createFields" in page and "material_code" in page and "canonical_name" in page and "default_unit" in page and "specification" in page
    assert "manual_selection" in hook and 'confidence: "confirmed"' in hook
    assert 'field_name: "material_master_admin"' in hook
    assert "setMaterialId(\"\")" in page
    assert "setCreateFields" in page
    assert "hệ thống có thể gợi ý nhưng không tự chọn" in page.lower()

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
    assert "supplierProductCountByMaterialId" in page
    assert "Đã xác nhận NCC" in page
    assert "Chưa xác nhận NCC" in page
    assert "Đã lưu NCC - chạm để xem" in page
    assert "truncateId" in page
    assert "Sao chép ID chi tiết" not in page
    primary_label_area = page.split("data-bmq-material-master-no-raw-ids", 1)[1].split("data-bmq-material-master-audit-timeline", 1)[0]
    assert ">{row.id}<" not in primary_label_area
    assert ".id}</" not in primary_label_area


def test_task9_controller_shadow_dashboard_and_safe_queue_source_filter():
    hook = read(HOOK)
    page = read(PAGE)
    queue = read(QUEUE)
    dashboard = read(DASHBOARD)
    system_status_page = read(SYSTEM_STATUS_PAGE)
    combined = hook + "\n" + page + "\n" + queue + "\n" + dashboard

    assert "ControllerDashboard" not in page
    assert "Kiểm tra trạng thái hệ thống" not in page
    assert "ControllerDashboard" in system_status_page
    assert "useAuth()" in system_status_page
    assert 'canAccessModule("material_master")' in system_status_page
    assert 'canEditModule("material_master")' in system_status_page
    assert "Quay lại danh mục NVL" in system_status_page
    assert '<TabsTrigger value="controller">' not in page
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
    assert 'sourceFilter' in page
    assert 'sourceFilter' in system_status_page and 'onSourceFilterChange' in system_status_page
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


def test_task10_guarded_owner_mode_change_ui_contract():
    hook = read(HOOK)
    page = read(PAGE)
    dashboard = read(DASHBOARD)
    system_status_page = read(SYSTEM_STATUS_PAGE)
    combined = hook + "\n" + page + "\n" + dashboard + "\n" + system_status_page

    assert "useSetMaterialMasterEnforcementMode" in hook
    assert '.rpc("set_material_master_enforcement_mode"' in hook
    for param in [
        "p_source_type",
        "p_expected_mode",
        "p_new_mode",
        "p_reason",
        "p_readiness_snapshot",
    ]:
        assert param in hook, f"missing Task10 RPC param {param}"
    assert 'invalidateQueries({ queryKey: ["material-master", "rollout-dashboard"] })' in hook
    assert 'invalidateQueries({ queryKey: ["material-master"] })' in hook
    assert "validateRpcResponse" in hook
    assert "nonEmptyReason" in hook

    assert "canEditModule(\"material_master\")" in system_status_page
    assert "<ControllerDashboard" in system_status_page and "canEdit={canEdit}" in system_status_page
    assert "type ControllerDashboardProps" in dashboard and "canEdit: boolean" in dashboard
    assert "data-bmq-material-master-owner-mode-controls" in dashboard
    assert "data-bmq-material-master-fixed-enforcement" in dashboard
    assert "FIXED_EXACT_CONTROLLER_SOURCES" in dashboard
    assert "reason_code: newMode === \"disabled\" ? \"emergency_disable\"" in dashboard
    assert "set_material_master_enforcement_mode" in dashboard
    assert "reason.trim()" in dashboard
    assert "Lý do tiếng Việt bắt buộc" in dashboard
    assert "useState<ModeChangeDraft | null>(null)" in dashboard, "mode change must start with no preselection"
    assert "newMode: null" not in dashboard and "mode: \"enforced\"" not in dashboard, "must not auto-promote or preselect a target mode"

    for token in [
        "AlertDialog",
        "AlertDialogTitle",
        "AlertDialogDescription",
        "Nguồn",
        "Mode hiện tại",
        "Mode mới",
        "Readiness snapshot",
        "Blockers",
        "Pending",
        "Tôi hiểu đây là emergency disable",
    ]:
        assert token in dashboard, f"confirmation dialog missing {token}"

    assert "canPromoteToEnforced(row)" in dashboard
    assert "row.ready_for_enforcement === true" in dashboard
    assert "numberValue(row.queue_pending_count) === 0" in dashboard
    assert "hasNoBlockers(row.blockers)" in dashboard
    assert "modeIs(row.mode, \"enforced\")" in dashboard and 'openModeDialog(row, "shadow"' in dashboard
    assert 'openModeDialog(row, "disabled"' in dashboard and "destructive" in dashboard
    assert "Đã cập nhật chế độ nguồn NVL" in dashboard
    assert "w-full sm:w-auto" in dashboard and "min-w-0" in dashboard
    assert "q7_config" not in combined.lower(), "must not introduce q7 config source"
    assert "source_type: draft.row.source_type" in dashboard
    assert "kitchen_inventory" in dashboard and "Q7 / kho bếp" in dashboard
