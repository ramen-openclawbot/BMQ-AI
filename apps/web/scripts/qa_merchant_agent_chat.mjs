// QA for the owner's merchant-agent chat (Anthropic merchant agent behind bmq-agent.vnagent.ai).
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are in-memory fixtures and
// the merchant agent API is answered by scripted routes; all other non-local network is blocked.
// It proves the real widget renders and wires replies, cards, drafts and approvals; it is not
// a real Claude turn and never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_merchant_agent_chat.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-merchant-chat-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5213);
const AGENT = "https://bmq-agent.vnagent.ai";
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaBodies = window.__qaBodies || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const READ_RPCS = new Set(["rpc:finance_unc_total_from_evidence", "rpc:finance_daily_snapshot", "rpc:get_payment_submission"]);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const pr = (id, number, supplierId, supplierName, amount, status = "pending", unpaid = false, hour = "02") => ({
  id, request_number: number, title: "Thanh toán " + supplierName, total_amount: amount, vat_amount: 0,
  status, payment_status: status === "approved" && !unpaid ? "paid" : "unpaid", payment_method: "bank_transfer",
  delivery_status: "pending", created_at: today + "T" + hour + ":00:00.000Z", created_by: "acc-user",
  supplier_id: supplierId, suppliers: { id: supplierId, name: supplierName },
  payment_request_items: [{ id: id + "-i", product_name: "Bột mì số 13", raw_product_name: null }],
  payment_allocations: status === "approved" && !unpaid ? [{ id: id + "-a", amount, payment_id: "p1", created_at: today }] : [],
  goods_receipts: null, purchase_orders: { id: "po-" + id, po_number: "PO-" + number, status: "approved" },
  invoices: null, invoice_created: false, image_url: null, notes: null, approved_by: null, approved_at: null,
  rejection_reason: null, goods_receipt_id: null, purchase_order_id: "po-" + id, invoice_id: null,
});
const PRS = [
  pr("11111111-1111-4111-8111-111111111111", "DC-0101", "sup-a", "Bột Mì Sài Gòn", 13500000),
  pr("22222222-2222-4222-8222-222222222222", "DC-0102", "sup-a", "Bột Mì Sài Gòn", 6250000),
  pr("33333333-3333-4333-8333-333333333333", "DC-0103", "sup-b", "Công ty TNHH Thực Phẩm Tươi Sống Miền Nam chi nhánh Bình Tân", 31750000),
  pr("44444444-4444-4444-8444-444444444444", "DC-0099", "sup-a", "Bột Mì Sài Gòn", 8000000, "approved"),
  pr("55555555-5555-4555-8555-555555555551", "DC-0096", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "00"),
  pr("55555555-5555-4555-8555-555555555552", "DC-0097", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "01"),
  pr("55555555-5555-4555-8555-555555555553", "DC-0098", "sup-t", "Thiên An Sinh", 11131500, "approved", true, "02"),
  pr("55555555-5555-4555-8555-555555555554", "DC-0104", "sup-t", "Thiên An Sinh", 11131500, "pending", false, "03"),
  pr("55555555-5555-4555-8555-555555555555", "DC-0105", "sup-t", "Thiên An Sinh", 2607720, "pending", false, "04"),
];
const UNPAID = Array.from({ length: 23 }, (_, i) => {
  const r = pr("88888888-8888-4888-8888-" + String(100000000000 + i).slice(1), "PR-U" + String(i + 1).padStart(3, "0"), i % 3 === 0 ? "sup-t" : "sup-a", i % 3 === 0 ? "Thiên An Sinh" : "Bột Mì Sài Gòn", 1000000 * (i + 1), i % 4 === 0 ? "approved" : "pending", true, "02");
  r.created_at = new Date(Date.now() - i * 3 * 86400000).toISOString();
  return r;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
function settle(st) {
  if (st.table === "rpc:set_dealer_order_lock") {
    window.__qaBodies.push({ name: "set_dealer_order_lock", ...(st.args || {}) });
    return { data: { customer_id: st.args?.p_customer_id, order_locked: !!st.args?.p_locked, revoked_sessions: st.args?.p_locked ? 2 : 0 }, error: null };
  }
  if (st.table.startsWith("rpc:")) return { data: null, error: null };
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
  if (st.table === "mini_crm_customers") return { data: CUSTOMERS, error: null, count: CUSTOMERS.length };
  return { data: [], error: null, count: 0 };
}
const CUSTOMERS = [
  { id: "cus-open", customer_name: "Đại lý Hồng Phát", customer_code: "DL-001", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: false, address: "12 Lê Lợi", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [{ id: "ct1", customer_id: "cus-open", contact_name: "Chị Hồng", phone_normalized: "84901234567", is_active: true, is_primary: true, is_test: false }] },
  { id: "cus-locked", customer_name: "Đại lý Minh Châu", customer_code: "DL-002", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: true, order_locked_at: new Date(Date.now() - 3600000).toISOString(), order_lock_reason: "Nợ quá hạn tháng 9", address: "5 Hai Bà Trưng", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [] },
];
function builder(table, args) {
  const st = { table, args, filters: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...a) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && a[1] && a[1].head) st.head = true;
        if (prop === "eq") st.filters[a[0]] = a[1];
        if (prop === "range") st.range = [a[0], a[1]];
        if (prop === "in" && a[0] === "supplier_id") st.supplierIds = a[1];
        if (prop === "or") st.or = a[0];
        if (prop === "gte") st.gte = a[1];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaBodies.push({ name, ...body });
  const c = cfg();
  if (name === "dealer-auth-start") {
    if (c.dealer === "locked") return { data: { otp_required: false, reason: "dealer_order_locked", code: "dealer_order_locked", message: "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng." }, error: null };
    return { data: { otp_required: true, message: "Mã OTP đã được gửi qua Zalo." }, error: null };
  }
  return { data: null, error: { message: "QA fixture: functions disabled" } };
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: null, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "qa-fixture-token", user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: { access_token: "qa-fixture-token", user } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  channel: () => channel,
  removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const cfg = JSON.parse(localStorage.getItem("qa-shell") || "{}");
const role = cfg.role || "owner";
const MODULES = { owner: null, accountant: ["dashboard", "payment_requests", "goods_receipts", "suppliers", "finance_cost"] }[role];
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = {
  user, session: { access_token: "qa-fixture-token", user },
  profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: role === "owner" ? ["owner"] : ["staff"], authzLoaded: true, authzError: false,
  isOwner: role === "owner", canAccessModule: can, canEditModule: can,
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-unc-fixtures",
  enforce: "pre",
  resolveId(id) {
    if (id === "@/integrations/supabase/client" || id.endsWith("/src/integrations/supabase/client") || id.endsWith("/src/integrations/supabase/client.ts")) return "\0qa-supabase";
    if (id === "@/contexts/AuthContext" || id.endsWith("/src/contexts/AuthContext") || id.endsWith("/src/contexts/AuthContext.tsx")) return "\0qa-auth.jsx";
    return null;
  },
  load(id) {
    if (id === "\0qa-supabase") return SUPABASE_FIXTURE;
    if (id === "\0qa-auth.jsx") return AUTH_FIXTURE;
    return null;
  },
};


const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-merchant-chat-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://qa.supabase.test"), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"), __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name) => { results.push({ name }); console.log("PASS", name); };

const CHANGE = { change_id: "chg-1", kind: "campaign", status: "staged", summary: "Thông báo: đặt từ 300 que tặng 1 hộp pate", items: [{ target: "Đặt 300 que tặng 1 hộp pate", field: "name", after: "Đặt 300 que tặng 1 hộp pate (20/10 – 26/10)" }], guardrail_notes: ["Có thể nhắc món không có trong danh mục.", "Thời gian/điều kiện chưa rõ."] };
const COST_BLOCK = {
  v: 1, kind: "cost_line", mode: "example", month: "2026-10",
  line: { classificationId: "cls-1", sourceNumber: "PR-QA01", sourceDate: "2026-10-12", supplierName: "Bột Mì Sài Gòn", productName: "Bột mì số 13", amount: 13500000, categoryLabel: "Nguyên liệu chính", categoryCode: "NVL", reviewStatus: "approved", confidence: "high", classificationSource: "rule" },
  evidence: { stored: true, rule: null, alias: null, aliasStatus: null },
  notes: [], source: { name: "Phân loại chi phí", observedAt: "2026-10-18T03:00:00Z", snapshotId: "snap-1", semanticVersion: "v1", selectionRule: null, matchCount: 1, truncated: false, disclaimer: "Số liệu tham khảo." },
  followUp: "line_explanation",
};
// Shape of the server's deterministic `revenue_snapshot` block (version 1); numbers mirror a
// real 19/10 run so the card is checked against realistic magnitudes.
const SNAPSHOT = {
  version: 1, generated_at: "2026-10-19T14:05:00+07:00",
  periods: { current: { start: "2026-10-01", end: "2026-10-19" }, previous: { start: "2026-09-01", end: "2026-09-19" } },
  revenue: {
    total: { current: 687707835, previous: 605402622, delta_pct: 13.6, daily_avg_current: 36195149.21, daily_avg_previous: 31863295.89 },
    groups: [
      { group: "dealer", label: "Đại lý", current: 296500000, previous: 291200000, delta_pct: 1.8, silent_days: 0, previous_active_days: 19, last_day_with_revenue: "2026-10-19" },
      { group: "bakery", label: "Bánh ngọt", current: 248600000, previous: 168500000, delta_pct: 47.5, silent_days: 0, previous_active_days: 19, last_day_with_revenue: "2026-10-19" },
      { group: "b2b", label: "B2B / Siêu thị", current: 80400000, previous: 92400000, delta_pct: -13.0, silent_days: 0, previous_active_days: 15, last_day_with_revenue: "2026-10-18" },
      { group: "retail", label: "Xe bán lẻ", current: 62200000, previous: 53300000, delta_pct: 16.7, silent_days: 2, previous_active_days: 19, last_day_with_revenue: "2026-10-17" },
    ],
    channels_raw: [], days_current: 19, days_previous: 19,
  },
  kiosk: { channels: [{ channel_code: "khach_le", channel_name: "Khách lẻ", current: 10900000, previous: 9200000, delta_pct: 18.1 }, { channel_code: "grabfood", channel_name: "GrabFood", current: 1200000, previous: 2600000, delta_pct: -53.8 }], reported_yesterday: 2, missing_yesterday: [{ location_code: "HCM005-TN", location_name: "Điểm Tân Phú" }], reported_today: 0, active_count: 3 },
  dealer_orders: { count_current: 223, count_previous: 250, amount_current: 274300000, amount_previous: 287170000, delta_pct: -4.5, orders_last_2_days: 16, previous_daily_avg: 13.16, days_current: 19, days_previous: 19 },
  auto_job: { status: "error", message: "timeout" },
  flags: [
    { code: "channel_silent", severity: "high", title: "Kênh Xe bán lẻ không có số 2 ngày", detail: "Kênh có số 19/19 ngày của tháng trước nhưng đang im lặng.", action: "Kênh Xe bán lẻ không có số 2 ngày liền: kiểm tra app/kênh vận hành hoặc job nhập sổ" },
    { code: "kiosk_missing_reports", severity: "medium", title: "1 điểm bán chưa nộp báo cáo hôm qua", detail: "Điểm chưa nộp: Điểm Tân Phú.", action: "Nhắc các điểm chưa nộp báo cáo ngày 18/10: Điểm Tân Phú" },
    { code: "kiosk_channel_drop", severity: "medium", title: "Kênh GrabFood tại điểm bán giảm 53,8%", detail: "Kỳ này 1,2 tr, cùng kỳ 2,6 tr (-53,8%).", action: "Kiểm tra app GrabFood tại điểm bán (đóng gian hàng, lỗi app, hết hàng)" },
    { code: "data_source_error", severity: "info", title: "Không đọc được dữ liệu nhật ký job 23:59", detail: "timeout", action: "Thử lại sau; nếu lặp lại, báo kỹ thuật" },
  ],
  sources: ["revenue_ledger_lines", "kiosk_report_locations", "kiosk_daily_reports", "dealer_orders", "revenue_auto_daily_parse_logs"],
  caveat: "Số đã kiểm soát theo sổ doanh thu, chưa phải số kiểm toán.",
};
const DOC_PR = { kind: "pr", code: "PR-MV6H33KA", id: "11111111-1111-4111-8111-111111111111", title: "DNTT 131026 · Chi phí thuê nhà kho Q7 tháng 10 · 28,040,000 đ", path: "/payment-requests?id=11111111-1111-4111-8111-111111111111" };
const DOC_PO = { kind: "po", code: "PO-000854", id: "22222222-2222-4222-8222-222222222222", title: "PO-000854 · 7,830,000 đ", path: "/purchase-orders?id=22222222-2222-4222-8222-222222222222" };
// Bank slip fixture modelled on the real case (rent 21/10–20/11 to Lại Đình Tuấn, pending PR-MV6VLC9E).
const SLIP_PR_ID = "66666666-6666-4666-8666-666666666666";
const SLIP_CATEGORIES = [
  { code: "B2_KIOSK_RENT", label: "Mặt bằng điểm bán" },
  { code: "C1_WAREHOUSE_RENT", label: "Thuê kho, bếp" },
  { code: "C2_ELECTRICITY", label: "Điện" },
  { code: "C11_BANK_TAX_OTHER", label: "Phí ngân hàng, thuế, phí khác" },
];
const SLIP_STAGED = {
  change_id: "slip-1", status: "staged", version: 1,
  slip: { amount: 20000000, reference: "6087660296", transfer_date: "2026-10-29", beneficiary_account: "9908011986", beneficiary_name: "LAI DINH TUAN", transfer_content: "CONG TY CO PHAN THUC PHAM BMQ chuyen tien thue nha tu 2110 den 20112026 tai 14.1.15 Duong Bia Truyen Thong, Binh Tan", confidence: 0.74, file_sha256: "f".repeat(64), storage_path: "payment-unc/2026/10/x.jpg" },
  supplier: { id: "sup-ldt", name: "Lại Đình Tuấn (thuê kho Bình Tân)" },
  target: { mode: "pay_existing", request_id: SLIP_PR_ID, request_number: "PR-MV6VLC9E", title: "DNTT131026", line_name: "DNTT131026", amount: 20000000 },
  category: { code: "C1_WAREHOUSE_RENT", label: "Thuê kho, bếp", source: "history", evidence: { request_numbers: ["PR-MV6VLC9E"] } },
  previous: { request_number: "PR-MT71Z1SX", date: "2026-08-24", amount: 20000000 },
  warnings: ["low_ocr_confidence"],
  categories: SLIP_CATEGORIES,
};
const SLIP_DOC = { kind: "pr", code: "PR-MV6VLC9E", id: SLIP_PR_ID, title: "PR-MV6VLC9E · 20.000.000 đ", path: `/payment-requests?id=${SLIP_PR_ID}` };
let slipSends = 0;
function reply(body) {
  const text = String(body.message || "").toLowerCase();
  if (Array.isArray(body.attachments) && body.attachments.length) {
    slipSends += 1;
    if (slipSends % 2 === 0) return { status: 200, json: { session_id: "s-1", text: "Bankslip này đã được ghi nhận trước đó ở phiếu PR-MV6VLC9E.", tool_calls: ["bank_slip_intake"], ui: [{ component: "bank_slip_payment", payload: { status: "already_recorded", request_number: "PR-MV6VLC9E", doc_link: SLIP_DOC } }], pending_changes: [] } };
    return { status: 200, json: { session_id: "s-1", text: "Đã đọc bankslip 20.000.000 đ cho Lại Đình Tuấn (thuê kho Bình Tân). Đề xuất thanh toán phiếu PR-MV6VLC9E.", tool_calls: ["bank_slip_intake"], ui: [{ component: "bank_slip_payment", payload: SLIP_STAGED }], pending_changes: [{ change_id: "slip-1", kind: "bank_slip_payment", status: "staged", summary: "Thanh toán phiếu PR-MV6VLC9E" }] } };
  }
  if (text.includes("snapshot")) return { status: 200, json: { session_id: "s-1", text: "Snapshot doanh thu 19/10 — từ đầu tháng so với cùng kỳ tháng trước\nTổng doanh thu: 687,7 tr (+13,6% so với cùng kỳ)", tool_calls: ["bmq_revenue_snapshot"], ui: [{ component: "revenue_snapshot", payload: SNAPSHOT }, { component: "suggestions", payload: { suggestions: ["Vì sao kênh giảm?", "Điểm bán nào chưa nộp báo cáo?", "Doanh thu tháng này theo kênh"] } }], pending_changes: [] } };
  if (text.includes("chi tiết pr")) return { status: 200, json: { session_id: "s-1", text: "BMQ Agent xem được PR-MV6H33KA (DNTT 131026) của ANH HẢI (CHỦ NHÀ KHO Q.7): 28.040.000 VND, chờ duyệt.", tool_calls: ["mcp__bmq__bmq_document_link"], ui: [{ component: "doc_link", version: 1, payload: DOC_PR }, { component: "doc_link", version: 1, payload: DOC_PR }, { component: "doc_link", version: 1, payload: { ...DOC_PR, path: "javascript:alert(1)" } }, { component: "doc_link", version: 1, payload: DOC_PO }], pending_changes: [] } };
  if (text.includes("lỗi máy chủ")) return { status: 503, json: { detail: "Trợ lý quản trị đang không phản hồi." } };
  if (text.includes("thông báo")) return { status: 200, json: { session_id: "s-1", text: "Em đã soạn bản nháp thông báo, anh xem và bấm Duyệt nếu đồng ý.", tool_calls: ["mcp__merchant__stage_campaign"], ui: [{ component: "change_preview", payload: { change_id: "chg-1", change: CHANGE, headline: "Thông báo khuyến mãi tuần 20/10", note: "Chưa có gì được gửi." } }, { component: "suggestions", payload: { suggestions: ["Rút gọn nội dung", "Đổi thời gian áp dụng"] } }], pending_changes: [CHANGE] } };
  if (text.includes("công nợ")) return { status: 200, json: { session_id: "s-1", text: "BMQ Agent đã tra công nợ nhà cung cấp.", tool_calls: ["mcp__bmq__ask_sushi"], ui: [{ component: "sushi_answer", payload: { answer: "Công nợ nhà cung cấp hiện tại là 182,4 triệu, lớn nhất là Bột Mì Sài Gòn.", costBlock: COST_BLOCK, images: [{ id: "a".repeat(64), date: "2026-10-12", declarationId: "PR-QA01", paymentStatus: "submitted_unverified" }], details: "Bột Mì Sài Gòn: 13,5 triệu\nThiên An Sinh: 10,7 triệu", citations: [{ id: "c1", title: "Bảng công nợ NCC", source: "BMQ", updated_at: "2026-10-18" }] } }], pending_changes: [] } };
  if (text.includes("vấn đề")) return { status: 200, json: { session_id: "s-1", text: "Hôm nay có 3 việc cần chú ý.", tool_calls: [], ui: [{ component: "digest", payload: { title: "Đơn đại lý hôm nay", items: [{ kind: "order_issue", headline: "Đại lý Lê Văn Lương chưa có đơn giao hôm nay", why_it_matters: "Đã đặt 5/7 ngày gần đây." }, { kind: "order_issue", headline: "Đại lý Hồng Lạc đang bị khoá đặt hàng" }] } }], pending_changes: [] } };
  return { status: 200, json: { session_id: "s-1", text: "Doanh thu tháng 9 đạt 979,5 triệu, Đại lý chiếm 46%.", tool_calls: ["mcp__merchant__query_metrics"], ui: [{ component: "metrics", payload: { title: "Doanh thu tháng 9", period: "2026-09", metrics: [{ metric: "sales", value: 979545347, change_pct: 4.2, currency: "VND" }, { metric: "orders", value: 385, change_pct: -2.1 }, { metric: "revenue", series: { metric: "revenue", unit: "VND", segment: "channel:ĐẠI LÝ", points: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value: 12000000 + (i % 7) * 900000 })) }, note: "Kênh lớn nhất" }] } }, { component: "suggestions", payload: { suggestions: ["So với tháng 8", "Chi tiết kênh Bánh ngọt"] } }], pending_changes: [] } };
}

