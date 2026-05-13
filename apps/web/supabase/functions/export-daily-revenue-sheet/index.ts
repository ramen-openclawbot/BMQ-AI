import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const DEFAULT_PARENT_FOLDER_ID = "1Add8Lj3NiOUel-7h-0wpWUU1-qXzgwdi";

const jsonResponse = (body: unknown, status = 200, corsHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type RevenueLine = {
  id: string;
  revenue_date: string;
  period: string;
  channel: string | null;
  invoice_no: string | null;
  customer_name: string | null;
  product_name: string | null;
  item_note: string | null;
  quantity: number | null;
  unit_price: number | null;
  gross_revenue: number | null;
  source_type: string | null;
  approval_status: string | null;
  audit_status: string | null;
  review_status: string | null;
  reconciliation_status: string | null;
};

function assertIsoDate(value: unknown): string {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("revenue_date_invalid");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("revenue_date_invalid");
  return date;
}

function dateFolderName(date: string): string {
  // Google Drive date subfolder format required by ops: dd/mm/yyyy
  const [yyyy, mm, dd] = date.split("-");
  return `${dd}/${mm}/${yyyy}`;
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

async function getAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: tokenData, error } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  if (error || !tokenData?.value) throw new Error("missing_google_drive_refresh_token");

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("missing_google_oauth_env");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokenData.value,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) throw new Error(`google_token_refresh_failed:${await tokenResponse.text()}`);
  const tokens = await tokenResponse.json();
  if (!tokens.access_token) throw new Error("google_access_token_missing");
  return tokens.access_token;
}

async function driveJson(accessToken: string, url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`drive_api_error:${response.status}:${text}`);
  return data;
}

