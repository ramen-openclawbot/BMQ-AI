import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

const DEFAULT_PARENT_FOLDER_ID = "1Add8Lj3NiOUel-7h-0wpWUU1-qXzgwdi";

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

function sheetIdByTitle(spreadsheet: { sheets?: Array<{ properties?: { sheetId?: number; title?: string | null } }> }, title: string) {
  return spreadsheet.sheets?.find((sheet) => sheet.properties?.title === title)?.properties?.sheetId;
}

async function getSheetId(accessToken: string, spreadsheetId: string, title: string) {
  const spreadsheet = await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`);
  const sheetId = sheetIdByTitle(spreadsheet, title);
  if (sheetId == null) throw new Error(`sheet_id_missing:${title}`);
  return sheetId;
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

async function shareSheetWithRecipients(accessToken: string, spreadsheetId: string, emails: string[]) {
  const results = [];
  for (const email of emails) {
    try {
      const result = await googleJson(accessToken, `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false&supportsAllDrives=true&fields=id`, {
        method: "POST",
        body: JSON.stringify({ type: "user", role: "reader", emailAddress: email }),
      });
      results.push({ email, ok: true, permissionId: result?.id || null });
    } catch (error) {
      results.push({ email, ok: false, error: error instanceof Error ? error.message : "share_failed" });
    }
  }
  return results;
}

async function sendDebtEmail(input: { to: string[]; customerName: string; fromDate: string; toDate: string; spreadsheetName: string; webViewLink: string; payable: number; lineCount: number; isNpp: boolean }) {
  const emailEnabled = (Deno.env.get("CUSTOMER_DEBT_EMAIL_ENABLED") || "true").toLowerCase() !== "false";
  if (!emailEnabled) return { skipped: true, reason: "CUSTOMER_DEBT_EMAIL_ENABLED=false" };
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY missing");
  const from = Deno.env.get("CUSTOMER_DEBT_EMAIL_FROM") || Deno.env.get("FINANCE_REPORT_FROM") || "BMQ Finance <ramen@bmq.vn>";
  const subject = `BMQ - Công nợ ${input.customerName} ${vnDate(input.fromDate)}-${vnDate(input.toDate)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">
      <p>Kính gửi Quý khách,</p>
      <p>BMQ gửi bảng công nợ của <strong>${escapeHtml(input.customerName)}</strong> cho kỳ <strong>${vnDate(input.fromDate)} đến ${vnDate(input.toDate)}</strong>.</p>
      <ul>
        <li>Loại khách hàng: ${input.isNpp ? "NPP / đại lý cấp 1" : "Khách hàng trực tiếp"}</li>
        <li>Số dòng công nợ: ${input.lineCount}</li>
        <li>Tổng công nợ: <strong>${formatVnd(input.payable)}</strong></li>
      </ul>
      <p>Link Google Sheet: <a href="${escapeHtml(input.webViewLink)}">${escapeHtml(input.spreadsheetName)}</a></p>
      <p>Trân trọng,<br/>BMQ Finance</p>
    </div>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: input.to, subject, html }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Resend error ${response.status}: ${text}`);
  return { sent: true, provider: "resend", subject, response: text };
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
    const data: Array<{ range: string; values: unknown[][] }> = [];
    const accessToken = await getAccessToken(supabaseAdmin);
    const customerName = String(customer.customer_name || "Khách hàng");
    const spreadsheetName = `${customerName.replace(/^Đại lý cấp 1\s*-\s*/i, "").trim()} ${formatRangeName(fromDate, toDate)} Công nợ`;
    const spreadsheet = await googleJson(accessToken, "https://sheets.googleapis.com/v4/spreadsheets?fields=spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))", {
      method: "POST",
      body: JSON.stringify({ properties: { title: spreadsheetName }, sheets: [{ properties: { title: "TOTAL" } }] }),
    });
    const spreadsheetId = spreadsheet.spreadsheetId;

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

      const addSheetRequests = summaries.filter((g) => g.id !== "unmapped").map((g) => ({ addSheet: { properties: { title: safeSheetTitle(g.name) } } }));
      if (addSheetRequests.length) await googleJson(accessToken, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: addSheetRequests }) });

      const totalValues = [
        ["BMQ - Lầu 4 - Tòa Nhà 212 Pasteur - Quận 3 - TPHCM"],
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
          ["BMQ - Lầu 4 - Tòa Nhà 212 Pasteur - Quận 3 - TPHCM"],
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
        ["BMQ - Lầu 4 - Tòa Nhà 212 Pasteur - Quận 3 - TPHCM"],
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
          { repeatCell: { range: { sheetId: totalSheetId, startRowIndex: 0, endRowIndex: 4 }, cell: { userEnteredFormat: { textFormat: { bold: true }, horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat(textFormat,horizontalAlignment)" } },
          { repeatCell: { range: { sheetId: totalSheetId, startRowIndex: 5, endRowIndex: 6 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.85, green: 0.47, blue: 0.04 } } }, fields: "userEnteredFormat(textFormat,backgroundColor)" } },
          { autoResizeDimensions: { dimensions: { sheetId: totalSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: totalColumnCount } } },
        ],
      }),
    });

    try {
      await googleJson(accessToken, `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${encodeURIComponent(parentFolderId)}&fields=id,parents,webViewLink&supportsAllDrives=true`, { method: "PATCH", body: JSON.stringify({}) });
    } catch (moveError) {
      console.warn("[export-npp-debt-sheet] move to folder skipped", moveError);
    }

    let shareResults: Array<{ email: string; ok: boolean; permissionId?: string | null; error?: string }> = [];
    let emailResult: unknown = null;
    if (shouldSendEmail) {
      if (!recipientEmails.length) throw new Error("customer_email_missing_in_crm");
      shareResults = await shareSheetWithRecipients(accessToken, spreadsheetId, recipientEmails);
      const failedShare = shareResults.filter((row) => !row.ok);
      if (failedShare.length) throw new Error(`share_sheet_failed:${failedShare.map((row) => row.email).join(",")}`);
      emailResult = await sendDebtEmail({
        to: recipientEmails,
        customerName,
        fromDate,
        toDate,
        spreadsheetName,
        webViewLink: spreadsheet.spreadsheetUrl,
        payable: emailPayable,
        lineCount: emailLineCount,
        isNpp,
      });
    }

    return jsonResponse({ success: true, spreadsheetId, spreadsheetName, webViewLink: spreadsheet.spreadsheetUrl, summaryCount, recipientEmails, isNpp, emailResult, shareResults }, 200, corsHeaders);
  } catch (error) {
    console.error("[export-npp-debt-sheet] Error", error);
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    return jsonResponse({ success: false, error: friendlyGoogleError(rawMessage) }, 500, corsHeaders);
  }
});
