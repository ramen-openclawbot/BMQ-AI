import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";
import SparkMD5 from "npm:spark-md5@3.0.2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const DEFAULT_PARENT_FOLDER_ID = "1Add8Lj3NiOUel-7h-0wpWUU1-qXzgwdi";
const DEFAULT_COMPOSIO_BASE_URL = "https://backend.composio.dev";
const CUSTOMER_DEBT_GMAIL_SENDER = "no-reply@bmq.vn";
const CUSTOMER_DEBT_DEFAULT_CC = "ketoantruong@bmq.vn";
const COMPANY_HEADER_LINES = [
  "CÔNG TY CỔ PHẦN THỰC PHẨM BMQ MST: 0311840107",
  "Địa chỉ: Tầng 2, 68 Nguyễn Huệ, phường Sài Gòn, Thành phố Hồ Chí Minh",
];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type DbClient = ReturnType<typeof createClient>;
type QueryError = { message?: string } | null;
type Customer = {
  id: string;
  customer_name: string;
  is_npp?: boolean | null;
  supplied_by_npp_customer_id?: string | null;
  npp_management_fee_vnd?: number | string | null;
  is_active?: boolean | null;
};
type CustomerEmail = { email: string | null; customer_id?: string | null };
type LedgerLine = {
  id: string;
  revenue_date: string;
  channel?: string | null;
  customer_id?: string | null;
  parent_customer_id?: string | null;
  customer_name?: string | null;
  product_name?: string | null;
  item_note?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  gross_revenue?: number | string | null;
  raw_payload?: unknown;
  approval_status?: string | null;
  revenue_source_documents?: { source_name?: string | null } | null;
};
type DebtGroup = {
  id: string;
  name: string;
  customer: Customer | null;
  lines: LedgerLine[];
  quantity: number;
  gross: number;
  fee: number;
  payable: number;
};
type SheetData = { range: string; values: unknown[][] };
type DriveFile = { id: string; name?: string; webViewLink?: string | null; modifiedTime?: string | null };

const jsonResponse = (body: unknown, status = 200, corsHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const assertIsoDate = (value: unknown, field: string) => {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${field}_invalid`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`${field}_invalid`);
  return date;
};

const normalizeText = (value: unknown) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const formatRangeName = (fromDate: string, toDate: string) => {
  const [, fm, fd] = fromDate.split("-");
  const [, tm, td] = toDate.split("-");
  return `${fd}.${fm}-${td}.${tm}`;
};

const vnDate = (date: string) => {
  const [y, m, d] = date.split("-");
  return `${d}/${m}/${y}`;
};

const safeSheetTitle = (name: string) =>
  String(name || "Sheet")
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "Sheet";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function getAccessToken(supabaseAdmin: DbClient): Promise<string> {
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
    body: new URLSearchParams({ refresh_token: String(tokenData.value), client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" }),
  });
  if (!tokenResponse.ok) throw new Error(`google_token_refresh_failed:${await tokenResponse.text()}`);
  const tokens = await tokenResponse.json();
  if (!tokens.access_token) throw new Error("google_access_token_missing");
  return tokens.access_token;
}

const parseGoogleJson = (text: string) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { raw: text };
  }
};

const friendlyGoogleError = (message: string) => {
  if (message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || message.includes("insufficient authentication scopes")) {
    return "Google Drive đang kết nối bằng quyền read-only. Vào Cài đặt hệ thống → Tích hợp Google Drive → Ngắt kết nối/Kết nối lại để cấp quyền tạo Google Sheet, rồi export lại.";
  }
  return message;
};

async function googleJson(accessToken: string, url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  const data = parseGoogleJson(text);
  if (!response.ok) throw new Error(`google_api_error:${response.status}:${text}`);
  return data;
}

const escapeDriveQueryValue = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findExistingDebtSheet(accessToken: string, parentFolderId: string, spreadsheetName: string): Promise<DriveFile | null> {
  const query = [
    `name = '${escapeDriveQueryValue(spreadsheetName)}'`,
    `'${escapeDriveQueryValue(parentFolderId)}' in parents`,
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
    "trashed = false",
  ].join(" and ");
  const result = await googleJson(accessToken, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink,modifiedTime)&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=1`);
  const files = Array.isArray(result?.files) ? result.files as DriveFile[] : [];
  return files[0] || null;
}

