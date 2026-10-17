// Browser QA for Missions in Kho 2D (/warehouse/game): HUD notebook, board, mission tools, submit + ceremony, done and error states.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-missions-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5247);
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
  if (st.table === "rpc:get_unit_variant_receipt_lines") {
    window.__qaWrites.push("read:" + st.table + ":" + st.args.p_unit);
    if (/pack/.test(st.args.p_unit)) return { data: [
      { goods_receipt_id: "gr-u1", goods_receipt_item_id: "gri-u1-" + st.args.p_unit, receipt_number: "GRN-000610", receipt_date: "2026-10-02", status: "confirmed", supplier_name: "Mega Market", raw_name: "Phô mai lát trắng Dairymont 1kg", quantity: 2, unit: st.args.p_unit, unit_price: 152000, line_total: 304000, image_path: "goods-receipts/delivery-note-610.jpg", photo_paths: null },
    ], error: null };
    return { data: [], error: null };
  }
  if (st.table === "rpc:get_alias_receipt_lines") {
    window.__qaWrites.push("read:" + st.table);
    if (cfg().notesError) return { data: null, error: { message: "QA fixture: notes down" } };
    return { data: [
      { goods_receipt_id: "gr-459", goods_receipt_item_id: "gri-459-" + st.args.p_alias_id, receipt_number: "GRN-000459", receipt_date: "2026-08-05", status: "confirmed", supplier_name: "Suatuoi.com", raw_name: "Mekovita I-Love-Milk Full Cream 1L - Combo 3 thùng", quantity: 1, unit: "Combo", unit_price: 1036800, line_total: 1036800, image_path: "goods-receipts/delivery-note-459.jpg", photo_paths: null },
      { goods_receipt_id: "gr-405", goods_receipt_item_id: "gri-405-" + st.args.p_alias_id, receipt_number: "GRN-000405", receipt_date: "2026-07-15", status: "confirmed", supplier_name: "Suatuoi.com", raw_name: "Mekovita I-Love-Milk Full Cream 1L - Combo 3 thùng", quantity: 1, unit: "Combo", unit_price: 1036800, line_total: 1036800, image_path: null, photo_paths: null },
    ], error: null };
  }
  // Quy đổi tồn 16/10 (owner 17/10): three questions — answered, suggested item, no suggestion.
  if (st.table === "rpc:get_stock_count_unit_questions") {
    const base = { batch: "2026-10-16", suggested_factor: null, item_id: null, factor: null, counted_qty: null, record_result: null, note: null, answered_by: null, answered_at: null, chosen_item: null, item_units: [] };
    const tape = { id: "it-tape", code: "NVL-083", name: "Băng keo lớn", unit: "cuộn" };
    return { data: [
      { ...base, id: "cq-1", location: "q7", sort_order: 1, file_label: "Tem pháp", file_qty: 79, file_unit: "tờ", suggested_item_id: "it-tem", suggested_item: { id: "it-tem", code: "CCDC-038", name: "Tem pháp", unit: "con" }, status: "answered", item_id: "it-tem", factor: 12, counted_qty: 948, chosen_item: { id: "it-tem", code: "CCDC-038", name: "Tem pháp", unit: "con" } },
      { ...base, id: "cq-6", location: "tan_tao", sort_order: 6, file_label: "Muối", file_qty: 24.9, file_unit: "kg", suggested_item_id: null, suggested_item: null, status: "open" },
      { ...base, id: "cq-7", location: "tan_tao", sort_order: 7, file_label: "Băng keo lớn", file_qty: 8, file_unit: "cây", suggested_item_id: tape.id, suggested_factor: 6, suggested_item: tape, status: "open" },
    ], error: null };
  }
  if (st.table === "rpc:get_item_receipt_lines" && st.args.p_item_id === "it-tape") {
    const line = (n, d, qty, unit) => ({ goods_receipt_id: "gr-" + n, goods_receipt_item_id: "gri-" + n, receipt_number: n, receipt_date: d, status: "confirmed", supplier_name: "Ngọc Trân", raw_name: "Băng keo 100 yard", quantity: qty, unit, unit_price: 135000, line_total: qty * 135000, image_path: null, photo_paths: [] });
    return { data: [line("GRN-000590", "2026-10-10", 30, "cuộn"), line("GRN-000581", "2026-10-08", 5, "cây")], error: null };
  }
  if (st.table === "rpc:answer_stock_count_unit_question") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { batch: "2026-10-16", id: st.args.p_question_id, location: "tan_tao", sort_order: 7, file_label: "x", file_qty: 8, file_unit: "cây", suggested_item_id: null, suggested_factor: null, status: st.args.p_skip ? "skipped" : "answered", item_id: st.args.p_item_id, factor: st.args.p_factor, counted_qty: st.args.p_factor ? 8 * st.args.p_factor : null, record_result: null, note: null, answered_by: null, answered_at: null, suggested_item: null, chosen_item: { id: "it-tape", code: "NVL-083", name: "Băng keo lớn", unit: "cuộn" }, item_units: [], replay: false }, error: null };
  }
  // Giao nhiệm vụ (owner 17/10): staff list + assignment copies kept in page memory.
  if (/^rpc:(get_mission_staff|get_mission_assignments)$/.test(st.table)) {
    window.__qaReads = (window.__qaReads || []).concat(st.table);
    if (st.table === "rpc:get_mission_staff") return { data: [
      { user_id: "u-mai", name: "Xuan Mai", email: "mai@bmq.test", badges: 0, level: { level: 1, title: "Nhân viên mới", min_badges: 0 }, open_missions: 0 },
      { user_id: "u-ha", name: "Thu Hà", email: "ha@bmq.test", badges: 4, level: { level: 2, title: "Nhân viên kho", min_badges: 3 }, open_missions: 1 },
      { user_id: "u-lan", name: "Ngọc Lan", email: "lan@bmq.test", badges: 0, level: null, open_missions: 0 },
    ], error: null };
    return { data: (window.__qaCopies || []).filter((c) => c.status !== "cancelled"), error: null };
  }
  if (st.table === "rpc:assign_mission") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    if (st.args.p_user_id === "u-lan") return { data: null, error: { message: "assignee_not_allowed", code: "22023" } };
    const names = { "u-mai": "Xuan Mai", "u-ha": "Thu Hà" };
    const copies = window.__qaCopies || (window.__qaCopies = []);
    let copy = copies.find((c) => c.parent_mission_id === st.args.p_mission_id && c.assignee_user_id === st.args.p_user_id);
    const created = !copy;
    if (!copy) { copy = { mission_id: "copy-" + copies.length, parent_mission_id: st.args.p_mission_id, assignee_user_id: st.args.p_user_id, assignee_name: names[st.args.p_user_id], status: "open", completed_at: null, progress: { done: false, total: 2, left: 1, detail: [] } }; copies.push(copy); }
    else copy.status = "open";
    return { data: { mission_id: copy.mission_id, parent_mission_id: copy.parent_mission_id, assignee_user_id: copy.assignee_user_id, assignee_name: copy.assignee_name, status: "open", created, reopened: !created }, error: null };
  }
  if (st.table === "rpc:unassign_mission") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    const copy = (window.__qaCopies || []).find((c) => c.mission_id === st.args.p_mission_id);
    if (copy) copy.status = "cancelled";
    return { data: { mission_id: st.args.p_mission_id, status: "cancelled" }, error: null };
  }
  // Khớp công thức Q7 (owner 17/10): one counted-but-short line, one unit-mismatch remap, one excluded.
  if (st.table === "rpc:get_q7_bom_mismatch_review") {
    const mat = (id, code, name) => ({ id, code, name, default_unit: "g" });
    const base = { planned_by_issue_date: [{ issue_date: "2026-10-17", planned_qty: 1 }, { issue_date: "2026-10-18", planned_qty: 1 }], latest_issue_date: "2026-10-18", item_class: "raw_material", resolved: false, excluded: false, decision: null };
    return { data: [
      { ...base, canonical_material_id: "m-cbc", canonical_material: mat("m-cbc", "NVL-CBC", "Chà bông cay"), source_unit: "g", current_mapping: { q7_mapping_id: "q-1", kitchen_inventory_item_id: "it-cbc", item_code: "Q7-CBC", name: "Chà bông cay", unit: "g", conversion_factor: 1 }, planned_qty_total: 5375, current_balance: 5000, projected_balance: -375, has_count_since_cutover: true, open: true, candidates: [{ kitchen_inventory_item_id: "it-cbc", item_code: "Q7-CBC", name: "Chà bông cay", unit: "g", counted_balance: 5000, similarity: 1 }] },
      { ...base, canonical_material_id: "m-dau", canonical_material: mat("m-dau", "NVL-DAU", "Dầu hướng dương"), source_unit: "g", current_mapping: { q7_mapping_id: "q-2", kitchen_inventory_item_id: "it-dhd", item_code: "Q7-DHD", name: "Dầu hướng dương", unit: "g", conversion_factor: 1 }, planned_qty_total: 5212, current_balance: -8166.21, projected_balance: -13378.21, has_count_since_cutover: false, open: true, candidates: [{ kitchen_inventory_item_id: "it-ta", item_code: "NVL-105", name: "Dầu ăn Tường An 5L x 4 chai (thùng)", unit: "thùng", counted_balance: 1, similarity: 0.4 }] },
      { ...base, canonical_material_id: "m-da", canonical_material: mat("m-da", "NVL-DA", "NƯỚC ĐÁ"), source_unit: "g", current_mapping: { q7_mapping_id: "q-3", kitchen_inventory_item_id: "it-da", item_code: "Q7-DA", name: "NƯỚC ĐÁ", unit: "g", conversion_factor: 1 }, planned_qty_total: 3600, current_balance: -5310, projected_balance: -8910, has_count_since_cutover: false, open: false, excluded: true, decision: { id: "d-1", action: "not_tracked", new_kitchen_item_id: null, conversion_factor: null, note: null, created_at: "2026-10-17T05:00:00Z" }, candidates: [] },
    ], error: null };
  }
  if (st.table === "rpc:resolve_q7_bom_line") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { status: "resolved", replay: false, decision_id: "d-new", action: st.args.p_action, canonical_material_id: st.args.p_canonical_material_id, source_unit: st.args.p_source_unit, old_kitchen_item_id: null, new_kitchen_item_id: st.args.p_target_item_id, conversion_factor: st.args.p_factor, note: null, created_at: "2026-10-17T06:00:00Z" }, error: null };
  }
  if (st.table === "rpc:post_pending_q7_material_issues") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { status: "ok", dry_run: false, cutover_date: "2026-10-16", issues: [], posted: 1, already_posted: 0, regenerated: 1, skipped_open_mismatch: 0 }, error: null };
  }

  // Công thức pate Tân Tạo (owner 17/10, part D).
  if (st.table === "rpc:get_tan_tao_recipe") {
    const complete = Boolean(cfg().pateComplete);
    const ing = (id, label, item, name, grams, status) => ({ id, line_kind: "ingredient", sort_order: id.length, label, kitchen_inventory_item_id: item, item_code: item ? "NVL-" + id : null, item_name: name, item_unit: "g", sku_code: null, grams_per_batch: grams, pate_grams_per_pack: null, pack_item_id: null, pack_item_code: null, pack_item_name: null, pack_item_unit: null, label_item_id: null, label_item_code: null, label_item_name: null, label_item_unit: null, status, answered_by: null, answered_at: null });
    const pack = (id, label, sku, grams, status) => ({ ...ing(id, label, null, null, null, status), line_kind: "pack", sku_code: sku, pate_grams_per_pack: grams, pack_item_id: "hop-" + id, pack_item_name: "Hộp " + label, pack_item_unit: "cái", label_item_id: "tem-" + id, label_item_name: "Tem " + label, label_item_unit: "cái" });
    const lines = complete
      ? [ing("l1", "Chả lụa", "it-cl", "Chả lụa lá TVP XL (kg)", 3000, "answered"), ing("l2", "Tiêu", "it-tieu", "Tiêu sọ xay", 50, "answered"), ing("l3", "Muối", null, null, null, "not_used"), pack("p5", "Hộp pate 500g", "PATE-500G", 500, "answered"), pack("p2", "Hộp pate 200g", "PATE-200G", 200, "answered")]
      : [ing("l1", "Chả lụa", "it-cl", "Chả lụa lá TVP XL (kg)", null, "open"), ing("l2", "Tiêu", "it-tieu", "Tiêu sọ xay", 50, "answered"), ing("l3", "Muối", null, null, null, "open"), pack("p5", "Hộp pate 500g", "PATE-500G", 500, "open")];
    return { data: { id: "rc-1", code: "pate-heo", name: "Pate heo Tân Tạo", batch_output_kg: complete ? 10 : null, status: complete ? "complete" : "draft", updated_by: null, updated_at: null, lines, can_answer: true }, error: null };
  }
  if (/^rpc:(answer_tan_tao_recipe_line|set_tan_tao_recipe_batch|record_tan_tao_pate_production)$/.test(st.table)) {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    if (st.table === "rpc:record_tan_tao_pate_production") return { data: { status: "recorded", slip_id: "slip-1", recipe_code: "pate-heo", production_date: st.args.p_date, batches: st.args.p_batches, packs: st.args.p_packs, ingredients: [], packaging: [], documents: [], movement_count: 6, replay: false }, error: null };
    return { data: { id: "rc-1", code: "pate-heo", name: "Pate heo Tân Tạo", batch_output_kg: 10, status: "draft", updated_by: null, updated_at: null, lines: [], can_answer: true }, error: null };
  }
  if (st.table === "rpc:record_mission_sku_count") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    return { data: { mission_id: st.args.p_mission_id, sku_code: "BMQ-001", counted_qty: st.args.p_counted_qty, result: { status: "created" } }, error: null };
  }
  // Thẻ nhiệm vụ tự giao (owner 17/10): batches, staff and the staff member's own cards live in page memory.
  if (/^rpc:(get_my_manual_missions|get_manual_missions_overview|get_manual_mission_staff|create_manual_mission|submit_manual_mission|review_manual_mission|cancel_manual_mission|add_manual_mission_assignee)$/.test(st.table)) {
    const M = window.__msFixture.manual_state;
    if (st.table === "rpc:get_my_manual_missions") return { data: M.my, error: null };
    if (st.table === "rpc:get_manual_missions_overview") return { data: M.batches, error: null };
    if (st.table === "rpc:get_manual_mission_staff") return { data: M.staff, error: null };
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    const a = st.args;
    if (st.table === "rpc:create_manual_mission") return { data: { batch_id: "b-new", missions: a.p_assignee_ids.map((id, i) => ({ mission_id: "m-new-" + i, assignee_user_id: id, assignee_name: (M.staff.find((x) => x.user_id === id) || {}).name || "?" })) }, error: null };
    if (st.table === "rpc:submit_manual_mission") {
      const row = M.my.find((r) => r.mission_id === a.p_mission_id);
      const sub = { id: "s-new", mission_id: a.p_mission_id, submitted_by: "qa-user", note: a.p_note, number_value: a.p_number, photo_paths: a.p_photo_paths, checklist: a.p_checklist, review_status: "pending", review_note: null, rating: null, created_at: new Date().toISOString() };
      if (row) { row.review_state = "pending"; row.last_submission = sub; row.submissions_count += 1; }
      return { data: sub, error: null };
    }
    if (st.table === "rpc:review_manual_mission") {
      for (const b of M.batches) for (const x of b.assignees) if (x.last_submission && x.last_submission.id === a.p_submission_id) {
        x.review_state = a.p_approve ? "approved" : "returned"; x.last_submission.review_status = x.review_state; x.last_submission.review_note = a.p_note; x.last_submission.rating = a.p_rating;
        if (a.p_approve) { x.status = "completed"; x.completed_at = new Date().toISOString(); }
      }
      return { data: { submission_id: a.p_submission_id, mission_id: "m", review_status: a.p_approve ? "approved" : "returned", rating: a.p_rating, badge_awarded: Boolean(a.p_approve), level_before: null, level_after: null }, error: null };
    }
    if (st.table === "rpc:cancel_manual_mission") { for (const b of M.batches) for (const x of b.assignees) if (x.mission_id === a.p_mission_id) x.status = "cancelled"; return { data: { mission_id: a.p_mission_id, status: "cancelled" }, error: null }; }
    return { data: { mission_id: "m-added", status: "open" }, error: null };
  }
  if (st.table === "rpc:get_my_missions") {
    if (cfg().missionsError) return { data: null, error: { message: "QA fixture: missions down" } };
    return { data: window.__msFixture[cfg().missions || "three_open_partial"], error: null };
  }
  if (/^rpc:(complete_mission|update_stock_material_alias_factor|mark_stock_items_distinct|resolve_unknown_purchase_unit|apply_stock_item_merge)$/.test(st.table)) {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args));
    if (st.table === "rpc:complete_mission") return { data: { mission_id: st.args.p_mission_id, badge: { code: "cham_chi", name: "Chăm chỉ", icon: "🐝" }, badges_total: 3, level_before: { level: 1, title: "Nhân viên mới", min_badges: 0 }, level_after: { level: 2, title: "Nhân viên kho", min_badges: 3 }, leveled_up: true }, error: null };
    if (st.table === "rpc:update_stock_material_alias_factor") return { data: { alias_id: st.args.p_alias_id, old_factor: 1000, new_factor: st.args.p_factor }, error: null };
    if (st.table === "rpc:mark_stock_items_distinct") return { data: { item_a: st.args.p_item_a, item_b: st.args.p_item_b }, error: null };
    if (st.table === "rpc:resolve_unknown_purchase_unit") return { data: { variant: st.args.p_variant, action: st.args.p_action, code: st.args.p_code ?? null }, error: null };
    return { data: {}, error: null };
  }
  if (st.table === "rpc:get_warehouse_game_snapshot") {
    const F = window.__kgFixture;
    const loc = st.args.p_location;
    const role = cfg().role || "owner";
    if (mode === "error") return { data: null, error: { message: "QA fixture: network error" } };
    const started = cfg().started ? "2026-10-05" : null;
    const items = F.items.map((it, i) => ({ ...it, on_hand: started ? (i * 137) % 5000 : 0 }));
    return { data: { location: loc, cutover_date: started, items, skus: loc === "tan_tao" ? F.skus : [], pending: role === "owner" ? (loc === "q7" ? F.q7 : F.tt) : [], counts: {}, can_edit: role === "owner" }, error: null };
  }
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
  functions: { invoke: async (name) => { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
  storage: { from: (bucket) => ({ upload: async (path) => { window.__qaWrites.push("upload:" + bucket + ":" + path); return { data: { path }, error: null }; }, getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async (path) => ({ data: { signedUrl: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#fff"/><text x="40" y="80" font-size="40" font-family="sans-serif">PHIẾU GIAO HÀNG</text><text x="40" y="140" font-size="22" font-family="sans-serif">' + String(path).slice(-28) + '</text></svg>') }, error: null }), list: async () => ({ data: [], error: null }), download: async () => ({ data: null, error: null }) }) },
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-missions-qa/vite-cache",
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

const MS_RAW = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_missions.fixture.json"), "utf8"));
const ready = structuredClone(MS_RAW.three_open_partial);
ready.missions[0].progress = { ...ready.missions[0].progress, done: true, left: 0, detail: ready.missions[0].progress.detail.map((row) => ({ ...row, fixed: true })) };
const countFixture = structuredClone(MS_RAW.three_open_partial);
countFixture.missions = [{ ...countFixture.missions[0], id: "0f0b3d2a-0009-4c11-8a10-000000000009", code: "wh-count-units-20261016", title: "Quy đổi tồn 16/10", description: "Trả lời 12 dòng tồn kho chưa rõ đơn vị trong file 16/10", sort_order: 6, progress: { done: false, total: 12, left: 11, detail: [{ kind: "count_questions", batch: "2026-10-16", total: 12, open: 11, answered: 1, skipped: 0 }] } }];
const bomFixture = structuredClone(MS_RAW.three_open_partial);
bomFixture.missions = [{ ...bomFixture.missions[0], id: "0f0b3d2a-0010-4c11-8a10-000000000010", code: "wh-q7-bom-match-20261017", title: "Khớp công thức Q7 với kho", description: "Trỏ từng nguyên liệu công thức vào đúng món kho đã kiểm kê để trừ NVL từ 17/10", sort_order: 7, progress: { done: false, total: 3, left: 2, detail: [{ kind: "bom_mismatch", open: 2, resolved: 0, excluded: 1, total: 3 }] } }];
const recipeFixture = structuredClone(MS_RAW.three_open_partial);
recipeFixture.missions = [{ ...recipeFixture.missions[0], id: "0f0b3d2a-0011-4c11-8a10-000000000011", code: "wh-tan-tao-pate-recipe", title: "Công thức pate Tân Tạo", description: "Nhập gram từng nguyên liệu cho 1 mẻ pate và hộp/tem cho mỗi hộp 500g, 200g", sort_order: 8, progress: { done: false, total: 5, left: 4, detail: [{ kind: "recipe", code: "pate-heo", open: 3, answered: 1, not_used: 0, batch_set: false }] } }];
const skuMission = (detail) => ({ ...recipeFixture.missions[0], id: "0f0b3d2a-0012-4c11-8a10-000000000012", code: "wh-count-bmq001-20261017", title: "Đếm bánh mì que Tân Tạo", description: "Đếm thực tế BMQ-001 tại kho Tân Tạo và ghi số đếm", sort_order: 9, progress: { done: Boolean(detail.counted_at), total: 1, left: detail.counted_at ? 0 : 1, detail: [{ kind: "sku_count", sku_code: "BMQ-001", since: "2026-10-17", ...detail }] } });
const skuFixture = structuredClone(MS_RAW.three_open_partial);
skuFixture.missions = [skuMission({ counted_at: null, counted_qty: null })];
const skuDoneFixture = structuredClone(MS_RAW.three_open_partial);
skuDoneFixture.missions = [skuMission({ counted_at: "2026-10-17T10:31:18+00:00", counted_qty: 60 })];
// Thẻ tự giao: one card for the staff member, and two handed-out batches on the owner's side.
const MM_EVIDENCE = { photo: "required", note: "optional", number: { label: "Số thùng đếm được", unit: "thùng" }, checklist: ["Dán nhãn ngày", "Xếp lên kệ số 3"] };
const mmSub = (id, extra = {}) => ({ id, note: "Đã đếm và xếp gọn", number_value: 12, photo_paths: ["m-mai/a.jpg", "m-mai/b.jpg"], checklist: [true, true], review_status: "pending", review_note: null, rating: null, created_at: "2026-10-17T09:30:00Z", ...extra });
const DUE_SOON = new Date(Date.now() + 5 * 3600_000).toISOString();
const MANUAL_STATE = {
  staff: [
    { user_id: "u-mai", name: "Xuan Mai", email: "mai@bmq.test", level: { level: 1, title: "Nhân viên mới", min_badges: 0 }, open_missions: 1 },
    { user_id: "u-mi", name: "Mi Ái", email: "mi@bmq.test", level: { level: 2, title: "Nhân viên kho", min_badges: 3 }, open_missions: 0 },
    { user_id: "u-ktt", name: "KTT BMQ", email: "ktt@bmq.test", level: null, open_missions: 0 },
  ],
  batches: [
    { batch_id: "b-1", title: "Kiểm kê bơ ở Q7", description: "Đếm hết bơ trong tủ mát Q7, chụp ảnh từng kệ.", due_at: DUE_SOON, priority: "high", location: "q7", evidence: MM_EVIDENCE, created_at: "2026-10-17T08:00:00Z", assignees: [
      { mission_id: "m-mai", user_id: "u-mai", name: "Xuan Mai", status: "open", review_state: "pending", completed_at: null, last_submission: mmSub("s-mai") },
      { mission_id: "m-mi", user_id: "u-mi", name: "Mi Ái", status: "open", review_state: null, completed_at: null, last_submission: null },
    ] },
    { batch_id: "b-2", title: "Dọn kệ bao bì Tân Tạo", description: null, due_at: null, priority: "normal", location: "tan_tao", evidence: { photo: "optional", note: "required", number: null, checklist: [] }, created_at: "2026-10-16T08:00:00Z", assignees: [
      { mission_id: "m-ktt", user_id: "u-ktt", name: "KTT BMQ", status: "open", review_state: "pending", completed_at: null, last_submission: mmSub("s-ktt", { number_value: null, checklist: [], photo_paths: [] }) },
    ] },
  ],
  my: [
    { mission_id: "mm-1", batch_id: "b-9", title: "Chụp ảnh tủ mát Q7", due_at: DUE_SOON, priority: "high", location: "q7", evidence: MM_EVIDENCE, created_by_name: "Tâm Vũ", created_at: "2026-10-17T08:00:00Z", review_state: null, last_submission: null, submissions_count: 0 },
    { mission_id: "mm-2", batch_id: "b-8", title: "Ghi số thùng bánh mì", due_at: null, priority: "normal", location: null, evidence: { photo: "none", note: "required", number: null, checklist: [] }, created_by_name: "Tâm Vũ", created_at: "2026-10-16T08:00:00Z", review_state: "returned", last_submission: { id: "s-old", note: "xong", number_value: null, photo_paths: [], checklist: [], review_status: "returned", review_note: "Ghi rõ số thùng từng loại", rating: null, created_at: "2026-10-16T09:00:00Z" }, submissions_count: 1 },
  ],
};
const manualFixture = structuredClone(MS_RAW.three_open_partial);
manualFixture.missions = [
  { ...manualFixture.missions[0], id: "mm-1", code: "manual-b9b9b9b9b9@0000aaaa", title: "Chụp ảnh tủ mát Q7", description: "Chụp từng ngăn tủ mát, đếm số thùng bơ.", area: "manual", sort_order: 100, progress: { done: false, total: 1, left: 1, detail: [] } },
  { ...manualFixture.missions[0], id: "mm-2", code: "manual-b8b8b8b8b8@0000aaaa", title: "Ghi số thùng bánh mì", description: null, area: "manual", sort_order: 100, progress: { done: false, total: 1, left: 1, detail: [] } },
  ...manualFixture.missions.slice(1),
];
const MS_FIXTURE = { ...MS_RAW, manual_state: MANUAL_STATE, manual: manualFixture, ready, count: countFixture, bom: bomFixture, recipe: recipeFixture, sku: skuFixture, sku_done: skuDoneFixture };
const KG_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_warehouse_game.fixture.json"), "utf8"));
async function open(cfg, route, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: extra.reducedMotion || "reduce", locale: "vi-VN" });
  await context.addInitScript((fixture) => { window.__kgFixture = fixture; }, KG_FIXTURE);
  await context.addInitScript((fixture) => { window.__msFixture = fixture; }, MS_FIXTURE);
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
  await page.waitForSelector(route.startsWith("/warehouse/game") ? "[data-bmq-warehouse-game]" : "[data-bmq-shell='demo3-v1']", { timeout: 30000 });
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


const writes = (page) => page.evaluate(() => window.__qaWrites.slice());
async function board(page) {
  await page.locator("[data-bmq-mission-hud]").click({ force: true });
  await page.waitForSelector("[data-bmq-mission-board]", { timeout: 10000 });
  await page.waitForTimeout(500);
}
async function closeSheet(page) {
  await page.locator(".kg .sheet .close").click({ force: true });
  await page.waitForTimeout(300);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const w = viewport.width;
  // 1. Three open missions: HUD, board, each tool writes through its RPC.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "three_open_partial" }, "/warehouse/game", viewport);
    await page.waitForTimeout(900);
    const hud = page.locator("[data-bmq-mission-hud]");
    assert.equal(await hud.count(), 1, "HUD mission notebook");
    assert.equal((await page.locator("[data-bmq-mission-open]").textContent()).trim(), "3", "3 open missions in the HUD");
    const hb = await hud.boundingBox();
    assert.ok(hb && hb.x + hb.width <= w && hb.width >= 60, `HUD fits ${w}: ${JSON.stringify(hb)}`);
    await page.screenshot({ path: `${EVIDENCE}/yard-hud-${w}.png` });
    await board(page);
    assert.equal(await overflow(page), 0, `board no overflow ${w}`);
    assert.equal((await page.locator("[data-bmq-mission-level]").textContent()).trim(), "Nhân viên mới");
    assert.equal(await page.locator("[data-bmq-mission]").count(), 3, "3 mission notes");
    assert.match(await page.locator(".kg .title-pill").textContent(), /Nhiệm vụ/);
    await page.screenshot({ path: `${EVIDENCE}/board-${w}.png` });
    await page.locator(".kg .mission-view").screenshot({ path: `${EVIDENCE}/board-full-${w}.png` }).catch(() => {});

    // Alias tool
    await page.locator("[data-bmq-mission='wh-fix-alias-factors']").click({ force: true });
    await page.waitForSelector(".kg .sheet", { timeout: 5000 });
    await page.waitForTimeout(700);
    assert.equal(await page.locator("[data-bmq-mission-alias]").count(), 2);
    const submit = page.locator("[data-bmq-mission-submit]");
    assert.equal(await submit.isDisabled(), true, "submit locked until done");
    assert.match(await submit.textContent(), /Còn 1 việc/);
    const open1 = page.locator("[data-bmq-mission-alias]").nth(1);
    // Delivery notes (16/10): only the unfixed alias shows them, above the factor input.
    assert.equal(await page.locator("[data-bmq-mission-alias] [data-bmq-receipt-notes]").count(), 1, "notes only on the open alias");
    assert.equal(await open1.locator("[data-bmq-note]").count(), 2, "two receipt cards");
    assert.match(await open1.locator("[data-bmq-receipt-notes]").textContent(), /2 lần nhập · 1 có ảnh/);
    await open1.locator("[data-bmq-note='GRN-000459'] img").waitFor({ timeout: 5000 });
    assert.equal(await overflow(page), 0, `alias notes no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-alias-notes-${w}.png` });
    await open1.locator("[data-bmq-note='GRN-000459']").click({ force: true });
    await page.waitForSelector(".kg .note-photo", { timeout: 5000 });
    assert.match(await page.locator(".kg .note-line").textContent(), /1 Combo × 1\.036\.800đ/);
    await page.waitForTimeout(900);
    const viewerOnTop = await page.evaluate(() => { const v = document.querySelector(".kg .note-viewer"); if (!v) return false; const r = v.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(el && v.contains(el)); });
    assert.ok(viewerOnTop, `note viewer is on top of the mission sheet ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/alias-note-viewer-${w}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    if (await page.locator(".kg .note-photo").count()) await page.locator(".kg .note-viewer button[aria-label='Đóng']").click({ force: true }).catch(() => {});
    await open1.locator("input").fill("36000");
    await open1.getByRole("button", { name: "Lưu" }).click({ force: true });
    await page.waitForTimeout(400);
    if (process.env.QA_DEBUG) { await page.screenshot({ path: `${EVIDENCE}/debug-alias-${w}.png` }); console.log("BOX", JSON.stringify(await open1.getByRole("button", { name: "Lưu" }).boundingBox()), JSON.stringify(await writes(page))); }
    assert.ok((await writes(page)).some((x) => x.startsWith("rpc:update_stock_material_alias_factor:") && x.includes('"p_factor":36000')), "factor saved via RPC");
    assert.equal(await overflow(page), 0, `alias sheet no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-alias-${w}.png` });
    await closeSheet(page);

    // Duplicate tool
    await page.locator("[data-bmq-mission='wh-croissant-duplicate']").click({ force: true });
    await page.waitForSelector(".kg .sheet", { timeout: 5000 });
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".kg .dup-item").count(), 2);
    assert.equal(await page.locator("[data-bmq-dup='merge']").count(), 1, "same unit → merge offered");
    await page.screenshot({ path: `${EVIDENCE}/sheet-duplicate-${w}.png` });
    await page.locator("[data-bmq-dup='rename']").click({ force: true });
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".kg .sheet .field input").count(), 1, "rename field");
    await page.locator(".kg .sheet .btn.ghost", { hasText: "Quay lại" }).dispatchEvent("click");
    await page.waitForTimeout(200);
    await page.locator("[data-bmq-dup='distinct']").click({ force: true, timeout: 5000 });
    await page.waitForTimeout(400);
    assert.ok((await writes(page)).some((x) => x.startsWith("rpc:mark_stock_items_distinct:")), "keep-both via RPC");
    await closeSheet(page);

    // Units tool
    await page.locator("[data-bmq-mission='wh-unknown-units']").click({ force: true });
    await page.waitForSelector(".kg .sheet", { timeout: 5000 });
    await page.waitForTimeout(700);
    const rows = page.locator("[data-bmq-mission-unit]");
    assert.equal(await rows.count(), 3);
    await rows.nth(0).locator("[data-bmq-picker]").click({ force: true });
    await page.locator("[data-bmq-picker-option='gói']").click();
    await page.waitForSelector("[data-bmq-picker-sheet]", { state: "detached", timeout: 3000 });
    await rows.nth(0).getByRole("button", { name: "Gán" }).click({ force: true });
    await rows.nth(2).getByRole("button", { name: "Không phải hàng kho" }).click({ force: true });
    await page.waitForTimeout(400);
    const all = await writes(page);
    assert.ok(all.some((x) => x.includes("rpc:resolve_unknown_purchase_unit:") && x.includes('"p_action":"map"') && x.includes('"p_code":"gói"')), "map via RPC");
    assert.ok(all.some((x) => x.includes("rpc:resolve_unknown_purchase_unit:") && x.includes('"p_action":"not_stock"')), "not_stock via RPC");
    assert.equal(await overflow(page), 0, `units sheet no overflow ${w}`);
    // Delivery notes per unit (16/10): every row has the strip; a unit with no receipt says so.
    assert.equal(await page.locator("[data-bmq-mission-unit] [data-bmq-receipt-notes]").count(), 3, "notes on every unit row");
    assert.ok((await page.locator("[data-bmq-mission-unit] [data-bmq-note='GRN-000610']").count()) >= 1, "pack unit shows its receipt");
    assert.ok((await page.locator("[data-bmq-mission-unit] [data-bmq-receipt-notes]", { hasText: "Chưa có phiếu nhập nào" }).count()) >= 1, "empty unit says so");
    await page.screenshot({ path: `${EVIDENCE}/sheet-units-${w}.png` });
    await closeSheet(page);
    assert.ok(!all.some((x) => x.startsWith("rpc:complete_mission")), "nothing submitted yet");

    await page.locator(".kg .hud .round-btn").first().click({ force: true });
    await page.waitForTimeout(600);
    assert.equal(await page.locator("[data-bmq-mission-board]").count(), 0, "back to the street");
    assert.deepEqual(errors, [], "no page errors");
    record(`missions tools ${w}`);
    await context.close();
  }
  // 1b. Quy đổi tồn 16/10: question cards write through answer_stock_count_unit_question.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "count" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.match(await page.locator("[data-bmq-mission='wh-count-units-20261016']").textContent(), /1\/12/, "card counts answered of 12");
    await page.locator("[data-bmq-mission='wh-count-units-20261016']").click({ force: true });
    await page.waitForSelector("[data-bmq-count-questions]", { timeout: 5000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-bmq-count-question]").count(), 3, "three question cards");
    assert.match(await page.locator("[data-bmq-count-question='Tem pháp']").textContent(), /Đã ghi 948 con/);
    const tape = page.locator("[data-bmq-count-question='Băng keo lớn']");
    assert.equal(await tape.locator("[data-bmq-count-factor]").inputValue(), "6", "suggested factor prefilled");
    assert.match(await tape.textContent(), /Sẽ ghi tồn 16\/10:\s*48 cuộn/);
    // Owner rule 17/10: every conversion shows the file line + delivery notes, same-unit receipts first.
    assert.equal(await page.locator("[data-bmq-count-question] [data-bmq-receipt-notes]").count(), 3, "evidence on every card");
    assert.equal(await page.locator("[data-bmq-count-question] [data-bmq-note='File tồn 16/10']").count(), 3, "file line pinned on every card");
    const tapeNotes = await tape.locator("[data-bmq-note]").evaluateAll((els) => els.map((el) => el.getAttribute("data-bmq-note")));
    assert.deepEqual(tapeNotes, ["File tồn 16/10", "GRN-000581", "GRN-000590"], `file first, then the 'cây' receipt: ${tapeNotes}`);
    assert.match(await tape.locator("[data-bmq-receipt-notes] .notes-h").textContent(), /2 lần nhập/, "file is not counted as a receipt");
    const salt = page.locator("[data-bmq-count-question='Muối']");
    assert.equal(await salt.locator(".cq-new input").first().inputValue(), "Muối", "no suggestion → new item named after the line");
    assert.equal(await salt.locator("[data-bmq-count-save]").isDisabled(), true, "needs a factor first");
    assert.equal(await overflow(page), 0, `count sheet no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-count-${w}.png` });
    await tape.locator("[data-bmq-count-save]").click({ force: true });
    await salt.locator("[data-bmq-count-factor]").fill("1000");
    await page.waitForTimeout(150);
    assert.match(await salt.textContent(), /24\.?900 g|24900 g/, "kg → g preview");
    await salt.locator("[data-bmq-count-save]").click({ force: true });
    await page.waitForTimeout(400);
    const all = await writes(page);
    assert.ok(all.some((x) => x.startsWith("rpc:answer_stock_count_unit_question:") && x.includes('"p_question_id":"cq-7"') && x.includes('"p_item_id":"it-tape"') && x.includes('"p_factor":6')), "tape answered with item × 6");
    assert.ok(all.some((x) => x.startsWith("rpc:answer_stock_count_unit_question:") && x.includes('"p_question_id":"cq-6"') && x.includes('"p_new_item_name":"Muối"') && x.includes('"p_new_item_unit":"g"') && x.includes('"p_factor":1000')), "salt creates a new item");
    assert.deepEqual(errors, [], "no page errors");
    record(`count questions ${w}`);
    await context.close();
  }
  // 1c. Khớp công thức Q7: keep / remap with a factor / exclude, evidence beside every remap.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "bom" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.match(await page.locator("[data-bmq-mission='wh-q7-bom-match-20261017']").textContent(), /1\/3/, "card counts excluded line as done");
    await page.locator("[data-bmq-mission='wh-q7-bom-match-20261017']").click({ force: true });
    await page.waitForSelector("[data-bmq-bom-lines]", { timeout: 5000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-bmq-bom-line]").count(), 3, "three BOM lines");
    assert.deepEqual(await page.locator("[data-bmq-bom-line]").evaluateAll((els) => els.map((el) => el.getAttribute("data-status"))), ["open", "open", "done"], "open lines first");
    const cbc = page.locator("[data-bmq-bom-line='Chà bông cay']");
    assert.match(await cbc.locator("[data-bmq-bom-save]").textContent(), /Đúng món này/, "counted item keeps its own mapping");
    assert.equal(await cbc.locator("[data-bmq-bom-factor]").count(), 0, "same unit asks no factor");
    const oil = page.locator("[data-bmq-bom-line='Dầu hướng dương']");
    // Owner 18/10: a loose name overlap (0.4) is never pre-picked; the line keeps the item it draws from now.
    assert.equal(await oil.locator("[data-bmq-picker]").getAttribute("data-value"), "it-dhd", "keeps the current item, not the loose match");
    assert.equal(await oil.locator("[data-bmq-bom-hint='uncounted']").count(), 1, "says the kept item was not counted 16/10");
    assert.equal(await oil.locator("[data-bmq-bom-factor]").count(), 0, "same unit, no factor");
    assert.match(await oil.locator("[data-bmq-bom-save]").textContent(), /Đúng món này/);
    assert.equal(await cbc.locator("[data-bmq-bom-hint]").count(), 0, "counted own item needs no hint");
    await oil.locator("[data-bmq-picker]").click({ force: true });
    await page.locator("[data-bmq-picker-option='it-ta']").click();
    await page.waitForSelector("[data-bmq-picker-sheet]", { state: "detached", timeout: 3000 });
    assert.equal(await oil.locator("[data-bmq-bom-factor]").count(), 1, "g → thùng asks a factor");
    assert.equal(await oil.locator("[data-bmq-bom-save]").isDisabled(), true, "needs the factor first");
    assert.equal(await page.locator("[data-bmq-bom-line][data-status='open'] [data-bmq-receipt-notes]").count(), 2, "delivery notes beside every open line");
    assert.equal(await overflow(page), 0, `bom sheet no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-bom-${w}.png` });
    await cbc.locator("[data-bmq-bom-save]").click({ force: true });
    assert.match(await oil.locator(".conv").textContent(), /1 thùng =\s*g/, "asks 1 thùng = ? g");
    await oil.locator("[data-bmq-bom-factor]").fill("18400");
    await oil.locator("[data-bmq-bom-save]").click({ force: true });
    await page.locator("[data-bmq-bom-post]").click({ force: true });
    await page.waitForTimeout(400);
    const all = await writes(page);
    assert.ok(all.some((x) => x.startsWith("rpc:resolve_q7_bom_line:") && x.includes('"p_canonical_material_id":"m-cbc"') && x.includes('"p_action":"remap"') && x.includes('"p_target_item_id":"it-cbc"') && x.includes('"p_factor":1')), "keep = remap to itself ×1");
    const oilWrite = all.find((x) => x.startsWith("rpc:resolve_q7_bom_line:") && x.includes('"p_canonical_material_id":"m-dau"'));
    const oilArgs = oilWrite ? JSON.parse(oilWrite.slice("rpc:resolve_q7_bom_line:".length)) : null;
    assert.ok(oilArgs && oilArgs.p_target_item_id === "it-ta" && Math.abs(oilArgs.p_factor - 1 / 18400) < 1e-12, `oil remapped to Tường An with 1/18400: ${oilWrite}`);
    assert.ok(all.some((x) => x.startsWith("rpc:post_pending_q7_material_issues:")), "post now calls the catch-up");
    assert.deepEqual(errors, [], "no page errors");
    record(`bom match ${w}`);
    await context.close();
  }
  // 1d. Công thức pate Tân Tạo: batch kg, grams per ingredient or "Không dùng", hộp + tem per pack.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "recipe" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.match(await page.locator("[data-bmq-mission='wh-tan-tao-pate-recipe']").textContent(), /1\/5/, "card counts answered of 5");
    await page.locator("[data-bmq-mission='wh-tan-tao-pate-recipe']").click({ force: true });
    await page.waitForSelector("[data-bmq-pate-lines]", { timeout: 5000 });
    await page.waitForTimeout(400);
    assert.equal(await page.locator("[data-bmq-pate-batch]").count(), 1, "batch question first");
    assert.equal(await page.locator("[data-bmq-pate-line]").count(), 4, "one card per seeded line");
    assert.deepEqual(await page.locator("[data-bmq-pate-line]").evaluateAll((els) => els.map((el) => el.getAttribute("data-status"))), ["open", "open", "open", "answered"], "open lines first");
    assert.equal(await overflow(page), 0, `recipe sheet no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-recipe-${w}.png` });
    await page.locator("[data-bmq-pate-batch] input").fill("12,5");
    await page.locator("[data-bmq-pate-batch] .btn").click({ force: true });
    const chaLua = page.locator("[data-bmq-pate-line='Chả lụa']");
    await chaLua.locator("[data-bmq-pate-grams]").fill("3000");
    await chaLua.locator("[data-bmq-pate-save]").click({ force: true });
    await page.locator("[data-bmq-pate-line='Muối'] [data-bmq-pate-not-used]").click({ force: true });
    await page.locator("[data-bmq-pate-line='Hộp pate 500g'] [data-bmq-pate-save]").click({ force: true });
    await page.waitForTimeout(400);
    const all = await writes(page);
    assert.ok(all.some((x) => x.startsWith("rpc:set_tan_tao_recipe_batch:") && x.includes('"p_batch_output_kg":12.5')), "batch saved as 12.5 kg");
    assert.ok(all.some((x) => x.startsWith("rpc:answer_tan_tao_recipe_line:") && x.includes('"p_line_id":"l1"') && x.includes('"p_item_id":"it-cl"') && x.includes('"p_grams":3000')), "ingredient grams saved");
    assert.ok(all.some((x) => x.startsWith("rpc:answer_tan_tao_recipe_line:") && x.includes('"p_line_id":"l3"') && x.includes('"p_not_used":true')), "not used saved");
    assert.ok(all.some((x) => x.startsWith("rpc:answer_tan_tao_recipe_line:") && x.includes('"p_line_id":"p5"') && x.includes('"p_pack_item_id":"hop-p5"') && x.includes('"p_pate_grams":500')), "pack line confirmed");
    assert.deepEqual(errors, [], "no page errors");
    record(`pate recipe ${w}`);
    await context.close();
  }
  // 1e. Đếm bánh mì que: gõ số đếm → record_mission_sku_count; đã đếm → nút nộp sáng.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "sku" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.match(await page.locator("[data-bmq-mission='wh-count-bmq001-20261017']").textContent(), /0\/1/, "count card 0/1");
    await page.locator("[data-bmq-mission='wh-count-bmq001-20261017']").click({ force: true });
    await page.waitForSelector("[data-bmq-sku-count='BMQ-001']", { timeout: 5000 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator("[data-bmq-sku-count-save]").isDisabled(), true, "save disabled before a number");
    assert.equal(await overflow(page), 0, `sku count sheet no overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/sheet-sku-count-${w}.png` });
    await page.locator("[data-bmq-sku-count-qty]").fill("60");
    await page.locator("[data-bmq-sku-count-note]").fill("đếm sáng");
    await page.locator("[data-bmq-sku-count-save]").click({ force: true });
    await page.waitForTimeout(400);
    const all = await writes(page);
    assert.ok(all.some((x) => x.startsWith("rpc:record_mission_sku_count:") && x.includes('"p_mission_id":"0f0b3d2a-0012-4c11-8a10-000000000012"') && x.includes('"p_counted_qty":60') && x.includes('"p_note":"đếm sáng"') && /"p_request_id":"[0-9a-f-]{36}"/.test(x)), `count saved: ${all.join(" | ")}`);
    assert.deepEqual(errors, [], "no page errors");
    await context.close();
    const done = await open({ data: "populated", role: "owner", missions: "sku_done" }, "/warehouse/game", viewport);
    await done.page.waitForTimeout(700);
    await board(done.page);
    await done.page.locator("[data-bmq-mission='wh-count-bmq001-20261017']").click({ force: true });
    await done.page.waitForSelector("[data-bmq-sku-counted]", { timeout: 5000 });
    await done.page.waitForTimeout(600);
    assert.match(await done.page.locator("[data-bmq-sku-counted]").textContent(), /60 BMQ-001/, "shows counted qty");
    assert.equal(await done.page.locator("[data-bmq-mission-submit]").isDisabled(), false, "submit enabled after count");
    assert.equal(await overflow(done.page), 0, `sku counted sheet no overflow ${w}`);
    await done.page.screenshot({ path: `${EVIDENCE}/sheet-sku-counted-${w}.png` });
    assert.deepEqual(done.errors, [], "no page errors (counted)");
    record(`sku count ${w}`);
    await done.context.close();
  }
  // 2. Ready mission: submit → badge ceremony → level-up.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "ready" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".kg .mission-hud.is-ready").count(), 1, "HUD flags a ready mission");
    await board(page);
    assert.equal(await page.locator(".kg .mission-go.is-ready").count(), 1);
    await page.locator("[data-bmq-mission='wh-fix-alias-factors']").click({ force: true });
    const submit = page.locator("[data-bmq-mission-submit]");
    assert.equal(await submit.isDisabled(), false, "submit open when done");
    await page.screenshot({ path: `${EVIDENCE}/sheet-ready-${w}.png` });
    await submit.click({ force: true });
    await page.waitForSelector("[data-bmq-ceremony='badge']", { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}/ceremony-badge-${w}.png` });
    assert.ok((await writes(page)).some((x) => x.startsWith("rpc:complete_mission:")), "complete via RPC");
    await page.getByRole("button", { name: /Tiếp/ }).click({ force: true });
    await page.waitForSelector("[data-bmq-ceremony='level']", { timeout: 5000 });
    assert.match(await page.locator(".kg .ceremony-card h2").textContent(), /Nhân viên kho/);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${EVIDENCE}/ceremony-level-${w}.png` });
    await page.getByRole("button", { name: "Nhận danh hiệu" }).click({ force: true });
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-bmq-ceremony]").count(), 0, "ceremony closes");
    assert.deepEqual(errors, []);
    record(`missions submit + ceremony ${w}`);
    await context.close();
  }
  // 3. Two done, two badges; and the missions RPC down.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "two_done_two_badges" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.equal(await page.locator(".kg .stamp").count(), 2, "2 XONG stamps");
    assert.equal(await page.locator(".kg .rank-bees .bee-badge").count(), 3, "3 slots to Nhân viên kho");
    assert.match(await page.locator(".kg .rank-next").textContent(), /Còn 1 huy hiệu nữa lên Nhân viên kho/);
    await page.screenshot({ path: `${EVIDENCE}/board-done-${w}.png`, fullPage: false });
    await page.locator("[data-bmq-mission='wh-croissant-duplicate']").click({ force: true });
    assert.equal(await page.locator(".kg .done-box").count(), 1, "done mission shows its badge");
    assert.equal(await page.locator("[data-bmq-mission-submit]").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    const bad = await open({ data: "populated", role: "owner", missionsError: true }, "/warehouse/game", viewport);
    await bad.page.waitForTimeout(700);
    await bad.page.locator("[data-bmq-mission-hud]").click({ force: true });
    await bad.page.waitForTimeout(2500);
    assert.ok((await bad.page.locator(".kg .err").count()) >= 1, "missions error shown");
    await bad.page.screenshot({ path: `${EVIDENCE}/board-error-${w}.png` });
    assert.deepEqual(bad.errors, []);
    record(`missions done + error ${w}`);
    await bad.context.close();
  }
}
// Giao nhiệm vụ (owner 17/10): the owner hands an open mission to staff; staff boards have no Giao button.
{
  const OPEN = MS_RAW.three_open_partial.missions.filter((m) => m.status === "open");
  const first = OPEN[0];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const w = viewport.width;
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "three_open_partial" }, "/warehouse/game", viewport);
    // Thu Hà already finished her copy of the first mission.
    await page.evaluate((root) => { window.__qaCopies = [{ mission_id: "copy-ha", parent_mission_id: root, assignee_user_id: "u-ha", assignee_name: "Thu Hà", status: "completed", completed_at: "2026-10-17T02:00:00Z", progress: { done: true, total: 2, left: 0, detail: [] } }]; }, first.id);
    await page.waitForTimeout(700);
    await board(page);
    assert.equal(await page.locator("[data-bmq-mission-assign]").count(), OPEN.length, "every open mission has a Giao button");
    assert.match(await page.locator(`[data-bmq-mission='${first.code}'] [data-bmq-mission-crew]`).textContent(), /✓ Thu Hà/, "card shows who finished");
    const btn = await page.locator(`[data-bmq-mission-assign='${first.code}']`).boundingBox();
    const icon = await page.locator(`[data-bmq-mission='${first.code}'] .mission-title`).boundingBox();
    assert.ok(btn.height >= 36 && btn.y + btn.height <= icon.y + 4, `Giao button clears the title ${w}: ${JSON.stringify([btn, icon])}`);
    assert.equal(await overflow(page), 0, `board no overflow ${w}`);
    await page.locator(`[data-bmq-mission='${first.code}']`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: `${EVIDENCE}/assign-board-${w}.png` });
    await page.locator(`[data-bmq-mission-assign='${first.code}']`).click();
    await page.waitForSelector("[data-bmq-assign-list]", { timeout: 5000 });
    assert.equal(await page.locator("[data-bmq-assign-row]").count(), 3, "three staff rows");
    assert.match(await page.locator("[data-bmq-assign-row='Thu Hà']").textContent(), /Đã nộp/);
    assert.equal(await page.locator(".kg .sheet [data-bmq-mission-submit]").count(), 0, "assign sheet is not the play sheet");
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-assign='u-mai']").click();
    await page.waitForSelector("[data-bmq-unassign='u-mai']", { timeout: 5000 });
    const sent = (await writes(page)).filter((x) => x.startsWith("rpc:assign_mission:"));
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0].slice("rpc:assign_mission:".length)), { p_mission_id: first.id, p_user_id: "u-mai" });
    assert.match(await page.locator(".kg .toast").textContent(), /Đã giao “.+” cho Xuan Mai/);
    assert.match(await page.locator("[data-bmq-assign-row='Xuan Mai']").textContent(), /đang làm việc này/);
    assert.equal(await overflow(page), 0, `assign sheet no overflow ${w}`);
    const small = await page.evaluate(() => [...document.querySelectorAll(".kg .sheet button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 36; }).map((el) => el.outerHTML.slice(0, 60)));
    assert.deepEqual(small, [], `assign sheet tap targets ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/assign-sheet-${w}.png` });
    // Refused staff: error shown, nothing assigned.
    await page.locator("[data-bmq-assign='u-lan']").click();
    await page.waitForSelector("[data-bmq-assign-error]", { timeout: 5000 });
    assert.match(await page.locator("[data-bmq-assign-error]").textContent(), /không thể nhận nhiệm vụ kho/);
    assert.equal(await page.locator("[data-bmq-assign='u-lan']").count(), 1, "refused staff stays unassigned");
    // Withdraw.
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-unassign='u-mai']").click();
    await page.waitForSelector("[data-bmq-assign='u-mai']", { timeout: 5000 });
    assert.ok((await writes(page)).some((x) => x.startsWith("rpc:unassign_mission:") && x.includes('"p_mission_id":"copy-1"')), "withdraw sends the copy id");
    // Give again, close: the card lists Mai.
    await page.locator("[data-bmq-assign='u-mai']").click();
    await page.waitForSelector("[data-bmq-unassign='u-mai']", { timeout: 5000 });
    await closeSheet(page);
    await page.waitForTimeout(400);
    assert.match(await page.locator(`[data-bmq-mission='${first.code}'] [data-bmq-mission-crew]`).textContent(), /👤 Xuan Mai/);
    // The card itself still opens the play sheet.
    await page.locator(`[data-bmq-mission='${first.code}']`).click({ force: true });
    await page.waitForSelector(".kg .sheet [data-bmq-mission-submit]", { timeout: 5000 });
    assert.deepEqual(errors, [], "no page errors");
    record(`assign missions ${w}`);
    await context.close();
  }
  // Staff (not owner): no Giao button and the owner-only RPCs are never called.
  {
    const { context, page, errors } = await open({ data: "populated", role: "limited", name: "Xuan Mai", missions: "three_open_partial" }, "/warehouse/game", { width: 390, height: 844 });
    await page.waitForTimeout(700);
    await board(page);
    assert.equal(await page.locator("[data-bmq-mission-assign]").count(), 0, "staff see no Giao button");
    assert.deepEqual(await page.evaluate(() => window.__qaReads || []), [], "owner-only RPCs not called for staff");
    assert.deepEqual(errors, []);
    record("assign missions hidden for staff 390");
    await context.close();
  }
}
// Thẻ nhiệm vụ tự giao GĐ1 (owner 17/10).
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const mmWrites = async (page, name) => (await writes(page)).filter((x) => x.startsWith(`rpc:${name}:`)).map((x) => JSON.parse(x.slice(`rpc:${name}:`.length)));
const tapTargets = (page, scope) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input:not([type=checkbox]):not([type=file]), ${sel} textarea`)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 34; }).map((el) => el.outerHTML.slice(0, 70)), scope);
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  const w = viewport.width;
  // Owner: write a card, review hand-ins, withdraw one.
  {
    const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "three_open_partial" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    await page.waitForSelector("[data-bmq-mm-board] [data-bmq-mm-batch]", { timeout: 8000 });
    assert.equal(await page.locator("[data-bmq-mm-batch]").count(), 2, "two handed-out batches");
    assert.match(await page.locator("[data-bmq-mm-board] .cork-title").textContent(), /2 chờ duyệt/);
    assert.match(await page.locator("[data-bmq-mm-batch='Kiểm kê bơ ở Q7']").textContent(), /Gấp[\s\S]*Còn 5 giờ[\s\S]*Xuan Mai · 📨 Chờ duyệt[\s\S]*Mi Ái · Đang làm/);
    assert.equal(await overflow(page), 0, `owner board no overflow ${w}`);
    await page.locator("[data-bmq-mm-board]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/mm-board-${w}.png` });
    // Create.
    await page.locator("[data-bmq-manual-create]").click();
    await page.waitForSelector("[data-bmq-mm-create]", { timeout: 5000 });
    assert.equal(await page.locator("[data-bmq-mm-send]").isDisabled(), true, "empty form cannot be sent");
    await page.locator("[data-bmq-mm-title]").fill("Kiểm kê bao bì Tân Tạo");
    await page.locator("[data-bmq-mm-desc]").fill("Đếm thùng giấy và bao ly, ghi số vào thẻ.");
    await page.locator("[data-bmq-mm-person='Xuan Mai']").click();
    await page.locator("[data-bmq-mm-person='Mi Ái']").click();
    await page.locator("[data-bmq-mm-seg='priority:high']").click();
    await page.locator("[data-bmq-mm-seg='place:tan_tao']").click();
    await page.locator("[data-bmq-mm-seg='photo:required']").click();
    await page.locator("[data-bmq-mm-number-on]").check();
    assert.equal(await page.locator("[data-bmq-mm-send]").isDisabled(), true, "number needs a label");
    await page.locator("[data-bmq-mm-number-label]").fill("Số thùng đếm được");
    await page.locator("[data-bmq-mm-number-unit]").fill("thùng");
    await page.locator("[data-bmq-mm-check-input]").fill("Dán nhãn ngày");
    await page.locator("[data-bmq-mm-check-add]").click();
    await page.locator("[data-bmq-mm-check-input]").fill("Chụp kệ sau khi xếp");
    await page.locator("[data-bmq-mm-check-input]").press("Enter");
    assert.equal(await overflow(page), 0, `create sheet no overflow ${w}`);
    assert.deepEqual(await tapTargets(page, ".kg .sheet"), [], `create sheet tap targets ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/mm-create-${w}.png`, fullPage: false });
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-mm-send]").click();
    await page.waitForTimeout(500);
    const [created] = await mmWrites(page, "create_manual_mission");
    assert.ok(created, "create sent");
    assert.equal(created.p_title, "Kiểm kê bao bì Tân Tạo");
    assert.deepEqual(created.p_assignee_ids.sort(), ["u-mai", "u-mi"]);
    assert.equal(created.p_priority, "high");
    assert.equal(created.p_location, "tan_tao");
    assert.deepEqual(created.p_evidence, { photo: "required", note: "optional", number: { label: "Số thùng đếm được", unit: "thùng" }, checklist: ["Dán nhãn ngày", "Chụp kệ sau khi xếp"] });
    assert.ok(created.p_due_at && created.p_due_at.endsWith("T10:00:00.000Z"), `due tomorrow 17:00 VN: ${created.p_due_at}`);
    assert.ok(created.p_request_id, "request id");
    assert.match(await page.locator(".kg .toast").textContent(), /Đã giao “Kiểm kê bao bì Tân Tạo” cho 2 người · đã báo nhóm Zalo Kho/);
    // Review: approve Mai with 4 stars.
    await page.waitForTimeout(400);
    await page.locator("[data-bmq-mm-batch='Kiểm kê bơ ở Q7']").click();
    await page.waitForSelector("[data-bmq-mm-batch-sheet]", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-mm-assignee='Xuan Mai'] .mm-photos img").length === 2, null, { timeout: 5000 });
    await page.waitForTimeout(600); // the notebook sheet slides in over 0.45 s
    assert.match(await page.locator("[data-bmq-mm-assignee='Xuan Mai'] [data-bmq-mm-evidence]").textContent(), /Số thùng đếm được12 thùng[\s\S]*Đã đếm và xếp gọn[\s\S]*✅ Dán nhãn ngày[\s\S]*✅ Xếp lên kệ số 3/);
    assert.equal(await overflow(page), 0, `batch sheet no overflow ${w}`);
    assert.deepEqual(await tapTargets(page, ".kg .sheet"), [], `batch sheet tap targets ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/mm-review-${w}.png` });
    await page.locator("[data-bmq-mm-assignee='Xuan Mai'] .mm-photos button").first().click();
    await page.waitForSelector("[data-bmq-mm-viewer]", { timeout: 3000 });
    await page.getByRole("button", { name: "Đóng ảnh" }).click();
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-mm-assignee='Xuan Mai'] [data-bmq-mm-star='4']").click();
    await page.locator("[data-bmq-mm-approve='Xuan Mai']").click();
    await page.waitForTimeout(500);
    assert.deepEqual(await mmWrites(page, "review_manual_mission"), [{ p_submission_id: "s-mai", p_approve: true, p_rating: 4, p_note: null }]);
    assert.match(await page.locator(".kg .toast").textContent(), /Đã duyệt Xuan Mai · 4★/);
    await page.waitForSelector("[data-bmq-mm-assignee='Xuan Mai'].is-done", { timeout: 5000 });
    // Withdraw Mi Ái (two taps).
    await page.locator("[data-bmq-mm-cancel='Mi Ái']").click();
    await page.locator("[data-bmq-mm-cancel-yes]").click();
    await page.waitForTimeout(400);
    assert.deepEqual(await mmWrites(page, "cancel_manual_mission"), [{ p_mission_id: "m-mi" }]);
    await closeSheet(page);
    // Return KTT with a reason (the reason is required).
    await page.locator("[data-bmq-mm-batch='Dọn kệ bao bì Tân Tạo']").click();
    await page.waitForSelector("[data-bmq-mm-return='KTT BMQ']", { timeout: 5000 });
    await page.locator("[data-bmq-mm-return='KTT BMQ']").click();
    assert.equal(await page.locator("[data-bmq-mm-return-send]").isDisabled(), true, "return needs a reason");
    await page.locator("[data-bmq-mm-reason]").fill("Chưa thấy ảnh kệ sau khi dọn");
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-mm-return-send]").click();
    await page.waitForTimeout(500);
    assert.deepEqual(await mmWrites(page, "review_manual_mission"), [{ p_submission_id: "s-ktt", p_approve: false, p_rating: null, p_note: "Chưa thấy ảnh kệ sau khi dọn" }]);
    assert.deepEqual(errors, [], "no page errors (owner)");
    record(`manual missions owner ${w}`);
    await context.close();
  }
  // Staff: the card on the board, hand in photo + number + ticks; a returned card shows why.
  {
    const { context, page, errors } = await open({ data: "populated", role: "limited", name: "Xuan Mai", missions: "manual" }, "/warehouse/game", viewport);
    await page.waitForTimeout(700);
    await board(page);
    assert.equal(await page.locator("[data-bmq-mm-board], [data-bmq-manual-create]").count(), 0, "staff see no owner section");
    const card = page.locator("[data-bmq-mission='manual-b9b9b9b9b9@0000aaaa']");
    await card.waitFor({ timeout: 5000 });
    assert.match(await card.textContent(), /Chụp ảnh tủ mát Q7[\s\S]*Còn 5 giờ[\s\S]*Gấp/);
    assert.match(await page.locator("[data-bmq-mission='manual-b8b8b8b8b8@0000aaaa']").textContent(), /↩️ Làm lại/);
    await page.screenshot({ path: `${EVIDENCE}/mm-staff-board-${w}.png` });
    await card.click({ force: true });
    await page.waitForSelector("[data-bmq-mm-submit-form]", { timeout: 5000 });
    assert.equal(await page.locator(".kg .sheet [data-bmq-mission-submit]").count(), 0, "no auto-check submit bar on manual cards");
    assert.match(await page.locator(".kg .sheet .mm-req").textContent(), /Chụp ảnh \(bắt buộc\)[\s\S]*Số thùng đếm được \(thùng\)[\s\S]*Dán nhãn ngày[\s\S]*Xếp lên kệ số 3/);
    assert.equal(await page.locator("[data-bmq-mm-submit]").isDisabled(), true, "nothing handed in yet");
    await page.locator("[data-bmq-mm-file]").setInputFiles([{ name: "ke so 3.png", mimeType: "image/png", buffer: PNG_1PX }]);
    await page.locator("[data-bmq-mm-number]").fill("1.234");
    await page.locator("[data-bmq-mm-note]").fill("Tủ 2 còn 3 thùng chưa dán nhãn");
    await page.locator("[data-bmq-mm-tick='0']").check();
    assert.equal(await page.locator("[data-bmq-mm-submit]").isDisabled(), true, "checklist incomplete");
    await page.locator("[data-bmq-mm-tick='1']").check();
    assert.equal(await overflow(page), 0, `submit form no overflow ${w}`);
    assert.deepEqual(await tapTargets(page, ".kg .sheet"), [], `submit form tap targets ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/mm-submit-${w}.png` });
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-mm-submit]").click();
    await page.waitForTimeout(600);
    const all = await writes(page);
    const upload = all.find((x) => x.startsWith("upload:mission-evidence:mm-1/"));
    assert.ok(upload && /ke-so-3\.png$/.test(upload), `photo uploaded under the mission folder: ${JSON.stringify(all)} err=${await page.locator(".kg .sheet [data-bmq-mm-error]").textContent().catch(() => "")}`);
    const [sent] = await mmWrites(page, "submit_manual_mission");
    assert.equal(sent.p_mission_id, "mm-1");
    assert.equal(sent.p_number, 1234, "Vietnamese thousands parsed");
    assert.deepEqual(sent.p_checklist, [true, true]);
    assert.equal(sent.p_photo_paths.length, 1);
    assert.ok(sent.p_photo_paths[0].startsWith("mm-1/"));
    assert.ok(sent.p_request_id);
    await page.waitForSelector("[data-bmq-mm-waiting]", { timeout: 5000 });
    await closeSheet(page);
    await page.locator("[data-bmq-mission='manual-b8b8b8b8b8@0000aaaa']").click({ force: true });
    await page.waitForSelector("[data-bmq-mm-returned]", { timeout: 5000 });
    assert.match(await page.locator("[data-bmq-mm-returned]").textContent(), /Ghi rõ số thùng từng loại/);
    assert.equal(await page.locator("[data-bmq-mm-add-photo]").count(), 0, "photo-less card has no photo picker");
    assert.deepEqual(errors, [], "no page errors (staff)");
    record(`manual missions staff ${w}`);
    await context.close();
  }
}
// Zalo link: /warehouse/game?mission=<id> opens the card straight away.
{
  const { context, page, errors } = await open({ data: "populated", role: "limited", name: "Xuan Mai", missions: "manual" }, "/warehouse/game?mission=mm-1", { width: 390, height: 844 });
  await page.waitForSelector("[data-bmq-mm-submit-form]", { timeout: 10000 });
  assert.match(await page.locator(".kg .sheet h2").first().textContent(), /Chụp ảnh tủ mát Q7/);
  assert.equal(new URL(page.url()).search, "", "link parameter cleared");
  assert.deepEqual(errors, []);
  record("manual missions zalo link 390");
  await context.close();
}
{
  const { context, page, errors } = await open({ data: "populated", role: "owner", missions: "three_open_partial" }, "/warehouse/game?mission=m-mai", { width: 1440, height: 900 });
  await page.waitForSelector("[data-bmq-mm-batch-sheet]", { timeout: 10000 });
  assert.match(await page.locator(".kg .sheet h2").first().textContent(), /Kiểm kê bơ ở Q7/);
  assert.deepEqual(errors, []);
  record("manual missions zalo link owner 1440");
  await context.close();
}
await browser.close();
await server.close();
console.log(`ALL ${results.length} MISSIONS QA CHECKS PASSED — evidence in ${EVIDENCE}`);
