from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "src/pages/WarehouseDispatch.tsx"
CSS = ROOT / "src/pages/warehouse-dispatch-print.css"


def read_page() -> str:
    return PAGE.read_text(encoding="utf-8")


def compact(src: str) -> str:
    return re.sub(r"\s+", " ", src)


def extract_print_structure(src: str) -> str:
    marker = 'data-kfm-material-issue-print'
    assert marker in src, "missing printable KFM issue structure marker"
    start = src.index(marker)
    end_marker = "{/* KFM daily material issue dialog"
    end = src.find(end_marker, start + len(marker))
    if end == -1:
        end = src.find("</Dialog>", start)
    assert end != -1, "could not isolate KFM printable structure"
    return src[start:end]


def test_kfm_daily_issue_queries_exact_tables_columns_and_rpcs() -> None:
    src = read_page()
    flat = compact(src)
    assert 'from("kfm_daily_material_issues")' in src
    assert 'from("kfm_daily_material_issue_items")' in src
    assert 'from("kfm_daily_material_issue_sources")' in src
    assert '.select("id,issue_number,issue_date,status,printed_at")' in src
    assert '.eq("issue_date", materialIssueDate)' in src
    assert '.neq("status", "superseded")' in src
    assert '.maybeSingle()' in src
    assert '.select("id,issue_id,ingredient_name,required_qty,unit,sort_order")' in src
    assert '.select("id,issue_id,production_number,po_number")' in src
    assert 'rpc("upsert_kfm_daily_material_issue", { p_issue_date: submittedDate })' in flat
    assert 'rpc("mark_kfm_daily_material_issue_printed", { p_issue_id: targetIssueId })' in flat
    assert 'window.print()' in src


def test_kfm_daily_issue_uses_cohesive_snapshot_payload_for_view_and_print() -> None:
    src = read_page()
    printable = extract_print_structure(src)
    assert "type KfmDailyIssueSnapshot" in src
    assert "issue: KfmDailyMaterialIssue;" in src
    assert "items: KfmDailyMaterialIssueItem[];" in src
    assert "sources: KfmDailyMaterialIssueSource[];" in src
    assert "const [selectedKfmDailyIssueSnapshot" in src
    assert "const [printableKfmDailyIssueSnapshot" in src
    assert "setSelectedKfmDailyIssue(" not in src, "legacy header-only setter must be removed"
    assert "printableKfmDailyIssue?." not in printable
    assert "kfmDailyIssueItems.map" not in printable
    assert "printableKfmDailyIssueSnapshot?.issue.issue_number" in printable
    assert "printableKfmDailyIssueSnapshot?.items" in printable


def test_kfm_daily_issue_loader_filters_children_by_same_issue_id() -> None:
    src = read_page()
    assert "loadKfmDailyIssueSnapshotById" in src
    loader_start = src.index("loadKfmDailyIssueSnapshotById")
    loader_end = src.index("const handleViewKfmDailyIssue", loader_start)
    loader = src[loader_start:loader_end]
    assert '.eq("id", issueId)' in loader
    assert '.eq("issue_id", issue.id)' in loader
    assert '.eq("issue_id", issueId)' not in loader, "children must use the loaded issue id, not an unverified caller/date value"
    assert "return { issue: issue as KfmDailyMaterialIssue, items:" in compact(loader)


def test_kfm_daily_issue_print_marks_reloads_same_issue_id_paints_then_prints() -> None:
    src = read_page()
    flat = compact(src)
    print_start = src.index("const printKfmDailyIssue")
    print_end = src.index("const createMutation", print_start)
    print_fn = src[print_start:print_end]
    assert "const targetIssueId = issue.id" in print_fn
    assert 'rpc("mark_kfm_daily_material_issue_printed", { p_issue_id: targetIssueId })' in compact(print_fn)
    assert "loadKfmDailyIssueSnapshotById(targetIssueId)" in print_fn
    assert "setPrintableKfmDailyIssueSnapshot(refreshedSnapshot)" in print_fn
    assert "await waitForKfmPrintDomPaint()" in print_fn
    assert "window.print()" in print_fn
    assert "kfmDailyIssueQuery.refetch()" not in print_fn
    assert "queryClient.invalidateQueries({ queryKey: [\"kfm_daily_material_issue\", refreshedSnapshot.issue.issue_date] })" in flat


