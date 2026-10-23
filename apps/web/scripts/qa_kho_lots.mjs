// Browser QA for the temporary Rà soát nhập kho tab (owner 22/10/2026), built on the qa_kho_app harness.
// Original header: (owner 22/10/2026): Danh mục kho (/warehouse/danh-muc),
// Tên mới trên phiếu (?view=moi), Kiểm kê (/warehouse/kiem-ke) and Phiếu kho (/warehouse/phieu), inside the app shell.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures;
// every RPC call is recorded and nothing leaves the machine. This proves the real page components render,
// size and call the right RPCs with the right arguments; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_kho_app.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-kho-lots-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5263);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaCalls = window.__qaCalls || [];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
function khoItems() {
  const F = window.__kgFixture;
  const off = JSON.parse(localStorage.getItem("qa-off") || "[]");
  return F.items.map((it, i) => ({
    id: it.id, item_code: it.code, name: it.name, unit: i % 3 === 0 ? "g" : it.unit, active: !off.includes(it.id) && i % 17 !== 5,
    item_class: it.item_class, in_q7: Boolean(it.pastry_q7),
    qty: { tan_tao: it.pastry_q7 ? null : (i * 1371) % 50000, q7: it.pastry_q7 ? (i * 977) % 200000 - (i % 4 === 0 ? 3000 : 0) : null },
    last_count_date: { tan_tao: i % 7 === 0 ? today : i % 3 === 0 ? "2026-10-16" : null, q7: it.pastry_q7 && i % 5 === 0 ? today : null },
    pending_count: { tan_tao: i % 11 === 1 ? 21600 : null, q7: it.pastry_q7 && i % 6 === 1 ? 160000 : null },
    doc_lines: (i * 7) % 40,
  })).concat([{ id: "it-nho", item_code: "NVL-031", name: "Nho khô Mỹ", unit: "g", active: false, item_class: "raw_material", in_q7: false, in_tan_tao: true,
    qty: { tan_tao: 0, q7: null }, last_count_date: { tan_tao: null, q7: null }, pending_count: { tan_tao: null, q7: null }, doc_lines: 4 },
    { id: "it-tem", item_code: "CCDC-038", name: "Tem pháp QA", unit: "con", active: true, item_class: "packaging_supply", in_q7: true, in_tan_tao: false,
    qty: { tan_tao: null, q7: 1085 }, last_count_date: { tan_tao: null, q7: null }, pending_count: { tan_tao: null, q7: null }, doc_lines: 0 },
    { id: "other", item_code: "NVL-999", name: "Kem Rich's", unit: "g", active: true, item_class: "raw_material", in_q7: true, in_tan_tao: false,
    qty: { tan_tao: null, q7: 0 }, last_count_date: { tan_tao: null, q7: null }, pending_count: { tan_tao: null, q7: null }, doc_lines: 3 }]);
}
function settle(st) {
  const mode = cfg().data || "populated";
  const role = cfg().role || "owner";
  window.__qaCalls.push(st.table + ":" + JSON.stringify(st.args));
  if (mode === "error" && st.table === "rpc:kho_get_items") return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
  if (st.table === "rpc:kho_get_items") {
    const items = mode === "empty" ? [] : khoItems();
    return { data: { can_edit: role === "owner", can_count: { tan_tao: role === "owner", q7: role === "owner" }, items }, error: null };
  }
  if (st.table === "rpc:kho_save_item") {
    const a = st.args;
    const names = khoItems().filter((it) => it.id !== a.p_item_id);
    const twin = names.find((it) => it.name.toLowerCase() === String(a.p_name).trim().toLowerCase());
    if (twin && !a.p_merge) return { data: { status: "name_taken", other: { id: twin.id, name: twin.name, unit: twin.unit, active: twin.active } }, error: null };
    if (twin && a.p_merge) {
      if (twin.unit !== "g" && !a.p_unit_factor && twin.unit !== khoItems().find((it) => it.id === a.p_item_id).unit) return { data: { status: "unit_factor_needed", from: khoItems().find((it) => it.id === a.p_item_id).unit, to: twin.unit }, error: null };
      return { data: { status: "merged", into: { id: twin.id, name: twin.name, unit: twin.unit } }, error: null };
    }
    const me = khoItems().find((it) => it.id === a.p_item_id);
    if (a.p_unit !== me.unit && !a.p_unit_factor && !(me.unit === "g" && a.p_unit === "g")) return { data: { status: "unit_factor_needed", from: me.unit, to: a.p_unit }, error: null };
    if (a.p_active === false) { const off = JSON.parse(localStorage.getItem("qa-off") || "[]"); off.push(a.p_item_id); localStorage.setItem("qa-off", JSON.stringify(off)); }
    return { data: { status: "saved", item: { id: a.p_item_id, name: a.p_name, unit: a.p_unit, active: a.p_active } }, error: null };
  }
  if (st.table === "rpc:kho_review_list") {
    if (mode === "error") return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
    if (mode === "empty") return { data: { items: [], materials: [] }, error: null };
    const cand = (n, name, unit, qty, price, loc, score, extra) => Object.assign({ receipt_item_id: "gri-" + n, receipt_number: "GRN-QA-" + (1000 + n), receipt_date: "2026-10-" + String(10 + (n % 10)).padStart(2, "0"), location: loc, supplier_name: n % 2 ? "Kamereo" : "Nhất Hương Thực Phẩm Sài Gòn (rất dài tên nhà cung cấp)", product_name: name, unit, actual_quantity: qty, unit_price: price, image_url: n % 3 === 0 ? null : "goods-receipts/qa-" + n + ".jpg", score, linked_item_id: null, posted: false, jev_verdict: n === 1 ? "same_item" : n === 2 ? "different" : null, jev_probability: n === 1 ? 0.93 : n === 2 ? 0.05 : null, jev_model: n <= 2 ? "typesafe-ai/jev" : null }, extra || {});
    const items = [
      { target_key: "i:it-kem:q7", item_id: "it-kem", item_code: "Q7-KEM", name: "Kem làm mềm bánh", unit: "g", item_class: "raw_material", location: "q7", qty: -13021.8, reason: "no_docs_negative", candidates: [cand(1, "Kem rich làm mềm bánh", "kg", 5, 95000, "q7", 1), cand(2, "Kem Rich's Whipping Topping 907g / hộp (thùng 12 hộp) giao kèm hóa đơn đỏ", "hộp", 12, 89000, "q7", 0.5, { linked_item_id: "other" })] },
      { target_key: "i:it-nuoc:q7", item_id: "it-nuoc", item_code: "Q7-NUOC", name: "Nước Vihawa 20L Bình Vòi", unit: "g", item_class: "raw_material", location: "q7", qty: -47274.04, reason: "no_docs_negative", candidates: [cand(3, "Nước Vihawa 20L Bình Vòi", "Bình", 6, 61000, "tan_tao", 1)] },
      { target_key: "i:it-gang:q7", item_id: "it-gang", item_code: "CCDC-GANG", name: "Bao tay đen size M", unit: "cái", item_class: "packaging_supply", location: "q7", qty: 800, reason: "no_docs", candidates: [cand(9, "Bao tay y tế đen size M", "kg", 7, 90000, "q7", 1, { image_url: "goods-receipts/qa-9.jpg", raw_name: "BAO TAY Y TE DEN SIZE M (HOP 100 CAI)" })] },
      { target_key: "i:it-tem:q7", item_id: "it-tem", item_code: "CCDC-038", name: "Tem pháp QA", unit: "con", item_class: "packaging_supply", location: "q7", qty: 1085, reason: "no_docs", hidden_different: 1, candidates: [] },
      { target_key: "i:it-muoi:tan_tao", item_id: "it-muoi", item_code: "NVL-155", name: "Muối", unit: "g", item_class: "raw_material", location: "tan_tao", qty: 24900, reason: "no_docs", candidates: [cand(4, "Muối sấy khô 500G bao 25kg", "kg", 200, 6500, "tan_tao", 0.5)] },
    ];
    const materials = [
      { target_key: "m:mat-honey:g", canonical_material_id: "mat-honey", name: "Mật Ong Tam Đảo Eufood", recipe_unit: "g", sku_codes: ["KF-XUCXICH-PHOMAI-40G-T0526"], candidates: [cand(5, "MẬT ONG TAM ĐẢO 860G/EUF T=15C", "CHAI", 3, 99000, "q7", 1)] },
      { target_key: "m:mat-nho:g", canonical_material_id: "mat-nho", name: "Nho khô vàng 10kg/thùng", recipe_unit: "g", sku_codes: ["rbn-2026-v5"], candidates: [cand(6, "Men Kho Meizan - Nhãn Vàng (0.5*10kg/Thùng)", "Thùng", 10, 92593, "q7", 0.5, { linked_item_id: "it-men", posted: true })] },
      { target_key: "m:mat-gas:kg", canonical_material_id: "mat-gas", name: "Gas", recipe_unit: "kg", sku_codes: ["TP-PATE"], candidates: [] },
    ];
    return { data: { items, materials }, error: null };
  }
  if (st.table === "rpc:kho_review_fix_line_unit") return { data: { status: "fixed", fix_id: "fix-1", receipt_item_id: st.args.p_receipt_item_id, old_unit: "kg", new_unit: "hộp", request_id: st.args.p_request_id, replayed: false }, error: null };
  if (st.table === "rpc:kho_review_undo_unit_fix") return { data: { status: "undone", fix_id: st.args.p_fix_id, receipt_item_id: "gri-9", unit: "kg" }, error: null };
  if (st.table === "rpc:kho_review_factor_hint") return { data: { factor: null, source: null }, error: null };
  if (st.table === "rpc:food_cert_list") return { data: (cfg().data === "empty") ? [] : [
    { id: "c1", owner_kind: "manufacturer", owner_id: "m1", owner_name: "Cty TNHH Interflour Vietnam", cert_type: "attp_facility", cert_no: "123/2025/ATTP-CNĐK", issuer: "Sở Y tế TP.HCM", issued_on: "2025-01-10", expires_on: "2026-11-05", days_left: 13, file_path: "certs/c1/gcn.pdf", file_name: "GCN-ATTP-Interflour.pdf", mime_type: "application/pdf", note: null, created_by: null, created_at: "2026-10-23T08:00:00Z", archived_at: null, archived_by: null },
    { id: "c2", owner_kind: "manufacturer", owner_id: "m2", owner_name: "Cty Sữa TH True Milk", cert_type: "coa", cert_no: "KN-2026-0912", issuer: "Quatest 3", issued_on: "2026-01-01", expires_on: "2026-10-01", days_left: -22, file_path: "certs/c2/coa.jpg", file_name: "COA-Bo-TH.jpg", mime_type: "image/jpeg", note: null, created_by: null, created_at: "2026-10-22T08:00:00Z", archived_at: null, archived_by: null },
    { id: "c3", owner_kind: "company", owner_id: null, owner_name: "Công ty", cert_type: "product_declaration", cert_no: null, issuer: null, issued_on: null, expires_on: null, days_left: null, file_path: "certs/c3/cb.pdf", file_name: "Cong-bo-Banh-mi-pho-mai.pdf", mime_type: "application/pdf", note: null, created_by: null, created_at: "2026-10-21T08:00:00Z", archived_at: null, archived_by: null },
  ], error: null };
  if (st.table === "rpc:kho_trace_candidates") return { data: (cfg().data === "empty") ? [] : [
    { production_order_item_id: "poi-1", production_number: "SX-20261023-001", production_date: "2026-10-23", sku_id: "s1", sku_code: "cpm-2026-v3", product_name: "BÁNH CUA PHÔ MAI", qty: 200, unit: "cái", location_code: "q7", has_issue: true },
    { production_order_item_id: "poi-2", production_number: "SX-20261022-001", production_date: "2026-10-22", sku_id: "s2", sku_code: "Croi-2026-v4", product_name: "BÁNH CROISSANT 50G có tên rất dài để thử xuống dòng trên điện thoại nhỏ", qty: 120, unit: "cái", location_code: "q7", has_issue: false },
  ], error: null };
  if (st.table === "rpc:kho_trace_report") {
    const lot = (o) => ({ receipt_number: "GRN-000590", received_date: "2026-10-15", quantity: 13, unit: "gói", manufacture_date: null, expiry_date: null, manufacturer_lot: null, lot_code: "GRN-000590-003", lot_code_internal: true, manufacturer_id: null, manufacturer_name: null, supplier_name: "Đại Tân Việt", ...o });
    return { data: {
      production_order_item_id: "poi-1", product_name: "BÁNH CUA PHÔ MAI", sku_code: "cpm-2026-v3", production_number: "SX-20261023-001", production_date: "2026-10-23", qty: 200, unit: "cái", shelf_life_days: 3, expiry_date: "2026-10-26", missing: [],
      materials: [
        { item_id: "k1", item_code: "NVL-001", name: "Bột mì 999 Cam", section: "raw", required_qty: 14342, unit: "g", lots: [lot({ receipt_number: "GRN-000604", quantity: 250, unit: "kg", manufacture_date: "2026-09-08", expiry_date: "2026-12-08", manufacturer_lot: "M829092026", lot_code: "M829092026", lot_code_internal: false, manufacturer_name: "Cty TNHH Interflour Vietnam" })], missing: [] },
        { item_id: "k2", item_code: "NVL-060", name: "Phô mai 84 lát trắng Dairymont (1kg/khối 12 khối/thùng)", section: "raw", required_qty: 3660, unit: "g", lots: [lot({})], missing: ["manufacturer", "nsx", "hsd"] },
        { item_id: "k3", item_code: "NVL-090", name: "sữa tươi 1L", section: "raw", required_qty: 1758, unit: "g", lots: [], missing: ["lot", "receipt", "nsx", "hsd", "manufacturer"] },
        { item_id: "k4", item_code: "CCDC-010", name: "Túi OPP", section: "packaging", required_qty: 200, unit: "cái", lots: [lot({ quantity: 10, unit: "kg", manufacturer_name: "Cty TNHH Minh Sang" })], missing: [] },
      ],
      certificates: [{ id: "c1", cert_type: "attp_facility", cert_no: "123/2025", issuer: "Sở Y tế", expires_on: "2026-11-05", file_path: "certs/a.pdf", file_name: "GCN-ATTP-Interflour.pdf", mime_type: "application/pdf" }],
      company_certificates: [],
      semi_finished: [
        { name: "Lô bánh ủ", production_date: "2026-10-23", qty: 200, remaining: null, lot_code: "CPM23102026 Ủ" },
        { name: "Vỏ bánh", production_date: "2026-10-23", qty: 200, remaining: null, lot_code: "CPM23102026" },
      ],
    }, error: null };
  }
  if (st.table === "rpc:food_manufacturer_list") return { data: [{ id: "m1", name: "Cty TNHH Interflour Vietnam" }, { id: "m2", name: "Cty Sữa TH True Milk" }], error: null };
  if (st.table === "rpc:food_manufacturer_upsert") return { data: { id: "m9", name: st.args.p_name }, error: null };
  if (st.table === "rpc:food_cert_upsert") return { data: { id: "c9", owner_kind: st.args.p_owner_kind, owner_id: st.args.p_owner_id, cert_type: st.args.p_cert_type, file_path: st.args.p_file_path }, error: null };
  if (st.table === "rpc:food_cert_archive") return { data: { id: st.args.p_id }, error: null };
  if (st.table === "rpc:kho_expiry_overview") { const it = khoItems().find((x) => x.active && !x.in_q7); return { data: it ? [
    { batch_id: "b1", item_id: it.id, sku_id: null, name: it.name, kho: "tan_tao", receipt_number: "GRN-QA-0601", received_date: "2026-10-01", quantity: 25, unit: "kg", manufacture_date: "2026-04-01", expiry_date: "2026-10-30", days_left: 7, manufacturer_lot: "M829092026", manufacturer_name: "Cty TNHH Interflour Vietnam" },
    { batch_id: "b2", item_id: it.id, sku_id: null, name: it.name, kho: "tan_tao", receipt_number: "GRN-QA-0544", received_date: "2026-08-01", quantity: 10, unit: "kg", manufacture_date: "2026-02-01", expiry_date: "2026-10-20", days_left: -3, manufacturer_lot: null, manufacturer_name: null },
  ] : [], error: null }; }
  if (st.table === "rpc:kho_review_search_lines") return { data: String(st.args.p_query).toLowerCase().includes("tem") ? [{ target_key: st.args.p_target_key, receipt_item_id: "gri-s1", receipt_number: "GRN-QA-0343", receipt_date: "2026-06-23", location: "tan_tao", supplier_name: "Hoàng Tuấn", product_name: "IN TEM 17K", raw_name: null, unit: "con", actual_quantity: 10000, unit_price: 136, image_url: "goods-receipts/qa-s1.jpg", score: 1, linked_item_id: null, posted: false, jev_verdict: null, jev_probability: null, jev_model: null }] : [], error: null };
  if (st.table === "rpc:kho_review_dismiss") return { data: { status: "dismissed", id: "dm-1", target_key: st.args.p_target_key, reason: st.args.p_reason, replayed: false }, error: null };
  if (st.table === "rpc:kho_review_undismiss") return { data: { status: "removed" }, error: null };
  if (st.table === "rpc:kho_review_link_line") return st.args.p_receipt_item_id === "gri-3" ? { data: { status: "evidence", posted: false, location: "tan_tao", evidence_id: "ev-1" }, error: null } : { data: { status: "linked", alias_id: "al-1", posted: true, location: "q7" }, error: null };
  if (st.table === "rpc:kho_review_create_item_from_line") return { data: { status: "created", item_id: "new-1", alias_id: "al-2", posted: false, location: "q7" }, error: null };
  if (st.table === "rpc:cogs_decide_ingredient") return { data: { ok: true }, error: null };
  if (st.table === "rpc:kho_count_item") {
    const me = khoItems().find((it) => it.id === st.args.p_item_id);
    const book = me.qty[st.args.p_location] ?? 0;
    return { data: { status: "counted", location: st.args.p_location, item_id: st.args.p_item_id, counted_qty: st.args.p_counted_qty, result: { status: "recorded", difference_qty: st.args.p_counted_qty - book } }, error: null };
  }
  if (st.table === "rpc:get_tan_tao_warehouse_snapshot") {
    return { data: { can_manage: role === "owner", items: [
      { sku_code: "BMQ-001", product_name: "Bánh mì tươi", unit: "que", on_hand_quantity: 38 },
      { sku_code: "BMQ-002", product_name: "Bánh mì đông lạnh", unit: "que", on_hand_quantity: 194 },
      { sku_code: "PATE-500G", product_name: "Pate 500g", unit: "hộp", on_hand_quantity: 23 },
      { sku_code: "PATE-200G", product_name: "Pate 200g", unit: "hộp", on_hand_quantity: 22 },
    ] }, error: null };
  }
  if (st.table === "rpc:set_item_pastry_q7") return { data: { item_id: st.args.p_item_id, pastry_q7: st.args.p_value }, error: null };
  if (st.table === "rpc:set_item_kho_locations") return { data: { item_id: st.args.p_item_id, in_tan_tao: st.args.p_tan_tao, in_q7: st.args.p_q7 }, error: null };
  if (st.table === "rpc:set_stock_item_class") return { data: { item_id: st.args.p_item_id, old_class: null, item_class: st.args.p_class }, error: null };
  if (st.table === "rpc:get_item_receipt_lines" || st.table === "rpc:get_crate_receipt_lines") return { data: window.__kgFixture.receipt_lines ?? [], error: null };
  if (st.table === "rpc:get_warehouse_game_snapshot") {
    const F = window.__kgFixture;
    const loc = st.args.p_location;
    const items = F.items.filter((it) => loc !== "q7" || it.pastry_q7);
    const q7Skus = [{ id: "fg-cbc", sku_code: "cbc-2026-v2", product_name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", on_hand: 12 }];
    return { data: { location: loc, cutover_date: "2026-10-16", items, skus: loc === "tan_tao" ? F.skus : q7Skus, pending: mode === "empty" ? [] : (loc === "q7" ? F.q7 : F.tt), transfers: F.transfers ?? [], counts: {}, can_edit: role === "owner" }, error: null };
  }
  if (st.table === "rpc:kho_get_units") return { data: ["g","ml"].map((c) => ({ code: c, label: c, kind: c === "g" ? "weight" : "volume", base_code: c, to_base: 1 })).concat(["bao","bịch","cái","cây","chai","cuộn","gói","hộp","thùng","tờ"].concat(JSON.parse(localStorage.getItem("qa-units") || "[]")).map((c) => ({ code: c, label: c, kind: "count", base_code: c, to_base: 1 }))), error: null };
  if (st.table === "rpc:kho_add_stock_unit") { const u = String(st.args.p_label).trim().toLowerCase(); const list = JSON.parse(localStorage.getItem("qa-units") || "[]"); list.push(u); localStorage.setItem("qa-units", JSON.stringify(list)); return { data: { status: "created", unit: u }, error: null }; }
  if (st.table === "rpc:kho_get_item_conversions") {
    const me = khoItems().find((it) => it.id === st.args.p_item_id);
    return { data: { item: { id: me.id, name: me.name, unit: me.unit, in_q7: me.in_q7 }, can_edit: role === "owner", cutover: { tan_tao: "2026-10-16", q7: "2026-10-16" },
      conversions: [
        { unit: "cây", factors: [1, 6], disagree: true, auto: false, alias_count: 3, supplier_names: ["Ngọc Trân- Cô Trang"], line_count: 4, posted_count: 1, last_receipt_date: "2026-09-20" },
        { unit: "thùng", factors: [24], disagree: false, auto: false, alias_count: 1, supplier_names: ["Mỹ Toàn"], line_count: 2, posted_count: 0, last_receipt_date: "2026-10-12" },
      ], saved: [] }, error: null };
  }
  if (st.table === "rpc:kho_set_item_conversion") {
    const f = Number(st.args.p_factor);
    const line = { receipt_number: "GRN-000543", receipt_date: "2026-09-20", location: "tan_tao", posted_qty: 10, new_qty: 10 * f, delta: 10 * f - 10 };
    if (st.args.p_dry_run) return { data: { status: "preview", aliases: 3, lines: [line], total_delta: { tan_tao: line.delta, q7: 0 } }, error: null };
    return { data: { status: "saved", aliases_updated: 3, lines: 1, total_delta: { tan_tao: line.delta, q7: 0 } }, error: null };
  }
  if (st.table === "rpc:kho_get_commitments") {
    const F = window.__kgFixture;
    const q7Item = F.items.find((it, i) => it.pastry_q7 && i % 17 !== 5 && ["raw_material", "unclassified"].includes(it.item_class));
    const ttItem = F.items.find((it, i) => !it.pastry_q7 && i % 3 !== 0 && i % 17 !== 5 && ["raw_material", "unclassified"].includes(it.item_class));
    const src = (ref, date, qty) => ({ kind: "pxk", ref, date, qty });
    return { data: { as_of: today,
      items: mode === "empty" ? [] : [
        { kitchen_inventory_item_id: q7Item.id, location: "q7", committed_qty: 1250, unit: q7Item.unit, next_date: today.replace(/\d\d$/, (d) => String(Math.min(28, Number(d) + 1)).padStart(2, "0")), sources: [src("PXK-NVL-Q7-QA-001", today, 1000), src("PXK-NVL-Q7-QA-002", today, 250)] },
        { kitchen_inventory_item_id: ttItem.id, location: "tan_tao", committed_qty: 3, unit: ttItem.unit, next_date: today, sources: [src("PXK-NVL-Q7-QA-003", today, 3)] },
      ],
      skus: mode === "empty" ? [] : [
        { location: "tan_tao", sku_id: "s-bmq2", sku_code: "BMQ-002", name: "Bánh mì que đông lạnh", unit: "que", on_hand: 194, incoming_qty: 0, committed_qty: 120, overdue_qty: 0, available: 74, orders: 3, next_date: today },
        { location: "q7", sku_id: "fg-cbc", sku_code: "cbc-2026-v2", name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", on_hand: 12, incoming_qty: 170, committed_qty: 170, overdue_qty: 0, available: 12, orders: 1, next_date: today },
      ],
      gaps: mode === "empty" ? { pxk_lines_unposted: 0, pxk_unposted_issues: [] } : { pxk_lines_unposted: 7, pxk_unposted_issues: ["PXK-NVL-Q7-QA-009", "PXK-NVL-Q7-QA-010"] } }, error: null };
  }
  if (st.table === "rpc:get_stock_transfers") return { data: (window.__kgFixture.transfers ?? []).map((t, i) => ({ ...t, source: i % 2 ? "manual" : "auto", slip_id: null, slip_number: i % 2 ? "PCK-QA-" + i : null, note: i === 1 ? "hàng cho ca sáng Q7" : null })), error: null };
  if (st.table === "rpc:get_q7_finished_goods_planned") return { data: [{ sku_id: "fg-cbc", product_name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", planned_qty: 40, already_received: 12, production_order_item_id: "poi-qa-1" }], error: null };
  if (/^rpc:/.test(st.table)) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args: args || {} };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      // data "loading": the catalog/count lists never arrive, so the loading state stays on screen.
      if (prop === "then" && cfg().data === "loading" && st.table === "rpc:kho_get_items") return () => new Promise(() => {});
      if (prop === "then") return (ok, ko) => Promise.resolve().then(() => settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return () => proxy;
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
  functions: { invoke: async (name, opts) => { window.__qaCalls.push("fn:" + name + ":" + JSON.stringify(opts && opts.body)); if (name === "kho-review-jev") return { data: { asked: 3, cached: 0, skipped: 0, marks: [] }, error: null }; if (name === "kho-review-read-line") { await new Promise((r) => setTimeout(r, 250)); const id = opts && opts.body && opts.body.receipt_item_id; if (id === "gri-9") return { data: { ok: true, found: true, doc_unit: "hộp", doc_quantity: 7, doc_unit_price: 90000, pack_count: 100, pack_unit: "cái", evidence_text: "Bao tay y tế đen size M 7 hộp", unit_mismatch: true, ocr_engine: "indra", ocr_fallback_reason: null, cached: false }, error: null }; if (id === "gri-3") return { data: null, error: { message: "ocr_failed" } }; return { data: { ok: true, found: false, doc_unit: null, doc_quantity: null, doc_unit_price: null, pack_count: null, pack_unit: null, evidence_text: null, unit_mismatch: false, ocr_engine: "indra", ocr_fallback_reason: null, cached: false }, error: null }; } return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
  storage: { from: () => ({ upload: async (p) => { window.__qaCalls.push("upload:" + p); return { data: { path: p }, error: null }; }, getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#fff"/><text x="40" y="80" font-size="40">PHIẾU GIAO HÀNG</text></svg>') }, error: null }), list: async () => ({ data: [], error: null }) }) },
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
const cfg = JSON.parse(localStorage.getItem("qa-shell") || "{}");
const role = cfg.role || "owner";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const value = {
  user, session: { access_token: "qa", user }, profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: role === "owner" ? ["owner"] : ["staff"], authzLoaded: true, authzError: false,
  isOwner: role === "owner", canAccessModule: () => true, canEditModule: () => role === "owner",
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-kho-app-fixtures",
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
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-kho-lots-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const KG_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_warehouse_game.fixture.json"), "utf8"));
const results = [];
const pass = (name) => { results.push(name); console.log("PASS", name); };

async function open(cfg, route, viewport, ready = "[data-bmq-kho-catalog], [data-bmq-kho-count-page], [data-bmq-warehouse-slips]") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((fixture) => { window.__kgFixture = fixture; }, KG_FIXTURE);
  await context.addInitScript((value) => { if (!sessionStorage.getItem("qa-init")) { localStorage.clear(); sessionStorage.setItem("qa-init", "1"); } localStorage.setItem("qa-shell", JSON.stringify(value)); }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page, errors };
}
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll(".d3-kho *, [role='dialog'] *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).position === "fixed") continue;
      if (el.closest(".d3-kho-tabs, .d3-kho-notes-row, .d3-kho-viewer-stage, .d3-kho-viewer-photos")) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(`${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    return { doc: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
  });
  assert.ok(o.doc <= 0 && o.bad.length === 0, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function shot(page, file, full = true) {
  if (full) await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${EVIDENCE}/${file}`, fullPage: full });
}
async function dialogInView(page, selector, vp) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.waitForTimeout(450);
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.y >= -1 && box.x >= -1 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `${selector} outside the viewport at ${vp.width}: ${JSON.stringify(box)}`);
}
async function confirmOk(page) {
  await page.waitForSelector("[data-bmq-kho-confirm]", { timeout: 4000 });
  await page.locator("[data-bmq-kho-confirm-ok]").click();
  await page.waitForSelector("[data-bmq-kho-confirm]", { state: "detached", timeout: 3000 });
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u;
async function themeFacts(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector(".d3-screen h1");
    return {
      h1: h1?.textContent?.trim() ?? null,
      h1Font: h1 ? getComputedStyle(h1).fontFamily : "",
      gameFont: Boolean(document.getElementById("kg-fonts")),
      gameNodes: document.querySelectorAll(".kg, .k2, [data-bmq-warehouse-game], canvas").length,
      text: document.querySelector(".d3-screen")?.innerText ?? "",
    };
  });
}
async function assertTheme(page, title, vp) {
  const f = await themeFacts(page);
  assert.equal(f.h1, title, `h1 ${vp.width}`);
  assert.match(f.h1Font, /Be Vietnam Pro/, "app font on the title");
  assert.equal(f.gameFont, false, "no game font loaded");
  assert.equal(f.gameNodes, 0, "no game markup");
  assert.ok(!EMOJI.test(f.text), `no emoji on ${title}: ${(f.text.match(EMOJI) || [])[0]}`);
  assert.ok(!/Game kho|Sushi|⭐/.test(f.text), `no game words on ${title}`);
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];

const READY = "[data-bmq-kho-certs]";
try {
  for (const vp of VIEWPORTS) {
    const { context, page, errors } = await open({ role: "owner" }, "/warehouse/ho-so-attp", vp, READY);
    await page.waitForSelector("[data-bmq-cert-list] li");
    assert.equal(await page.locator("[data-bmq-cert-list] li").count(), 3, "three certificates");
    assert.equal(await page.locator("[data-bmq-cert-exp='soon']").count(), 1, "one expiring soon");
    assert.equal(await page.locator("[data-bmq-cert-exp='expired']").count(), 1, "one expired");
    await noSpill(page, "certs-list", vp);
    await shot(page, `certs-list-${vp.width}.png`);
    await page.locator("[data-bmq-cert-view='expired']").click();
    assert.equal(await page.locator("[data-bmq-cert-list] li").count(), 1, "expired filter");
    await page.locator("[data-bmq-cert-view='all']").click();
    await page.locator("[data-bmq-cert-search]").fill("th true");
    assert.equal(await page.locator("[data-bmq-cert-list] li").count(), 1, "search by owner");
    await page.locator("[data-bmq-cert-search]").fill("");
    pass(`Hồ sơ ATTP list, filters, search ${vp.width}`);
    await page.locator("[data-bmq-trace-open]").click();
    await page.waitForSelector("[data-bmq-trace-list] li");
    await dialogInView(page, "[data-bmq-trace]", vp);
    assert.equal(await page.locator("[data-bmq-trace-list] li").count(), 2, "two production orders to trace");
    await noSpill(page, "trace-list", vp);
    await shot(page, `trace-list-${vp.width}.png`, false);
    await page.locator("[data-bmq-trace-pick='poi-1']").click();
    await page.waitForSelector("[data-bmq-trace-report]");
    assert.match(await page.locator("[data-bmq-trace-report]").innerText(), /26\/10\/2026/, "HSD = NSX + shelf life");
    assert.equal(await page.locator("[data-bmq-trace-missing]").count(), 2, "two rows name their gaps");
    assert.equal(await page.locator("[data-bmq-trace-gaps]").getAttribute("data-bmq-trace-gaps"), "2", "gap count");
    await page.locator("[data-bmq-trace-semi='1'] [data-bmq-trace-semi-left]").fill("4");
    await noSpill(page, "trace-report", vp);
    await shot(page, `trace-report-${vp.width}.png`, false);
    const [xlsx] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator("[data-bmq-trace-xlsx]").click()]);
    assert.match(xlsx.suggestedFilename(), /^Truy-xuat-cpm-2026-v3-20261023\.xlsx$/, "excel file name");
    const [zip] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.locator("[data-bmq-trace-zip]").click()]);
    assert.match(zip.suggestedFilename(), /\.zip$/, "zip bundle");
    if (vp.width === 1440) { await xlsx.saveAs(`${EVIDENCE}/trace.xlsx`); await zip.saveAs(`${EVIDENCE}/trace.zip`); }
    await page.locator("[data-bmq-trace-back]").click();
    await page.waitForSelector("[data-bmq-trace-list]");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-trace]", { state: "detached" });
    pass(`Truy xuất pick → report → Excel + zip ${vp.width}`);
    await page.locator("[data-bmq-cert-add]").click();
    await dialogInView(page, "[data-bmq-cert-form]", vp);
    await page.locator("[data-bmq-cert-type='coa']").click();
    await page.locator("[data-bmq-cert-owner]").fill("Cty CP Đường Quảng Ngãi");
    await page.locator("[data-bmq-cert-no]").fill("KN-01");
    await page.locator("[data-bmq-cert-issued]").fill("2026-03-03");
    await page.locator("[data-bmq-cert-expires]").fill("2027-03-02");
    await page.locator("[data-bmq-cert-file]").setInputFiles({ name: "coa-duong.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 qa") });
    await noSpill(page, "certs-form", vp);
    await shot(page, `certs-form-${vp.width}.png`, false);
    await page.locator("[data-bmq-cert-save]").click();
    await page.waitForSelector("[data-bmq-cert-form]", { state: "detached", timeout: 5000 });
    const cs = await calls(page);
    assert.ok(cs.some((c) => c.startsWith("rpc:food_manufacturer_upsert:") && c.includes("Quảng Ngãi")), "new manufacturer created");
    assert.ok(cs.some((c) => c.startsWith("upload:certs/") && c.endsWith("/coa-duong.pdf")), "file uploaded under certs/");
    assert.ok(cs.some((c) => c.startsWith("rpc:food_cert_upsert:") && c.includes('"p_cert_type":"coa"') && c.includes('"p_owner_id":"m9"') && c.includes('"p_expires_on":"2027-03-02"')), "certificate saved");
    pass(`add a COA for a new manufacturer ${vp.width}`);
    assert.deepEqual(errors, [], `page errors ${vp.width}`);
    await context.close();

    const cat = await open({ role: "owner" }, "/warehouse/danh-muc", vp, "[data-bmq-kho-catalog]");
    await cat.page.waitForSelector("[data-bmq-kho-expiry]");
    assert.match(await cat.page.locator("[data-bmq-kho-expiry]").innerText(), /2 lô hết hạn trong 30 ngày, 1 đã quá hạn/, "expiry banner");
    await cat.page.locator("[data-bmq-kho-expiry-toggle]").click();
    assert.equal(await cat.page.locator("[data-bmq-kho-expiry-list] li").count(), 2, "expiry lots listed");
    await noSpill(cat.page, "catalog-expiry", vp);
    await shot(cat.page, `catalog-expiry-${vp.width}.png`);
    pass(`Danh mục kho expiry banner ${vp.width}`);
    assert.deepEqual(cat.errors, [], `catalog page errors ${vp.width}`);
    await cat.context.close();
  }
  const empty = await open({ role: "owner", data: "empty" }, "/warehouse/ho-so-attp", VIEWPORTS[1], READY);
  await empty.page.waitForSelector("[data-bmq-cert-empty]");
  await shot(empty.page, "certs-empty-390.png", false);
  await empty.context.close();
  pass("empty state");
  console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
