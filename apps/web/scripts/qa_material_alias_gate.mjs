// Browser QA for the alias save gate: a PO / phiếu chi cannot be saved while a line is unanswered.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_demo3_shell.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-alias-gate-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5243);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (mode === "error") return { data: null, error: { message: "QA fixture: network error", code: "QA" }, count: null };
  // "partial": only the revenue ledger fails; every other source answers.
  if (mode === "partial" && st.table === "revenue_ledger_lines") return { data: null, error: { message: "QA fixture: ledger down" }, count: null };
  const filled = mode === "populated" || mode === "partial";
  if (st.head) {
    let count = 0;
    if (filled && st.table === "payment_requests" && st.filters.status === "pending") count = 3;
    if (filled && st.table === "purchase_orders" && st.filters.status === "draft") count = 2;
    if (filled && st.table === "customer_po_inbox" && st.filters.match_status === "pending_approval") count = 4;
    return { data: null, error: null, count };
  }
  if (/^rpc:(resolve_stock_alias|record_q7_stock_count|record_tan_tao_stock_count|set_goods_receipt_receiving_location|create_q7_draft_purchase_orders|upsert_q7_purchase_item_setting|update_q7_auto_purchase_settings|run_q7_auto_purchase_now|decide_stock_catalog_suggestion|revert_stock_item_merge|link_kitchen_items_to_canonical_materials|confirm_material_alias|undo_material_alias_event|set_material_alias_status)$/.test(st.table)) { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.table === "rpc:get_stock_catalog_review" && mode === "empty") return { data: { pending_suggestions: [], recent_merges: [], item_class_counts: { unclassified: 121 }, jev_usage: { usage_date: vnDay(0), calls: 0, cost: 0, call_limit: 600 } }, error: null };
  if (st.table === "rpc:get_q7_purchase_forecast" && mode === "empty") return { data: { as_of: vnDay(0), horizon_days: 14, items: [] }, error: null };
  if (st.table === "rpc:get_q7_auto_purchase_status" && mode === "empty") return { data: { settings: AP_SETTINGS(false), latest_run: null, decisions: [] }, error: null };
  if (st.table === "rpc:get_stock_ledger_overview" && mode === "empty") return { data: { location: st.args.p_location, location_name: "x", as_of: vnDay(0), cutover_date: null, items: [], pending_aliases: [] }, error: null };
  if (st.table === "rpc:reject_payment_request" && cfg().rejectError) return { data: null, error: { message: cfg().rejectError } };
  if (st.single) {
    if (filled && st.table === "payment_requests") return { data: PRS.find((pr) => pr.id === st.filters.id) || null, error: null };
    return { data: null, error: null };
  }
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const nowIso = new Date().toISOString();
const pr = (id, n, title, status, payment_status, amount, supplier) => ({
  id, request_number: n, title, description: null, supplier_id: "s-" + id, total_amount: amount, status, payment_status,
  delivery_status: "pending", payment_method: "bank_transfer", payment_type: "supplier", image_url: null, notes: null,
  created_by: "qa-user", approved_by: status === "approved" ? "qa-user" : null, approved_at: status === "approved" ? nowIso : null,
  rejection_reason: null, created_at: nowIso, updated_at: nowIso, invoice_id: null, invoice_created: false, vat_amount: 0,
  goods_receipt_id: null, purchase_order_id: null, paid_at: null,
  suppliers: { id: "s-" + id, name: supplier }, payment_request_items: [{ id: "it-" + id, product_name: "Bơ lạt Anchor 25kg", raw_product_name: null }],
  payment_allocations: [], goods_receipts: null, purchase_orders: null, invoices: null,
});
const PRS = [
  pr("11111111-1111-4111-8111-000000000001", "DC-QA-001", "Thanh toán bơ lạt tháng 10", "pending", "unpaid", 13500000, "TV Food"),
  pr("11111111-1111-4111-8111-000000000002", "DC-QA-002", "Thanh toán bột mì", "pending", "unpaid", 8200000, "Bột mì Bình Đông"),
  pr("11111111-1111-4111-8111-000000000003", "DC-QA-003", "Thanh toán bao bì", "approved", "unpaid", 4600000, "Bao bì Minh Phát"),
  pr("11111111-1111-4111-8111-000000000004", "DC-QA-004", "Thanh toán pate gan", "approved", "paid", 3100000, "Pate Hạ Long"),
];
function AP_SETTINGS(enabled) { return { id: 1, enabled, system_actor_id: enabled ? "qa-user" : null, max_po_amount: 10000000, max_daily_amount: 30000000, max_stock_count_age_days: 10, max_backtest_error: 0.25, run_hour_vn: 6, updated_by: null, updated_at: nowIso }; }
const NOFLAGS = { no_stock_count: false, stale_stock_count: false, short_history: false, no_supplier: false, no_pack_size: false, no_price: false, duplicate_material: false, high_backtest_error: false };
function apItem(id, name, unit, mode, usage, onHand, sup, pack, label, reorderBack, qty, price, flags) {
  return { item_id: id, item_code: "NVL-" + id, item_name: name, unit, mode, daily_usage: usage, avg_14d: usage, avg_28d: usage, stddev_28d: usage / 10, days_with_data: 52, weekday_factor: 1, scheduled_usage: 0, on_hand: onHand, last_count_date: onHand === null ? null : vnDay(2), open_po_qty: 0, supplier_id: sup, pack_size: pack, pack_label: label, lead_time_days: 2, safety_days: 2, order_cycle_days: 7, reorder_date: vnDay(reorderBack), suggested_qty: qty, last_unit_price: price, estimated_amount: price === null ? null : qty * price, flags: { ...NOFLAGS, ...flags } };
}
function fixtureRows(st) {
  if (st.table === "rpc:suggest_material_aliases") {
    const lines = st.args.p_lines || [];
    return lines.map((l) => {
      if (/ph\u00ed|vat/i.test(l.raw_name)) return { line_key: l.line_key, normalized_name: "phi", alias: null, needs_prompt: false, candidates: [], candidates_hash: "", jev: null, pack_guess: null, auto_non_stock: { reason: /vat/i.test(l.raw_name) ? "vat" : "fee", source: "rule" } };
      const auto = /b\u1ed9t m\u00ec|bot mi/i.test(l.raw_name);
      return auto
        ? { line_key: l.line_key, normalized_name: "bot mi", alias: { alias_id: "al-auto", status: "auto", item_id: "k2", sku_id: null, item_name: "Bột mì 888 Cam", unit: "g", conversion_factor: 25000, pack_label: "bao 25kg", confirm_count: 3, confirmers_count: 2, jev_disagreed: false }, needs_prompt: false, candidates: [], candidates_hash: "h2", jev: null, pack_guess: { pack_size: 25000, pack_label: "25kg", base_qty: 25, base_unit: "kg", multiplier: 1 } }
        : { line_key: l.line_key, normalized_name: "toi", alias: null, needs_prompt: true, candidates: [
            { id: "k1", item_id: "k1", sku_id: null, name: "Tỏi bóc vỏ", unit: "g", score: 0.9, reason: "name_contains" },
            { id: "k3", item_id: "k3", sku_id: null, name: "Tỏi phi", unit: "g", score: 0.9, reason: "name_contains" },
          ], candidates_hash: "h1", jev: null, pack_guess: null };
    });
  }
  if (st.table === "rpc:get_material_alias_review") return { days: 7, aliases: [
    { alias_id: "a1", normalized_name: "toi", supplier_id: "sup1", supplier_name: "Tỏi", location: "q7", item_id: "k1", sku_id: null, item_name: "Tỏi bóc vỏ", unit: "g", conversion_factor: 1000, pack_label: "kg", status: "learning", confirm_count: 2, confirmers_count: 1, jev_disagreed: true, last_confirmed_at: nowIso, last_event: { id: "e1", action: "correct", actor_id: "u1", created_at: nowIso }, applied_lines: 3 },
    { alias_id: "a2", normalized_name: "gan", supplier_id: "sup2", supplier_name: "Mai Hoàng Bích Hà", location: "q7", item_id: "k4", sku_id: null, item_name: "Gan heo", unit: "g", conversion_factor: 1000, pack_label: "kg", status: "auto", confirm_count: 3, confirmers_count: 1, jev_disagreed: false, last_confirmed_at: nowIso, last_event: { id: "e2", action: "auto_promoted", actor_id: null, created_at: nowIso }, applied_lines: 12 },
  ], summary: { auto_count: 9, learning_count: 4, disabled_count: 0, pending_lines: 131, jev_usage: { usage_date: vnDay(0), calls: 46, cost: 0.0011, call_limit: 600 } } };
  if (st.table === "suppliers") return [{ id: "sup1", name: "Tỏi" }, { id: "sup2", name: "Mai Hoàng Bích Hà" }];
  if (st.table === "rpc:get_stock_catalog_review") {
    const sug = (id, kind, a, au, ai, b, bu, bi, target, p, factor, fs, cls) => ({ id, kind, item_id: a[0], item_name: a[1], item_unit: au, other_item_id: b ? b[0] : null, other_item_name: b ? b[1] : null, other_item_unit: bu, proposed_target_id: target, target_name: target === a[0] ? a[1] : (b ? b[1] : null), target_unit: target === a[0] ? au : bu, probability: p, proposed_factor: factor, factor_source: fs, proposed_class: cls, prompt_version: "qa", cost: 0.0002, created_at: nowIso, item_issue_count_90d: ai, other_issue_count_90d: bi });
    return {
      pending_suggestions: [
        sug("m1", "merge", ["i1", "Bột mì 888 Cam"], "g", 60, ["i2", "Bột mì 888"], "g", 54, "i1", 0.93, 1, "unit_rule", null),
        sug("m2", "merge", ["i3", "Chà bông"], "g", 54, ["i4", "Chà bông"], "Kg", 0, "i3", 0.97, 1000, "unit_rule", null),
        sug("m3", "merge", ["i5", "Trứng gà 60gr"], "g", 60, ["i6", "Trứng gà"], "Quả", 0, "i5", 0.81, null, "none", null),
        sug("m4", "merge", ["i7", "Bột mì 888"], "Kg", 0, ["i8", "Bột mì 999"], "Kg", 0, "i7", 0.12, 1, "unit_rule", null),
        sug("c1", "classify", ["i9", "Nước lau sàn POWER100 Hương Tinh Dầu Chanh Sả 3.8L"], "Chai", 0, null, null, null, null, 0.88, null, null, "non_stock"),
        sug("c2", "classify", ["i10", "Hộp Croissant thường"], "Hộp", 12, null, null, null, null, 0.91, null, null, "packaging_supply"),
      ],
      recent_merges: [
        { merge_id: "g1", source_id: "i11", source_name: "Đường tinh luyện (Kg)", target_id: "i12", target_name: "Đường tinh luyện", factor: 1000, status: "applied", applied_at: nowIso, reverted_at: null, can_revert: true },
        { merge_id: "g2", source_id: "i13", source_name: "Muối sấy khô", target_id: "i14", target_name: "Muối sấy", factor: 1, status: "reverted", applied_at: nowIso, reverted_at: nowIso, can_revert: false },
      ],
      item_class_counts: { raw_material: 70, packaging_supply: 30, non_stock: 5, unclassified: 16 },
      jev_usage: { usage_date: vnDay(0), calls: 167, cost: 0.0334, call_limit: 600 },
    };
  }
  if (st.table === "rpc:get_q7_purchase_forecast") return { as_of: vnDay(0), horizon_days: 14, items: [
    apItem("a1", "Bột mì 888 Cam", "g", "auto_send", 13388, 40000, "sup1", 25000, "bao 25kg", 0, 375000, 16, {}),
    apItem("a2", "Bột mì 999 Cam", "g", "auto_draft", 12047, 30000, "sup1", 25000, "bao 25kg", 1, 350000, 17, { stale_stock_count: true }),
    apItem("a3", "Dầu Hướng Dương Simply 2L x 6 Chai / Thùng loại đặc biệt nhập khẩu", "g", "suggest", 2191, null, null, null, null, 0, 15337, null, { no_stock_count: true, no_supplier: true, no_pack_size: true, no_price: true, duplicate_material: true }),
    apItem("a4", "Đường", "g", "suggest", 849, 90000, "sup2", 50000, "bao 50kg", -9, 0, 20, {}),
  ] };
  if (st.table === "rpc:get_q7_auto_purchase_status") return { settings: AP_SETTINGS(true), latest_run: { id: "r1", run_date: vnDay(0), status: "done", started_at: nowIso, finished_at: nowIso, summary: {} }, decisions: [
    { id: "d1", run_id: "r1", item_id: "a1", item_name: "Bột mì 888 Cam", decision: "auto_send", reason_codes: ["auto_send"], suggested_qty: 375000, estimated_amount: 6000000, purchase_order_id: "po1", purchase_order_number: "PO-20261011-0001", created_at: nowIso },
    { id: "d2", run_id: "r1", item_id: "a2", item_name: "Bột mì 999 Cam", decision: "draft", reason_codes: ["stale_stock_count"], suggested_qty: 350000, estimated_amount: 5950000, purchase_order_id: "po2", purchase_order_number: "PO-20261011-0002", created_at: nowIso },
  ] };
  if (st.table === "suppliers") return [{ id: "sup1", name: "Phúc Thịnh" }, { id: "sup2", name: "Đường Biên Hòa" }];
  if (st.table === "rpc:get_stock_ledger_overview") {
    const q7 = st.args.p_location === "q7";
    const item = (id, code, name, unit, cur, inq, outq, cnt, diff) => ({ item_id: id, item_code: code, item_name: name, unit, current_qty: cur, in_qty_7d: inq, out_qty_7d: outq, last_count_date: cnt, last_count_difference: diff, is_low_stock: outq > 0 && cur < (outq / 7) * 3 });
    const items = q7 ? [
      item("k1", "NVL-TOI", "Tỏi bóc vỏ", "kg", 2.5, 12, 14, vnDay(3), -0.4),
      item("k2", "NVL-GAN", "Gan heo", "kg", 18, 30, 21, vnDay(3), 0),
      item("k3", "NVL-CAROT", "Cà rốt", "kg", 40, 35, 28, null, null),
      item("k4", "NVL-CHALUA", "Chả lụa lá TVP XL loại đặc biệt đóng gói hút chân không", "kg", 6.25, 10, 7, vnDay(3), 1.25),
    ] : [
      item("t1", "BMQ-001", "Bánh mì tươi", "que", 350, 2480, 2300, vnDay(1), -12),
      item("t2", "PATE-500G", "Pate 500g", "hộp", 40, 60, 70, null, null),
    ];
    const pend = (id, rn, sup, name, norm, q, back) => ({ goods_receipt_item_id: id, receipt_number: rn, supplier: sup, product_name: name, normalized_name: norm, quantity: q, receipt_date: vnDay(back) });
    const pending = q7 ? [
      pend("g1", "PN-1010-01", "Tỏi", "tỏi ngày 10", "toi", 5, 2), pend("g2", "PN-1010-04", "Tỏi", "tỏi ngày 11", "toi", 4, 1),
      pend("g3", "PN-1010-02", "Mai Hoàng Bích Hà", "gan 10", "gan", 6, 2), pend("g4", "PN-1010-03", "Đại Tân Việt", "DAIRYMONT WHITE SLICES CHEESE 1.04KG", "dairymont white slices cheese 1.04kg", 2, 1),
    ] : [];
    return { location: st.args.p_location, location_name: q7 ? "Kho NVL Q7" : "Kho Tân Tạo", as_of: vnDay(0), cutover_date: vnDay(7), items, pending_aliases: pending };
  }
  if (st.table === "rpc:get_q7_inventory_picker") return [
    { kitchen_inventory_item_id: "k1", display_label: "NVL-TOI · Tỏi bóc vỏ · kg" }, { kitchen_inventory_item_id: "k2", display_label: "NVL-GAN · Gan heo · kg" },
    { kitchen_inventory_item_id: "k3", display_label: "NVL-CAROT · Cà rốt · kg" }, { kitchen_inventory_item_id: "k4", display_label: "NVL-CHALUA · Chả lụa lá TVP XL · kg" },
  ];
  if (st.table === "goods_receipts") return [
    { id: "gr1", receipt_number: "PN-1010-01", supplier_id: "s1", receipt_date: vnDay(1), status: "confirmed", total_quantity: 9, payable_status: "generated", receiving_location: "q7", created_at: nowIso, suppliers: { id: "s1", name: "Tỏi" }, purchase_orders: { id: "p1", po_number: "PO-1", status: "approved" }, payment_requests: null },
    { id: "gr2", receipt_number: "PN-1010-02", supplier_id: "s2", receipt_date: vnDay(1), status: "draft", total_quantity: 2480, payable_status: "not_generated", receiving_location: null, created_at: nowIso, suppliers: { id: "s2", name: "Lò bánh Tân Tạo" }, purchase_orders: null, payment_requests: null },
  ];
  if (st.table === "payment_requests") return PRS;
  if (st.table === "revenue_ledger_lines") {
    const rows = [];
    // The ledger lags: no figures for today and yesterday.
    for (let back = 2; back < 20; back += 1) {
      const day = vnDay(back);
      if (day.slice(0, 7) !== st.filters.period) continue;
      const wave = Math.sin(back / 2);
      // Full ledger row shape, so the real revenue pages render with it too.
      const line = (channel, customer, amount, qty) => ({
        id: day + "-" + channel + "-" + customer, period: day.slice(0, 7), revenue_date: day, channel, source_tab: channel,
        customer_id: "c-" + customer, parent_customer_id: null, customer_name: customer, quantity: qty,
        gross_revenue: Math.round(amount), source_type: "dealer_portal", approval_status: "approved",
        raw_payload: {}, source_document: { status: "controlled" },
      });
      rows.push(line("ĐẠI LÝ", "NPP Bình Tân", (9 + 2 * wave) * 1e6, 1400));
      rows.push(line("ĐẠI LÝ", "Đại lý Quận 7", (6 + wave) * 1e6, 900));
      rows.push(line("BÁNH NGỌT", "Bánh ngọt Q7", (9 + 2 * Math.cos(back)) * 1e6, 600));
      rows.push(line("Retail Kiosk", "Kiosk Bình Thạnh", (3 + wave) * 1e6, 220));
      if (back % 3 === 0) rows.push(line("B2B BMQ", "Siêu thị Co.op", 4.5e6, 300));
    }
    return rows;
  }
  if (st.table === "rpc:get_kiosk_point_revenue_reviews") {
    const names = ["Kiosk Bình Thạnh", "Kiosk Phú Nhuận", "Kiosk Bình Dương", "Kiosk Quận 7", "Kiosk Thủ Đức", "Kiosk Gò Vấp", "Kiosk Tân Bình", "Kiosk Quận 10", "Kiosk Hotline"];
    const rows = names.map((name, i) => ({
      report_id: "r" + i, report_date: vnDay(0), location_id: "loc-" + i, location_name: name, staff_name: "NV " + (i + 1),
      submitted_at: new Date().toISOString(), review_status: "pending", reviewed_at: null, reviewed_by_name: null, review_note: null, report_notes: null,
      channels: [
        { channel_code: "retail", channel_name: "Khách lẻ", quantity: 40 + i * 7, source_amount_vnd: (40 + i * 7) * 14000, effective_amount_vnd: (40 + i * 7) * 14000, corrected: false },
        { channel_code: "grab", channel_name: "Grab", quantity: 12 + i * 2, source_amount_vnd: (12 + i * 2) * 14000, effective_amount_vnd: (12 + i * 2) * 14000, corrected: false },
      ],
    }));
    rows.push({ ...rows[1], report_id: "dup" });
    return rows;
  }
  if (st.table === "production_orders") return [{ status: "planned" }, { status: "planned" }, { status: "planned" }, { status: "draft" }, { status: "completed" }].map((r, i) => ({ id: "po" + i, ...r }));
  if (st.table === "inventory_items") return [
    { id: "i1", name: "Bơ lạt", quantity: 2, min_stock: 10 },
    { id: "i2", name: "Pate gan", quantity: 0, min_stock: 5 },
    { id: "i3", name: "Bột mì", quantity: 80, min_stock: 20 },
  ];
  return null;
}
function builder(table, args) {
  const st = { table, args: args || {}, filters: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...args) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && args[1] && args[1].head) st.head = true;
        if (prop === "eq") st.filters[args[0]] = args[1];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn) => builder("rpc:" + fn) }),
  functions: { invoke: async (name, opts) => {
    window.__qaWrites.push("invoke:" + name + ":" + JSON.stringify((opts && opts.body) || {}));
    if (name === "stock-alias-jev") {
      const body = (opts && opts.body) || {};
      if (body.mode === "backlog") return { data: { mode: "backlog", candidates: 146, evaluated: 120, skipped_existing: 26, failed: 0, calls: 120, cost: 0.003, usage: { date: vnDay(0), calls: 120, limit: 600 }, stopped: null }, error: null };
      const results = (body.lines || []).map((l) => ({ line_key: l.line_key, normalized_name: null, candidates_hash: "h", cached: false, answer: { choice: l.candidates[0]?.id ?? null, item_id: l.candidates[0]?.id ?? null, probability: 0.93, confidence: 0.9, pack: null } }));
      return { data: { mode: "lines", results, calls: results.length, cost: 0.0001, cached: 0, failed: 0, usage: { date: vnDay(0), calls: 3, limit: 600 }, stopped: null }, error: null };
    }
    return { data: null, error: { message: "QA fixture: functions disabled" } };
  } },
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
const MODULES = {
  owner: null,
  limited: ["dashboard", "inventory", "kitchen_inventory", "goods_receipts", "payment_requests", "suppliers"],
  buyer: ["dashboard", "inventory", "goods_receipts", "payment_requests", "suppliers", "purchase_orders"],
  viewer: ["dashboard", "inventory"],
  none: [],
}[role];
const name = cfg.name || "Tâm Vũ";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: name } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = {
  user,
  session: { access_token: "qa-fixture-token", user },
  profile: { id: "qa-profile", user_id: "qa-user", full_name: name, email: user.email },
  loading: false,
  timedOut: false,
  roles: role === "owner" ? ["owner"] : ["staff"],
  authzLoaded: true,
  authzError: false,
  isOwner: role === "owner",
  canAccessModule: can,
  canEditModule: can,
  signOut: async () => { window.__qaSignedOut = true; },
  refreshProfile: async () => {},
  refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-demo3-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-alias-gate-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name, detail = {}) => {
  results.push({ name, ...detail });
  console.log("PASS", name);
};