async function open(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript(() => localStorage.setItem("qa-shell", JSON.stringify({ role: "owner" })));
  const calls = [];
  await context.route("**/*", async (r) => {
    const url = r.request().url();
    if (url.startsWith(AGENT)) {
      const method = r.request().method();
      if (method === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": BASE, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST,GET,OPTIONS" } });
      const headers = { "access-control-allow-origin": BASE, "content-type": "application/json" };
      const pathName = new URL(url).pathname;
      const body = r.request().postDataJSON?.() || {};
      calls.push({ path: pathName, body, auth: r.request().headers()["authorization"] });
      // Slip messages wait longer so the upload progress strip can be observed.
      await new Promise((resolve) => setTimeout(resolve, Array.isArray(body.attachments) && body.attachments.length ? 900 : 200));
      if (pathName === "/v1/chat") { const answer = reply(body); return r.fulfill({ status: answer.status, headers, body: JSON.stringify(answer.json) }); }
      if (pathName === "/v1/changes/slip-1/approve") return r.fulfill({ status: 200, headers, body: JSON.stringify({ change_id: "slip-1", kind: "bank_slip_payment", status: "applied", request_number: "PR-MV6VLC9E", doc_link: SLIP_DOC, classification: "applied" }) });
      if (pathName.endsWith("/approve")) return r.fulfill({ status: 200, headers, body: JSON.stringify({ ...CHANGE, status: "applied" }) });
      if (pathName.endsWith("/discard")) return r.fulfill({ status: 200, headers, body: JSON.stringify({ ...CHANGE, status: "discarded" }) });
      return r.fulfill({ status: 404, headers, body: "{}" });
    }
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/mini-crm", { waitUntil: "domcontentloaded" });
  await page.locator("[data-merchant-agent-launcher]").waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, calls };
}

