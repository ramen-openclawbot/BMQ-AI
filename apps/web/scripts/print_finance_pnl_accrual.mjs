#!/usr/bin/env node
// Read-only table printer for the accrual P&L (phase 1, server-side).
//
// Usage:
//   SUPABASE_URL="https://<project>.supabase.co" \
//   SUPABASE_SERVICE_ROLE_KEY="<service-role-key>" \
//   node scripts/print_finance_pnl_accrual.mjs
//
// Optional:
//   FINANCE_PNL_ACCRUAL_MONTH=2026-10-01
//
// It only calls public.finance_pnl_accrual(date); it never inserts, updates or
// deletes anything. Amounts are printed in million VND for Maestro review.
import { createClient } from "@supabase/supabase-js";

const month = process.env.FINANCE_PNL_ACCRUAL_MONTH || "2026-10-01";
const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  console.error("This script is read-only but needs a server-side key to pass the finance permission gate.");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const million = new Intl.NumberFormat("vi-VN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const amountM = (value) => million.format(Number(value || 0) / 1_000_000);
const quantity = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
const bool = (value) => (value ? "có" : "không");

const { data, error } = await supabase.rpc("finance_pnl_accrual", { p_month: month });

if (error) {
  console.error(`finance_pnl_accrual failed: ${error.message}`);
  process.exit(1);
}

if (!data) {
  console.error("finance_pnl_accrual returned no data.");
  process.exit(1);
}

const sections = [
  ["revenue", "DOANH THU"],
  ["cogs", "GIÁ VỐN"],
  ["selling", "CHI PHÍ BÁN HÀNG"],
  ["operating", "CHI PHÍ VẬN HÀNH"],
  ["unclassified", "CHƯA PHÂN LOẠI"],
];

const allLines = Array.isArray(data.lines) ? data.lines : [];
const sectionLines = (name) =>
  data.sections?.[name] || allLines.filter((line) => line.section === name);

console.log(`P&L dồn tích tháng ${data.month || month} — đơn vị: triệu đồng`);
console.log("=".repeat(112));
console.log(
  ["Mục", "Dòng", "Nguồn", "Ước tính", "Triệu đồng"]
    .map((heading, index) => heading.padEnd([18, 31, 34, 10, 12][index]))
    .join(" "),
);
console.log("-".repeat(112));

for (const [key, title] of sections) {
  const lines = sectionLines(key);
  if (lines.length === 0) {
    console.log(`${title.padEnd(18)} ${"(không có dòng)".padEnd(31)} ${"".padEnd(34)} ${"".padEnd(10)} ${amountM(0).padStart(12)}`);
    continue;
  }
  lines.forEach((line, index) => {
    const label = String(line.label || line.line_code || "").slice(0, 30);
    const source = String(line.source || "").slice(0, 33);
    console.log(
      `${(index === 0 ? title : "").padEnd(18)} ${label.padEnd(31)} ${source.padEnd(34)} ${bool(line.is_estimate).padEnd(10)} ${amountM(line.amount).padStart(12)}`,
    );
  });
}

console.log("-".repeat(112));
const totals = data.totals || {};
console.log(`${"TỔNG".padEnd(18)} ${"".padEnd(31)} ${"".padEnd(34)} ${"".padEnd(10)}`);
for (const [key, label] of [
  ["revenue", "Doanh thu"],
  ["cogs", "Giá vốn"],
  ["gross_profit", "Lãi gộp"],
  ["selling", "Bán hàng"],
  ["operating", "Vận hành"],
  ["unclassified", "Chưa phân loại"],
  ["ebitda", "EBITDA"],
  ["estimate_total", "Tổng ước tính"],
]) {
  if (totals[key] === undefined || totals[key] === null) continue;
  console.log(`${"".padEnd(18)} ${label.padEnd(31)} ${"".padEnd(34)} ${"".padEnd(10)} ${amountM(totals[key]).padStart(12)}`);
}
if (totals.gross_margin !== undefined && totals.gross_margin !== null) {
  console.log(`${"".padEnd(18)} ${"Biên lãi gộp".padEnd(31)} ${"".padEnd(34)} ${"".padEnd(10)} ${(Number(totals.gross_margin) * 100).toFixed(1).padStart(11)}%`);
}
if (totals.ebitda_margin !== undefined && totals.ebitda_margin !== null) {
  console.log(`${"".padEnd(18)} ${"Biên EBITDA".padEnd(31)} ${"".padEnd(34)} ${"".padEnd(10)} ${(Number(totals.ebitda_margin) * 100).toFixed(1).padStart(11)}%`);
}

const bread = data.bread_supplier || {};
if (Object.keys(bread).length > 0) {
  console.log("\nBánh mì Tuyết Anh");
  console.log(`  Que: ${quantity.format(Number(bread.que_quantity || 0))} que, đơn giá=${bread.que_unit_price == null ? "—" : quantity.format(Number(bread.que_unit_price))}, chi phí=${amountM(bread.accrued_amount)} tr`);
  console.log(`  VietJet: ${quantity.format(Number(bread.vietjet_quantity || 0))} cái, đơn giá=${bread.vietjet_unit_price == null ? "—" : quantity.format(Number(bread.vietjet_unit_price))}`);
  console.log(`  Đã trả=${amountM(bread.paid_amount)} tr; chênh lệch so với đã trả=${amountM(bread.variance_vs_paid)} tr`);
  console.log(`  Đã duyệt (request) =${amountM(bread.approved_request_amount)} tr; loại trừ khỏi phiếu chi=${amountM(bread.excluded_payment_request_amount)} tr`);
}

if (data.inventory) {
  console.log(`\nTồn kho: ${data.inventory.status} — ${data.inventory.note}`);
}

if (Array.isArray(data.flags) && data.flags.length > 0) {
  console.log("\nFlags");
  for (const flag of data.flags) {
    console.log(`  - ${flag.code}: ${flag.detail_en}${flag.amount !== undefined ? ` (${amountM(flag.amount)} tr)` : ""}`);
  }
}