async function findChildFolder(accessToken: string, parentFolderId: string, name: string): Promise<{ id: string; name: string } | null> {
  const query = encodeURIComponent(`'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=10&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const data = await driveJson(accessToken, url);
  return data.files?.[0] || null;
}

async function ensureDateFolder(accessToken: string, parentFolderId: string, folderName: string) {
  const existing = await findChildFolder(accessToken, parentFolderId, folderName);
  if (existing) return { ...existing, created: false };

  const data = await driveJson(accessToken, "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink&supportsAllDrives=true", {
    method: "POST",
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    }),
  });
  return { id: data.id, name: data.name, webViewLink: data.webViewLink, created: true };
}

async function uploadCsvAsGoogleSheet(accessToken: string, folderId: string, fileName: string, csv: string) {
  const boundary = `bmq_export_${crypto.randomUUID()}`;
  const metadata = {
    name: fileName,
    mimeType: "application/vnd.google-apps.spreadsheet",
    parents: [folderId],
    description: "BMQ daily controlled revenue export",
  };
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: text/csv; charset=UTF-8",
    "",
    csv,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,parents&supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`drive_sheet_upload_failed:${response.status}:${text}`);
  return data;
}

type AccountingSheetLayout = {
  channelHeaderRow: number;
  channelStartRow: number;
  channelEndRow: number;
  detailSectionRow: number;
  detailGroupHeaderRow: number;
  detailHeaderRow: number;
  totalRows: number;
  totalColumns: number;
};

function color(red: number, green: number, blue: number) {
  return { red: red / 255, green: green / 255, blue: blue / 255 };
}

async function sheetsJson(accessToken: string, url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`sheets_api_error:${response.status}:${text}`);
  return data;
}

async function styleAccountingSheet(accessToken: string, spreadsheetId: string, layout: AccountingSheetLayout) {
  const spreadsheet = await sheetsJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`);
  const sheetId = spreadsheet.sheets?.[0]?.properties?.sheetId;
  if (sheetId == null) throw new Error("sheet_id_missing");

  const allRange = { sheetId, startRowIndex: 0, endRowIndex: layout.totalRows, startColumnIndex: 0, endColumnIndex: layout.totalColumns };
  const detailDataStart = Math.min(layout.detailHeaderRow + 1, layout.totalRows);

  const requests = [
    { updateSheetProperties: { properties: { sheetId, title: "Doanh thu ngày", gridProperties: { frozenRowCount: Math.min(layout.detailHeaderRow + 1, 20) } }, fields: "title,gridProperties.frozenRowCount" } },
    { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, mergeType: "MERGE_ALL" } },
    { repeatCell: { range: allRange, cell: { userEnteredFormat: { backgroundColor: color(255, 251, 235), textFormat: { fontFamily: "Arial", fontSize: 10, foregroundColor: color(41, 37, 36) }, verticalAlignment: "MIDDLE", wrapStrategy: "WRAP" } }, fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, cell: { userEnteredFormat: { backgroundColor: color(67, 45, 25), horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 16, foregroundColor: color(251, 191, 36) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, cell: { userEnteredFormat: { backgroundColor: color(245, 235, 218), textFormat: { italic: true, foregroundColor: color(87, 83, 78) } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 3 }, cell: { userEnteredFormat: { backgroundColor: color(217, 119, 6), horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: color(255, 255, 255) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.channelHeaderRow, endRowIndex: layout.channelHeaderRow + 1, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { backgroundColor: color(217, 119, 6), horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: color(255, 255, 255) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { mergeCells: { range: { sheetId, startRowIndex: layout.detailGroupHeaderRow, endRowIndex: layout.detailGroupHeaderRow + 1, startColumnIndex: 0, endColumnIndex: 5 }, mergeType: "MERGE_ALL" } },
    { mergeCells: { range: { sheetId, startRowIndex: layout.detailGroupHeaderRow, endRowIndex: layout.detailGroupHeaderRow + 1, startColumnIndex: 5, endColumnIndex: 8 }, mergeType: "MERGE_ALL" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.detailGroupHeaderRow, endRowIndex: layout.detailGroupHeaderRow + 1, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: color(120, 53, 15), horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: color(255, 255, 255) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.detailGroupHeaderRow, endRowIndex: layout.detailGroupHeaderRow + 1, startColumnIndex: 5, endColumnIndex: 8 }, cell: { userEnteredFormat: { backgroundColor: color(146, 64, 14), horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: color(255, 255, 255) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.detailHeaderRow, endRowIndex: layout.detailHeaderRow + 1, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, cell: { userEnteredFormat: { backgroundColor: color(68, 64, 60), horizontalAlignment: "CENTER", textFormat: { bold: true, foregroundColor: color(255, 255, 255) } } }, fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 8, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, cell: { userEnteredFormat: { backgroundColor: color(254, 243, 199), textFormat: { bold: true, foregroundColor: color(146, 64, 14) } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.detailSectionRow, endRowIndex: layout.detailSectionRow + 1, startColumnIndex: 0, endColumnIndex: layout.totalColumns }, cell: { userEnteredFormat: { backgroundColor: color(254, 243, 199), textFormat: { bold: true, foregroundColor: color(146, 64, 14) } } }, fields: "userEnteredFormat(backgroundColor,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: 4, endRowIndex: 7, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { horizontalAlignment: "RIGHT", numberFormat: { type: "NUMBER", pattern: "#,##0" }, textFormat: { bold: true } } }, fields: "userEnteredFormat(horizontalAlignment,numberFormat,textFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: layout.channelStartRow, endRowIndex: layout.channelEndRow, startColumnIndex: 1, endColumnIndex: 4 }, cell: { userEnteredFormat: { horizontalAlignment: "RIGHT", numberFormat: { type: "NUMBER", pattern: "#,##0" } } }, fields: "userEnteredFormat(horizontalAlignment,numberFormat)" } },
    { repeatCell: { range: { sheetId, startRowIndex: detailDataStart, endRowIndex: layout.totalRows, startColumnIndex: 5, endColumnIndex: 8 }, cell: { userEnteredFormat: { horizontalAlignment: "RIGHT", numberFormat: { type: "NUMBER", pattern: "#,##0" } } }, fields: "userEnteredFormat(horizontalAlignment,numberFormat)" } },
    { updateBorders: { range: allRange, top: { style: "SOLID", width: 1, color: color(214, 211, 209) }, bottom: { style: "SOLID", width: 1, color: color(214, 211, 209) }, left: { style: "SOLID", width: 1, color: color(214, 211, 209) }, right: { style: "SOLID", width: 1, color: color(214, 211, 209) }, innerHorizontal: { style: "SOLID", width: 1, color: color(231, 229, 228) }, innerVertical: { style: "SOLID", width: 1, color: color(231, 229, 228) } } },
    { setBasicFilter: { filter: { range: { sheetId, startRowIndex: layout.detailHeaderRow, endRowIndex: layout.totalRows, startColumnIndex: 0, endColumnIndex: layout.totalColumns } } } },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: layout.totalColumns } } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 2, endIndex: 4 }, properties: { pixelSize: 220 }, fields: "pixelSize" } },
  ];

  await sheetsJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function canExportRevenue(supabaseAdmin: any, userId: string): Promise<boolean> {
  const [{ data: roleRows }, { data: permRows }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
    supabaseAdmin.from("user_module_permissions").select("can_view,can_edit").eq("user_id", userId).eq("module_key", "finance_revenue"),
  ]);
  return Boolean(
    (roleRows || []).some((row: any) => row.role === "owner") ||
    (permRows || []).some((row: any) => row.can_view || row.can_edit)
  );
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return jsonResponse({ error: "Invalid or expired token" }, 401, corsHeaders);
    if (!(await canExportRevenue(supabaseAdmin, user.id))) return jsonResponse({ error: "finance_revenue_permission_required" }, 403, corsHeaders);

    const body = await req.json().catch(() => ({}));
    const revenueDate = assertIsoDate(body.revenueDate || body.revenue_date);
    const parentFolderId = String(body.parentFolderId || DEFAULT_PARENT_FOLDER_ID).trim();
    if (!parentFolderId) throw new Error("parent_folder_required");

    const { data, error } = await supabaseAdmin
      .from("revenue_ledger_lines")
      .select("id,revenue_date,period,channel,invoice_no,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,review_status,reconciliation_status,source_document:revenue_source_documents!inner(status)")
      .eq("revenue_date", revenueDate)
      .eq("approval_status", "approved")
      .in("source_document.status", ["controlled", "trusted"])
      .order("channel", { ascending: true })
      .order("customer_name", { ascending: true });
    if (error) throw error;

    const lines = (data || []) as RevenueLine[];
    const totalsByChannel = new Map<string, { rows: number; qty: number; revenue: number }>();
    for (const line of lines) {
      const key = line.channel || "Không rõ kênh";
      const current = totalsByChannel.get(key) || { rows: 0, qty: 0, revenue: 0 };
      current.rows += 1;
      current.qty += Number(line.quantity || 0);
      current.revenue += Number(line.gross_revenue || 0);
      totalsByChannel.set(key, current);
    }

    const totalQuantity = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
    const totalGrossRevenue = lines.reduce((sum, line) => sum + Number(line.gross_revenue || 0), 0);
    const channelRows = Array.from(totalsByChannel.entries()).map(([channel, stats]) => [channel, stats.rows, stats.qty, stats.revenue]);
    if (channelRows.length === 0) channelRows.push(["Không có dữ liệu", 0, 0, 0]);
    const detailSectionRow = 10 + channelRows.length + 1;
    const detailGroupHeaderRow = detailSectionRow + 1;
    const detailHeaderRow = detailSectionRow + 2;

    const accountingRows = [
      ["BÁO CÁO DOANH THU NGÀY", "", "", "", "", "", "", ""],
      ["Bánh Mì Que - Doanh thu đã kiểm soát", `Ngày doanh thu: ${revenueDate}`, "Đơn vị: VND", "Mẫu kế toán nội bộ", "", "", "", ""],
      [],
      ["CHỈ TIÊU", "GIÁ TRỊ", "GHI CHÚ"],
      ["Tổng số dòng", lines.length, "Số dòng ledger đã duyệt"],
      ["Tổng số lượng", totalQuantity, "Tổng quantity trong ngày"],
      ["Tổng doanh thu", totalGrossRevenue, "Doanh thu đã kiểm soát"],
      [],
      ["TỔNG HỢP THEO KÊNH"],
      ["Kênh bán hàng", "Số dòng", "Số lượng", "Doanh thu"],
      ...channelRows,
      [],
      ["CHI TIẾT DOANH THU / SỔ PHỤ KẾ TOÁN"],
      ["THÔNG TIN BÁN HÀNG", "", "", "", "", "GIÁ TRỊ KẾ TOÁN", "", ""],
      ["Ngày", "Kênh", "Khách hàng", "Sản phẩm", "Ghi chú", "Số lượng", "Đơn giá", "Thành tiền"],
      ...lines.map((line) => [
        line.revenue_date,
        line.channel || "",
        line.customer_name || "",
        line.product_name || "",
        line.item_note || "",
        Number(line.quantity || 0),
        Number(line.unit_price || 0),
        Number(line.gross_revenue || 0),
      ]),
    ];

    const sheetLayout: AccountingSheetLayout = {
      channelHeaderRow: 9,
      channelStartRow: 10,
      channelEndRow: 10 + channelRows.length,
      detailSectionRow,
      detailGroupHeaderRow,
      detailHeaderRow,
      totalRows: accountingRows.length,
      totalColumns: 8,
    };

    const accessToken = await getAccessToken(supabaseAdmin);
    const folderName = dateFolderName(revenueDate);
    const folder = await ensureDateFolder(accessToken, parentFolderId, folderName);
    const fileName = `BMQ Báo cáo doanh thu ngày ${folderName}`;
    const sheet = await uploadCsvAsGoogleSheet(accessToken, folder.id, fileName, toCsv(accountingRows));
    await styleAccountingSheet(accessToken, sheet.id, sheetLayout);

    return jsonResponse({
      success: true,
      revenueDate,
      folderName,
      folderId: folder.id,
      folderCreated: folder.created,
      fileId: sheet.id,
      fileName: sheet.name,
      webViewLink: sheet.webViewLink,
      rowCount: lines.length,
      grossRevenue: totalGrossRevenue,
    }, 200, corsHeaders);
  } catch (error) {
    console.error("[export-daily-revenue-sheet] failed", error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || rawMessage.includes("insufficient authentication scopes")
      ? "Google Drive đang kết nối bằng quyền read-only. Vào Cài đặt hệ thống → Tích hợp Google Drive → Ngắt kết nối/Kết nối lại để cấp quyền tạo thư mục và Google Sheet, rồi export lại."
      : rawMessage;
    return jsonResponse({ error: message }, 500, getCorsHeaders(req));
  }
});