const panel = (page) => page.locator("[data-merchant-agent-chat]");
const overflow = (page) => page.evaluate(() => { const el = document.querySelector("[data-merchant-agent-chat]"); return el ? el.scrollWidth - el.clientWidth : 0; });
async function ask(page, text) {
  await page.getByLabel("Tin nhắn cho BMQ Agent").fill(text);
  await page.locator("[data-merchant-send]").click();
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const tag = viewport.width;
    const { context, page, errors, calls } = await open(viewport);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}/launcher-page-${tag}.png` });
    const launcherBox = await page.locator("[data-merchant-agent-launcher]").boundingBox();
    assert.ok(launcherBox && Math.round(launcherBox.width) === 60 && launcherBox.x + launcherBox.width <= viewport.width, `launcher 60px inside the viewport ${tag}`);
    await page.locator("[data-merchant-agent-launcher]").click();
    await panel(page).waitFor();
    // Starters follow the page: /mini-crm has its own CRM set.
    assert.equal(await page.locator("[data-merchant-starters]").getAttribute("data-merchant-starters"), "/mini-crm");
    assert.equal(await page.locator("[data-merchant-starter]").count(), 3);
    assert.equal(await page.locator("[data-merchant-starter]").first().textContent(), "Đại lý nào lâu chưa đặt hàng?");
    assert.ok((await page.locator("[data-merchant-starters]").textContent()).includes("Gợi ý · CRM"));
    assert.ok((await panel(page).textContent()).includes("bấm Duyệt mới áp"));
    assert.ok(await overflow(page) <= 0, `no overflow with page starters ${tag}`);
    // The chat sheet is a Radix dialog; the form-dialog kit must not repaint it (owner IMG_6026:
    // the composer became a white bar, the font, title weight and caps changed).
    const look = await page.evaluate(() => {
      const sheet = document.querySelector("[data-merchant-agent-chat]");
      const style = (el) => (el ? getComputedStyle(el) : null);
      return {
        composerBg: style(document.querySelector("[aria-label='Tin nhắn cho BMQ Agent']"))?.backgroundColor,
        sheetFont: style(sheet)?.fontFamily,
        titleWeight: style(sheet?.querySelector("h2"))?.fontWeight,
        captionCase: style(document.querySelector("[data-merchant-starters] > div"))?.textTransform,
      };
    });
    assert.equal(look.composerBg, "rgba(0, 0, 0, 0)", `composer stays transparent ${tag}`);
    assert.ok(look.sheetFont?.startsWith('"Be Vietnam Pro"') || look.sheetFont?.startsWith("Be Vietnam Pro"), `chat uses the BMQ app font ${tag}: ${look.sheetFont}`);
    assert.equal(look.titleWeight, "600", `BMQ Agent title weight ${tag}`);
    assert.equal(look.captionCase, "none", `starter caption in sentence case ${tag}`);
    // BMQ theme (owner 30/10): pink BMQ badge in the header and on the launcher, light sheet.
    const theme = await page.evaluate(() => {
      const sheet = document.querySelector("[data-merchant-agent-chat]");
      return {
        sheetBg: getComputedStyle(sheet).backgroundColor,
        logo: document.querySelector("[data-merchant-agent-logo]")?.getAttribute("src"),
        launcherLogo: document.querySelector("[data-merchant-agent-launcher] img")?.getAttribute("src"),
        logoLoaded: (() => { const img = document.querySelector("[data-merchant-agent-logo]"); return Boolean(img && img.complete && img.naturalWidth > 0); })(),
        defaultCloseShown: Array.from(sheet.children).some((el) => el.tagName === "BUTTON" && el.querySelector(".sr-only") && getComputedStyle(el).display !== "none"),
        composerHeight: document.querySelector("[aria-label='Tin nhắn cho BMQ Agent']").getBoundingClientRect().height,
      };
    });
    assert.equal(theme.sheetBg, "rgb(236, 236, 234)", `sheet uses the app panel colour ${tag}: ${theme.sheetBg}`);
    assert.ok(theme.logo?.includes("/assets/brand/bmq-logo") && theme.launcherLogo?.includes("/assets/brand/bmq-logo"), "BMQ badge in header and launcher");
    assert.ok(theme.logoLoaded, "BMQ badge image loads");
    assert.equal(theme.defaultCloseShown, false, `only the header close key shows ${tag}`);
    assert.equal(theme.composerHeight, 24, `empty composer is one line ${tag}`);
    record(`chat keeps its own theme inside the dialog kit ${tag}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${EVIDENCE}/empty-${tag}.png` });
    record(`page starters on CRM ${tag}`);

    await page.locator("[data-merchant-starter]").nth(1).click();
    await page.locator("[data-merchant-ui='metrics']").waitFor({ timeout: 10000 });
    assert.equal(calls[0].path, "/v1/chat");
    assert.equal(calls[0].auth, "Bearer qa-fixture-token", "sends the Supabase session token");
    assert.equal(calls[0].body.page, "/mini-crm · CRM: khách hàng và đại lý của BMQ", "page context names the page and its purpose");
    assert.equal(calls[0].body.message, "Top đại lý theo doanh số tháng này");
    assert.equal(calls[0].body.session_id, undefined, "first turn opens a new session");
    const metricsText = await page.locator("[data-merchant-ui='metrics']").textContent();
    assert.ok(metricsText.includes("979,5 triệu") && metricsText.includes("+4,2%") && metricsText.includes("ĐẠI LÝ"), metricsText);
    assert.equal(await page.locator("[data-merchant-suggestion]").count(), 2);
    assert.ok(await overflow(page) <= 0, `no overflow ${tag}`);
    await page.screenshot({ path: `${EVIDENCE}/metrics-${tag}.png` });
    record(`metrics reply ${tag}`);

    await page.locator("[data-merchant-suggestion]").first().click();
    await page.waitForFunction(() => document.querySelectorAll("[data-merchant-message='agent']").length >= 2);
    assert.equal(calls[1].body.session_id, "s-1", "follow-up keeps the session");
    record(`suggestion chip continues the session ${tag}`);

    await ask(page, "Hôm nay đơn đại lý có vấn đề gì?");
    await page.locator("[data-merchant-ui='digest']").waitFor();
    assert.ok((await page.locator("[data-merchant-ui='digest']").textContent()).includes("Lê Văn Lương"));
    record(`digest card ${tag}`);

    await ask(page, "Công nợ nhà cung cấp hiện tại?");
    const sushiCard = page.locator("[data-merchant-ui='sushi']");
    await sushiCard.waitFor();
    const sushiText = await sushiCard.textContent();
    assert.ok(sushiText.includes("182,4 triệu") && sushiText.includes("Bột mì số 13"), "Sushi answer and cost card");
    assert.ok(sushiText.includes("Bảng công nợ NCC"), "sources shown");
    assert.ok(await overflow(page) <= 0, `no overflow with Sushi card ${tag}`);
    await sushiCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/sushi-${tag}.png` });
    const panelText = await panel(page).textContent();
    for (const internal of ["Sushi", "Claude", "Haiku", "dữ liệu BMQ", "VNAgent"]) assert.ok(!panelText.includes(internal), `no internal name "${internal}" in the chat UI`);
    assert.ok(panelText.includes("BMQ Agent"), "BMQ Agent name shown");
    record(`Sushi answer card ${tag}`);

    await ask(page, "Soạn thông báo khuyến mãi tuần này");
    const card = page.locator("[data-merchant-change='chg-1']");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-merchant-change-status"), "staged");
    assert.ok((await card.textContent()).includes("Thông báo dathang"));
    const warnings = await card.locator("[data-merchant-change-warnings]").textContent();
    assert.ok(warnings.includes("không có trong danh mục") && warnings.includes("chưa rõ"), "guard warnings on the draft");
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/draft-${tag}.png` });
    assert.equal(calls.filter((c) => c.path.includes("/approve")).length, 0, "nothing approved before the tap");
    await card.locator("[data-merchant-change-action='approve']").click();
    await page.locator("[data-merchant-change='chg-1'][data-merchant-change-status='applied']").waitFor();
    assert.equal(await card.locator("[data-merchant-change-action]").count(), 0, "buttons gone after apply");
    assert.equal(await card.locator("[data-merchant-change-warnings]").count(), 0, "warnings hidden once applied");
    assert.ok(calls.some((c) => c.path === "/v1/changes/chg-1/approve"));
    await page.screenshot({ path: `${EVIDENCE}/applied-${tag}.png` });
    record(`draft approve applies ${tag}`);

    // Bank slip: attach, read, approve with the chosen cost category, resend is refused.
    const slipImage = process.env.QA_SLIP_IMAGE;
    assert.ok(slipImage && fs.existsSync(slipImage), "QA_SLIP_IMAGE points to a slip image");
    await page.locator("[data-merchant-image-input]").setInputFiles(slipImage);
    await page.locator("[data-merchant-pending-image] img").waitFor();
    assert.ok(await page.locator("[data-merchant-send]").isEnabled(), "an image alone can be sent");
    await page.waitForTimeout(400);
    const sendBg = await page.locator("[data-merchant-send]").evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(sendBg, "rgb(39, 39, 39)", `send key turns ink with only an image ${tag}: ${sendBg}`);
    assert.ok((await page.locator("[data-merchant-pending-image]").textContent()).includes("1 ảnh"), "pending card header counts the image");
    await page.locator("[data-merchant-view-image]").click();
    const viewerEl = page.locator("[data-merchant-image-viewer]");
    await viewerEl.waitFor();
    await page.screenshot({ path: `${EVIDENCE}/slip-viewer-${tag}.png` });
    await page.locator("[data-merchant-viewer-close]").click();
    await viewerEl.waitFor({ state: "hidden" });
    record(`pending image: header, View opens the viewer ${tag}`);
    assert.ok(await overflow(page) <= 0, `no overflow with a pending image ${tag}`);
    await page.screenshot({ path: `${EVIDENCE}/slip-pending-${tag}.png` });
    const chatCallsBefore = calls.filter((c) => c.path === "/v1/chat").length;
    await page.locator("[data-merchant-send]").click();
    await page.locator("[data-merchant-upload-progress]").waitFor({ timeout: 3000 });
    await page.screenshot({ path: `${EVIDENCE}/slip-uploading-${tag}.png` });
    const slipCard = page.locator("[data-merchant-bank-slip='slip-1']");
    await slipCard.waitFor({ timeout: 10000 });
    const slipCall = calls.filter((c) => c.path === "/v1/chat")[chatCallsBefore];
    assert.equal(slipCall.body.message, "Duyệt chi theo bankslip");
    assert.equal(slipCall.body.attachments.length, 1);
    assert.equal(slipCall.body.attachments[0].kind, "image");
    assert.equal(slipCall.body.attachments[0].mime_type, "image/jpeg", "slip re-encoded to JPEG");
    assert.ok(slipCall.body.attachments[0].data_base64.length > 1000 && slipCall.body.attachments[0].data_base64.length < 8_000_000, "base64 image within the 6 MB limit");
    assert.equal(await page.locator("[data-merchant-pending-image]").count(), 0, "composer cleared after sending");
    assert.equal(await page.locator("[data-merchant-upload-progress]").count(), 0, "progress strip gone after the reply");
    const sentImage = page.locator("[data-merchant-message-attachment='image'] img").last();
    assert.ok((await sentImage.getAttribute("src")).startsWith("data:image/jpeg"), "sent bubble shows the prepared slip");
    await page.locator("[data-merchant-message-attachment='image']").last().click();
    await viewerEl.waitFor();
    await page.keyboard.press("Escape");
    await viewerEl.waitFor({ state: "hidden" });
    assert.ok(await panel(page).isVisible(), "Escape closes the image, not the chat");
    record(`sent slip thumbnail opens the viewer; Escape keeps the chat ${tag}`);
    const slipText = await slipCard.textContent();
    for (const expected of ["20.000.000 đ", "Lại Đình Tuấn", "PR-MV6VLC9E", "29/10/2026", "6087660296", "PR-MT71Z1SX", "24/08/2026", "Học từ PR-MV6VLC9E", "đối chiếu lại số tiền"]) {
      assert.ok(slipText.includes(expected), `slip card shows "${expected}"`);
    }
    assert.equal(await slipCard.locator("[data-merchant-bank-slip-category]").inputValue(), "C1_WAREHOUSE_RENT", "history category preselected");
    assert.equal(calls.filter((c) => c.path.includes("/approve") && c.path.includes("slip")).length, 0, "nothing approved before the tap");
    assert.ok(await overflow(page) <= 0, `no overflow with the slip card ${tag}`);
    const selectBox = await slipCard.locator("[data-merchant-bank-slip-category]").boundingBox();
    const cardBox = await slipCard.boundingBox();
    assert.ok(selectBox && cardBox && selectBox.x + selectBox.width <= cardBox.x + cardBox.width + 0.5, `category select inside the card ${tag}`);
    await slipCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/slip-card-${tag}.png` });
    await slipCard.screenshot({ path: `${EVIDENCE}/slip-card-only-${tag}.png` });
    await slipCard.locator("[data-merchant-bank-slip-category]").selectOption("C11_BANK_TAX_OTHER");
    assert.ok((await slipCard.locator("[data-merchant-bank-slip-source]").textContent()).includes("Anh tự chọn"));
    await slipCard.locator("[data-merchant-bank-slip-category]").selectOption("C1_WAREHOUSE_RENT");
    await slipCard.locator("[data-merchant-bank-slip-action='approve']").click();
    await page.locator("[data-merchant-bank-slip='slip-1'][data-merchant-bank-slip-status='applied']").waitFor();
    const approveCall = calls.find((c) => c.path === "/v1/changes/slip-1/approve");
    assert.deepEqual(approveCall.body, { category_code: "C1_WAREHOUSE_RENT" }, "approval carries the chosen category");
    assert.equal(await slipCard.locator("[data-merchant-bank-slip-action]").count(), 0, "buttons gone after apply");
    assert.equal(await slipCard.locator("[data-merchant-bank-slip-warnings]").count(), 0, "warnings hidden once applied");
    assert.ok((await slipCard.locator("[data-merchant-bank-slip-done]").textContent()).includes("PR-MV6VLC9E"));
    assert.equal(await slipCard.locator("[data-merchant-bank-slip-doc]").count(), 1, "open-phiếu button after apply");
    await slipCard.scrollIntoViewIfNeeded();
    await slipCard.screenshot({ path: `${EVIDENCE}/slip-applied-${tag}.png` });
    record(`bank slip: attach, card, approve with category ${tag}`);
    await page.locator("[data-merchant-image-input]").setInputFiles(slipImage);
    await page.locator("[data-merchant-pending-image] img").waitFor();
    await page.locator("[data-merchant-send]").click();
    const recorded = page.locator("[data-merchant-bank-slip='already_recorded']").last();
    await recorded.waitFor();
    assert.ok((await recorded.textContent()).includes("đã được ghi"));
    assert.ok(await overflow(page) <= 0, `no overflow with already-recorded card ${tag}`);
    record(`bank slip resend shows already recorded ${tag}`);

    await ask(page, "lỗi máy chủ thử");
    await page.locator("[data-merchant-message='error']").waitFor();
    assert.ok((await page.locator("[data-merchant-message='error']").textContent()).includes("không phản hồi"));
    assert.ok(await page.getByLabel("Tin nhắn cho BMQ Agent").isEnabled(), "composer usable after an error");
    record(`server error shown ${tag}`);

    await ask(page, "Snapshot doanh thu");
    const snapshot = page.locator("[data-merchant-ui='revenue_snapshot']");
    await snapshot.waitFor();
    const snapshotText = await snapshot.textContent();
    for (const expected of ["687,7 triệu", "+13,6%", "Đại lý", "Bánh ngọt", "+47,5%", "Xe bán lẻ", "im lặng 2 ngày", "2/3", "Điểm Tân Phú", "16 đơn", "GrabFood", "Bất thường (4)", "Kênh Xe bán lẻ không có số 2 ngày", "→ Kiểm tra app GrabFood", "chưa phải số kiểm toán", "Chụp lúc 14:05 19/10"]) {
      assert.ok(snapshotText.includes(expected), `snapshot card shows "${expected}"`);
    }
    assert.ok(snapshotText.includes("Nhật ký job: chưa đọc được dữ liệu"), "a failed source reads as unreadable, never 0");
    assert.equal(await snapshot.locator("[data-merchant-snapshot-flag]").count(), 4);
    assert.equal(await snapshot.locator("[data-merchant-snapshot-flag]").first().getAttribute("data-merchant-snapshot-flag"), "channel_silent", "high flag listed first");
    assert.equal(await page.locator("[data-merchant-suggestion]").count(), 3, "follow-up chips after the snapshot");
    assert.ok(await overflow(page) <= 0, `no overflow with snapshot card ${tag}`);
    await snapshot.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/snapshot-${tag}.png` });
    await snapshot.screenshot({ path: `${EVIDENCE}/snapshot-card-${tag}.png` });
    record(`revenue snapshot card ${tag}`);

    await ask(page, "Xem chi tiết PR-MV6H33KA");
    const docLinks = page.locator("[data-merchant-doc-link]");
    await docLinks.first().waitFor();
    assert.equal(await docLinks.count(), 2, "duplicate and unsafe doc links are dropped");
    assert.ok((await docLinks.first().textContent()).includes("Mở phiếu"));
    assert.ok(await overflow(page) <= 0, `no overflow with doc links ${tag}`);
    await docLinks.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/doc-links-${tag}.png` });
    const turnsBefore = await page.locator("[data-merchant-message]").count();
    await docLinks.first().click();
    await page.waitForURL(/\/payment-requests\?id=11111111-1111-4111-8111-111111111111/);
    await panel(page).waitFor({ state: "hidden" });
    const back = page.locator("[data-merchant-back-to-chat]");
    await back.waitFor();
    assert.ok((await back.getAttribute("aria-label")).includes("PR-MV6H33KA"));
    const backBox = await back.boundingBox();
    assert.ok(backBox && backBox.x >= 0 && backBox.x + backBox.width <= viewport.width, `back pill inside viewport ${tag}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${EVIDENCE}/doc-opened-${tag}.png` });
    record(`Mở phiếu closes the chat and opens the PR page ${tag}`);
    await back.click();
    await panel(page).waitFor();
    assert.equal(await page.locator("[data-merchant-message]").count(), turnsBefore, "conversation kept after opening a phiếu");
    assert.equal(await back.count(), 0, "pill hidden while the chat is open");
    record(`back to chat keeps the conversation ${tag}`);
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-merchant-agent-launcher]").waitFor({ state: "attached", timeout: 30000 });
    await back.waitFor();
    await back.click();
    await panel(page).waitFor();
    assert.equal(await page.locator("[data-merchant-message]").count(), turnsBefore, "conversation restored after reload");
    await ask(page, "Doanh thu tháng 9");
    await page.waitForFunction((n) => document.querySelectorAll("[data-merchant-message]").length >= n + 2, turnsBefore);
    assert.equal(calls[calls.length - 1].body.session_id, "s-1", "reloaded chat continues the same server session");
    record(`reload restores the conversation and session ${tag}`);

    await page.locator("[data-merchant-agent-reset]").click();
    assert.equal(await page.locator("[data-merchant-message]").count(), 0);
    // Reset happened on the PR page, so the Duyệt chi starters show.
    assert.equal(await page.locator("[data-merchant-starters]").getAttribute("data-merchant-starters"), "/payment-requests");
    assert.equal(await page.locator("[data-merchant-starter]").count(), 4);
    assert.equal(await page.locator("[data-merchant-starter]").first().textContent(), "Phiếu chi nào đang chờ duyệt?");
    assert.ok(await overflow(page) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/reset-payment-requests-${tag}.png` });
    record(`reset clears the conversation and shows the page starters ${tag}`);
    await page.locator("[data-merchant-starter]").first().click();
    await page.waitForFunction(() => document.querySelectorAll("[data-merchant-message='agent']").length >= 1);
    assert.ok(calls[calls.length - 1].body.page.startsWith("/payment-requests · Duyệt chi: phiếu đề nghị chi (PR)"), calls[calls.length - 1].body.page);
    record(`PR page context sent ${tag}`);
    assert.deepEqual(errors, []);

    // A page without its own set keeps the five general starters.
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "hidden" });
    await page.goto(BASE + "/settings", { waitUntil: "domcontentloaded" });
    await page.locator("[data-merchant-agent-launcher]").waitFor({ timeout: 30000 });
    await page.locator("[data-merchant-agent-launcher]").click();
    await panel(page).waitFor();
    await page.locator("[data-merchant-agent-reset]").click();
    assert.equal(await page.locator("[data-merchant-starters]").getAttribute("data-merchant-starters"), "general");
    assert.equal(await page.locator("[data-merchant-starter]").count(), 5);
    assert.equal(await page.locator("[data-merchant-starter]").first().textContent(), "Snapshot doanh thu");
    assert.ok((await page.locator("[data-merchant-starters]").textContent()).includes("Gợi ý nhanh"));
    await page.screenshot({ path: `${EVIDENCE}/general-starters-${tag}.png` });
    record(`general starters on a page without its own set ${tag}`);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-merchant-chat.json`, JSON.stringify({ results }, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} MERCHANT CHAT QA CHECKS PASSED — evidence in ${EVIDENCE}`);