function sheetIdByTitle(spreadsheet: { sheets?: Array<{ properties?: { sheetId?: number; title?: string | null } }> }, title: string) {
  return spreadsheet.sheets?.find((sheet) => sheet.properties?.title === title)?.properties?.sheetId;
}

async function getSheetId(accessToken: string, spreadsheetId: string, title: string) {
  const spreadsheet = await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`);
  const sheetId = sheetIdByTitle(spreadsheet, title);
  if (sheetId == null) throw new Error(`sheet_id_missing:${title}`);
  return sheetId;
}

async function prepareSpreadsheetForOverwrite(accessToken: string, spreadsheetId: string, desiredTitles: string[]) {
  let spreadsheet = await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))`);
  const existingSheets = Array.isArray(spreadsheet?.sheets) ? spreadsheet.sheets as Array<{ properties?: { sheetId?: number; title?: string | null } }> : [];
  const existingTitles = new Set(existingSheets.map((sheet) => String(sheet.properties?.title || "")).filter(Boolean));
  const desired = new Set(desiredTitles);
  const requests: unknown[] = [];

  for (const title of desiredTitles) {
    if (!existingTitles.has(title)) requests.push({ addSheet: { properties: { title } } });
  }
  for (const sheet of existingSheets) {
    const title = String(sheet.properties?.title || "");
    const sheetId = sheet.properties?.sheetId;
    if (sheetId != null && title && !desired.has(title)) requests.push({ deleteSheet: { sheetId } });
  }

  if (requests.length) {
    await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
    spreadsheet = await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))`);
  }

  await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`, {
    method: "POST",
    body: JSON.stringify({ ranges: desiredTitles.map((title) => `'${title.replace(/'/g, "''")}'!A:Z`) }),
  });
  return spreadsheet;
}

async function canExportRevenue(supabaseAdmin: DbClient, userId: string): Promise<boolean> {
  const [{ data: roleRows }, { data: permRows }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
    supabaseAdmin.from("user_module_permissions").select("can_view,can_edit").eq("user_id", userId).eq("module_key", "finance_revenue"),
  ]);
  return Boolean(
    (roleRows || []).some((row: { role?: string }) => row.role === "owner") ||
    (permRows || []).some((row: { can_view?: boolean; can_edit?: boolean }) => row.can_view || row.can_edit)
  );
}

const getRouteCustomerId = (line: LedgerLine) => {
  const raw = asRecord(line.raw_payload);
  return String(raw.route_customer_id || raw.routeCustomerId || raw.agency_customer_id || "").trim();
};
const getRouteCustomerName = (line: LedgerLine) => {
  const raw = asRecord(line.raw_payload);
  return String(raw.route_customer_name || raw.routeCustomerName || raw.agency_customer_name || raw.route || "").trim();
};

const lineBelongsToCustomer = (line: LedgerLine, customer: Customer) => {
  const routeId = getRouteCustomerId(line);
  const routeName = getRouteCustomerName(line);
  return (
    line.customer_id === customer.id ||
    line.parent_customer_id === customer.id ||
    routeId === customer.id ||
    normalizeText(line.customer_name) === normalizeText(customer.customer_name) ||
    Boolean(routeName && normalizeText(routeName) === normalizeText(customer.customer_name))
  );
};

const sum = (lines: LedgerLine[], key: "quantity" | "gross_revenue") => lines.reduce((total, line) => total + Number(line[key] || 0), 0);

const sheetRange = (title: string, columns: string, rows: number) => `'${title.replace(/'/g, "''")}'!A1:${columns}${rows}`;

