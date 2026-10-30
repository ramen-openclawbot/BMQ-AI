// Browser QA for Đặt hàng (/dat-hang, owner 23/10/2026): supplier tabs, order lines, preview of the real
// email, send with gối đầu, sent history, catalog add/remove and the forbidden state, inside the app shell.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures; every
// RPC and function call is recorded and nothing leaves the machine. The preview email is built by the real
// shared builder. This proves the page renders, sizes and calls the right RPCs; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_supplier_order_page.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-supplier-order-qa";
const PW = process.env.PLAYWRIGHT_CORE || `${process.env.HOME}/.openclaw/lib/node_modules/openclaw/node_modules/playwright-core`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5263);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
import { buildSupplierOrderEmailLines } from "/supabase/functions/_shared/supplier-order-email.ts";
import { computeOrderAmounts } from "/src/lib/supplier-order.ts";
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaCalls = window.__qaCalls || [];
const PT = "bc39ded3-755c-4b31-9e4c-d7729e009608";
const TV = "9546bd80-18d7-4ec7-b0e5-de50798ea718";
const MG = "5a1e0000-0000-4000-8000-000000000001";
const MT = "5a1e0000-0000-4000-8000-0000000000b1";
const delivery = { address: "24 Đường số 36, P. Tân Quy, Q7, TP.HCM", contact_name: "Huỳnh Kim Ngân", contact_phone: "0926 504 623", note: "" };
const prices = () => JSON.parse(localStorage.getItem("qa-prices") || "{}");
const line = (id, name, wording, onHand, daily, proposal, price, open, vat = 8, list = null) => {
  const set = prices()[id];
  const listPrice = set ? (set.price > 0 ? set.price : null) : list;
  const gross = set ? set.gross : list !== null;
  return {
  list_price: listPrice === null ? null : String(listPrice), list_price_includes_vat: listPrice !== null && gross,
  list_price_source: listPrice === null ? null : set ? "Sửa trong trang Đặt hàng" : "Phiếu xuất kho Phúc Thịnh ĐH19993 ngày 22/10/2026",
  history_price: String(price),
  unit_price_gross: listPrice !== null && gross ? String(listPrice) : String(Math.round(price * (1 + vat / 100) * 100) / 100),
  catalog_id: "c-" + id, item: { id, name, code: "NVL-" + id.slice(0, 3), unit: "g" }, product_name: wording, po_unit: "kg",
  po_unit_factor: "1000", pack_size_po: "25", vat_rate: String(vat),
  stock: { on_hand: String(onHand), daily_usage: String(daily), days_left: daily > 0 ? String(Math.round(onHand / daily * 10) / 10) : null, reorder_date: "2026-11-02", last_count_date: "2026-10-16" },
  proposal_qty: String(proposal), unit_price: String(listPrice !== null ? (gross ? Math.round(listPrice / (1 + vat / 100) * 100) / 100 : listPrice) : price), open_order: open || null,
  };
};
const removed = () => JSON.parse(localStorage.getItem("qa-removed") || "[]");
const added = () => JSON.parse(localStorage.getItem("qa-added") || "[]");
function catalog(id) {
  if (id === MT) {
    // Long catalog (Bao bì Minh Tuấn): 9 items, five with a proposal; enough to need the finder.
    const names = [["Bao giấy bánh mì que", 8500, 1000, 8000], ["Bao tấm", 0, 0, 0], ["Bao giấy Ông Bầu", 300, 100, 2000], ["Tăm VJ", 90, 30, 500], ["Bánh mì lớn", 40, 10, 0], ["Túi bánh mì", 700, 200, 3000], ["Hộp kraft vuông", 120, 20, 0], ["Băng keo vàng", 55, 5, 0], ["Màng bọc thực phẩm", 12, 4, 20]];
    const items = names.map(([name, onHand, daily, proposal], index) => ({ ...line("5a1e0000-0000-4000-8000-0000000001" + String(index).padStart(2, "0"), name, name, onHand, daily, proposal, index === 1 ? 0 : 167, null, 8), po_unit: "cái", po_unit_factor: "1", pack_size_po: null, location: "tan_tao", estimated: true }));
    return { supplier: { id: MT, name: "Bao bì Minh Tuấn", email: "order@minhtuan.example" }, delivery, mailbox_connected: true, blockers: [], items, prepay: null };
  }
  if (id === MG) {
    const tt = { ...line("5a1e0000-0000-4000-8000-000000000011", "Cà rốt", "Cà rốt", 1888, 727.959, 8, 35700, null, 0), location: "tan_tao", estimated: true };
    const none = { ...line("5a1e0000-0000-4000-8000-000000000012", "Giấm tinh luyện 1L", "Giấm tinh luyện 1L", 0, 0, 0, 18333, null, 0), location: "tan_tao", estimated: true };
    none.stock = { ...none.stock, on_hand: null, days_left: null };
    const decal = { ...line("5a1e0000-0000-4000-8000-000000000013", "Giấy decal PVC", "Giấy decal PVC 90x60x50m", 0, 0, 0, 150000, null, 0), location: "q7", estimated: false };
    decal.stock = { ...decal.stock, last_count_date: null, days_left: null };
    Object.assign(tt, { learned_supplier_mismatch: true, learned_supplier: { id: "5a1e0000-0000-4000-8000-0000000000c1", name: "Cholimex" } });
    const outlier = { ...line("5a1e0000-0000-4000-8000-000000000014", "Tương ớt gói 10g", "T. Ốt gói 10g", 0, 0, 0, 432000, null, 0), location: "q7", estimated: false, price_outlier: true, reference_price: { supplier_id: "5a1e0000-0000-4000-8000-0000000000c2", supplier_name: "Cholimex", unit_price: 500 } };
    const email = localStorage.getItem("qa-mega-email");
    return { supplier: { id: MG, name: "Mega Market", email }, delivery, mailbox_connected: true, blockers: email ? [] : ["no_supplier_email"], items: [tt, none, decal, outlier], prepay: null };
  }
  if (id === PT) {
    const items = [
      line("1039f461-8f9f-45a1-b05c-b96cb736812e", "Bột mì 999 Cam", "Bột mì 999 Cam (25kg)", 303751.946, 13561.438, 0, 19300, null, 8, 20840),
      line("64952d75-2351-43f8-886f-de5282c96ed2", "Bột mì 888 Cam", "Bột mì 888 Cam (25kg)", 232339.76, 18581.266, 0, 18900, null, 8, 20440),
      line("6ba549f7-d3b6-4971-a742-2fb4091800bb", "Sữa Bột Béo New Zealand", "Sữa Bột Béo New Zealand (25kg)", -5712.81, 1303.958, 25, 140740, null, 8, 152000),
      ...(added().includes("c78c5281-0000-4000-8000-000000000001") ? [line("c78c5281-0000-4000-8000-000000000001", "Men khô Meizan nhãn vàng", "Men Khô Meizan - Nhãn Vàng (0.5*10kg/Thùng)", 4200, 350, 0, 92592)] : []),
    ].filter((it) => !removed().includes(it.item.id));
    return { supplier: { id: PT, name: "Phúc Thịnh", email: "botmiphucthinh@gmail.com" }, delivery, mailbox_connected: true, blockers: [], items, prepay: null };
  }
  return {
    supplier: { id: TV, name: "TV Food", email: "hongtinh2603@gmail.com" }, delivery, mailbox_connected: true,
    blockers: cfg().blocked ? ["mailbox_not_connected"] : [],
    items: [line("3c16ed3f-54c7-427f-a316-5aa4fcadda5a", "Bơ Peerless Úc 25kg", "BƠ PEERLESS", 105812.654, 8870.791, 0, 90000,
      { po_number: "PO-000862", quantity: "75", unit: "kg", sent_at: "2026-10-23T05:09:25Z" }, 0)],
    prepay: { id: "pr-1", request_number: "PR-D6E88DCB", created_at: "2026-06-17T03:53:09Z", total_amount: "9000000", remaining: "9000000", po_number: "PO-000582", recent_submission: null, official_invoice: { invoice_number: "00003476", invoice_series: "1C26TTV", invoice_date: "2026-10-20" } },
  };
}
function history(id) {
  const mine = JSON.parse(localStorage.getItem("qa-orders") || "[]").filter((row) => row.supplier_id === id);
  if (id === TV) mine.push({ id: "h-tv", request_id: "r-tv", po_number: "PO-000862", total: "6750000", status: "sent", sent_at: "2026-10-23T05:09:25Z", to_email: "order@bmq.vn", created_at: "2026-10-23T05:09:22Z",
    lines: [{ position: 1, item_id: "3c16ed3f-54c7-427f-a316-5aa4fcadda5a", product_name: "BƠ PEERLESS", quantity: 75, unit: "kg", unit_price: 90000, line_total: 6750000 }],
    uploads: [{ file_name: "phieu-giao-hang-TV-Food.jpg", mime_type: "image/jpeg", size_bytes: 120000, created_at: "2026-10-23T08:00:00Z", storage_path: "h-tv/a.jpg" }], prepay: null,
    po_status: "sent", receipt: { id: "gr-1", receipt_number: "GRN-000607", status: "confirmed", finalized_at: null },
    payment: { request_number: "PR-7399CE38", status: "pending", payment_status: "unpaid", total_amount: "6750000" } });
  return { items: mine };
}
function settle(st) {
  window.__qaCalls.push(st.table + ":" + JSON.stringify(st.args));
  if (cfg().data === "forbidden" && st.table.startsWith("rpc:supplier_order_")) return { data: null, error: { message: "insufficient_privilege", code: "42501" } };
  if (st.table === "rpc:supplier_order_suppliers") return { data: [
    ...(cfg().long ? [{ id: MT, name: "Bao bì Minh Tuấn", email: "order@minhtuan.example", has_email: true, item_count: 9, active_item_count: 9, need_order_count: 3, low_stock_count: 0, out_of_stock_count: 0, locations: ["tan_tao"], urgency_rank: 0, last_order: null, unpaid_count: 0 }] : []),
    { id: TV, name: "TV Food", email: "hongtinh2603@gmail.com", has_email: true, item_count: 1, active_item_count: 1, need_order_count: 0, low_stock_count: 0, out_of_stock_count: 0, locations: ["q7"], urgency_rank: 4, last_order: { po_number: "PO-000862", sent_at: "2026-10-23T05:09:25Z" }, unpaid_count: 2 },
    { id: PT, name: "Phúc Thịnh", email: "botmiphucthinh@gmail.com", has_email: true, item_count: catalog(PT).items.length, active_item_count: catalog(PT).items.length, need_order_count: 1, low_stock_count: 1, out_of_stock_count: 1, locations: ["q7", "tan_tao"], urgency_rank: 1, last_order: null, unpaid_count: 0 },
    { id: MG, name: "Mega Market", email: localStorage.getItem("qa-mega-email"), has_email: Boolean(localStorage.getItem("qa-mega-email")), item_count: 2, active_item_count: 2, need_order_count: 1, low_stock_count: 1, out_of_stock_count: 0, locations: ["tan_tao"], urgency_rank: 2, last_order: null, unpaid_count: 0 },
  ], error: null };
  if (st.table === "rpc:supplier_order_set_supplier_email") {
    localStorage.setItem("qa-mega-email", st.args.p_email.trim().toLowerCase());
    return { data: { id: st.args.p_supplier_id, email: st.args.p_email }, error: null };
  }
  if (st.table === "rpc:supplier_order_catalog") return { data: catalog(st.args.p_supplier_id), error: null };
  if (st.table === "rpc:supplier_order_catalog_candidates") return { data: added().length ? [] : [
    { item_id: "c78c5281-0000-4000-8000-000000000001", name: "Men khô Meizan nhãn vàng", unit: "g", latest_product_name: "Men Khô Meizan - Nhãn Vàng (0.5*10kg/Thùng)", last_order_date: "2026-09-17", line_count: 11 },
  ], error: null };
  if (st.table === "rpc:supplier_order_catalog_set") {
    const a = st.args;
    if (a.p_active && a.p_list_price !== null && a.p_list_price !== undefined) {
      localStorage.setItem("qa-prices", JSON.stringify({ ...prices(), [a.p_item_id]: { price: Number(a.p_list_price), gross: a.p_list_price_includes_vat === true } }));
    } else if (a.p_active) localStorage.setItem("qa-added", JSON.stringify([...added(), a.p_item_id]));
    else localStorage.setItem("qa-removed", JSON.stringify([...removed(), a.p_item_id]));
    return { data: { supplier_id: a.p_supplier_id, kitchen_inventory_item_id: a.p_item_id, active: a.p_active }, error: null };
  }
  if (st.table === "app_settings") return { data: [
    { key: "order_email_tan_tao_delivery_address", value: "14/1/15 Bia Truyền Thống, P. Tân Tạo, Q. Bình Tân, TP.HCM" },
    { key: "order_email_tan_tao_contact_name", value: "Võ Thị Tú Trinh" },
    { key: "order_email_tan_tao_contact_phone", value: "0908 113 576" },
  ], error: null };
  if (st.table === "payment_requests") return { data: null, error: null, count: 3 };
  if (st.table === "suppliers") return { data: [
    { id: PT, name: "Phúc Thịnh", category: "Bột mì", description: null, phone: "0909 111 222", email: "botmiphucthinh@gmail.com", contact_name: localStorage.getItem("qa-pt-contact"), bank_account_name: null, default_payment_method: "bank_transfer", contract_url: null, payment_terms_days: 7, created_at: "2026-01-01T00:00:00Z" },
    { id: MG, name: "Mega Market", category: null, description: null, phone: null, email: null, contact_name: null, bank_account_name: null, default_payment_method: "bank_transfer", contract_url: null, payment_terms_days: null, created_at: "2026-02-01T00:00:00Z" },
    { id: TV, name: "TV Food", category: "Bơ sữa", description: null, phone: "028 3333 4444", email: "hongtinh2603@gmail.com", contact_name: "Chị Tình", bank_account_name: null, default_payment_method: "bank_transfer", contract_url: null, payment_terms_days: 15, created_at: "2026-03-01T00:00:00Z" },
    { id: "00000000-0000-4000-8000-0000000000aa", name: "Đại Phát (cũ)", category: null, description: null, phone: null, email: "dai@example.test", contact_name: null, bank_account_name: null, default_payment_method: "cash", contract_url: null, payment_terms_days: null, created_at: "2025-01-01T00:00:00Z" },
  ], error: null };
  if (st.table === "rpc:supplier_profile_overview") return { data: [
    { id: MG, name: "Mega Market", email: null, phone: null, contact_name: null, default_receiving_location: null, order_item_count: 11, last_purchase_at: "2026-10-27", active_60d: true, unpaid_count: 0, unpaid_amount: 0, missing: ["email", "phone", "contact_name", "receiving_location"] },
    { id: PT, name: "Phúc Thịnh", email: "botmiphucthinh@gmail.com", phone: "0909 111 222", contact_name: localStorage.getItem("qa-pt-contact"), default_receiving_location: "q7", order_item_count: 5, last_purchase_at: "2026-10-22", active_60d: true, unpaid_count: 1, unpaid_amount: "4842000", missing: localStorage.getItem("qa-pt-contact") ? [] : ["contact_name"] },
    { id: TV, name: "TV Food", email: "hongtinh2603@gmail.com", phone: "028 3333 4444", contact_name: "Chị Tình", default_receiving_location: "tan_tao", order_item_count: 2, last_purchase_at: "2026-10-23", active_60d: true, unpaid_count: 2, unpaid_amount: "6750000", missing: [] },
    { id: "00000000-0000-4000-8000-0000000000aa", name: "Đại Phát (cũ)", email: "dai@example.test", phone: null, contact_name: null, default_receiving_location: null, order_item_count: 0, last_purchase_at: "2025-06-01", active_60d: false, unpaid_count: 0, unpaid_amount: 0, missing: ["phone", "contact_name", "receiving_location"] },
  ], error: null };
  if (st.table === "rpc:supplier_order_history_by_supplier") return { data: history(st.args.p_supplier_id), error: null };
  if (/^rpc:/.test(st.table)) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args: args || {} };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve().then(() => settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...callArgs) => {
        // suppliers.update({...}) is the profile save; keep the payload for QA asserts.
        if (table === "suppliers" && prop === "update") {
          st.table = "update:suppliers";
          st.args = callArgs[0] || {};
          if (st.args.contact_name) localStorage.setItem("qa-pt-contact", st.args.contact_name);
        }
        return proxy;
      };
    },
  });
  return proxy;
}
function priced(body) {
  const items = catalog(body.supplier_id).items;
  const picked = body.lines.map((l) => items.find((row) => row.item.id === l.item_id));
  const a = computeOrderAmounts(body.lines.map((l, i) => ({ quantity: l.quantity, unitPrice: Number(picked[i].history_price), vatRate: Number(picked[i].vat_rate),
    listPrice: picked[i].list_price === null ? null : Number(picked[i].list_price), listPriceIncludesVat: picked[i].list_price_includes_vat })));
  const lines = a.lines.map((x, i) => ({ position: i + 1, item_id: body.lines[i].item_id, product_name: picked[i].product_name, quantity: x.quantity, unit: "kg",
    unit_price: x.unitPrice, line_total: x.lineTotal, vat_rate: x.vatRate, vat_amount: x.vatAmount, gross_amount: x.grossAmount }));
  return { lines, subtotal: a.subtotal, vat: a.vatAmount, total: a.total };
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn) => builder("rpc:" + fn) }),
  functions: { invoke: async (name, options) => {
    window.__qaCalls.push("invoke:" + name + ":" + JSON.stringify(options?.body ?? {}));
    const b = options?.body ?? {};
    if (name !== "supplier-order-send" || !Array.isArray(b.lines)) return { data: null, error: { message: "QA fixture: functions disabled" } };
    const c = catalog(b.supplier_id);
    const { lines, subtotal, vat, total } = priced(b);
    if (b.mode === "preview") {
      const mail = buildSupplierOrderEmailLines({ poNumber: "", supplierName: c.supplier.name, lines: lines.map((l) => ({ productName: l.product_name, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, lineTotal: l.line_total, vatRate: l.vat_rate })),
        subtotal, vatAmount: vat, total, deliveryAddress: delivery.address, contactName: delivery.contact_name, contactPhone: delivery.contact_phone, note: b.note || "", requestedDate: "2026-10-23", uploadUrl: "", subjectName: c.supplier.name });
      return { data: { subject: mail.subject, html: mail.html, text: mail.text, to_email: c.supplier.email, lines, subtotal, vat_amount: vat, total, prepay: c.prepay, prepay_reason: c.prepay ? null : "none" }, error: null };
    }
    if (cfg().sendFails) return { data: { code: "email_failed" }, error: null };
    const po = "PO-0009" + String(10 + JSON.parse(localStorage.getItem("qa-orders") || "[]").length);
    const row = { supplier_id: b.supplier_id, id: "o-" + po, request_id: b.request_id, po_number: po, total, status: "sent", sent_at: new Date().toISOString(), to_email: c.supplier.email, created_at: new Date().toISOString(), lines, uploads: [],
      prepay: b.prepay && c.prepay ? { status: "created", request_number: c.prepay.request_number, submission_number: "TC-261023-05" } : null };
    localStorage.setItem("qa-orders", JSON.stringify([...JSON.parse(localStorage.getItem("qa-orders") || "[]"), row]));
    return { data: { status: "sent", po_number: po, to_email: c.supplier.email, sent_at: row.sent_at, prepay: b.prepay ? (c.prepay ? row.prepay : { status: "skipped_none", request_number: null, submission_number: null }) : null }, error: null };
  } },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: "data:text/plain,qa" }, error: null }), list: async () => ({ data: [], error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  channel: () => channel,
  removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const value = {
  user, session: { access_token: "qa", user }, profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: ["owner"], authzLoaded: true, authzError: false,
  isOwner: true, canAccessModule: () => true, canEditModule: () => true,
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-supplier-order-fixtures",
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

process.env.VITE_SUPABASE_URL ||= "https://qa-supabase.invalid";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= "qa-anon";
const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-supplier-order-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const pass = (name) => { results.push(name); console.log("PASS", name); };

async function open(cfg, route, viewport, ready = "[data-bmq-supplier-orders]") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => { if (!sessionStorage.getItem("qa-init")) { localStorage.clear(); sessionStorage.setItem("qa-init", "1"); } localStorage.setItem("qa-shell", JSON.stringify(value)); }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll(".d3-so *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).position === "fixed") continue;
      if (el.closest(".d3-kho-tabs, .d3-so-filters")) continue; // horizontal scrollers
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(`${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    return { doc: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
  });
  assert.ok(o.doc <= 0 && o.bad.length === 0, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function shot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${EVIDENCE}/${file}`, fullPage: true });
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u;
const PT = "bc39ded3-755c-4b31-9e4c-d7729e009608";
const TV = "9546bd80-18d7-4ec7-b0e5-de50798ea718";
const MG = "5a1e0000-0000-4000-8000-000000000001";
const MT = "5a1e0000-0000-4000-8000-0000000000b1";
const I999 = "1039f461-8f9f-45a1-b05c-b96cb736812e";
const IMILK = "6ba549f7-d3b6-4971-a742-2fb4091800bb";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];

try {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    // Mega Market sells Tân Tạo and Q7 items: the delivery line follows the chosen items.
    const { context, page, errors } = await open({}, `/dat-hang?ncc=${MG}`, vp);
    await page.waitForSelector("[data-bmq-so-lines] li");
    const TT = "5a1e0000-0000-4000-8000-000000000011";
    const DECAL = "5a1e0000-0000-4000-8000-000000000013";
    for (const id of ["5a1e0000-0000-4000-8000-000000000011", "5a1e0000-0000-4000-8000-000000000012", DECAL, "5a1e0000-0000-4000-8000-000000000014"]) {
      const box = page.locator(`[data-bmq-so-qty='${id}']`);
      if (await box.count()) await box.fill("");
    }
    await page.locator(`[data-bmq-so-qty='${TT}']`).fill("10");
    await page.waitForFunction(() => document.querySelector("[data-bmq-so-delivery]")?.textContent?.includes("Tú Trinh"));
    let texts = await page.locator("[data-bmq-so-delivery]").allInnerTexts();
    assert.equal(texts.length, 1, "Tân Tạo only: one row");
    assert.ok(texts[0].startsWith("14/1/15 Bia Truyền Thống") && texts[0].includes("Võ Thị Tú Trinh 0908 113 576"), `Tân Tạo address ${texts[0]}`);
    await page.locator(`[data-bmq-so-qty='${DECAL}']`).fill("2");
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-so-delivery]").length === 2);
    texts = await page.locator("[data-bmq-so-delivery]").allInnerTexts();
    assert.ok(texts[0].startsWith("Kho Q7 (1 món): 24 Đường số 36") && texts[1].startsWith("Kho Tân Tạo (1 món): 14/1/15"), `two rows ${JSON.stringify(texts)}`);
    assert.equal(await page.locator("[data-bmq-so-ship-target='auto']").getAttribute("aria-checked"), "true", "mixed lines: split by warehouse");
    // Explicit Kho Q7: one address for every line.
    await page.locator("[data-bmq-so-ship-target='q7']").click();
    texts = await page.locator("[data-bmq-so-delivery]").allInnerTexts();
    assert.ok(texts.length === 1 && texts[0].startsWith("24 Đường số 36"), `Q7 chosen ${JSON.stringify(texts)}`);
    // Another address: Lập phiếu waits for an address, a recipient and a phone.
    await page.locator("[data-bmq-so-ship-target='custom']").click();
    await page.locator("[data-bmq-so-ship-address]").fill("45 Nguyễn Huệ, Quận 1");
    assert.ok(await page.locator("[data-bmq-so-make]").isDisabled(), "custom without recipient: disabled");
    await page.locator("[data-bmq-so-ship-name]").fill("Chị Lan");
    await page.locator("[data-bmq-so-ship-phone]").fill("0987 654 321");
    await noSpill(page, "delivery two warehouses", vp);
    await shot(page, `delivery-two-warehouses-${vp.width}.png`);
    await page.locator("[data-bmq-so-email-input]").fill("order@mega.vn");
    await page.locator("[data-bmq-so-email-save]").click();
    await page.waitForSelector("[data-bmq-so-email-form]", { state: "detached" });
    await page.locator("[data-bmq-so-make]").click();
    await page.waitForSelector("[data-bmq-so-preview]");
    const shipCall = (await calls(page)).filter((c) => c.startsWith("invoke:supplier-order-send:")).pop();
    assert.ok(shipCall.includes('"delivery":{"target":"custom","address":"45 Nguyễn Huệ, Quận 1","contact_name":"Chị Lan","contact_phone":"0987 654 321"}'), `custom delivery body ${shipCall}`);
    assert.match(await page.locator("[data-bmq-so-preview-ship]").innerText(), /45 Nguyễn Huệ, Quận 1 · Chị Lan 0987 654 321/);
    assert.deepEqual(errors, []);
    await context.close();
    pass(`Giao tới theo kho (Tân Tạo / hai kho) @${vp.width}`);
  }
  for (const vp of VIEWPORTS) {
    const { context, page, errors } = await open({}, `/dat-hang?ncc=${PT}`, vp);
    // Main menu: Đặt hàng is its own zone and is the active one.
    if (vp.width >= 1024) {
      const tab = page.locator(".d3-tabs a.d3-tab", { hasText: "Đặt hàng" });
      assert.equal(await tab.count(), 1, "Đặt hàng tab in the main menu");
      assert.equal(await tab.getAttribute("aria-current"), "page", "Đặt hàng tab active");
    }
    assert.equal((await page.locator(".d3-screen h1, [data-bmq-supplier-orders] h1").first().innerText()).trim(), "Đặt hàng");
    await page.waitForSelector("[data-bmq-so-lines] li");
    {
      // Delivery follows the chosen items' warehouse, like the order email.
      await page.waitForFunction(() => [...document.querySelectorAll("[data-bmq-so-delivery]")].some((p) => p.innerText.includes("Tân Tạo") || p.innerText.includes("Q7")));
      const texts = await page.locator("[data-bmq-so-delivery]").allInnerTexts();
      console.log("delivery rows @" + vp.width, JSON.stringify(texts));
      assert.ok(/^Giao tới/.test(await page.locator("[data-bmq-so-ship]").innerText()) && texts.every((t) => t.trim().length > 10), "delivery text");
      if (texts.length > 1) {
        assert.ok(texts.some((t) => t.startsWith("Kho Q7") && t.includes("Huỳnh Kim Ngân")), "Q7 row");
        assert.ok(texts.some((t) => t.startsWith("Kho Tân Tạo") && t.includes("Võ Thị Tú Trinh")), "Tân Tạo row");
      }
      await noSpill(page, "delivery rows", vp);
    }
    if (vp.width >= 1024) {
      // Wide: the list stays next to the order, most urgent supplier first.
      const rows = await page.locator("[data-bmq-so-supplier]").allInnerTexts();
      assert.ok(rows.length === 3 && /Phúc Thịnh/.test(rows[0]) && /3 món/.test(rows[0]) && /1 đã hết/.test(rows[0]) && /Mega Market/.test(rows[1]) && /chưa có email/.test(rows[1]) && /TV Food/.test(rows[2]), `supplier list ${rows}`);
      assert.equal(await page.locator(`[data-bmq-so-supplier='${PT}']`).getAttribute("aria-current"), "true");
    } else {
      // Phone: a picked supplier has its own screen with a way back to the list.
      assert.ok(!(await page.locator("[data-bmq-so-suppliers]").isVisible()), "list hidden while an order is open");
      assert.ok(await page.locator("[data-bmq-so-back-list]").isVisible(), "back to list visible");
    }
    const card = await page.locator("[data-bmq-so-card]").innerText();
    for (const text of ["botmiphucthinh@gmail.com", "Bột mì 999 Cam (25kg)", "20.840 đ/kg gồm VAT", "20.440 đ/kg gồm VAT", "152.000 đ/kg gồm VAT", "giá chưa VAT 8%", "· hết", "Huỳnh Kim Ngân", "không có phiếu chi nào đang chờ trả"]) {
      assert.ok(card.includes(text), `Phúc Thịnh card shows "${text}" @${vp.width}: ${card}`);
    }
    assert.ok(!EMOJI.test(card), "no emoji");
    // Proposal seeds Sữa bột 25 kg; the others start empty.
    assert.equal(await page.locator(`[data-bmq-so-qty='${IMILK}']`).inputValue(), "25");
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "");
    assert.match(await page.locator("[data-bmq-so-subtotal]").innerText(), /3\.518\.519 đ/);
    assert.match(await page.locator("[data-bmq-so-vat]").innerText(), /281\.481 đ/);
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /3\.800\.000 đ/);
    assert.match(await page.locator(`[data-bmq-so-line='${IMILK}'] [data-bmq-so-line-total]`).innerText(), /3\.800\.000 đ/);
    // + adds one bag of 25 kg.
    await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-stepper button`).last().click();
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "25");
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /4\.321\.000 đ/);
    // A wrong number blocks Lập phiếu and says so on the line.
    await page.locator(`[data-bmq-so-qty='${I999}']`).fill("abc");
    assert.match(await page.locator(`[data-bmq-so-line='${I999}'] [data-bmq-so-line-total]`).innerText(), /Số chưa đúng/);
    assert.ok(await page.locator("[data-bmq-so-make]").isDisabled(), "Lập phiếu disabled on a bad number");
    await page.locator(`[data-bmq-so-qty='${I999}']`).fill("50");
    assert.match(await page.locator("[data-bmq-so-subtotal]").innerText(), /4\.483\.334 đ/);
    assert.match(await page.locator("[data-bmq-so-vat]").innerText(), /358\.666 đ/);
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /4\.842\.000 đ/);
    assert.match(await page.locator(`[data-bmq-so-line='${I999}'] [data-bmq-so-line-total]`).innerText(), /1\.042\.000 đ/);
    await page.locator("[data-bmq-so-note]").fill("Giao trước 10h");
    // Kho name shows only when it adds something to the supplier's wording.
    assert.ok(!(await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-line-main > small`).innerText()).includes("Bột mì 999 Cam\n"), "no duplicate kho name");
    assert.equal(await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-line-main > small span`).first().innerText(), "20.840 đ/kg gồm VAT");
    // The VNAgent launcher never covers Lập phiếu once the button is on screen.
    const clash = await page.evaluate(() => {
      document.querySelector("[data-bmq-so-make]")?.scrollIntoView({ block: "center" });
      const a = document.querySelector("[data-bmq-so-make]")?.getBoundingClientRect();
      const l = document.querySelector(".d3-agent-launcher")?.getBoundingClientRect();
      if (!a || !l || !l.width) return false;
      return !(a.right <= l.left || a.left >= l.right || a.bottom <= l.top || a.top >= l.bottom);
    });
    assert.equal(clash, false, `launcher covers Lập phiếu @${vp.width}`);
    await noSpill(page, "form", vp);
    // A line total never sits on top of its stepper (320px puts it on its own row).
    const overlaps = await page.evaluate(() => [...document.querySelectorAll("[data-bmq-so-line]")].filter((li) => {
      const s = li.querySelector(".d3-so-stepper")?.getBoundingClientRect();
      const t = li.querySelector("[data-bmq-so-line-total]")?.getBoundingClientRect();
      if (!s || !t || !t.width) return false;
      return !(t.right <= s.left || t.left >= s.right || t.bottom <= s.top || t.top >= s.bottom);
    }).map((li) => li.getAttribute("data-bmq-so-line")));
    assert.deepEqual(overlaps, [], `line total overlaps its stepper @${vp.width}`);
    await shot(page, `form-pt-${vp.width}.png`);

    // Preview shows the real email; nothing is created yet.
    await page.locator("[data-bmq-so-make]").click();
    await page.waitForSelector("[data-bmq-so-preview]");
    const prev = (await calls(page)).filter((c) => c.startsWith("invoke:supplier-order-send:"));
    assert.equal(prev.length, 1);
    assert.ok(prev[0].includes('"mode":"preview"') && prev[0].includes('"quantity":50') && prev[0].includes('"quantity":25') && prev[0].includes("Giao trước 10h") && prev[0].includes('"prepay":false'), `preview body ${prev[0]}`);
    const frame = page.frameLocator("[data-bmq-so-mail]");
    const mailText = await frame.locator("body").innerText();
    for (const text of ["Kính gửi Phúc Thịnh", "Bột mì 999 Cam (25kg)", "Sữa Bột Béo New Zealand (25kg)", "Cộng tiền hàng", "4.483.334 đ", "Thuế GTGT", "358.666 đ", "4.842.000 đ", "19.296,30 đ", "140.740,74 đ", "8%", "Huỳnh Kim Ngân", "PO mới (số cấp khi gửi)", "Giao trước 10h"]) {
      assert.ok(mailText.includes(text), `email preview shows "${text}"`);
    }
    // The whole email fits the frame at every width (it scales down on phones), so no column is cut off.
    const fitFacts = await page.evaluate(() => {
      const f = document.querySelector("[data-bmq-so-mail]");
      const d = f?.contentDocument;
      return d ? { wide: d.documentElement.scrollWidth, room: f.clientWidth, cell: [...d.querySelectorAll("td")].some((td) => /Tổng cộng/.test(td.textContent || "")) } : null;
    });
    assert.ok(fitFacts && fitFacts.wide <= fitFacts.room + 1 && fitFacts.cell, `email fits its frame @${vp.width}: ${JSON.stringify(fitFacts)}`);
    const frameBox = await page.locator("[data-bmq-so-mail]").boundingBox();
    assert.ok(frameBox && frameBox.height > 400, `email frame grows to its content: ${JSON.stringify(frameBox)}`);
    const facts = await page.locator(".d3-so-facts").innerText();
    assert.ok(/botmiphucthinh@gmail\.com/.test(facts) && /Không trình chi/.test(facts) && /4\.842\.000 đ · gồm VAT 358\.666 đ/.test(facts), `preview facts ${facts}`);
    await noSpill(page, "preview", vp);
    await shot(page, `preview-pt-${vp.width}.png`);

    // Sửa lại keeps the numbers.
    await page.locator("[data-bmq-so-back]").click();
    await page.waitForSelector("[data-bmq-so-lines]");
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "50");
    await page.locator("[data-bmq-so-make]").click();
    await page.waitForSelector("[data-bmq-so-preview]");
    await page.locator("[data-bmq-so-send]").click();
    await page.waitForSelector("[data-bmq-so-done]");
    const sent = (await calls(page)).filter((c) => c.includes('"mode":"send"'));
    assert.equal(sent.length, 1, "one send call");
    assert.ok(/"request_id":"[0-9a-f-]{36}"/.test(sent[0]), "send carries a request id");
    const done = await page.locator("[data-bmq-so-done]").innerText();
    assert.ok(/Đã gửi PO-0009/.test(done) && /botmiphucthinh@gmail\.com/.test(done), `done ${done}`);
    await page.waitForSelector("[data-bmq-so-history] li");
    const hist = await page.locator("[data-bmq-so-history]").innerText();
    assert.ok(/PO-0009/.test(hist) && /Bột mì 999 Cam \(25kg\) 50 kg/.test(hist) && /Đã gửi/.test(hist), `history ${hist}`);
    await noSpill(page, "sent", vp);
    await shot(page, `sent-pt-${vp.width}.png`);
    assert.deepEqual(errors, [], `page errors @${vp.width}`);
    await context.close();
    pass(`Phúc Thịnh: lines, stepper, bad number, preview email, send, history @${vp.width}`);

    // TV Food: gối đầu ticked by default, open PO note, uploads in history.
    const tv = await open({}, `/dat-hang?ncc=${TV}`, vp);
    await tv.page.waitForSelector("[data-bmq-so-prepay='pr']");
    assert.match(await tv.page.locator("[data-bmq-so-prepay-invoice='official']").innerText(), /Đã có hoá đơn chính thức 1C26TTV-00003476 ngày 20\/10\/2026/);
    assert.ok(await tv.page.locator("[data-bmq-so-prepay-check]").isChecked(), "gối đầu ticked");
    const tvCard = await tv.page.locator("[data-bmq-so-card]").innerText();
    assert.ok(/PR-D6E88DCB/.test(tvCard) && /9\.000\.000 đ/.test(tvCard) && /chờ PO-000862 \(75 kg\)/.test(tvCard) && /không VAT/.test(tvCard), `TV card ${tvCard}`);
    assert.ok(await tv.page.locator("[data-bmq-so-make]").isDisabled(), "nothing picked yet");
    await tv.page.locator(".d3-so-stepper button").last().click();
    await tv.page.locator("[data-bmq-so-make]").click();
    await tv.page.waitForSelector("[data-bmq-so-preview]");
    assert.match(await tv.page.locator(".d3-so-facts").innerText(), /Trình chi gấp PR-D6E88DCB/);
    await tv.page.locator("[data-bmq-so-send]").click();
    await tv.page.waitForSelector("[data-bmq-so-done-prepay]");
    assert.match(await tv.page.locator("[data-bmq-so-done-prepay]").innerText(), /đã trình chi gấp TC-261023-05 cho PR-D6E88DCB/);
    const tvSend = (await calls(tv.page)).find((c) => c.includes('"mode":"send"'));
    assert.ok(tvSend.includes('"prepay":true') && tvSend.includes(TV), `TV send ${tvSend}`);
    const tvHist = await tv.page.locator("[data-bmq-so-history]").innerText();
    assert.ok(/phieu-giao-hang-TV-Food\.jpg/.test(tvHist) && /Gối đầu: TC-261023-05/.test(tvHist), `TV history ${tvHist}`);
    assert.ok(/Nhập kho\s*GRN-000607 · chờ kho xác nhận/.test(tvHist) && /Thanh toán\s*PR-7399CE38 · chờ duyệt · chưa trả/.test(tvHist), `TV chain ${tvHist}`);
    await noSpill(tv.page, "tv", vp);
    await shot(tv.page, `sent-tv-${vp.width}.png`);
    assert.deepEqual(tv.errors, [], `TV errors @${vp.width}`);
    await tv.context.close();

    // Untick gối đầu: the send says prepay false.
    const tv2 = await open({}, `/dat-hang?ncc=${TV}`, vp);
    await tv2.page.waitForSelector("[data-bmq-so-prepay-check]");
    await tv2.page.locator("[data-bmq-so-prepay-check]").uncheck();
    await tv2.page.locator(".d3-so-stepper button").last().click();
    await tv2.page.locator("[data-bmq-so-make]").click();
    await tv2.page.waitForSelector("[data-bmq-so-preview]");
    assert.match(await tv2.page.locator(".d3-so-facts").innerText(), /Không trình chi/);
    await tv2.page.locator("[data-bmq-so-send]").click();
    await tv2.page.waitForSelector("[data-bmq-so-done]");
    assert.ok((await calls(tv2.page)).find((c) => c.includes('"mode":"send"')).includes('"prepay":false'), "unticked gối đầu sends prepay false");
    await tv2.context.close();
    pass(`TV Food: gối đầu on/off, open PO, uploads @${vp.width}`);
  }

  // Catalog: add a delivered item, remove one.
  {
    const vp = { width: 390, height: 844 };
    const { context, page, errors } = await open({}, `/dat-hang?ncc=${PT}`, vp);
    await page.waitForSelector("[data-bmq-so-lines] li");
    await page.locator("[data-bmq-so-edit]").click();
    await page.waitForSelector("[data-bmq-so-candidates]");
    await page.locator("[data-bmq-so-add]").first().click();
    await page.waitForSelector("[data-bmq-so-line='c78c5281-0000-4000-8000-000000000001']");
    // Price editor: 888 to 20.500 đ/kg gồm VAT; the label follows and the RPC keeps the row's unit and bag.
    const I888 = "64952d75-2351-43f8-886f-de5282c96ed2";
    assert.match(await page.locator(`[data-bmq-so-price-edit='${I888}']`).innerText(), /Nguồn giá: Phiếu xuất kho Phúc Thịnh ĐH19993/);
    await page.locator(`[data-bmq-so-price='${I888}']`).fill("20500");
    await page.locator(`[data-bmq-so-price-save='${I888}']`).click();
    await page.waitForFunction((id) => /20\.500 đ\/kg gồm VAT/.test(document.querySelector(`[data-bmq-so-line='${id}'] [data-bmq-so-price-label]`)?.textContent || ""), I888);
    const priceCall = (await calls(page)).find((c) => c.startsWith("rpc:supplier_order_catalog_set:") && c.includes('"p_list_price":20500'));
    assert.ok(priceCall && priceCall.includes('"p_list_price_includes_vat":true') && priceCall.includes('"p_pack_size_po":25') && priceCall.includes('"p_po_unit":"kg"'), `price call ${priceCall}`);
    await page.locator(`[data-bmq-so-remove='${IMILK}']`).click();
    await page.waitForSelector(`[data-bmq-so-line='${IMILK}']`, { state: "detached" });
    const sets = (await calls(page)).filter((c) => c.startsWith("rpc:supplier_order_catalog_set:"));
    assert.ok(sets.length === 3 && sets[0].includes('"p_active":true') && sets[0].includes('"p_po_unit":"kg"') && sets[2].includes('"p_active":false') && sets[2].includes(IMILK), `catalog set calls ${sets}`);
    await noSpill(page, "catalog edit", vp);
    await shot(page, "catalog-edit-390.png");
    assert.deepEqual(errors, []);
    await context.close();
    pass("Sửa danh mục: add from history, remove");
  }

  // Many suppliers: search, filters, phone list → order → back, Tân Tạo estimate, save a missing email.
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const { context, page, errors } = await open({}, "/dat-hang", vp);
    await page.waitForSelector("[data-bmq-so-supplier]");
    const wide = vp.width >= 1024;
    assert.equal(await page.locator("[data-bmq-so-card]").isVisible(), wide, `order beside the list only when wide @${vp.width}`);
    await noSpill(page, "list", vp);
    await shot(page, `list-${vp.width}.png`);
    const counts = await page.locator("[data-bmq-so-filter]").allInnerTexts();
    assert.deepEqual(counts.map((t) => t.replace(/\s+/g, " ").trim()), ["Tất cả 3", "Cần đặt 2", "Sắp hết 2", "Chưa có email 1"], `filter counts ${counts}`);
    await page.locator("[data-bmq-so-filter='no_email']").click();
    assert.deepEqual(await page.locator("[data-bmq-so-supplier]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bmq-so-supplier"))), [MG]);
    await page.locator("[data-bmq-so-filter='all']").click();
    await page.locator("[data-bmq-so-search]").fill("phuc thinh");
    assert.deepEqual(await page.locator("[data-bmq-so-supplier]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bmq-so-supplier"))), [PT]);
    await page.locator("[data-bmq-so-search]").fill("zzz");
    await page.waitForSelector("[data-bmq-so-no-match]");
    await page.locator("[data-bmq-so-search]").fill("mega");
    await page.locator(`[data-bmq-so-supplier='${MG}']`).click();
    await page.waitForSelector("[data-bmq-so-email-form]");
    assert.equal(await page.locator("[data-bmq-so-suppliers]").isVisible(), wide, `list stays only when wide @${vp.width}`);
    const card = await page.locator("[data-bmq-so-card]").innerText();
    for (const text of ["Đơn mới cho Mega Market", "chưa có email", "tồn Tân Tạo ~", "chưa kiểm kê", "Nhà cung cấp chưa có email đặt hàng"]) {
      assert.ok(card.includes(text), `Mega card shows "${text}" @${vp.width}: ${card}`);
    }
    // Warnings sit behind a small icon; opening them shows the reason.
    for (const button of await page.locator("[data-bmq-so-warn]").all()) await button.click();
    const warned = await page.locator("[data-bmq-so-card]").innerText();
    for (const text of ["Kho thường đặt món này ở Cholimex, nên không tự đề xuất", "Giá lệch quá 3 lần so với Cholimex (500 đ/"]) {
      assert.ok(warned.includes(text), `Mega warning "${text}" @${vp.width}: ${warned}`);
    }
    assert.ok(await page.locator("[data-bmq-so-make]").isDisabled(), "no email: Lập phiếu disabled");
    assert.match(await page.locator("[data-bmq-so-line='5a1e0000-0000-4000-8000-000000000013']").innerText(), /tồn Q7 chưa kiểm kê/);
    await noSpill(page, "mega", vp);
    await shot(page, `mega-${vp.width}.png`);
    await page.locator("[data-bmq-so-email-input]").fill("Order@Mega.vn ");
    await page.locator("[data-bmq-so-email-save]").click();
    await page.waitForSelector("[data-bmq-so-email-form]", { state: "detached" });
    assert.match(await page.locator("[data-bmq-so-card]").innerText(), /order@mega\.vn/);
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:supplier_order_set_supplier_email:") && c.includes(MG)), "email RPC called");
    if (!wide) {
      await page.locator("[data-bmq-so-back-list]").click();
      await page.waitForSelector("[data-bmq-so-suppliers]", { state: "visible" });
      assert.ok(!(await page.locator("[data-bmq-so-card]").isVisible()), "back shows the list");
    }
    assert.deepEqual(errors, []);
    await context.close();
    pass(`many suppliers: search, filters, open, email @${vp.width}`);
  }

  // Nhà cung cấp: profile facts, filters, contact person, links both ways with Đặt hàng.
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const { context, page, errors } = await open({}, "/suppliers", vp, "[data-bmq-supplier-filters]");
    const order = await page.locator("[data-bmq-supplier-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bmq-supplier-row")));
    assert.deepEqual(order, [MG, PT, TV, "00000000-0000-4000-8000-0000000000aa"], `profile order ${order}`);
    const counts = await page.locator("[data-bmq-supplier-filter]").allInnerTexts();
    assert.deepEqual(counts.map((t) => t.replace(/\s+/g, " ").trim()), ["Tất cả 4", "Mua 60 ngày 3", "Thiếu email 1", "Thiếu thông tin 3", "Còn nợ 2"], `profile counts ${counts}`);
    const mega = await page.locator(`[data-bmq-supplier-row='${MG}']`).innerText();
    for (const text of ["Thiếu email", "Thiếu SĐT", "Thiếu người liên hệ", "Chưa chọn kho nhận", "11 món đặt được", "mua gần nhất 27/10/2026"]) assert.ok(mega.includes(text), `Mega row "${text}": ${mega}`);
    const tv = await page.locator(`[data-bmq-supplier-row='${TV}']`).innerText();
    for (const text of ["Chị Tình", "Còn nợ 6.750.000 đ · 2 phiếu", "Kho Tân Tạo"]) assert.ok(tv.includes(text), `TV row "${text}": ${tv}`);
    await page.locator("[data-bmq-supplier-filter='missing_email']").click();
    assert.deepEqual(await page.locator("[data-bmq-supplier-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bmq-supplier-row"))), [MG]);
    await page.locator("[data-bmq-supplier-filter='all']").click();
    await page.locator("[data-bmq-supplier-search]").fill("dai phat");
    assert.equal(await page.locator("[data-bmq-supplier-row]").count(), 1, "search without diacritics finds Đại Phát");
    await page.locator("[data-bmq-supplier-search]").fill("chi tinh");
    assert.deepEqual(await page.locator("[data-bmq-supplier-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-bmq-supplier-row"))), [TV], "search by contact person");
    await page.locator("[data-bmq-supplier-search]").fill("");
    const spill = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(spill <= 0, `suppliers page overflow ${spill} @${vp.width}`);
    await shot(page, `suppliers-${vp.width}.png`);
    // Open Phúc Thịnh, add the contact person, save; the dialog links to Đặt hàng.
    await page.locator(`[data-bmq-supplier-row='${PT}']`).click();
    await page.getByRole("button", { name: "Sửa NCC" }).click();
    await page.locator("[data-bmq-supplier-contact-input]").fill("Anh Phúc ");
    await page.getByRole("button", { name: "Lưu" }).click();
    await page.waitForSelector("[data-bmq-supplier-contact]");
    assert.match(await page.locator("[data-bmq-supplier-contact]").innerText(), /Anh Phúc/);
    await page.waitForFunction(() => /3 đề nghị/.test(document.querySelector("[data-bmq-supplier-requests]")?.textContent || ""));
    assert.match(await page.locator("[data-bmq-supplier-requests]").innerText(), /1 phiếu chưa trả · còn 4\.842\.000 đ/);
    const saved = (await calls(page)).find((c) => c.startsWith("update:suppliers:"));
    assert.ok(saved && saved.includes('"contact_name":"Anh Phúc"'), `profile save ${saved}`);
    await shot(page, `supplier-dialog-${vp.width}.png`);
    assert.equal(await page.locator("[data-bmq-supplier-order-link]").getAttribute("href"), `/dat-hang?ncc=${PT}`);
    assert.deepEqual(errors, []);
    await context.close();
    // Đặt hàng → Hồ sơ NCC opens that supplier's profile.
    const so = await open({}, `/dat-hang?ncc=${PT}`, vp);
    await so.page.waitForSelector("[data-bmq-so-profile-link]");
    await so.page.locator("[data-bmq-so-profile-link]").click();
    await so.page.waitForSelector("[data-bmq-supplier-order-link]");
    assert.match(await so.page.getByRole("dialog").innerText(), /Phúc Thịnh/);
    await so.context.close();
    pass(`Nhà cung cấp: profile facts, filters, contact, links @${vp.width}`);
  }

  // Long catalog: finder, filters, quick fill, Enter to the next box, sticky total bar.
  for (const vp of VIEWPORTS) {
    const { context, page, errors } = await open({ long: true }, `/dat-hang?ncc=${MT}`, vp);
    await page.waitForSelector("[data-bmq-so-lines] li");
    assert.equal(await page.locator("[data-bmq-so-lines] li").count(), 9, "all 9 items");
    assert.ok(await page.locator("[data-bmq-so-finder]").count() === 1, "finder shown for a long catalog");
    // Proposals seed five lines.
    assert.equal(await page.locator("[data-bmq-so-view='need'] small").innerText(), "5");
    assert.equal(await page.locator("[data-bmq-so-view='picked'] small").innerText(), "5");
    // Accent-insensitive search.
    await page.locator("[data-bmq-so-item-search]").fill("bao giay");
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-so-lines] li").length === 2);
    assert.match((await page.locator("[data-bmq-so-lines]").innerText()), /Bao giấy bánh mì que[\s\S]*Bao giấy Ông Bầu/);
    await page.locator("[data-bmq-so-item-search]").fill("zzz");
    await page.waitForSelector("[data-bmq-so-no-item-match]");
    await page.locator("[data-bmq-so-item-search]").fill("");
    // "Cần đặt" shows only lines with a proposal; "Đã nhập số" follows typed quantities.
    await page.locator("[data-bmq-so-view='need']").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-so-lines] li").length === 5);
    await page.locator("[data-bmq-so-view='all']").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-so-lines] li").length === 9);
    // Enter moves to the next quantity box, and a typed amount lands in the total.
    const first = page.locator("[data-bmq-so-qty]").first();
    await first.focus();
    await first.press("Enter");
    const focusedIndex = await page.evaluate(() => [...document.querySelectorAll("input[data-bmq-so-qty]")].indexOf(document.activeElement));
    assert.equal(focusedIndex, 1, "Enter focuses the next box");
    // Quick fill: a cleared line with a proposal offers "Đặt N".
    const bao = "5a1e0000-0000-4000-8000-000000000100";
    await page.locator(`[data-bmq-so-qty='${bao}']`).fill("");
    await page.locator(`[data-bmq-so-use='${bao}']`).click();
    assert.notEqual(await page.locator(`[data-bmq-so-qty='${bao}']`).inputValue(), "", "quick fill wrote a quantity");
    // Clear all typed numbers.
    await page.locator("[data-bmq-so-clear]").click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-so-total]")?.textContent?.trim().startsWith("0"));
    // Sticky bar: with the page scrolled to the top the bar is still inside the viewport.
    await page.evaluate(() => { const main = document.querySelector(".d3-main"); if (main) main.scrollTop = 0; window.scrollTo(0, 0); });
    const inView = await page.evaluate(() => {
      const bar = document.querySelector("[data-bmq-so-submit]");
      const r = bar.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), height: window.innerHeight, pos: getComputedStyle(bar).position };
    });
    assert.equal(inView.pos, "sticky");
    assert.ok(inView.bottom <= inView.height + 1, `sticky bar visible without scrolling ${JSON.stringify(inView)}`);
    // Measured, not eyeballed: a long quantity fits its box, the action is balanced in the bar
    // and never sits under the BMQ Agent launcher.
    const boxId = await page.locator("[data-bmq-so-qty]").first().getAttribute("data-bmq-so-qty");
    await page.locator(`[data-bmq-so-qty='${boxId}']`).fill("12500");
    await page.evaluate(() => { const main = document.querySelector(".d3-main"); if (main) main.scrollTop = 0; window.scrollTo(0, 0); });
    const fit = await page.evaluate((id) => {
      const box = document.querySelector(`[data-bmq-so-qty='${id}']`);
      const bar = document.querySelector("[data-bmq-so-submit]").getBoundingClientRect();
      const total = document.querySelector("[data-bmq-so-submit] .d3-so-total").getBoundingClientRect();
      const btn = document.querySelector("[data-bmq-so-make]").getBoundingClientRect();
      const fab = document.querySelector(".ac-launcher")?.getBoundingClientRect();
      const hit = fab && !(fab.right <= btn.left || fab.left >= btn.right || fab.bottom <= btn.top || fab.top >= btn.bottom);
      return { clip: box.scrollWidth - box.clientWidth, leftPad: Math.round(total.left - bar.left), rightPad: Math.round(bar.right - btn.right), hit: Boolean(hit), btnW: Math.round(btn.width) };
    }, boxId);
    assert.ok(fit.clip <= 0, `quantity 12500 clipped ${JSON.stringify(fit)}`);
    assert.ok(!fit.hit, `button under the launcher ${JSON.stringify(fit)}`);
    if (vp.width < 641) assert.ok(Math.abs(fit.leftPad - fit.rightPad) <= 1 && fit.btnW >= (vp.width < 360 ? 120 : 150), `bar balanced ${JSON.stringify(fit)}`);
    console.log(`bar @${vp.width}`, JSON.stringify(fit));
    // Every scroll position, not only the top: the launcher must never cover the action.
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const hitAt = await page.evaluate((f) => {
        const main = document.querySelector(".d3-main");
        const el = main && main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
        el.scrollTop = (el.scrollHeight - el.clientHeight) * f;
        const btn = document.querySelector("[data-bmq-so-make]").getBoundingClientRect();
        const fab = document.querySelector(".ac-launcher")?.getBoundingClientRect();
        return Boolean(fab && !(fab.right <= btn.left || fab.left >= btn.right || fab.bottom <= btn.top || fab.top >= btn.bottom));
      }, frac);
      assert.ok(!hitAt, `button under the launcher at scroll ${frac} @${vp.width}`);
    }
    await noSpill(page, "long catalog", vp);
    await page.screenshot({ path: `${EVIDENCE}/long-catalog-${vp.width}.png` });
    assert.deepEqual(errors, []);
    await context.close();
    pass(`Danh mục dài: tìm, lọc, dùng đề xuất, Enter, thanh tổng cố định @${vp.width}`);
  }

  // Forbidden and blocked states.
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page } = await open({ data: "forbidden" }, "/dat-hang", vp);
    await page.waitForSelector(".d3-kho-failed");
    assert.match(await page.locator(".d3-kho-failed").innerText(), /Chỉ chủ hoặc người được sửa PO mới đặt hàng được/);
    await context.close();
    const blocked = await open({ blocked: true }, `/dat-hang?ncc=${TV}`, vp);
    await blocked.page.waitForSelector("[data-bmq-so-blockers]");
    assert.match(await blocked.page.locator("[data-bmq-so-blockers]").innerText(), /Chưa kết nối hộp thư order@bmq\.vn/);
    await blocked.page.locator(".d3-so-stepper button").last().click();
    assert.ok(await blocked.page.locator("[data-bmq-so-make]").isDisabled(), "blocked: Lập phiếu disabled");
    await blocked.context.close();
    const failing = await open({ sendFails: true }, `/dat-hang?ncc=${PT}`, vp);
    await failing.page.waitForSelector("[data-bmq-so-lines] li");
    await failing.page.locator("[data-bmq-so-make]").click();
    await failing.page.waitForSelector("[data-bmq-so-preview]");
    await failing.page.locator("[data-bmq-so-send]").click();
    await failing.page.waitForSelector("[data-bmq-so-send-error]");
    assert.match(await failing.page.locator("[data-bmq-so-send-error]").innerText(), /Chưa gửi được email, đơn chưa được tạo\. Bấm gửi lại\./);
    assert.ok(await failing.page.locator("[data-bmq-so-send]").isEnabled(), "retry stays possible");
    await failing.context.close();
    pass(`forbidden, mailbox blocked, send failure @${vp.width}`);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