def test_kfm_daily_issue_sync_captures_submitted_date_for_rpc_messages_and_invalidation() -> None:
    src = read_page()
    sync_start = src.index("const syncKfmDailyIssueMutation")
    sync_end = src.index("const printKfmDailyIssue", sync_start)
    sync_block = src[sync_start:sync_end]
    flat = compact(sync_block)
    assert "mutationFn: async (submittedDate: string)" in sync_block
    assert 'rpc("upsert_kfm_daily_material_issue", { p_issue_date: submittedDate })' in flat
    assert "return { result: data as KfmDailyIssueUpsertResult, submittedDate }" in flat
    assert 'onSuccess: ({ result, submittedDate })' in sync_block
    assert "queryClient.invalidateQueries({ queryKey: [\"kfm_daily_material_issue\", submittedDate] })" in sync_block
    assert "cho ngày ${formatVietnamDateKey(submittedDate)}" in sync_block
    assert 'onError: (error: Error, submittedDate)' in sync_block


def test_kfm_daily_issue_never_directly_writes_print_tables_from_client() -> None:
    src = read_page()
    for table in ["kfm_daily_material_issues", "kfm_daily_material_issue_items", "kfm_daily_material_issue_sources"]:
        for write_method in ["insert", "update", "upsert", "delete"]:
            pattern = rf'from\("{table}"\)[\s\S]{{0,220}}\.{write_method}\('
            assert not re.search(pattern, src), f"client must not {write_method} {table}; use RPCs only"


def test_kfm_daily_issue_vn_date_helper_and_error_state_contract() -> None:
    src = read_page()
    assert "getVietnamTodayIso" in src
    assert "Asia/Ho_Chi_Minh" in src
    assert "formatVietnamDateKey" in src
    assert 'useState(getVietnamTodayIso)' in src
    assert 'type="date"' in src
    assert "kfmDailyIssueQuery.isError" in src
    assert "Không tải được phiếu KFM" in src
    assert "Dữ liệu chưa được kết luận là trống" in src
    error_block = src[src.index("kfmDailyIssueQuery.isError") : src.index("kfmDailyIssueQuery.data.issue", src.index("kfmDailyIssueQuery.isError"))]
    assert "Chưa có phiếu KFM" not in error_block, "query error state must not claim empty"


def test_kfm_daily_issue_panel_markers_and_operational_labels() -> None:
    src = read_page()
    for marker in [
        "data-kfm-daily-material-issue",
        "data-kfm-material-issue-print",
        "data-kfm-material-issue-print-table",
    ]:
        assert marker in src
    for text in [
        "Phiếu xuất kho NVL KFM theo ngày",
        "Tạo/đồng bộ phiếu KFM",
        "Xem phiếu",
        "In phiếu",
        "Sẵn sàng in",
        "Đã in",
        "Cần xử lý",
        "PHIẾU XUẤT KHO NGUYÊN VẬT LIỆU",
        "Người lập phiếu",
        "Thủ kho",
        "Người nhận",
    ]:
        assert text in src


def test_printable_dom_contains_only_operational_fields_no_cost_or_bom_or_codes() -> None:
    src = read_page()
    printable = extract_print_structure(src)
    required = [
        "PHIẾU XUẤT KHO NGUYÊN VẬT LIỆU",
        "Số phiếu",
        "Ngày phiếu",
        "Nguồn: KFM",
        "STT",
        "Tên nguyên vật liệu",
        "Số lượng",
        "Đơn vị",
    ]
    for text in required:
        assert text in printable
    forbidden = [
        "unit_cost",
        "total_amount",
        "amount",
        "material_code",
        "Mã NVL",
        "Đơn giá",
        "Chi phí",
        "BOM",
        "cost",
        "COGS",
    ]
    for token in forbidden:
        assert token not in printable, f"printable KFM DOM leaks forbidden field {token!r}"


def test_print_css_a4_and_overflow_contract() -> None:
    assert CSS.exists(), "missing KFM warehouse dispatch print stylesheet"
    css = CSS.read_text(encoding="utf-8")
    for token in [
        "@media print",
        "@page",
        "size: A4 portrait",
        "data-kfm-material-issue-print",
        "data-kfm-material-issue-print-table",
        "thead",
        "display: table-header-group",
        "break-inside: avoid",
        "overflow-wrap: anywhere",
        "white-space: normal",
        "overflow-x: hidden",
    ]:
        assert token in css


if __name__ == "__main__":
    test_kfm_daily_issue_queries_exact_tables_columns_and_rpcs()
    test_kfm_daily_issue_uses_cohesive_snapshot_payload_for_view_and_print()
    test_kfm_daily_issue_loader_filters_children_by_same_issue_id()
    test_kfm_daily_issue_print_marks_reloads_same_issue_id_paints_then_prints()
    test_kfm_daily_issue_sync_captures_submitted_date_for_rpc_messages_and_invalidation()
    test_kfm_daily_issue_never_directly_writes_print_tables_from_client()
    test_kfm_daily_issue_vn_date_helper_and_error_state_contract()
    test_kfm_daily_issue_panel_markers_and_operational_labels()
    test_printable_dom_contains_only_operational_fields_no_cost_or_bom_or_codes()
    test_print_css_a4_and_overflow_contract()
    print("KFM daily material issue UI contracts passed")