const escapeHtml = (value: unknown) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatVnd = (value: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Number(value || 0));

async function composioJson(path: string, init: RequestInit = {}) {
  const apiKey = Deno.env.get("COMPOSIO_API_KEY");
  const orgId = Deno.env.get("COMPOSIO_ORG_ID");
  const projectId = Deno.env.get("COMPOSIO_PROJECT_ID");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY missing");
  if (!orgId || !projectId) throw new Error("COMPOSIO_ORG_ID_OR_PROJECT_ID missing");
  const baseUrl = (Deno.env.get("COMPOSIO_BASE_URL") || DEFAULT_COMPOSIO_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-user-api-key": apiKey,
      "x-org-id": orgId,
      "x-project-id": projectId,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = parseGoogleJson(text);
  if (!response.ok) throw new Error(`composio_api_error:${response.status}:${text}`);
  return data as Record<string, unknown>;
}

function bytesToBinaryString(bytes: Uint8Array) {
  let output = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    output += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return output;
}

function parseRangeTitle(range: string) {
  const quoted = range.match(/^'((?:''|[^'])+)'!/);
  if (quoted) return quoted[1].replace(/''/g, "'");
  const plain = range.match(/^([^!]+)!/);
  return plain?.[1] || "TOTAL";
}

function safeExcelSheetTitle(name: string, used: Set<string>) {
  const base = String(name || "Sheet")
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31) || "Sheet";
  let title = base;
  let counter = 2;
  while (used.has(title)) {
    const suffix = ` ${counter}`;
    title = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }
  used.add(title);
  return title;
}

function buildDebtWorkbookBytes(sheets: SheetData[]) {
  const workbook = XLSX.utils.book_new();
  const usedTitles = new Set<string>();
  for (const sheet of sheets) {
    const title = safeExcelSheetTitle(parseRangeTitle(sheet.range), usedTitles);
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.values);
    worksheet["!cols"] = Array.from({ length: Math.max(...sheet.values.map((row) => row.length), 1) }, (_unused, index) => ({ wch: index === 0 ? 28 : 18 }));
    XLSX.utils.book_append_sheet(workbook, worksheet, title);
  }
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(bytes);
}

