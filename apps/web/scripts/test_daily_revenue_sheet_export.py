#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EDGE_FN = ROOT / "supabase" / "functions" / "export-daily-revenue-sheet" / "index.ts"
REVENUE_SOURCE = ROOT / "src" / "pages" / "RevenueSourceDetail.tsx"


def require_markers(path: Path, markers: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    missing = [marker for marker in markers if marker not in text]
    if missing:
        raise AssertionError(f"{path.relative_to(ROOT)} missing markers: {missing}")


def test_edge_function_exports_to_google_sheet_in_date_folder() -> None:
    require_markers(
        EDGE_FN,
        [
            "export-daily-revenue-sheet",
            "1Add8Lj3NiOUel-7h-0wpWUU1-qXzgwdi",
            "google_drive_refresh_token",
            "application/vnd.google-apps.folder",
            "application/vnd.google-apps.spreadsheet",
            "upload/drive/v3/files?uploadType=multipart",
            "finance_revenue_permission_required",
            "dateFolderName",
            "dd/mm/yyyy",
            "revenue_ledger_lines",
            "source_document:revenue_source_documents!inner(status)",
            "controlled",
            "trusted",
            "Google Drive đang kết nối bằng quyền read-only",
            "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
            "styleAccountingSheet",
            "sheets.googleapis.com/v4/spreadsheets",
            "batchUpdate",
            "BÁO CÁO DOANH THU NGÀY",
            "TỔNG HỢP THEO KÊNH",
            "CHI TIẾT DOANH THU / SỔ PHỤ LEDGER",
            "setBasicFilter",
            "autoResizeDimensions",
        ],
    )
    text = EDGE_FN.read_text(encoding="utf-8")
    if "function dateFolderName" not in text or 'return `${dd}/${mm}/${yyyy}`' not in text:
        raise AssertionError("date subfolder must be formatted as dd/mm/yyyy")
    if "source_document.status" not in text and "source_document:revenue_source_documents!inner(status)" not in text:
        raise AssertionError("export must be based on controlled/trusted ledger source status")


def test_revenue_source_detail_has_export_button_and_function_call() -> None:
    require_markers(
        REVENUE_SOURCE,
        [
            "FileSpreadsheet",
            "canAccessModule, canEditModule",
            "Export Google Sheet",
            "exportDailyRevenueSheet",
            "fetch(`${supabaseUrl}/functions/v1/export-daily-revenue-sheet`",
            "supabase.auth.getSession",
            "setSheetExportMessage",
            "Trạng thái export Google Sheet",
            "Mở Google Sheet",
            "Export quá 90 giây",
            "Đã export Google Sheet doanh thu ngày",
            "Export doanh thu ngày ra Google Sheet trong Drive theo thư mục dd/mm/yyyy",
            "window.open(result.webViewLink",
        ],
    )


def main() -> None:
    test_edge_function_exports_to_google_sheet_in_date_folder()
    test_revenue_source_detail_has_export_button_and_function_call()
    print("daily revenue sheet export checks passed")


if __name__ == "__main__":
    main()
