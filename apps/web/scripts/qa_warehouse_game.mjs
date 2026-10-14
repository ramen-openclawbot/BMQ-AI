// Browser QA for Dọn danh mục (/warehouse/catalog-cleanup): owner and limited, populated / empty / error.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-warehouse-game-qa";
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
  if (/^rpc:(resolve_stock_alias|record_q7_stock_count|record_tan_tao_stock_count|set_goods_receipt_receiving_location|create_q7_draft_purchase_orders|upsert_q7_purchase_item_setting|update_q7_auto_purchase_settings|run_q7_auto_purchase_now|decide_stock_catalog_suggestion|revert_stock_item_merge|link_kitchen_items_to_canonical_materials)$/.test(st.table)) { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.table === "rpc:get_stock_count_review") {
    const SC = window.__kgFixture.stock_count;
    if (mode === "empty") return { data: { open_session: null, history: [], cutover_date: null, can_edit: true }, error: null };
    return { data: SC.reviews[st.args.p_location], error: null };
  }
  if (st.table === "rpc:start_stock_count") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: { ...window.__kgFixture.stock_count.start, location: st.args.p_location }, error: null }; }
  if (st.table === "rpc:save_stock_count_line") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    const L = window.__kgFixture.stock_count.save_line;
    const qty = st.args.p_counted_qty;
    return { data: { ...L, id: st.args.p_line_id, counted_qty: qty, difference_qty: qty === null ? null : qty - L.book_qty, result: null }, error: null };
  }
  if (st.table === "rpc:submit_stock_count") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: window.__kgFixture.stock_count.submit, error: null }; }
  if (st.table === "rpc:cancel_stock_count") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: { ...window.__kgFixture.stock_count.submit, status: "cancelled" }, error: null }; }
  if (st.table === "rpc:get_warehouse_game_snapshot") {
    const F = window.__kgFixture;
    const loc = st.args.p_location;
    const role = cfg().role || "owner";
    if (mode === "error") return { data: null, error: { message: "QA fixture: network error" } };
    const started = cfg().started ? "2026-10-05" : null;
    const items = F.items.map((it, i) => ({ ...it, on_hand: started ? (i * 137) % 5000 : 0 })).filter((it) => loc !== "q7" || it.pastry_q7);
    return { data: { location: loc, cutover_date: started, items, skus: loc === "tan_tao" ? F.skus : [], pending: role === "owner" ? (loc === "q7" ? F.q7 : F.tt) : [], transfers: F.transfers ?? [], counts: {}, can_edit: role === "owner" }, error: null };
  }
  if (st.table === "rpc:get_q7_material_link_review") {
    const mat = (id, name, unit) => ({ id, material_code: "MAT-" + id, canonical_name: name, default_unit: unit });
    const item = (id, name, unit, exact, status, candidates) => ({ item_id: id, item_code: "NVL-" + id, name, unit, exact_material: exact, material_unit: exact ? exact.default_unit : null, unit_status: status, auto_factor: status === "auto" ? 0.001 : null, factor_suggestion: null, candidates });
    const items = [
      item("i1", "Bột Ngọt", "g", mat("m1", "Bột Ngọt", "g"), "same", [{ ...mat("m1", "Bột Ngọt", "g"), unit_status: "same", score: 1 }]),
      item("i2", "Chà bông", "g", mat("m2", "Chà bông", "kg"), "auto", [{ ...mat("m2", "Chà bông", "kg"), unit_status: "auto", score: 1 }]),
      item("i3", "Trứng gà 60gr", "g", mat("m3", "Trứng gà 60gr", "quả"), "needs_factor", [{ ...mat("m3", "Trứng gà 60gr", "quả"), unit_status: "needs_factor", score: 1 }]),
      item("i4", "Bột mì 888 Cam", "g", mat("m4", "Bột mì 888 Cam", "bao"), "needs_factor", [{ ...mat("m4", "Bột mì 888 Cam", "bao"), unit_status: "needs_factor", score: 1 }]),
      item("i5", "Bottega zelachi italian grated cheese", "g", null, null, [{ ...mat("m5", "Phomai Ý nghiền Bottega Zelachi (ĐTV)", "g"), unit_status: "same", score: 0.25 }, { ...mat("m6", "Phô mai ý nghiền", "kg"), unit_status: "auto", score: 0.2 }]),
      item("i6", "Băng keo lớn", "cuộn", null, null, []),
    ];
    return { data: { items, counts: { total: items.length, exact: 4, auto: 1, needs_factor: 2, linked_total: 0 } }, error: null };
  }
  if (st.table === "rpc:link_q7_item_material") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { item_id: st.args.p_item_id, material_id: st.args.p_material_id ?? "new-mat", material_code: "MAT-X", canonical_name: "Mã chuẩn", created_material: !!st.args.p_create_new, request_id: null }, error: null };
  }
  if (st.table === "rpc:link_q7_exact_materials") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { linked: 2, needs_factor: [{ item_id: "i3", name: "Trứng gà 60gr", unit: "g", material_unit: "quả", factor_suggestion: null }], failed: [] }, error: null };
  }
  if (st.table === "document_image_rotations") {
    // Every photo starts sideways (90) so the viewer has to turn it; manual saves stick per path.
    const saved = JSON.parse(localStorage.getItem("qa-rot") || "{}");
    const rotation = saved[st.filters.image_path] ?? 90;
    return { data: st.single ? { rotation } : [{ rotation }], error: null };
  }
  if (st.table === "rpc:set_document_image_rotation") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    const saved = JSON.parse(localStorage.getItem("qa-rot") || "{}");
    saved[st.args.p_image_path] = st.args.p_rotation;
    localStorage.setItem("qa-rot", JSON.stringify(saved));
    return { data: { image_path: st.args.p_image_path, rotation: st.args.p_rotation, source: "manual" }, error: null };
  }
  if (st.table === "rpc:get_stock_transfers") return { data: window.__kgFixture.transfers ?? [], error: null };
  if (st.table === "rpc:create_manual_stock_transfer") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    const names = Object.fromEntries(window.__kgFixture.items.map((it) => [it.id, it]));
    return { data: { slip_id: "slip-qa-1", slip_number: "CKP-20261012-QA0001", transfer_date: "2026-10-12", lines: st.args.p_lines.map((l, i) => ({ transfer_id: "t-" + i, transfer_number: "CK-20261012-QA000" + i, item_id: l.item_id, item_name: names[l.item_id]?.name ?? "?", quantity: l.quantity, unit: names[l.item_id]?.unit ?? "g" })) }, error: null };
  }
  if (st.table === "rpc:get_crate_receipt_lines" || st.table === "rpc:get_item_receipt_lines") { window.__qaWrites.push("read:" + st.table); return { data: window.__kgFixture.receipt_lines ?? [], error: null }; }
  if (st.table === "rpc:set_item_pastry_q7") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: { item_id: st.args.p_item_id, pastry_q7: st.args.p_value }, error: null }; }
  if (/^rpc:(rename_stock_item|change_stock_item_unit|confirm_material_alias|create_stock_material_item)$/.test(st.table)) {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    if (st.table === "rpc:rename_stock_item") return { data: { item_id: st.args.p_item_id, old_name: "x", new_name: st.args.p_new_name }, error: null };
    if (st.table === "rpc:change_stock_item_unit") return { data: { item_id: st.args.p_item_id, old_unit: "g", new_unit: st.args.p_new_unit, factor: st.args.p_factor ?? 1, merge_id: null }, error: null };
    if (st.table === "rpc:create_stock_material_item") return { data: { item_id: "new-item-1", created: true }, error: null };
    return { data: { alias: { status: "auto" } }, error: null };
  }
  if (st.table === "rpc:create_stock_material_item") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: { item_id: "new-item-1", created: true }, error: null }; }
  if (st.table === "rpc:confirm_material_alias") { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.table === "rpc:get_material_alias_backlog_review" && mode === "empty") return { data: [], error: null };
  if (st.table === "rpc:get_new_item_suggestions" && mode === "empty") return { data: [], error: null };
  if (/^rpc:(apply_new_item_suggestion|dismiss_new_item_suggestion)$/.test(st.table)) { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: { status: st.table.includes("dismiss") ? "dismissed" : "applied", suggestion_id: st.args.p_suggestion_id, item_id: "new-item-2", item_class: st.args.p_item_class ?? null, members_applied: 1 }, error: null }; }
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
  if (st.table === "rpc:get_stock_catalog_review") {
    const sug = (id, kind, a, au, ai, b, bu, bi, target, p, factor, fs, cls) => ({ id, kind, item_id: a[0], item_name: a[1], item_unit: au, other_item_id: b ? b[0] : null, other_item_name: b ? b[1] : null, other_item_unit: bu, proposed_target_id: target, target_name: target === a[0] ? a[1] : (b ? b[1] : null), target_unit: target === a[0] ? au : bu, probability: p, proposed_factor: factor, factor_source: fs, proposed_class: cls, prompt_version: "qa", cost: 0.0002, created_at: nowIso, item_issue_count_90d: ai, other_issue_count_90d: bi, source_live_refs: kind === 'merge' ? (bi > 0 || id === 'm1' ? 54 : 0) : null });
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
  if (st.table === "rpc:get_latest_new_item_run") {
    const status = cfg().runStatus;
    if (!status) return [];
    return [{ id: "run-1", location: st.args.p_location, status, processed: 12, remaining: 30, calls: 12, groups: 0, last_error: status === "failed" ? "jev_timeout" : null, started_by: "qa-user", started_at: nowIso, updated_at: nowIso, finished_at: status === "done" ? nowIso : null }];
  }
  if (st.table === "rpc:get_material_alias_backlog_review" && st.args.p_location === "tan_tao") {
    window.__qaWrites.push("review:tan_tao");
    const r = (n, raw, lines, sup, top, jev, p, src, jevName, jevUnit, isSku) => ({ normalized_name: "t" + n, raw_name: raw, line_count: lines, supplier_id: "tsup" + n, supplier_name: sup, last_receipt_date: vnDay(n), top_candidate: top, jev_item_id: jev, jev_item_name: jevName ?? null, jev_unit: jevUnit ?? null, jev_probability: p, jev_line_type: src ? "goods" : null, jev_source: src, jev_is_sku: Boolean(isSku) });
    return [
      r(1, "bánh mì que ngày 1", 91, "Tuyết Anh", { item_id: null, sku_id: "sku-bmq", name: "Bánh mì que Pate gói", unit: "gói", score: 0.9, reason: "name_contains+sku" }, "sku-bmq", 0.88, "jev", "Bánh mì que Pate gói", "gói", true),
      r(2, "gan heo ngày 10", 22, "Mai Hoàng Bích Hà", { item_id: "k-gan", sku_id: null, name: "Gan heo", unit: "g", score: 1, reason: "name_exact" }, "k-gan", 1, "exact", "Gan heo", "g", false),
    ];
  }
  if (st.table === "rpc:get_material_alias_backlog_review") {
    const cand = (item_id, name, unit, reason) => ({ item_id, sku_id: null, name, unit, score: 1, reason });
    const r = (n, raw, lines, sup, top, jev, p, src, jevName, jevUnit) => ({ normalized_name: "n" + n, raw_name: raw, line_count: lines, supplier_id: "sup" + (n % 3), supplier_name: sup, last_receipt_date: vnDay(n), top_candidate: top, jev_item_id: jev, jev_item_name: jevName ?? null, jev_unit: jevUnit ?? null, jev_probability: p, jev_line_type: src ? "goods" : null, jev_source: src });
    const rows = [
      r(1, "RE AN KHÈ", 6, "Rau Đà Lạt", cand("k-re", "RE AN KHÊ", "g", "name_exact"), "k-re", 1, "exact", "RE AN KHÊ", "g"),
      r(2, "Bột mì 888 Cam (25kg)", 12, "Phúc Thịnh", cand("k-bm", "Bột mì 888 Cam", "g", "name_exact"), "k-bm", 1, "exact", "Bột mì 888 Cam", "g"),
      r(3, "DAIRYMONT WHITE SLICES CHEESE 1KG", 4, "Đại Tân Việt", cand("k-cc", "Cream cheese", "g", "token"), "k-pm", 0.93, "jev", "Phô mai 84 lát trắng Dairymont (1kg/khối 12 khối/thùng)", "g"),
      r(4, "[Thùng] Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp / [Carton] Mekovita UHT Milk 3.5% Fat x 12 Boxes", 3, "Kingfood", cand("k-sm", "Sữa Mlekovita", "Hộp", "token"), "k-sm", 0.62, "jev", "Sữa Mlekovita", "Hộp"),
      r(5, "MUỐI DIÊM", 2, "Hóa chất Sài Gòn", cand("k-ms", "Muối sấy", "g", "token"), null, 0.81, "jev"),
      r(6, "Thùng carton 45*35*35", 5, "Bao bì Minh Phát", null, null, null, null),
      r(7, "Chà bông cay", 1, "Chà bông Cô Ba", cand("k-cb", "Chà bông cay", "g", "name_exact"), null, null, null),
      r(8, "Khay bạc vuông", 3, "Bao bì Minh Phát", cand("k-dh", "Dầu hướng dương", "g", "token"), null, null, null),
    ];
    for (let i = 9; i <= 26; i += 1) rows.push(r(i, "Trứng gà 60gr lô " + i, 1, "Trại gà", cand("k-tg", "Trứng gà 60gr", "g", "name_exact"), "k-tg", 1, "exact", "Trứng gà 60gr", "g"));
    return rows;
  }
  if (st.table === "rpc:get_new_item_suggestions") {
    const m = (n, raw, unit, count, sup) => ({ supplier_id: sup ?? "sup1", normalized_name: n, raw_name: raw, raw_unit: unit, receipt_count: count, last_date: vnDay(1) });
    const g = (id, name, unit, cls, p, members, count, days, recurring) => ({ id, location: "q7", cluster_key: "k" + id, members, suggested_name: name, suggested_unit: unit, suggested_class: cls, class_probability: p, receipt_count: count, receipt_days: days, first_date: vnDay(50), last_date: vnDay(1), is_recurring: recurring, status: "pending", item_id: null, prompt_version: "jev-new-item-2026-10-21.1", decided_by: null, decided_at: null, created_at: nowIso, updated_at: nowIso });
    return [
      g("ni1", "Tỏi", "g", "raw_material", 0.97, [m("toi", "TỎI NGÀY 1", "kg", 40, "sup-toi")], 40, 2, true),
      g("ni2", "Phô mai lát trắng Dairymont", "g", "raw_material", 0.92, [m("dairymont white slices cheese 1kg", "DAIRYMONT WHITE SLICES CHEESE 1KG", "PACK", 2), m("danpmont white slices cheese 1kg", "DANPMONT WHITE SLICES CHEESE 1KG", "PACK", 1), m("pho mai lat trang dairy/1kg", "Phô mai lát trắng Dairy/1kg (DAIRY/ONT WHITE SLICES CHEESE 1KG)", "CỐI (PACK)", 1)], 4, 4, true),
      g("ni3", "Bao xốp zin trắng 30", "cái", "packaging_supply", 0.71, [m("bao xop zin trang", "BAO XỚP ZIN TRẮNG 30 (kg)", "kg", 7)], 7, 2, true),
      g("ni4", "Thớt nhựa", "cái", "non_stock", 0.55, [m("thot nhua", "Thớt nhựa", "Cái", 1)], 1, 1, false),
    ];
  }
  if (st.table === "kitchen_inventory_items") return [
    { id: "k-re", name: "RE AN KHÊ", unit: "g" }, { id: "k-bm", name: "Bột mì 888 Cam", unit: "g" }, { id: "k-pm", name: "Phô mai 84 lát trắng Dairymont (1kg/khối 12 khối/thùng)", unit: "g" },
    { id: "k-sm", name: "Sữa Mlekovita", unit: "Hộp" }, { id: "k-ms", name: "Muối sấy", unit: "g" }, { id: "k-cc", name: "Cream cheese", unit: "g" }, { id: "k-tg", name: "Trứng gà 60gr", unit: "g" },
  ];
  if (st.table === "rpc:get_material_alias_review") return { summary: { auto_count: 0, learning_count: 0, disabled_count: 0, pending_lines: 0 }, aliases: [] };
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
      if (prop === "then") {
        const slow = cfg().slow && /^rpc:(get_warehouse_game_snapshot|get_my_missions)$/.test(st.table);
        return (ok, ko) => (slow ? new Promise((r) => setTimeout(r, cfg().slow)) : Promise.resolve()).then(() => settle(st)).then(ok, ko);
      }
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
  functions: { invoke: async (name, opts) => { window.__qaWrites.push("invoke:" + name); window.__qaWrites.push("invoke-body:" + name + ":" + JSON.stringify(opts?.body ?? null)); if (name === "suggest-stock-item-name") { await new Promise((r) => setTimeout(r, 1500)); } if (name === "suggest-stock-item-name") return { data: { suggestion: { full_name: "GIẤM TINH LUYỆN MINH CHÂU 4% 1L", unit: "chai", confidence: 0.86, source: "invoice_image" } }, error: null }; return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async (path) => ({ data: { signedUrl: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#fff"/><text x="40" y="80" font-size="40" font-family="sans-serif">PHIẾU GIAO HÀNG</text><text x="40" y="140" font-size="24" font-family="sans-serif">' + String(path).slice(-28) + '</text>' + Array.from({ length: 12 }, (_, i) => '<rect x="40" y="' + (200 + i * 48) + '" width="520" height="2" fill="#999"/>').join("") + '</svg>') }, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-warehouse-game-qa/vite-cache",
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

const KG_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_warehouse_game.fixture.json"), "utf8"));
// A count-to-count crate: the receipt says "cái", the shelf counts "cuộn".
KG_FIXTURE.q7.filter((crate) => crate.normalized_name === "n4").forEach((crate) => {
  crate.raw_unit = "cái";
  crate.raw_units = [{ unit: "cái", line_count: crate.line_count }];
  crate.top_candidate = { item_id: "fbdf4f9a-52db-446b-b3c2-e5b2e5d03842", sku_id: null, name: "Băng keo nhỏ", unit: "cuộn", score: 0.9, reason: "token" };
});
// "Nhãn Bánh Pháp" shares only the word "bánh" with "Chất làm mềm bánh" (live score 0.633): not a hint.
KG_FIXTURE.q7.filter((crate) => crate.raw_name === "Nhãn Bánh Pháp").forEach((crate) => { crate.top_candidate = { ...crate.top_candidate, score: 0.6333, reason: "token" }; });
// Live data had no Jev hints at ship time; give the first 4 Q7 crates one so the "Jev đã gợi ý" lot renders.
KG_FIXTURE.q7.slice(0, 4).forEach((crate, i) => {
  // Q7 only stocks pastry items (central warehouse rule), so the hint must be one of them.
  const pastry = KG_FIXTURE.items.filter((it) => it.pastry_q7);
  const item = pastry[i * 5 % pastry.length];
  Object.assign(crate, { jev_item_id: item.id, jev_item_name: item.name, jev_unit: item.unit, jev_probability: 0.9 - i * 0.05, jev_source: "jev", jev_line_type: "goods", jev_is_sku: false });
});
async function open(cfg, route, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: extra.reducedMotion || "reduce", locale: "vi-VN" });
  await context.addInitScript((fixture) => { window.__kgFixture = fixture; }, KG_FIXTURE);
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
  await page.waitForSelector(route === "/warehouse/game" ? "[data-bmq-warehouse-game]" : "[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}

// The shell scrolls inside a fixed-height frame: grow the viewport to capture a whole card.
async function shot(page, locator, file, viewport) {
  await page.setViewportSize({ width: viewport.width, height: 5200 });
  await page.waitForTimeout(150);
  await locator.screenshot({ path: file });
  await page.setViewportSize(viewport);
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







async function shotEl(page, locator, file, viewport) {
  await page.setViewportSize({ width: viewport.width, height: 2400 });
  await page.waitForTimeout(250);
  await locator.screenshot({ path: file });
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  for (const [data, role, started] of [["populated", "owner", false], ["populated", "viewer", true], ["error", "owner", false]]) {
    const { context, page, errors } = await open({ data, role, started }, "/warehouse/game", viewport);
    await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
    await page.waitForTimeout(1200);
    const game = page.locator("[data-bmq-warehouse-game]");
    assert.equal(await overflow(page), 0, `no overflow ${data} ${role} ${viewport.width}`);
    if (data === "error") {
      await page.getByRole("button", { name: "KHO Q7" }).click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${EVIDENCE}/error-${viewport.width}.png` });
      assert.deepEqual(errors, []);
      record(`game error ${viewport.width}`);
      await context.close();
      continue;
    }
    await page.screenshot({ path: `${EVIDENCE}/yard-${role}-${viewport.width}.png` });
    const box = await game.boundingBox();
    assert.ok(box && box.height >= 480 && box.x >= 0 && box.x + box.width <= viewport.width, `game frame fits ${viewport.width}: ${JSON.stringify(box)}`);
    await page.getByRole("button", { name: "KHO Q7" }).click({ force: true });
    await page.waitForTimeout(900);
    assert.ok((await page.locator(".kg .title-pill b").textContent()).includes("Kho Q7"));
    await page.screenshot({ path: `${EVIDENCE}/q7-${role}-${viewport.width}.png` });
    if (role === "owner") {
      await page.locator("[data-bmq-transfer-van]").click({ force: true });
      await page.waitForTimeout(600);
      assert.equal(await page.locator("[data-bmq-transfer-list] li").count(), (KG_FIXTURE.transfers ?? []).length, "transfer sheet lists the transfers");
      await page.screenshot({ path: `${EVIDENCE}/transfers-${viewport.width}.png` });
      await page.locator(".kg .sheet .close").click({ force: true });
      await page.waitForTimeout(300);
      await page.locator("[data-bmq-yard-gate]").click({ force: true });
      await page.waitForSelector("[data-bmq-crate-yard='q7']", { timeout: 8000 });
      await page.waitForTimeout(600);
      assert.equal(await overflow(page), 0, `crate yard no overflow ${viewport.width}`);
      assert.match(await page.locator(".kg .title-pill b").textContent(), /Bãi thùng chờ/);
      const cards = await page.locator("[data-bmq-crate]").count();
      assert.equal(cards, KG_FIXTURE.q7.length, "every pending crate has a card");
      assert.ok((await page.locator(".kg .crate-card.has-jev").count()) >= 1, "Jev hints grouped");
      await page.screenshot({ path: `${EVIDENCE}/crate-yard-${viewport.width}.png` });
      await page.locator("[data-bmq-jev-run]").click({ force: true });
      await page.waitForTimeout(700);
      let writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.includes("invoke:stock-alias-jev"), "Jev robot runs the backlog scan");
      assert.equal(await page.locator("[data-bmq-jev='error']").count(), 1, "fixture refuses functions → Jev shows the error face");
      await page.screenshot({ path: `${EVIDENCE}/crate-yard-jev-${viewport.width}.png` });
      await page.locator(".kg .crate-card.has-jev").first().click({ force: true });
      await page.waitForTimeout(700);
      assert.equal(await page.locator(".kg .sheet .pick.is-top", { hasText: "bấm để đổi" }).count(), 1, "label sheet opens on the hint");
      const unitMode = await page.locator("[data-bmq-unit-q]").getAttribute("data-bmq-unit-q");
      assert.ok(["pack", "auto", "unknown"].includes(unitMode ?? ""), "unit question shown");
      if (unitMode === "pack") {
        const factorInput = page.locator("[data-bmq-unit-q] input").first();
        if (!(await factorInput.inputValue())) {
          assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), true, "pack unit needs a factor first");
          await factorInput.fill("1000");
        }
      }
      const notes = page.locator("[data-bmq-receipt-notes] [data-bmq-note]");
      assert.equal(await notes.count(), (KG_FIXTURE.receipt_lines ?? []).length, "delivery-note strip lists every receipt line");
      await page.screenshot({ path: `${EVIDENCE}/crate-${viewport.width}.png` });
      await page.locator("[data-bmq-receipt-notes] .note-card:not([disabled])").first().click({ force: true });
      await page.waitForSelector("[data-bmq-note-viewer] img", { timeout: 5000 });
      const viewerBox = await page.locator("[data-bmq-note-viewer]").boundingBox();
      assert.ok(viewerBox && viewerBox.width >= viewport.width - 2 && viewerBox.x <= 1, `note viewer is full screen ${JSON.stringify(viewerBox)}`);
      // Saved rotation 90: the portrait fixture photo shows turned, in a landscape box that fits the screen.
      await page.waitForFunction(() => document.querySelector("[data-bmq-note-viewer] [data-bmq-rotated-image='90'] img")?.style.visibility === "visible", null, { timeout: 5000 });
      const turned = await page.locator("[data-bmq-note-viewer] [data-bmq-rotated-image='90']").boundingBox();
      assert.ok(turned && turned.width > turned.height && turned.x >= 0 && turned.x + turned.width <= viewport.width + 1, `turned photo box ${JSON.stringify(turned)}`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${EVIDENCE}/note-rotated-${viewport.width}.png` });
      await page.getByRole("button", { name: "Xoay ảnh" }).click({ force: true });
      await page.waitForFunction(() => /rotate\(180deg\)/.test(document.querySelector("[data-bmq-note-viewer] .note-stage img")?.style.transform ?? ""), null, { timeout: 5000 });
      writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.some((w) => w.startsWith("rpc:set_document_image_rotation:") && w.includes('"p_rotation":180')), JSON.stringify(writes));
      await page.getByRole("button", { name: "Xoay ảnh" }).click({ force: true });
      await page.waitForSelector("[data-bmq-note-viewer] [data-bmq-rotated-image='270']", { timeout: 5000 });
      await page.getByRole("button", { name: "Xoay ảnh" }).click({ force: true });
      await page.waitForFunction(() => { const img = document.querySelector("[data-bmq-note-viewer] .note-stage img"); return img && !img.closest("[data-bmq-rotated-image]") && !img.style.transform; }, null, { timeout: 5000 });
      await page.evaluate(() => localStorage.removeItem("qa-rot"));
      // GRN-QA-1001 also has an extra product photo: a "+1" badge on its card and a photo tab in the viewer.
      assert.equal(await page.locator("[data-bmq-receipt-notes] [data-bmq-note='GRN-QA-1001'] .note-more").first().textContent(), "+1", "extra photo badge");
      assert.equal(await page.locator("[data-bmq-note-viewer] .note-photos button").count(), 2, "viewer lists main + extra photo");
      await page.locator("[data-bmq-note-viewer] .note-photos button", { hasText: "Ảnh 2" }).click({ force: true });
      await page.waitForFunction(() => decodeURIComponent(document.querySelector("[data-bmq-note-viewer] .note-stage img")?.getAttribute("src") ?? "").includes("product-1001"), null, { timeout: 5000 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${EVIDENCE}/note-extra-photo-${viewport.width}.png` });
      const tabs = await page.locator("[data-bmq-note-viewer] .note-photos").boundingBox();
      assert.ok(tabs && tabs.x >= 0 && tabs.x + tabs.width <= viewport.width + 1, `photo tabs fit ${JSON.stringify(tabs)}`);
      await page.locator("[data-bmq-note-viewer] .note-photos button", { hasText: "Phiếu" }).click({ force: true });
      await page.waitForFunction(() => decodeURIComponent(document.querySelector("[data-bmq-note-viewer] .note-stage img")?.getAttribute("src") ?? "").includes("note-1001-1729"), null, { timeout: 5000 });
      await page.getByRole("button", { name: "Phóng to" }).click({ force: true });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${EVIDENCE}/note-viewer-${viewport.width}.png` });
      await page.getByRole("button", { name: "Đóng" }).last().click({ force: true });
      await page.waitForTimeout(300);
      assert.equal(await page.locator("[data-bmq-note-viewer]").count(), 0, "viewer closes");
      await page.getByRole("button", { name: "Xếp vào kệ" }).click({ force: true });
      await page.waitForTimeout(400);
      writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.some((w) => w.startsWith("rpc:confirm_material_alias:") && w.includes('"p_location":"q7"') && w.includes('"p_source_table":"warehouse_game"') && w.includes('"p_line_class":"stock"')), JSON.stringify(writes));
      await page.waitForTimeout(900);
      // cái → cuộn: both are counts, so the sheet asks how they relate (and blocks until answered).
      await page.locator("[data-bmq-crate='n4']").click({ force: true });
      await page.waitForTimeout(700);
      assert.equal(await page.locator("[data-bmq-count-q]").count(), 1, "count-to-count crate asks how the units relate");
      assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), true, "no default relation");
      await page.getByRole("radio", { name: /gồm nhiều cái/ }).click({ force: true });
      await page.locator("[data-bmq-count-q] input").fill("10");
      assert.match(await page.locator("[data-bmq-count-q] .unit-q-hint").textContent(), /1 cái = 0,1 cuộn|1 cái = 0\.1 cuộn/);
      assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), false);
      await page.screenshot({ path: `${EVIDENCE}/crate-count-${viewport.width}.png` });
      await page.getByRole("radio", { name: /Là một/ }).click({ force: true });
      assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), false);
      await page.locator(".kg .sheet .close").click({ force: true });
      await page.waitForTimeout(300);
      // A PACK crate asks "1 PACK = ? g" and blocks shelving until answered.
      await page.locator("[data-bmq-crate='n3']").click({ force: true });
      await page.waitForTimeout(700);
      assert.equal(await page.locator("[data-bmq-unit-q='pack']").count(), 1, "PACK crate asks for the pack factor");
      assert.match(await page.locator("[data-bmq-unit-q]").textContent(), /PACK/);
      assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), true, "no default factor for packs");
      await page.locator("[data-bmq-unit-q] input").first().fill("1000");
      assert.equal(await page.getByRole("button", { name: "Xếp vào kệ" }).isDisabled(), false);
      await page.screenshot({ path: `${EVIDENCE}/crate-pack-${viewport.width}.png` });
      await page.locator(".kg .sheet .close").click({ force: true });
      await page.waitForTimeout(300);
      assert.equal(await page.locator("[data-bmq-crate-lot='new'] [data-bmq-crate]", { hasText: "Nhãn Bánh Pháp" }).count(), 1, "weak one-word match is not offered as a hint");
      const freshLot = page.locator("[data-bmq-crate-lot='new'] [data-bmq-crate]");
      if (await freshLot.count()) {
        await freshLot.first().click({ force: true });
        await page.waitForTimeout(700);
        assert.equal(await page.locator("[data-bmq-crate-nohint]").count(), 1, "no-hint crate offers create");
        assert.equal(await page.locator(".kg .sheet .picks .pick").count(), 0, "no A→Z list before typing");
        await page.screenshot({ path: `${EVIDENCE}/crate-nohint-${viewport.width}.png` });
        await page.locator(".kg .sheet .field input").first().fill("bột");
        await page.waitForTimeout(200);
        assert.ok((await page.locator(".kg .sheet .picks .pick").count()) > 0, "typing lists matches");
        const pickBox = await page.locator(".kg .sheet .picks .pick").first().boundingBox();
        assert.ok(pickBox && pickBox.height >= 40, `search result is readable, not squeezed: ${JSON.stringify(pickBox)}`);
        await page.locator("[data-bmq-crate-nohint] .btn").click({ force: true });
        await page.waitForTimeout(300);
        await page.waitForTimeout(250);
        assert.equal(await page.locator("[data-bmq-invoice-scanner]").count(), 1, "invoice scanner shows while reading");
        assert.equal(await overflow(page), 0, `scanner no overflow ${viewport.width}`);
        await page.locator("[data-bmq-invoice-scanner]").screenshot({ path: `${EVIDENCE}/invoice-scanner-${viewport.width}.png` });
        await page.waitForTimeout(1700);
        assert.equal(await page.locator("[data-bmq-invoice-scanner]").count(), 0, "scanner gone after reading");
        const created = await page.locator(".kg .sheet .field input").first().inputValue();
        assert.equal(created, "Giấm tinh luyện minh châu 4% 1l", `full invoice name prefilled: ${created}`);
        assert.equal(await page.locator("[data-bmq-name-hint='invoice']").count(), 1, "invoice-name hint shown");
        assert.equal(await page.locator(".kg .sheet select").first().inputValue(), "chai", "unit taken from the invoice line");
        assert.ok((await page.evaluate(() => window.__qaWrites)).some((w) => w.startsWith("invoke-body:suggest-stock-item-name:") && w.includes('"normalized_name"')), "suggestion asked with the crate key");
        await page.screenshot({ path: `${EVIDENCE}/crate-new-fullname-${viewport.width}.png` });
        assert.equal(await page.locator("[data-bmq-new-pastry] [role='switch']").getAttribute("aria-checked"), "true", "new item from a Q7 crate starts as pastry");
        const unitInput = page.locator("[data-bmq-unit-q='pack'] input");
        if (await unitInput.count()) await unitInput.first().fill("1000");
        await page.getByRole("button", { name: /Tạo và xếp vào kệ/ }).click({ force: true });
        await page.waitForTimeout(600);
        const made = await page.evaluate(() => window.__qaWrites);
        const iCreate = made.findIndex((w) => w.startsWith("rpc:create_stock_material_item:"));
        const iFlag = made.findIndex((w) => w.startsWith("rpc:set_item_pastry_q7:") && w.includes('"p_value":true'));
        const iConfirm = made.findIndex((w, i) => i > iFlag && w.startsWith("rpc:confirm_material_alias:"));
        assert.ok(iCreate >= 0 && iFlag > iCreate && iConfirm > iFlag, `create → flag pastry → label, got ${JSON.stringify(made.slice(-6))}`);
        await page.screenshot({ path: `${EVIDENCE}/crate-new-pastry-${viewport.width}.png` });
        if (await page.locator(".kg .sheet .close").count()) await page.locator(".kg .sheet .close").click({ force: true });
        await page.waitForTimeout(300);
      } else {
        record(`(note) fixture has no hint-less crate ${viewport.width}`);
      }
      await page.locator(".kg .hud .round-btn").first().click({ force: true });
      await page.waitForTimeout(800);
    } else {
      assert.equal(await page.locator("[data-bmq-yard-gate]").count(), 0, "viewer cannot open the crate yard");
    }
    await page.getByRole("button", { name: /Nguyên liệu, \d+ mặt hàng/ }).click({ force: true });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${EVIDENCE}/shelf-${role}-${viewport.width}.png` });
    if (started) assert.ok((await page.locator(".kg .good-meta b").count()) > 0, "stock shown once the ledger started");
    await page.getByRole("button", { name: "Bột mì 888 Cam" }).click({ force: true });
    await page.waitForTimeout(600);
    assert.equal(await page.locator("[data-bmq-item-pastry]").count(), 1, "item sheet shows the Bánh ngọt (Q7) flag");
    assert.equal(await page.locator("[data-bmq-receipt-notes]").count(), role === "owner" ? 1 : 0, "item sheet shows recent receipts to editors only");
    if (role === "owner") {
      await page.getByRole("button", { name: /Đổi tên/ }).click({ force: true });
      await page.locator(".kg .field input").first().fill("Bột mì 999 Cam");
      assert.equal(await page.locator(".kg .warn", { hasText: "Trùng" }).count(), 1);
      await page.locator(".kg .field input").first().fill("Bột mì 888 Cam loại 1");
      await page.locator(".kg .field select").selectOption("bao");
      await page.locator(".kg .conv input").fill("0.00004");
      await page.screenshot({ path: `${EVIDENCE}/edit-${viewport.width}.png` });
      await page.getByRole("button", { name: "Lưu" }).click({ force: true });
      await page.waitForTimeout(600);
      const writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.some((w) => w.startsWith("rpc:rename_stock_item:") && w.includes("Bột mì 888 Cam loại 1")), "rename sent");
      assert.ok(writes.some((w) => w.startsWith("rpc:change_stock_item_unit:") && w.includes('"p_new_unit":"bao"') && w.includes('"p_factor":0.00004')), "unit change sent with factor");
      assert.ok(!(await page.locator(".kg .field select option").allTextContents().catch(() => [])).includes("kg"));
    } else {
      assert.equal(await page.getByRole("button", { name: /Đổi tên/ }).count(), 0, "viewer cannot edit");
      await page.screenshot({ path: `${EVIDENCE}/item-viewer-${viewport.width}.png` });
      await page.locator(".kg .sheet .close").click({ force: true });
    }
    assert.equal(await overflow(page), 0, `no overflow after ${viewport.width}`);
    assert.deepEqual(errors, [], "no page errors");
    record(`game ${role} ${viewport.width}`);
    await context.close();
  }
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const { context, page, errors } = await open({ data: "populated", role: "owner" }, "/warehouse/game", viewport);
  await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const box = await page.locator("[data-bmq-warehouse-game]").boundingBox();
  assert.ok(box && Math.abs(box.width - viewport.width) < 2 && Math.abs(box.height - viewport.height) < 2, `full screen ${viewport.width}: ${JSON.stringify(box)}`);
  assert.equal(await page.locator(".d3-header").count(), 0, "no BMQ shell header in the game");
  await page.getByRole("button", { name: "Xưởng dọn" }).click({ force: true });
  await page.waitForTimeout(900);
  assert.ok((await page.locator(".kg .title-pill b").textContent()).includes("Xưởng dọn danh mục"));
  await page.screenshot({ path: `${EVIDENCE}/workshop-${viewport.width}.png` });
  for (const [station, check] of [["Bàn gộp", "[data-bmq-catalog-merge]"], ["Bàn phân loại", "[data-bmq-catalog-classify]"], ["Bàn bánh ngọt", "[data-bmq-pastry-toggle]"], ["Bàn mã chuẩn Q7", "[data-bmq-link-station]"], ["Hàng mới đề xuất", "[data-bmq-new-items]"], ["Tên chờ gán mã", "[data-bmq-alias-backlog]"], ["Bảng bí danh", "[data-bmq-learned-aliases]"], ["Bàn xếp kho", "[data-bmq-routing-suppliers]"], ["Máy Jev", ".jev-meter"]]) {
    await page.getByRole("button", { name: new RegExp(`^${station}`) }).click({ force: true });
    await page.waitForTimeout(900);
    assert.ok((await page.locator(check).count()) >= 1, `${station} shows its tool at ${viewport.width}`);
    assert.equal(await overflow(page), 0, `${station} no overflow ${viewport.width}`);
    await page.screenshot({ path: `${EVIDENCE}/station-${station.replace(/\s+/g, "-")}-${viewport.width}.png` });
    if (station === "Bàn gộp") {
      await page.locator("[data-bmq-catalog-merge]").nth(3).getByRole("button", { name: "Bỏ" }).click({ force: true });
      await page.waitForTimeout(300);
      const writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.some((w) => w.startsWith("rpc:decide_stock_catalog_suggestion:") && w.includes('"p_action":"reject"')), "merge decision sent from the workshop");
    }
    if (station === "Hàng mới đề xuất") {
      await page.locator(".kg .loc-switch button", { hasText: "Kho Tân Tạo" }).click({ force: true });
      await page.waitForTimeout(500);
      assert.equal(await page.locator(".kg .loc-switch button.is-on", { hasText: "Tân Tạo" }).count(), 1);
    }
    if (station === "Bàn bánh ngọt") {
      await page.locator("[data-bmq-pastry-toggle]").first().click({ force: true });
      await page.waitForTimeout(400);
      assert.ok((await page.evaluate(() => window.__qaWrites)).some((w) => w.startsWith("rpc:set_item_pastry_q7:")), "pastry toggle writes");
      await page.screenshot({ path: `${EVIDENCE}/station-pastry-${viewport.width}.png` });
    }
    if (station === "Bàn mã chuẩn Q7") {
      assert.equal(await page.locator("[data-bmq-link-row]").count(), 6, "every unlinked item is listed");
      await page.locator("[data-bmq-link-bulk]").click({ force: true });
      await page.waitForTimeout(400);
      let writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.some((w) => w.startsWith("rpc:link_q7_exact_materials:")), "bulk link sent");
      const egg = page.locator("[data-bmq-link-row='Trứng gà 60gr']");
      assert.equal(await egg.locator("[data-bmq-link-factor] input").inputValue(), "60", "factor read from the name");
      const flour = page.locator("[data-bmq-link-row='Bột mì 888 Cam']");
      assert.equal(await flour.locator("[data-bmq-link-save]").isDisabled(), true, "no factor, no save");
      await flour.locator("[data-bmq-link-factor] input").fill("25000");
      await page.screenshot({ path: `${EVIDENCE}/station-links-${viewport.width}.png`, fullPage: true });
      await egg.locator("[data-bmq-link-save]").dispatchEvent("click");
      await page.waitForTimeout(500);
      await flour.locator("[data-bmq-link-save]").dispatchEvent("click");
      await page.waitForTimeout(300);
      const cheese = page.locator("[data-bmq-link-row='Bottega zelachi italian grated cheese']");
      await cheese.locator("[data-bmq-link-pick='Phomai Ý nghiền Bottega Zelachi (ĐTV)']").dispatchEvent("click");
      await cheese.locator("[data-bmq-link-save]").dispatchEvent("click");
      await page.waitForTimeout(300);
      await page.locator("[data-bmq-link-row='Băng keo lớn'] [data-bmq-link-create]").dispatchEvent("click");
      await page.waitForFunction(() => window.__qaWrites.some((w) => w.includes('"p_item_id":"i6"')), null, { timeout: 5000 }).catch(() => {});
      writes = await page.evaluate(() => window.__qaWrites);
      const links = writes.filter((w) => w.startsWith("rpc:link_q7_item_material:")).map((w) => JSON.parse(w.slice("rpc:link_q7_item_material:".length)));
      const eggW = links.find((l) => l.p_item_id === "i3");
      assert.ok(eggW && Math.abs(eggW.p_unit_factor - 1 / 60) < 1e-9 && eggW.p_material_id === "m3", `egg link ${JSON.stringify(eggW)}`);
      const flourW = links.find((l) => l.p_item_id === "i4");
      assert.ok(flourW && Math.abs(flourW.p_unit_factor - 1 / 25000) < 1e-12, `flour link ${JSON.stringify(flourW)}`);
      const cheeseW = links.find((l) => l.p_item_id === "i5");
      assert.ok(cheeseW && cheeseW.p_material_id === "m5" && cheeseW.p_unit_factor === null, `cheese link ${JSON.stringify(cheeseW)}`);
      const tapeW = links.find((l) => l.p_item_id === "i6");
      assert.ok(tapeW && tapeW.p_create_new === true && tapeW.p_material_id === null, `create link ${JSON.stringify(links)} rows=${await page.locator("[data-bmq-link-row]").count()}`);
    }
    if (station === "Máy Jev") {
      await page.getByRole("button", { name: /Quét cặp trùng/ }).click({ force: true });
      await page.waitForTimeout(400);
      const writes = await page.evaluate(() => window.__qaWrites);
      assert.ok(writes.includes("invoke:stock-catalog-jev"), "Jev machine runs the catalog scan");
    }
    await page.locator(".kg .hud .round-btn").first().click({ force: true });
    await page.waitForTimeout(700);
  }
  await page.locator(".kg .exit-btn").click({ force: true });
  await page.waitForTimeout(1500);
  assert.equal(new URL(page.url()).pathname, "/", "exit goes to Tổng quan");
  assert.equal(await page.locator("[data-bmq-warehouse-game]").count(), 0, "game closed");
  assert.deepEqual(errors, [], "no page errors");
  record(`workshop + full screen ${viewport.width}`);
  await context.close();
}
// Kiểm kê (owner 12/10): lobby → tally sheet → review → done.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const { context, page, errors } = await open({ data: "populated", role: "owner" }, "/warehouse/game", viewport);
  await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Kiểm kê" }).click({ force: true });
  await page.waitForSelector("[data-bmq-count-lobby]", { timeout: 5000 });
  await page.waitForTimeout(700);
  assert.equal(await page.locator("[data-bmq-count-card]").count(), 2, "two warehouse cards");
  assert.ok((await page.locator('[data-bmq-count-card="q7"]').textContent()).includes("Material Master"), "Q7 card explains the link requirement");
  assert.equal(await overflow(page), 0, `count lobby no overflow ${viewport.width}`);
  await page.screenshot({ path: `${EVIDENCE}/count-lobby-${viewport.width}.png` });
  await page.locator('[data-bmq-count-enter="tan_tao"]').click({ force: true });
  await page.waitForSelector('[data-bmq-count-sheet="tan_tao"]', { timeout: 5000 });
  await page.waitForTimeout(700);
  assert.equal(await page.locator("[data-bmq-count-row]").count(), 6, "six lines on the Tân Tạo sheet");
  assert.equal(await page.locator('[data-bmq-count-state="diff"]').count(), 2, "two lines differ from the book");
  assert.ok((await page.locator(".kg .title-pill small").textContent()).includes("đã đếm 3/6"), "HUD shows progress");
  assert.equal(await overflow(page), 0, `count sheet no overflow ${viewport.width}`);
  await page.screenshot({ path: `${EVIDENCE}/count-sheet-${viewport.width}.png` });
  const row = page.locator("[data-bmq-count-row]", { hasText: "Men Tươi 5 Sao" });
  const input = row.locator("[data-bmq-count-input]");
  const ib = await input.boundingBox();
  assert.ok(ib && ib.width >= 90 && ib.x + ib.width <= viewport.width, `count input usable ${viewport.width}: ${JSON.stringify(ib)}`);
  await input.fill("880");
  await input.press("Enter");
  await page.waitForTimeout(500);
  let writes = await page.evaluate(() => window.__qaWrites);
  assert.ok(writes.some((w) => w.startsWith("rpc:save_stock_count_line:") && w.includes('"p_counted_qty":880') && w.includes('"p_session_id":"75589837-110f-59cc-afd5-67f0eddfc03e"')), `count saved on Enter: ${JSON.stringify(writes.slice(-3))}`);
  await page.locator('[data-bmq-count-filter="diff"]').click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("[data-bmq-count-row]").count(), 2, "Lệch filter shows the two differing lines");
  await page.locator('[data-bmq-count-filter="todo"]').click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("[data-bmq-count-row]").count(), 3, "Chưa đếm filter shows the uncounted lines");
  await page.locator("[data-bmq-count-review-open]").click({ force: true });
  await page.waitForSelector("[data-bmq-count-review]", { timeout: 5000 });
  await page.waitForTimeout(600);
  assert.equal(await page.locator(".kg .cnt-diffs li").count(), 2, "review lists the two differences");
  assert.equal(await overflow(page), 0, `count review no overflow ${viewport.width}`);
  await page.screenshot({ path: `${EVIDENCE}/count-review-${viewport.width}.png` });
  await page.locator("[data-bmq-count-submit]").click({ force: true });
  await page.waitForSelector("[data-bmq-count-done]", { timeout: 5000 });
  await page.waitForTimeout(700);
  writes = await page.evaluate(() => window.__qaWrites);
  assert.ok(writes.some((w) => w.startsWith("rpc:submit_stock_count:") && w.includes('"p_session_id":"75589837-110f-59cc-afd5-67f0eddfc03e"')), "submit sent with the session id");
  await page.screenshot({ path: `${EVIDENCE}/count-done-${viewport.width}.png` });
  await page.locator("[data-bmq-count-done] .btn").click({ force: true });
  await page.waitForSelector("[data-bmq-count-lobby]", { timeout: 5000 });
  assert.deepEqual(errors, [], "no page errors");
  record(`stock count ${viewport.width}`);
  await context.close();
}
// Empty warehouse: the lobby offers to open the first sheet.
{
  const viewport = { width: 390, height: 844 };
  const { context, page, errors } = await open({ data: "empty", role: "owner" }, "/warehouse/game", viewport);
  await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Kiểm kê" }).click({ force: true });
  await page.waitForSelector('[data-bmq-count-start="tan_tao"]', { timeout: 5000 });
  await page.screenshot({ path: `${EVIDENCE}/count-lobby-empty-390.png` });
  await page.locator('[data-bmq-count-start="tan_tao"]').click({ force: true });
  await page.waitForTimeout(700);
  const writes = await page.evaluate(() => window.__qaWrites);
  assert.ok(writes.some((w) => w.startsWith("rpc:start_stock_count:") && w.includes('"p_location":"tan_tao"')), "start sent for Tân Tạo");
  assert.deepEqual(errors, [], "no page errors");
  record("stock count empty 390");
  await context.close();
}
// Manual Tân Tạo -> Q7 transfer slip (owner 12/10): build, validate, submit; ledger-not-started gate.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const { context, page, errors } = await open({ data: "populated", role: "owner", started: true }, "/warehouse/game", viewport);
  await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /KHO TÂN TẠO/i }).click({ force: true });
  await page.waitForTimeout(900);
  await page.locator("[data-bmq-transfer-van]").click({ force: true });
  await page.waitForTimeout(600);
  assert.equal(await page.locator("[data-bmq-transfer-list] li").count(), (KG_FIXTURE.transfers ?? []).length, "history lists get_stock_transfers rows");
  await page.locator("[data-bmq-transfer-new]").click({ force: true });
  await page.waitForTimeout(400);
  assert.equal(await page.locator("[data-bmq-slip-submit]").isDisabled(), true, "empty slip cannot be sent");
  await page.locator("[data-bmq-slip-search]").fill("băng keo nhỏ");
  await page.locator('[data-bmq-slip-pick="Băng keo nhỏ"]').click({ force: true });
  await page.locator("[data-bmq-slip-search]").fill("bao kiếng");
  await page.locator('[data-bmq-slip-pick="Bao kiếng chà bông"]').click({ force: true });
  await page.waitForTimeout(300);
  assert.equal(await page.locator("[data-bmq-slip-line]").count(), 2, "two lines on the slip");
  const qty = page.locator(".kg .slip-qty input");
  await qty.nth(0).fill("999");
  await qty.nth(1).fill("100");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".kg .slip-problem").count(), 1, "over on-hand line is flagged");
  assert.equal(await page.locator("[data-bmq-slip-submit]").isDisabled(), true, "over on-hand slip cannot be sent");
  await qty.nth(0).fill("2,5");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".kg .slip-problem").count(), 0);
  assert.equal(await overflow(page), 0, `slip no overflow ${viewport.width}`);
  await page.screenshot({ path: `${EVIDENCE}/transfer-slip-${viewport.width}.png` });
  await page.locator("[data-bmq-slip-submit]").click({ force: true });
  await page.waitForTimeout(700);
  const writes = await page.evaluate(() => window.__qaWrites);
  const sent = writes.find((w) => w.startsWith("rpc:create_manual_stock_transfer:"));
  assert.ok(sent && sent.includes('"quantity":2.5') && sent.includes('"quantity":100') && sent.includes('"p_request_id"'), `slip sent: ${sent}`);
  assert.match(await page.locator(".kg .toast").textContent(), /CKP-20261012-QA0001/);
  assert.equal(await page.locator("[data-bmq-transfer-list]").count(), 1, "back to the history after sending");
  await page.screenshot({ path: `${EVIDENCE}/transfer-sent-${viewport.width}.png` });
  assert.deepEqual(errors, [], "no page errors");
  record(`manual transfer ${viewport.width}`);
  await context.close();
}
{
  const viewport = { width: 390, height: 844 };
  const { context, page, errors } = await open({ data: "populated", role: "owner", started: false }, "/warehouse/game", viewport);
  await page.waitForSelector("[data-bmq-warehouse-game]", { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /KHO TÂN TẠO/i }).click({ force: true });
  await page.waitForTimeout(900);
  await page.locator("[data-bmq-transfer-van]").click({ force: true });
  await page.waitForTimeout(500);
  await page.locator("[data-bmq-transfer-new]").click({ force: true });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".kg .slip .warn", { hasText: "chưa bắt đầu" }).count(), 1, "ledger-not-started warning");
  assert.equal(await page.locator("[data-bmq-slip-submit]").isDisabled(), true);
  await page.screenshot({ path: `${EVIDENCE}/transfer-not-started-390.png` });
  assert.deepEqual(errors, []);
  record("manual transfer gate 390");
  await context.close();
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 430, height: 932 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const { context, page, errors } = await open({ data: "populated", role: "owner", slow: 6000 }, "/warehouse/game", viewport, { reducedMotion: "no-preference" });
  await page.waitForSelector("[data-bmq-game-loading]", { timeout: 5000 });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `${EVIDENCE}/loading-${viewport.width}.png` });
  const art = await page.locator(".kg-loading-art").boundingBox();
  assert.ok(art && art.width >= 240 && art.x >= 0 && art.x + art.width <= viewport.width, `loading art fits ${viewport.width}: ${JSON.stringify(art)}`);
  assert.equal(await overflow(page), 0, `loading no overflow ${viewport.width}`);
  const text1 = await page.locator(".kg-loading-text span").textContent();
  await page.waitForTimeout(1600);
  assert.notEqual(await page.locator(".kg-loading-text span").textContent(), text1, "loading line rotates");
  await page.waitForSelector("[data-bmq-game-loading]", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(600);
  const clipped = await page.$eval(".kg .title-pill b", (el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(clipped, false, `title not cut at ${viewport.width}`);
  assert.deepEqual(errors, []);
  record(`loading ${viewport.width}`);
  await context.close();
}
await browser.close();
await server.close();
console.log(`ALL ${results.length} WAREHOUSE GAME QA CHECKS PASSED — evidence in ${EVIDENCE}`);