function buildDebtEmailHtml(input: { customerName: string; fromDate: string; toDate: string; payable: number; lineCount: number; isNpp: boolean; attachmentName: string }) {
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#1f2937">
      <p>Kính gửi Quý khách hàng: <strong>${escapeHtml(input.customerName)}</strong>,</p>
      <p>BMQ gửi Anh/Chị file công nợ đính kèm trong kỳ <strong>${vnDate(input.fromDate)} đến ${vnDate(input.toDate)}</strong>.</p>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 12px 4px 0">Loại khách hàng</td><td><strong>${input.isNpp ? "NPP / đại lý cấp 1" : "Khách hàng trực tiếp"}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0">Tổng số dòng doanh thu</td><td><strong>${input.lineCount}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0">Tổng công nợ cần đối soát</td><td><strong>${formatVnd(input.payable)}</strong></td></tr>
      </table>
      <p>File đính kèm: <strong>${escapeHtml(input.attachmentName)}</strong></p>
      <p>Anh/Chị vui lòng kiểm tra số liệu trong file đính kèm. Nếu có chênh lệch, phản hồi lại email này để BMQ đối soát và điều chỉnh.</p>
      <p>Trân trọng,<br/>BMQ Finance</p>
    </div>`;
}

async function uploadComposioAttachment(bytes: Uint8Array, filename: string) {
  const md5 = SparkMD5.hashBinary(bytesToBinaryString(bytes));
  const uploadRequest = await composioJson("/api/v3/files/upload/request", {
    method: "POST",
    body: JSON.stringify({ toolkit_slug: "gmail", tool_slug: "GMAIL_SEND_EMAIL", filename, mimetype: XLSX_MIME, md5 }),
  });
  const uploadUrl = String(uploadRequest.new_presigned_url || uploadRequest.newPresignedUrl || "");
  const s3key = String(uploadRequest.key || "");
  if (!uploadUrl || !s3key) throw new Error("composio_upload_url_missing");
  const uploadHeaders: Record<string, string> = { "Content-Type": XLSX_MIME };
  const metadata = asRecord(uploadRequest.metadata);
  if (metadata.storage_backend === "azure_blob_storage") uploadHeaders["x-ms-blob-type"] = "BlockBlob";
  const uploadResponse = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: bytes });
  if (!uploadResponse.ok) throw new Error(`composio_upload_failed:${uploadResponse.status}:${await uploadResponse.text()}`);
  return { name: filename, mimetype: XLSX_MIME, s3key };
}

async function verifyComposioGmailSender(connectedAccountId: string, composioUserId: string, expectedEmail: string) {
  const result = await composioJson("/api/v3/tools/execute/GMAIL_GET_PROFILE", {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      user_id: composioUserId,
      version: "latest",
      arguments: { user_id: "me" },
    }),
  });
  const data = asRecord(result.data);
  const emailAddress = String(data.emailAddress || data.email || "").toLowerCase();
  if (emailAddress !== expectedEmail.toLowerCase()) throw new Error(`composio_sender_mismatch:${emailAddress || "unknown"}`);
}

async function sendDebtEmail(input: { to: string[]; customerName: string; fromDate: string; toDate: string; spreadsheetName: string; payable: number; lineCount: number; isNpp: boolean; workbookBytes: Uint8Array }) {
  const emailEnabled = (Deno.env.get("CUSTOMER_DEBT_EMAIL_ENABLED") || "true").toLowerCase() !== "false";
  if (!emailEnabled) return { skipped: true, reason: "CUSTOMER_DEBT_EMAIL_ENABLED=false" };
  const connectedAccountId = Deno.env.get("COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID");
  if (!connectedAccountId) throw new Error("COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID missing");
  const senderEmail = Deno.env.get("CUSTOMER_DEBT_GMAIL_SENDER") || CUSTOMER_DEBT_GMAIL_SENDER;
  const composioUserId = Deno.env.get("COMPOSIO_USER_ID");
  if (!composioUserId) throw new Error("COMPOSIO_USER_ID missing");
  await verifyComposioGmailSender(connectedAccountId, composioUserId, senderEmail);
  const attachmentName = `${input.spreadsheetName}.xlsx`;
  const attachment = await uploadComposioAttachment(input.workbookBytes, attachmentName);
  const subject = `BMQ - Công nợ ${input.customerName} ${vnDate(input.fromDate)}-${vnDate(input.toDate)}`;
  const html = buildDebtEmailHtml({ ...input, attachmentName });
  const result = await composioJson("/api/v3/tools/execute/GMAIL_SEND_EMAIL", {
    method: "POST",
    body: JSON.stringify({
      connected_account_id: connectedAccountId,
      user_id: composioUserId,
      version: "latest",
      arguments: {
        user_id: "me",
        from_email: senderEmail,
        recipient_email: input.to[0],
        extra_recipients: input.to.slice(1),
        cc: [CUSTOMER_DEBT_DEFAULT_CC],
        bcc: [],
        subject,
        body: html,
        is_html: true,
        attachment,
      },
    }),
  });
  if (result.successful === false) throw new Error(`composio_gmail_send_failed:${JSON.stringify(result.error || result)}`);
  return { sent: true, provider: "composio_gmail", from: senderEmail, subject, attachmentName, response: result.data || result };
}


serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return jsonResponse({ error: "Invalid or expired token" }, 401, corsHeaders);
    if (!(await canExportRevenue(supabaseAdmin, user.id))) return jsonResponse({ error: "finance_revenue_permission_required" }, 403, corsHeaders);

    const body = await req.json().catch(() => ({}));
    const fromDate = assertIsoDate(body.fromDate || body.from_date, "from_date");
    const toDate = assertIsoDate(body.toDate || body.to_date, "to_date");
    const customerId = String(body.customerId || body.customer_id || body.nppCustomerId || body.npp_customer_id || "").trim();
    if (!customerId) throw new Error("customer_id_required");
    const parentFolderId = String(body.parentFolderId || DEFAULT_PARENT_FOLDER_ID).trim();
    const shouldSendEmail = body.sendEmail === true || body.send_email === true;
    const overwriteExisting = body.overwrite === true || body.overwrite_existing === true;

    const { data: customer, error: customerError } = await supabaseAdmin
      .from("mini_crm_customers")
      .select("id,customer_name,is_npp,supplied_by_npp_customer_id,npp_management_fee_vnd,is_active")
      .eq("id", customerId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) throw new Error("customer_not_found");

    const { data: emailRows, error: emailError } = await supabaseAdmin
      .from("mini_crm_customer_emails")
      .select("email,customer_id")
      .eq("customer_id", customerId)
      .order("email", { ascending: true });
    if (emailError) throw emailError;
    const recipientEmails: string[] = Array.from(new Set((emailRows || [])
      .map((row: CustomerEmail) => String(row.email || "").trim().toLowerCase())
      .filter((email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))));

    const { data: children, error: childError } = await supabaseAdmin
      .from("mini_crm_customers")
      .select("id,customer_name,npp_management_fee_vnd,is_active")
      .eq("supplied_by_npp_customer_id", customerId)
      .order("customer_name", { ascending: true });
    if (childError) throw childError;

    const { data: lines, error: lineError } = await supabaseAdmin
      .from("revenue_ledger_lines")
      .select("id,revenue_date,channel,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,raw_payload,approval_status,revenue_source_documents(source_name)")
      .eq("approval_status", "approved")
      .gte("revenue_date", fromDate)
      .lte("revenue_date", toDate)
      .order("revenue_date", { ascending: true })
      .limit(10000);
    if (lineError) throw lineError;

    const isNpp = Boolean(customer.is_npp);
    const allLines = (lines || []) as LedgerLine[];
    const childRows = (children || []) as Customer[];
    const data: SheetData[] = [];
    const customerName = String(customer.customer_name || "Khách hàng");
    const spreadsheetName = `${customerName.replace(/^Đại lý cấp 1\s*-\s*/i, "").trim()} ${formatRangeName(fromDate, toDate)} Công nợ`;

    let summaryCount = 0;
    let emailLineCount = 0;
    let emailPayable = 0;
    if (isNpp) {
      const childById = new Map(childRows.map((c) => [c.id, c]));
      const childByName = new Map(childRows.map((c) => [normalizeText(c.customer_name), c]));
      const groups = new Map<string, DebtGroup>();
      const ensureGroup = (id: string, name: string, groupCustomer: Customer | null) => {
        if (!groups.has(id)) groups.set(id, { id, name, customer: groupCustomer, lines: [], quantity: 0, gross: 0, fee: Number(groupCustomer?.npp_management_fee_vnd || 0), payable: 0 });
        return groups.get(id)!;
      };
      for (const c of childRows) ensureGroup(c.id, c.customer_name, c);
      for (const line of allLines) {
        const routeId = getRouteCustomerId(line);
        const routeName = getRouteCustomerName(line);
        let groupCustomer = routeId ? childById.get(routeId) || null : null;
        if (!groupCustomer && line.customer_id) groupCustomer = childById.get(line.customer_id) || null;
        if (!groupCustomer && routeName) groupCustomer = childByName.get(normalizeText(routeName)) || null;
        const belongs = line.parent_customer_id === customerId || line.customer_id === customerId || Boolean(groupCustomer) || normalizeText(line.customer_name) === normalizeText(customerName);
        if (!belongs) continue;
        const group = groupCustomer ? ensureGroup(groupCustomer.id, groupCustomer.customer_name, groupCustomer) : ensureGroup("unmapped", "Chưa map đại lý", null);
        group.lines.push(line);
        group.quantity += Number(line.quantity || 0);
        group.gross += Number(line.gross_revenue || 0);
      }
      const summaries = Array.from(groups.values()).map((g) => ({ ...g, payable: g.gross - g.fee })).sort((a, b) => b.gross - a.gross);
      summaryCount = summaries.length;
      emailLineCount = summaries.reduce((s, g) => s + g.lines.length, 0);
      emailPayable = summaries.reduce((s, g) => s + g.payable, 0);

      const totalValues = [
        ...COMPANY_HEADER_LINES.map((line) => [line]),
        ["SỔ CHI TIẾT CÔNG NỢ"],
        [`${customerName} • Từ ${vnDate(fromDate)} đến ${vnDate(toDate)}`],
        [`Email CRM: ${recipientEmails.join(", ") || "Chưa có email trong CRM"}`],
        [],
        ["Đại lý", "Số lượng", "Tổng tiền bánh", "Phí quản lí", "Công nợ phải thanh toán"],
        ...summaries.map((g) => [g.name, g.quantity, g.gross, g.fee, g.payable]),
        ["TỔNG", summaries.reduce((s, g) => s + g.quantity, 0), summaries.reduce((s, g) => s + g.gross, 0), summaries.reduce((s, g) => s + g.fee, 0), summaries.reduce((s, g) => s + g.payable, 0)],
      ];
      data.push({ range: "TOTAL!A1:E" + totalValues.length, values: totalValues });
      for (const group of summaries.filter((x) => x.id !== "unmapped")) {
        const title = safeSheetTitle(group.name);
        const values = [
          ...COMPANY_HEADER_LINES.map((line) => [line]),
          ["SỔ CHI TIẾT CÔNG NỢ"],
          [`${group.name} • Từ ${vnDate(fromDate)} đến ${vnDate(toDate)}`],
          [],
          ["Ngày", "Số lượng", "Đơn giá", "Thành tiền"],
          ...group.lines.map((line) => [line.revenue_date, Number(line.quantity || 0), Number(line.unit_price || 0), Number(line.gross_revenue || 0)]),
          [],
          ["", "Tổng tiền bánh", "", group.gross],
          ["", "Phí quản lí", "", -group.fee],
          ["", "Công nợ phải thanh toán", "", group.payable],
        ];
        data.push({ range: sheetRange(title, "D", values.length), values });
      }
    } else {
      const directLines = allLines.filter((line) => lineBelongsToCustomer(line, customer as Customer));
      summaryCount = directLines.length;
      const gross = sum(directLines, "gross_revenue");
      const quantity = sum(directLines, "quantity");
      emailLineCount = directLines.length;
      emailPayable = gross;
      const values = [
        ...COMPANY_HEADER_LINES.map((line) => [line]),
        ["SỔ CHI TIẾT CÔNG NỢ"],
        [`${customerName} • Từ ${vnDate(fromDate)} đến ${vnDate(toDate)}`],
        [`Email CRM: ${recipientEmails.join(", ") || "Chưa có email trong CRM"}`],
        [],
        ["Ngày", "Kênh", "Diễn giải", "Số lượng", "Đơn giá", "Công nợ"],
        ...directLines.map((line) => [
          line.revenue_date,
          line.channel || "",
          line.product_name || line.customer_name || "Doanh thu",
          Number(line.quantity || 0),
          Number(line.unit_price || 0),
          Number(line.gross_revenue || 0),
        ]),
        [],
        ["", "", "TỔNG", quantity, "", gross],
      ];
      data.push({ range: `TOTAL!A1:F${values.length}`, values });
    }

    const workbookBytes = buildDebtWorkbookBytes(data);
    let spreadsheetId: string | null = null;
    let webViewLink: string | null = null;
    let shareResults: Array<{ email: string; ok: boolean; permissionId?: string | null; error?: string }> = [];
    let emailResult: unknown = null;
    let attachmentName: string | null = null;

    if (shouldSendEmail) {
      if (!recipientEmails.length) throw new Error("customer_email_missing_in_crm");
      emailResult = await sendDebtEmail({
        to: recipientEmails,
        customerName,
        fromDate,
        toDate,
        spreadsheetName,
        payable: emailPayable,
        lineCount: emailLineCount,
        isNpp,
        workbookBytes,
      });
      attachmentName = String(asRecord(emailResult).attachmentName || `${spreadsheetName}.xlsx`);
    } else {
      const accessToken = await getAccessToken(supabaseAdmin);
      const desiredSheetTitles = data.map((sheet) => safeSheetTitle(parseRangeTitle(sheet.range)));
      const existingFile = await findExistingDebtSheet(accessToken, parentFolderId, spreadsheetName);
      let spreadsheet: { spreadsheetId?: string; spreadsheetUrl?: string; sheets?: Array<{ properties?: { sheetId?: number; title?: string | null } }> };

      if (existingFile && !overwriteExisting) {
        return jsonResponse({
          success: false,
          code: "debt_sheet_exists",
          error: "File công nợ này đã tồn tại. Anh muốn ghi đè hay huỷ?",
          spreadsheetName,
          existingFileId: existingFile.id,
          existingWebViewLink: existingFile.webViewLink || null,
        }, 409, corsHeaders);
      }

      if (existingFile && overwriteExisting) {
        spreadsheetId = existingFile.id;
        webViewLink = existingFile.webViewLink || null;
        spreadsheet = await prepareSpreadsheetForOverwrite(accessToken, spreadsheetId, desiredSheetTitles);
        webViewLink = String(spreadsheet.spreadsheetUrl || webViewLink || "");
      } else {
        spreadsheet = await googleJson(accessToken, "https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))", {
          method: "POST",
          body: JSON.stringify({ properties: { title: spreadsheetName }, sheets: [{ properties: { title: "TOTAL" } }] }),
        });
        spreadsheetId = String(spreadsheet.spreadsheetId || "");
        webViewLink = String(spreadsheet.spreadsheetUrl || "");

        const sheetTitles = desiredSheetTitles.filter((title) => title !== "TOTAL");
        const addSheetRequests = sheetTitles.map((title) => ({ addSheet: { properties: { title } } }));
        if (addSheetRequests.length) {
          await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: addSheetRequests }) });
          spreadsheet = await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))`);
        }
      }

      await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
      });

      const totalSheetId = sheetIdByTitle(spreadsheet, "TOTAL") ?? await getSheetId(accessToken, spreadsheetId, "TOTAL");
      const totalColumnCount = isNpp ? 5 : 6;
      await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: [
            { repeatCell: { range: { sheetId: totalSheetId, startRowIndex: 0, endRowIndex: 5 }, cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(textFormat,horizontalAlignment)" } },
            { repeatCell: { range: { sheetId: totalSheetId, startRowIndex: 6, endRowIndex: 7 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.47, blue: 0.04 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
            { autoResizeDimensions: { dimensions: { sheetId: totalSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: totalColumnCount } } },
          ],
        }),
      });

      try {
        await googleJson(accessToken, `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${encodeURIComponent(parentFolderId)}&fields=id,parents,webViewLink&supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({}) });
      } catch (moveError) {
        console.warn("[export-npp-debt-sheet] move to folder skipped", moveError);
      }
    }

    return jsonResponse({ success: true, spreadsheetId, spreadsheetName, webViewLink, summaryCount, recipientEmails, isNpp, emailResult, shareResults, attachmentName, overwrittenExisting }, 200, corsHeaders);
  } catch (error) {
    console.error("[export-npp-debt-sheet] Error", error);
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ success: false, error: friendlyGoogleError(rawMessage) }, 500, corsHeaders);
  }
});