async function open(cfg, route, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: extra.reducedMotion || "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => {
    localStorage.setItem("qa-shell", JSON.stringify(value));
    if (value.language) localStorage.setItem("app-language", value.language);
  }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  // Duyệt chi now opens on "Chưa thanh toán" (Trình chi gấp); these checks cover the full list.
  if (route === "/payment-requests") await page.locator("[data-bmq-pr-view-all]").click({ timeout: 15000 });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const tabLabels = (page) => page.$$eval(".d3-tabs .d3-tab", (els) => els.map((el) => el.textContent.trim()));
const activeTab = (page) => page.$eval(".d3-tabs", (nav) => nav.querySelector("[data-zone-active='true']")?.textContent.trim() ?? null).catch(() => null);
const activeChip = (page) => page.$eval(".d3-subnav", (nav) => nav.querySelector(".d3-chip.is-active")?.textContent.trim() ?? null).catch(() => null);

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];






async function pickSupplier(page) {
  await page.getByRole("combobox").filter({ hasText: /Chọn nhà cung cấp|Nhà cung cấp/ }).first().click();
  await page.getByRole("option", { name: "Tỏi", exact: true }).click();
}



for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  // PO: blocked while "Tỏi ngày 10" is unanswered, then allowed after "Chưa rõ".
  {
    const { context, page, errors } = await open({ data: "populated" }, "/purchase-orders", viewport);
    await page.getByRole("button", { name: /Tạo PO/ }).first().click();
    await page.waitForSelector("[role=dialog]", { timeout: 15000 });
    await pickSupplier(page);
    await page.getByRole("button", { name: /Thêm sản phẩm/ }).click();
    await page.locator('input[name="items.0.product_name"]').fill("Tỏi ngày 10");
    // Units are picked from the standard list, never typed.
    const unitSelect = page.locator('select[name="items.0.unit"]');
    assert.equal(await unitSelect.inputValue(), "kg");
    const unitOptions = await unitSelect.locator("option").allTextContents();
    assert.ok(unitOptions.includes("g") && unitOptions.includes("cuộn") && !unitOptions.includes("Cuôn"), unitOptions.join(","));
    assert.equal(await page.locator('input[name="items.0.unit"]').count(), 0, "no free-typed unit box");
    // Save immediately: the lookup is still debouncing, so the gate must hold.
    await page.getByRole("button", { name: "Tạo đơn đặt hàng" }).click();
    await page.waitForTimeout(200);
    let writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(!writes.some((w) => w.startsWith("purchase_orders:") || w.startsWith("rpc:generate_po_number")), "save must wait for the lookup: " + JSON.stringify(writes));
    await page.waitForSelector("[data-bmq-alias-panel='prompt']", { timeout: 15000 });
    await page.getByRole("button", { name: "Tạo đơn đặt hàng" }).click();
    await page.waitForTimeout(400);
    writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(!writes.some((w) => w.startsWith("purchase_orders:") || w.startsWith("rpc:generate_po_number")), "save must be blocked while a line is unanswered: " + JSON.stringify(writes));
    assert.equal(await page.locator(".d3-ma.is-attention").count(), 1, "panel is highlighted");
    assert.ok(await page.getByText(/Còn 1 dòng chưa chọn mặt hàng kho/).first().isVisible(), "blocking message shown");
    const panelBox = await page.locator("[data-bmq-alias-panel]").boundingBox();
    assert.ok(panelBox && panelBox.y < viewport.height && panelBox.y + 40 > 0, "panel scrolled into view");
    await page.screenshot({ path: `${EVIDENCE}/po-gate-${viewport.width}.png` });
    await page.locator("[data-bmq-alias-prompt]").first().getByRole("button", { name: "Chưa rõ" }).click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: "Tạo đơn đặt hàng" }).click();
    await page.waitForTimeout(600);
    writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(writes.some((w) => w.startsWith("purchase_orders:") || w.startsWith("rpc:generate_po_number") || w.startsWith("purchase_order_items:")), "save proceeds once every line is answered: " + JSON.stringify(writes));
    assert.deepEqual(errors, []);
    record(`po gate ${viewport.width}`);
    await context.close();
  }
  // PO with an auto line only: no block.
  {
    const { context, page, errors } = await open({ data: "populated" }, "/purchase-orders", viewport);
    await page.getByRole("button", { name: /Tạo PO/ }).first().click();
    await page.waitForSelector("[role=dialog]", { timeout: 15000 });
    await pickSupplier(page);
    await page.getByRole("button", { name: /Thêm sản phẩm/ }).click();
    await page.locator('input[name="items.0.product_name"]').fill("Bột mì 888 Cam (25kg)");
    await page.waitForSelector("[data-bmq-alias-panel='auto']", { timeout: 15000 });
    await page.getByRole("button", { name: "Tạo đơn đặt hàng" }).click();
    await page.waitForTimeout(600);
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(writes.some((w) => w.startsWith("purchase_orders:") || w.startsWith("rpc:generate_po_number") || w.startsWith("purchase_order_items:")), "auto lines never block: " + JSON.stringify(writes));
    assert.deepEqual(errors, []);
    record(`po auto no-block ${viewport.width}`);
    await context.close();
  }
  // Phiếu chi: blocked while unanswered.
  {
    const { context, page, errors } = await open({ data: "populated" }, "/payment-requests", viewport);
    await page.locator("[data-bmq-pr-create-menu]").first().click(); await page.locator("[data-bmq-pr-create-choice='po']").first().click();
    await page.waitForSelector("[data-bmq-pr-create-dialog]", { timeout: 15000 });
    await pickSupplier(page);
    await page.getByRole("button", { name: /Thêm/ }).last().click();
    await page.locator('input[name="items.0.product_name"]').fill("Tỏi ngày 11");
    await page.locator('input[name="title"], textarea[name="title"]').first().fill("QA phiếu chi tỏi");
    await page.waitForSelector("[data-bmq-alias-panel='prompt']", { timeout: 15000 });
    await page.locator("[data-bmq-pr-submit]").click();
    await page.waitForTimeout(400);
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(!writes.some((w) => w.startsWith("payment_requests:") || w.startsWith("payment_request_items:")), "phiếu chi save blocked: " + JSON.stringify(writes));
    assert.equal(await page.locator(".d3-ma.is-attention").count(), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${EVIDENCE}/pr-gate-${viewport.width}.png` });
    record(`pr gate ${viewport.width}`);
    await context.close();
  }
}
// VAT / fee lines never block; staff do not get "Không nhập kho", owners do.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  for (const role of ["owner", "buyer"]) {
    const { context, page, errors } = await open({ data: "populated", role }, "/purchase-orders", viewport);
    await page.getByRole("button", { name: /Tạo PO/ }).first().click();
    await page.waitForSelector("[role=dialog]", { timeout: 15000 });
    await pickSupplier(page);
    await page.getByRole("button", { name: /Thêm sản phẩm/ }).click();
    await page.locator('input[name="items.0.product_name"]').fill("Phí vận chuyển");
    await page.getByRole("button", { name: /Thêm sản phẩm/ }).click();
    await page.locator('input[name="items.1.product_name"]').fill("Tỏi ngày 10");
    await page.waitForSelector("[data-bmq-alias-panel='prompt']", { timeout: 15000 });
    assert.equal(await page.locator("[data-bmq-alias-autononstock]").count(), 1, "fee line shown as auto non-stock chip");
    assert.equal(await page.locator("[data-bmq-alias-prompt]").count(), 1, "only the goods line asks");
    assert.equal(await page.locator("[data-bmq-alias-nonstock]").count(), role === "owner" ? 1 : 0, `Không nhập kho visible only to owner (${role})`);
    const prompt = page.locator("[data-bmq-alias-prompt]").first();
    assert.equal(await prompt.locator("option[value='__new__']").count(), role === "owner" ? 1 : 0, `Tạo mặt hàng mới only for owner / Q7 editors (${role})`);
    if (role === "owner") {
      await prompt.locator("select").selectOption("__new__");
      assert.equal(await prompt.getByLabel("Tên mặt hàng mới").inputValue(), "Tỏi ngày 10");
      assert.equal(await prompt.getByRole("button", { name: "Tạo và gán" }).count(), 1);
      assert.equal(await overflow(page), 0, `create-new fields fit at ${viewport.width}`);
      await prompt.scrollIntoViewIfNeeded();
      await prompt.screenshot({ path: `${EVIDENCE}/po-new-item-${viewport.width}.png` });
    }
    await prompt.getByRole("button", { name: "Chưa rõ" }).click();
    await page.getByRole("button", { name: "Tạo đơn đặt hàng" }).click();
    await page.waitForTimeout(600);
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.ok(writes.some((w) => w.startsWith("purchase_orders:") || w.startsWith("rpc:generate_po_number") || w.startsWith("purchase_order_items:")), "fee line does not block saving: " + JSON.stringify(writes));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${EVIDENCE}/po-fee-${role}-${viewport.width}.png` });
    record(`po fee line ${role} ${viewport.width}`);
    await context.close();
  }
}
await browser.close();
await server.close();
console.log(`ALL ${results.length} ALIAS GATE QA CHECKS PASSED — evidence in ${EVIDENCE}`);
