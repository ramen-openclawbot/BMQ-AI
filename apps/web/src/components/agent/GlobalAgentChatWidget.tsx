/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";

type AgentMessage = { role: "user" | "agent"; text: string };
type ModuleContext = { key: string; label: string; suggestions: string[] };
type CreateCustomerDraft = {
  customer_name: string;
  customer_group: string;
  product_group: string;
  emails: string[];
  kb_profile_name: string;
  kb_po_mode: string;
  kb_calc_notes: string | null;
  kb_ops_notes: string | null;
};
type PaymentRequestSearchSupplier = {
  id: string;
  name?: string | null;
  short_code?: string | null;
};
type SupplierSuggestion = PaymentRequestSearchSupplier & {
  pr_count?: number;
};
type PaymentRequestSearchRow = {
  id: string;
  request_number: string | null;
  title: string | null;
  total_amount: number | null;
  payment_status: "unpaid" | "paid" | string | null;
  payment_method: "bank_transfer" | "cash" | string | null;
  status: string | null;
  approved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  invoice_id: string | null;
  supplier_id: string | null;
  invoices?: { invoice_number?: string | null; invoice_date?: string | null } | null;
  suppliers?: { name?: string | null; short_code?: string | null } | null;
};
type MaterialSuggestion = {
  product_name: string;
  product_code: string | null;
  unit: string | null;
  pr_count: number;
  line_count: number;
  latest_item_at: string | null;
};
type PaymentRequestMaterialItem = {
  product_name?: string | null;
  product_code?: string | null;
};
type PaymentRequestMaterialSearchRow = PaymentRequestSearchRow & {
  matching_line_total: number;
  matching_line_count: number;
  matching_products: string[];
};

const moduleConfig: Array<{ test: (pathname: string) => boolean; context: ModuleContext }> = [
  { test: (p) => p === "/mini-crm", context: { key: "crm", label: "CRM", suggestions: ["Tạo khách hàng Vietjet Test email ops@vietjet.vn", "Checklist setup customer", "Tóm tắt module này"] } },
  { test: (p) => p === "/sales-po-inbox", context: { key: "sales_po", label: "Sales PO Inbox", suggestions: ["Tóm tắt PO đang chờ xử lý", "Checklist review delta trước khi post", "Giải thích auto-post an toàn"] } },
  { test: () => true, context: { key: "general", label: "Dashboard", suggestions: ["Tóm tắt màn hình hiện tại", "Đề xuất 3 việc nên làm tiếp", "Tạo checklist vận hành hôm nay"] } },
];

function getRouteContext(pathname: string): ModuleContext {
  if (pathname === "/") return { key: "home", label: "Dashboard", suggestions: ["Tóm tắt màn hình hiện tại", "Đề xuất 3 việc nên làm tiếp", "Tạo checklist vận hành hôm nay"] };
  if (pathname.startsWith("/inventory")) return { key: "inventory", label: "Tồn kho", suggestions: ["Kiểm tra mặt hàng sắp hết", "Tóm tắt tồn kho theo nhóm", "Đề xuất nhập hàng hôm nay"] };
  if (pathname.startsWith("/suppliers")) return { key: "suppliers", label: "Nhà cung cấp", suggestions: ["Tìm NCC theo từ khóa", "Checklist đánh giá NCC", "Tóm tắt NCC đang hoạt động"] };
  if (pathname.startsWith("/invoices")) return { key: "invoices", label: "Hóa đơn", suggestions: ["Tìm hóa đơn thiếu sản phẩm", "Kiểm tra ảnh hóa đơn/UNC bị thiếu file", "Đề xuất xử lý lỗi tạo invoice từ PR"] };
  if (pathname.startsWith("/payment-requests")) return { key: "payment_requests", label: "Đề nghị chi", suggestions: ["Tìm đề nghị chi theo NCC", "Tìm đề nghị chi theo NVL"] };
  if (pathname.startsWith("/goods-receipts")) return { key: "goods_receipts", label: "Phiếu nhập", suggestions: ["Tóm tắt phiếu nhập hôm nay", "Kiểm tra phiếu lệch số lượng", "Checklist đối soát nhập kho"] };
  if (pathname.startsWith("/purchase-orders")) return { key: "purchase_orders", label: "PO", suggestions: ["Tìm PO chờ xử lý", "Checklist tạo PO", "Đối soát PO với đề nghị chi"] };
  if (pathname.startsWith("/low-stock")) return { key: "low_stock", label: "Sắp hết hàng", suggestions: ["Liệt kê item dưới ngưỡng", "Đề xuất ưu tiên nhập", "Tạo checklist bổ sung tồn"] };
  if (pathname.startsWith("/settings")) return { key: "settings", label: "Cài đặt", suggestions: ["Kiểm tra cấu hình tích hợp", "Checklist cấu hình hệ thống", "Tóm tắt thay đổi gần đây"] };
  if (pathname.startsWith("/sku-costs")) return { key: "sku_costs", label: "SKU Costs", suggestions: ["Checklist cập nhật cost", "Tóm tắt cost anomalies", "Đề xuất kiểm tra tuần này"] };
  if (pathname.startsWith("/kho")) return { key: "warehouse", label: "Kho", suggestions: ["Checklist nhập kho", "Gợi ý kiểm tra tồn", "Tóm tắt thao tác theo ca"] };
  if (pathname === "/finance-control/cost") return { key: "finance_cost", label: "Finance / Cost", suggestions: ["Checklist cost", "KPI cost", "Cảnh báo bất thường"] };
  if (pathname === "/finance-control/revenue") return { key: "finance_revenue", label: "Quản lý doanh thu", suggestions: ["Doanh thu tháng này", "Dòng cần kiểm tra", "Top customer"] };
  if (pathname.startsWith("/finance-control/revenue/sources")) return { key: "finance_revenue_sources", label: "Chi tiết nguồn doanh thu", suggestions: ["Dòng nào cần kiểm tra", "So sánh nguồn đối soát và PO", "Gợi ý kiểm tra"] };
  if (pathname === "/finance-control/revenue/daily-review") return { key: "finance_revenue_review", label: "Daily Revenue Review", suggestions: ["Draft cần kiểm tra", "Ngoại lệ hôm nay", "Cách sửa doanh thu"] };
  if (pathname === "/finance-control/revenue/setup") return { key: "finance_revenue_setup", label: "Auto-parse operations", suggestions: ["Job gần nhất", "Snapshot hôm nay", "Lịch chạy 23:59"] };
  return moduleConfig.find((m) => m.test(pathname))!.context;
}

function parseCreateCustomerCommand(raw: string): { draft: CreateCustomerDraft; missing: string[] } {
  const text = String(raw || "").trim();
  const findValue = (keys: string[]) => {
    for (const k of keys) {
      const re = new RegExp(`(?:^|[;,\\n])\\s*${k}\\s*[:=]\\s*([^;\\n]+)`, "i");
      const m = text.match(re);
      if (m?.[1]) return String(m[1]).trim();
    }
    return "";
  };

  const inferredName = (() => {
    const m1 = text.match(/t[aạ]o\s+kh[aá]ch\s+h[aà]ng\s+([^,;\n]+)/i);
    if (m1?.[1]) return m1[1].trim();
    return "";
  })();

  const customerName = findValue(["ten", "tên", "name", "customer_name"]) || inferredName;
  const customerGroupRaw = findValue(["group", "nhom", "nhóm", "customer_group"]) || (/\bb2b\b/i.test(text) ? "b2b" : "");
  const productGroupRaw = findValue(["product_group", "nhom_sp"]) || (/b[aá]nh\s*m[iì]/i.test(text) ? "banhmi" : "");
  const poModeRaw = findValue(["po_mode", "mode", "kb_mode"]) || (/c[oộ]ng\s*d[oồ]n|cumulative/i.test(text) ? "cumulative" : "daily");
  const calcNotes = findValue(["calc", "calculation", "calculation_notes"]);
  const opsNotes = findValue(["ops", "operational", "operational_notes"]);

  const groupMap: Record<string, string> = { b2b: "b2b", banhmi_point: "banhmi_point", banhmi_agency: "banhmi_agency", online: "online" };
  const productMap: Record<string, string> = { banhmi: "banhmi", banhngot: "banhngot" };

  const directEmails = findValue(["email", "emails", "mail"]).split(/[;,\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /@/.test(s));
  const textEmails = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase())));
  const emails = Array.from(new Set([...directEmails, ...textEmails]));

  const missing: string[] = [];
  if (!customerName) missing.push("tên khách hàng");
  if (!emails.length) missing.push("ít nhất 1 email nhận diện");

  const draft: CreateCustomerDraft = {
    customer_name: customerName,
    customer_group: groupMap[String(customerGroupRaw || "").trim().toLowerCase()] || "b2b",
    product_group: productMap[String(productGroupRaw || "").trim().toLowerCase()] || "banhmi",
    emails,
    kb_profile_name: `${customerName || "Customer"} Knowledge`,
    kb_po_mode: String(poModeRaw || "").toLowerCase().includes("cum") ? "cumulative_snapshot" : "daily_new_po",
    kb_calc_notes: calcNotes || null,
    kb_ops_notes: opsNotes || null,
  };

  return { draft, missing };
}

function normalizeSupplierSearchTerm(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^(tìm|tim|search|kiểm tra|kiem tra)\s+/i, "")
    .replace(/^đề nghị chi\s+(theo\s+)?/i, "")
    .replace(/^(ncc|nhà cung cấp|nha cung cap)\s+/i, "")
    .replace(/^(đã chi|da chi|chưa chi|chua chi)\s+/i, "")
    .replace(/^theo\s+(ncc|nhà cung cấp|nha cung cap)\s*/i, "")
    .trim();
}

function normalizeVietnamese(value: string): string {
  return String(value || "")
    .replace(/[đĐ]/g, "d")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ");
}

function normalizedTokens(value: string): string[] {
  return normalizeVietnamese(value).split(" ").filter(Boolean);
}

function isNoAccentInput(value: string): boolean {
  const compactOriginal = String(value || "").toLowerCase().trim().replace(/\s+/g, " ");
  return Boolean(compactOriginal) && compactOriginal === normalizeVietnamese(value);
}

function hasTokensInOrder(haystack: string, tokens: string[]): boolean {
  let cursor = 0;
  for (const token of tokens) {
    const nextIndex = haystack.indexOf(token, cursor);
    if (nextIndex < 0) return false;
    cursor = nextIndex + token.length;
  }
  return true;
}

function getNormalizedMatchRank(query: string, labels: Array<string | null | undefined>): number | null {
  const normalizedQuery = normalizeVietnamese(query);
  const tokens = normalizedTokens(query);
  if (!normalizedQuery || !tokens.length) return null;

  const normalizedLabels = labels.map((label) => normalizeVietnamese(label || "")).filter(Boolean);
  if (!normalizedLabels.length) return null;

  const compactQuery = normalizedQuery.replace(/\s+/g, "");
  const compactLabels = normalizedLabels.map((label) => label.replace(/\s+/g, ""));
  if (normalizedLabels.some((label) => label === normalizedQuery)) return 0;
  if (compactLabels.some((label) => label === compactQuery)) return 0;
  if (normalizedLabels.some((label) => label.startsWith(normalizedQuery))) return 1;
  if (compactLabels.some((label) => label.startsWith(compactQuery))) return 1;
  if (normalizedLabels.some((label) => label.includes(normalizedQuery))) return 2;
  if (compactLabels.some((label) => label.includes(compactQuery))) return 2;
  if (normalizedLabels.some((label) => hasTokensInOrder(label, tokens))) return 3;

  const combined = normalizedLabels.join(" ");
  if (hasTokensInOrder(combined, tokens)) return 4;
  if (tokens.every((token) => combined.includes(token))) return 5;
  return null;
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return String(a || "").localeCompare(String(b || ""), "vi");
}

function supplierLabels(supplier: PaymentRequestSearchSupplier): Array<string | null | undefined> {
  return [supplier.name, supplier.short_code];
}

function materialLabels(item: PaymentRequestMaterialItem | MaterialSuggestion): Array<string | null | undefined> {
  return [item.product_name, item.product_code];
}

function sortSuppliersForTerm<T extends PaymentRequestSearchSupplier>(term: string, suppliers: T[]): T[] {
  return [...suppliers].sort((a, b) => {
    const rankA = getNormalizedMatchRank(term, supplierLabels(a)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = getNormalizedMatchRank(term, supplierLabels(b)) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;

    const countA = "pr_count" in a ? Number(a.pr_count || 0) : 0;
    const countB = "pr_count" in b ? Number(b.pr_count || 0) : 0;
    if (countB !== countA) return countB - countA;

    return compareText(a.name || a.short_code || a.id, b.name || b.short_code || b.id);
  });
}

function sortMaterialSuggestions(term: string, suggestions: MaterialSuggestion[]): MaterialSuggestion[] {
  return [...suggestions].sort((a, b) => {
    const rankA = getNormalizedMatchRank(term, materialLabels(a)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = getNormalizedMatchRank(term, materialLabels(b)) ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    if (b.pr_count !== a.pr_count) return b.pr_count - a.pr_count;

    const dateA = new Date(a.latest_item_at || 0).getTime();
    const dateB = new Date(b.latest_item_at || 0).getTime();
    if (dateB !== dateA) return dateB - dateA;

    if (b.line_count !== a.line_count) return b.line_count - a.line_count;
    return compareText(a.product_name, b.product_name);
  });
}

function isPaymentRequestSupplierSearch(content: string, routeKey: string): boolean {
  if (routeKey !== "payment_requests") return false;
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  if (/^tìm đề nghị chi theo (ncc|nhà cung cấp)|^tim de nghi chi theo (ncc|nha cung cap)/i.test(lower)) return true;
  if (/^(đã chi|da chi|chưa chi|chua chi)\s+/i.test(lower)) return true;
  if (/\b(ncc|nhà cung cấp|nha cung cap)\b/i.test(lower) && /^(tìm|tim|search|kiểm tra|kiem tra)\b/i.test(lower)) return true;
  if (/^(tìm|tim|search)\s+/i.test(lower)) {
    return !/(hóa đơn|hoa don|invoice|checklist|đối soát|doi soat|trạng thái|trang thai|chưa có|chua co)/i.test(lower);
  }
  return false;
}

function extractSupplierSearchTerm(content: string): string {
  const normalized = normalizeSupplierSearchTerm(content);
  if (/^(theo\s+)?(ncc|nhà cung cấp|nha cung cap)$/i.test(normalized)) return "";
  return normalized;
}

function isPaymentRequestNonSupplierCommand(content: string): boolean {
  return /(tóm tắt|tom tat|summary|checklist|hóa đơn|hoa don|invoice|đối soát|doi soat|trạng thái|trang thai|chưa có|chua co)/i.test(content.trim().toLowerCase());
}

function isPaymentRequestControlCommand(content: string): boolean {
  return /^(confirm|xác nhận|xac nhan|thực thi|thuc thi|execute|cancel|hủy|huy|tạo|tao)\b/i.test(content.trim().toLowerCase());
}

function normalizeMaterialSearchTerm(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^(tìm|tim|search|kiểm tra|kiem tra)\s+/i, "")
    .replace(/^đề nghị chi\s+(theo\s+)?/i, "")
    .replace(/^(nvl|nguyên vật liệu|nguyen vat lieu|mặt hàng|mat hang|item|sản phẩm|san pham)\s+/i, "")
    .replace(/^theo\s+(nvl|nguyên vật liệu|nguyen vat lieu|mặt hàng|mat hang|item|sản phẩm|san pham)\s*/i, "")
    .trim();
}

function isPaymentRequestMaterialSearch(content: string, routeKey: string): boolean {
  if (routeKey !== "payment_requests") return false;
  const lower = content.trim().toLowerCase();
  if (!lower) return false;
  if (/^tìm đề nghị chi theo (nvl|nguyên vật liệu|nguyen vat lieu|mặt hàng|mat hang|item|sản phẩm|san pham)/i.test(lower)) return true;
  return /\b(nvl|nguyên vật liệu|nguyen vat lieu|mặt hàng|mat hang|item|sản phẩm|san pham)\b/i.test(lower) && /^(tìm|tim|search|kiểm tra|kiem tra)\b/i.test(lower);
}

function extractMaterialSearchTerm(content: string): string {
  const normalized = normalizeMaterialSearchTerm(content);
  if (/^(theo\s+)?(nvl|nguyên vật liệu|nguyen vat lieu|mặt hàng|mat hang|item|sản phẩm|san pham)$/i.test(normalized)) return "";
  return normalized;
}

function isBarePaymentRequestSupplierPhrase(content: string, routeKey: string): boolean {
  if (routeKey !== "payment_requests") return false;
  const term = content.trim();
  if (term.length < 2) return false;
  if (isPaymentRequestNonSupplierCommand(term) || isPaymentRequestControlCommand(term)) return false;
  return true;
}

function formatVnd(amount: number | null | undefined): string {
  return `${Number(amount || 0).toLocaleString("vi-VN")}đ`;
}

function getVietnamDateParts(offsetDays = 0): { iso: string; period: string; label: string } {
  const currentParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const currentPart = (type: string) => currentParts.find((item) => item.type === type)?.value || "";
  const vnNoonUtc = new Date(Date.UTC(Number(currentPart("year")), Number(currentPart("month")) - 1, Number(currentPart("day")) + offsetDays, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(vnNoonUtc);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  const iso = `${part("year")}-${part("month")}-${part("day")}`;
  return { iso, period: iso.slice(0, 7), label: `${part("day")}/${part("month")}/${part("year")}` };
}

function formatDateVi(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("vi-VN");
}

function truncate(value: string | null | undefined, max: number): string {
  const text = String(value || "-");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function padCell(value: string, width: number): string {
  const text = truncate(value, width);
  return `${text}${" ".repeat(Math.max(0, width - text.length))}`;
}

function formatPaymentRows(rows: PaymentRequestSearchRow[], kind: "unpaid" | "paid"): string[] {
  const visibleRows = rows.slice(0, 8);
  const lines = visibleRows.map((row) => {
    const date = kind === "paid" ? row.invoices?.invoice_date || row.approved_at || row.updated_at || row.created_at : row.approved_at || row.updated_at || row.created_at;
    const lastCol = kind === "paid" ? row.invoices?.invoice_number || "-" : row.status || "-";
    return [
      padCell(row.request_number || "-", 12),
      padCell(formatDateVi(date), 10),
      padCell(formatVnd(row.total_amount), 13),
      padCell(lastCol, kind === "paid" ? 14 : 10),
    ].join(" | ");
  });

  if (rows.length > visibleRows.length) lines.push(`... còn ${rows.length - visibleRows.length} dòng`);
  return lines.length ? lines : ["Không có dòng nào."];
}

function formatPaymentMaterialRows(rows: PaymentRequestMaterialSearchRow[], kind: "unpaid" | "paid"): string[] {
  const visibleRows = rows.slice(0, 8);
  const lines = visibleRows.map((row) => {
    const date = kind === "paid" ? row.invoices?.invoice_date || row.approved_at || row.updated_at || row.created_at : row.approved_at || row.updated_at || row.created_at;
    const supplierName = row.suppliers?.short_code || row.suppliers?.name || "-";
    const lastCol = kind === "paid" ? row.invoices?.invoice_number || "-" : row.status || "-";
    return [
      padCell(row.request_number || "-", 12),
      padCell(supplierName, 12),
      padCell(formatDateVi(date), 10),
      padCell(formatVnd(row.matching_line_total), 13),
      padCell(`${row.matching_line_count} dòng`, 8),
      padCell(lastCol, kind === "paid" ? 14 : 10),
    ].join(" | ");
  });

  if (rows.length > visibleRows.length) lines.push(`... còn ${rows.length - visibleRows.length} PR`);
  return lines.length ? lines : ["Không có dòng nào."];
}

function formatPaymentSearchResults(term: string, suppliers: PaymentRequestSearchSupplier[], rows: PaymentRequestSearchRow[]): string {
  if (!suppliers.length || !rows.length) {
    return `Không tìm thấy đề nghị chi cho "${term}".\nGợi ý: thử nhập tên NCC đầy đủ hơn, ví dụ "Thiên An Sinh".`;
  }

  const supplierNames = suppliers.map((supplier) => supplier.name || supplier.short_code || supplier.id).join(", ");
  const sortedRows = [...rows].sort((a, b) => {
    const groupA = a.payment_status === "paid" ? 1 : 0;
    const groupB = b.payment_status === "paid" ? 1 : 0;
    if (groupA !== groupB) return groupA - groupB;
    const dateA = new Date(a.approved_at || a.updated_at || a.created_at || 0).getTime();
    const dateB = new Date(b.approved_at || b.updated_at || b.created_at || 0).getTime();
    return dateB - dateA;
  });
  const unpaidRows = sortedRows.filter((row) => row.payment_status !== "paid");
  const paidRows = sortedRows.filter((row) => row.payment_status === "paid");
  const unpaidTotal = unpaidRows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
  const paidTotal = paidRows.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);

  return [
    `Kết quả duyệt chi cho NCC: ${supplierNames}`,
    `Tổng dòng: ${rows.length} | Chưa chi: ${unpaidRows.length} (${formatVnd(unpaidTotal)}) | Đã chi: ${paidRows.length} (${formatVnd(paidTotal)})`,
    "",
    "CHƯA CHI / UNPAID",
    "PR           | Ngày       | Số tiền       | Trạng thái",
    "-------------|------------|---------------|-----------",
    ...formatPaymentRows(unpaidRows, "unpaid"),
    "",
    "ĐÃ CHI / PAID",
    "PR           | Ngày       | Số tiền       | Invoice",
    "-------------|------------|---------------|--------------",
    ...formatPaymentRows(paidRows, "paid"),
  ].join("\n");
}

function formatPaymentMaterialSearchResults(term: string, rows: PaymentRequestMaterialSearchRow[]): string {
  if (!rows.length) {
    return `Không tìm thấy đề nghị chi theo NVL "${term}".\nGợi ý: thử nhập tên mặt hàng đầy đủ hơn, ví dụ "bơ anchor", "bột mì".`;
  }

  const sortedRows = [...rows].sort((a, b) => {
    const groupA = a.payment_status === "paid" ? 1 : 0;
    const groupB = b.payment_status === "paid" ? 1 : 0;
    if (groupA !== groupB) return groupA - groupB;
    const dateA = new Date(a.approved_at || a.updated_at || a.created_at || 0).getTime();
    const dateB = new Date(b.approved_at || b.updated_at || b.created_at || 0).getTime();
    return dateB - dateA;
  });
  const unpaidRows = sortedRows.filter((row) => row.payment_status !== "paid");
  const paidRows = sortedRows.filter((row) => row.payment_status === "paid");
  const unpaidTotal = unpaidRows.reduce((sum, row) => sum + Number(row.matching_line_total || 0), 0);
  const paidTotal = paidRows.reduce((sum, row) => sum + Number(row.matching_line_total || 0), 0);
  const lineCount = rows.reduce((sum, row) => sum + row.matching_line_count, 0);

  return [
    `Kết quả duyệt chi theo NVL: ${term}`,
    `Tổng PR: ${rows.length} | Dòng NVL: ${lineCount} | Chưa chi: ${unpaidRows.length} (${formatVnd(unpaidTotal)}) | Đã chi: ${paidRows.length} (${formatVnd(paidTotal)})`,
    "",
    "CHƯA CHI / UNPAID",
    "PR           | NCC          | Ngày       | Tiền dòng    | Số dòng  | Trạng thái",
    "-------------|--------------|------------|--------------|----------|-----------",
    ...formatPaymentMaterialRows(unpaidRows, "unpaid"),
    "",
    "ĐÃ CHI / PAID",
    "PR           | NCC          | Ngày       | Tiền dòng    | Số dòng  | Invoice",
    "-------------|--------------|------------|--------------|----------|--------------",
    ...formatPaymentMaterialRows(paidRows, "paid"),
  ].join("\n");
}

type PaymentAgentSearchBody =
  | { action: "supplier_suggestions"; term: string }
  | { action: "material_suggestions"; term: string }
  | { action: "supplier_search"; term: string; exactSupplier?: PaymentRequestSearchSupplier }
  | { action: "material_search"; term: string; exactProductName?: boolean };

type PaymentAgentSearchResponse = {
  suggestions?: SupplierSuggestion[] | MaterialSuggestion[];
  suppliers?: PaymentRequestSearchSupplier[];
  rows?: PaymentRequestSearchRow[] | PaymentRequestMaterialSearchRow[];
};

type RevenueDailyChannelSummary = {
  channel: string;
  rows?: number;
  rowCount?: number;
  grossRevenue?: number;
  gross_revenue?: number;
  quantity?: number;
  reviewFlaggedRows?: number;
  review_flagged_rows?: number;
};

type RevenueDailyReport = {
  sourceDocumentId: string;
  sourceName?: string;
  status?: string;
  period: string;
  revenueDate: string;
  importedAt?: string;
  temporaryControlledRevenue?: boolean;
  trustSemantics?: string;
  summary: {
    rowCount?: number;
    lineCount?: number;
    grossRevenue?: number;
    grossTotal?: number;
    quantity?: number;
    reviewCount?: number;
    reviewFlaggedRows?: number;
    channels?: RevenueDailyChannelSummary[];
  };
};

type RevenueDailyCompare = {
  runId: string;
  revenueDate: string;
  period: string;
  existingReport: RevenueDailyReport | null;
  previewSummary: RevenueDailyReport["summary"];
  requiresCancellationConfirmation?: boolean;
  dailyCancellationResolution?: {
    enabled?: boolean;
    hasCancellationSignal?: boolean;
    requiresConfirmation?: boolean;
    cancelSignals?: Array<Record<string, unknown>>;
    excludedRows?: Array<Record<string, unknown>>;
    replacementRows?: Array<Record<string, unknown>>;
    unresolvedCancelSignals?: Array<Record<string, unknown>>;
    message?: string;
  } | null;
  comparison: {
    totals: {
      current: { lineCount: number; grossRevenue: number; quantity: number; reviewCount: number };
      preview: { lineCount: number; grossRevenue: number; quantity: number; reviewCount: number };
      delta: { lineCount: number; grossRevenue: number; quantity: number; reviewCount: number };
    };
    channels: Array<{
      channel: string;
      current: { rows: number; grossRevenue: number; quantity: number; reviewFlaggedRows: number };
      preview: { rows: number; grossRevenue: number; quantity: number; reviewFlaggedRows: number };
      delta: { rows: number; grossRevenue: number; quantity: number; reviewFlaggedRows: number };
    }>;
  };
};

type RevenueDailyActionResponse = {
  report?: RevenueDailyReport | null;
} & Partial<RevenueDailyCompare>;

type DashboardQuickReport = {
  todayIso: string;
  yesterdayIso: string;
  monthLabel: string;
  todayRevenue: number;
  monthRevenueToDate: number;
  yesterdayProductionQty: number;
  todayProductionQty: number;
};

class PaymentAgentAccessError extends Error {
  constructor() {
    super("ACCESS_DENIED");
  }
}

const PAYMENT_AGENT_ACCESS_DENIED_MESSAGE = "Tính năng tìm duyệt chi chỉ dành cho tài khoản owner. Anh kiểm tra lại quyền truy cập hoặc đăng nhập lại giúp em.";
const PAYMENT_AGENT_SEARCH_ERROR_MESSAGE = "Em chưa tải được dữ liệu duyệt chi lúc này. Anh thử lại sau giúp em.";

function isPaymentAgentAccessError(error: unknown): boolean {
  return error instanceof PaymentAgentAccessError;
}

async function invokePaymentAgentSearch<T extends PaymentAgentSearchResponse>(body: PaymentAgentSearchBody): Promise<T> {
  const { data, error } = await supabase.functions.invoke("payment-agent-search", { body });
  if (error) {
    const status = Number((error as any)?.context?.status || (error as any)?.status || 0);
    if (status === 401 || status === 403) throw new PaymentAgentAccessError();
    throw new Error("Không tải được dữ liệu duyệt chi.");
  }
  return (data || {}) as T;
}

async function invokeRevenueDailyAction(body: Record<string, unknown>): Promise<RevenueDailyActionResponse> {
  const { data, error } = await supabase.functions.invoke("revenue-monthly-parse-preview", { body });
  if (error) throw new Error((error as any)?.message || "Không tải được báo cáo doanh thu daily.");
  return (data || {}) as RevenueDailyActionResponse;
}

async function fetchDashboardQuickReport(): Promise<DashboardQuickReport> {
  const today = getVietnamDateParts(0);
  const yesterday = getVietnamDateParts(-1);
  const monthLabel = `T${Number(today.period.slice(5, 7))}/${today.period.slice(0, 4)}`;

  let monthRevenueToDate = 0;
  let todayRevenue = 0;
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await (supabase as any)
      .from("revenue_ledger_lines")
      .select("revenue_date,gross_revenue,source_document:revenue_source_documents!inner(status)")
      .eq("period", today.period)
      .eq("approval_status", "approved")
      .in("source_document.status", ["controlled", "trusted"])
      .lte("revenue_date", today.iso)
      .order("revenue_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach((row: { revenue_date?: string | null; gross_revenue?: number | null }) => {
      const gross = Number(row.gross_revenue || 0);
      monthRevenueToDate += gross;
      if (row.revenue_date === today.iso) todayRevenue += gross;
    });
    if (rows.length < pageSize) break;
  }

  let yesterdayProductionQty = 0;
  let todayProductionQty = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await (supabase as any)
      .from("production_order_items")
      .select("delivery_date,actual_qty,planned_qty,ordered_qty")
      .in("delivery_date", [yesterday.iso, today.iso])
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = data || [];
    rows.forEach((row: { delivery_date?: string | null; actual_qty?: number | null; planned_qty?: number | null; ordered_qty?: number | null }) => {
      const qty = Number(row.actual_qty ?? row.planned_qty ?? row.ordered_qty ?? 0);
      if (row.delivery_date === yesterday.iso) yesterdayProductionQty += qty;
      if (row.delivery_date === today.iso) todayProductionQty += qty;
    });
    if (rows.length < pageSize) break;
  }

  return {
    todayIso: today.label,
    yesterdayIso: yesterday.label,
    monthLabel,
    todayRevenue,
    monthRevenueToDate,
    yesterdayProductionQty,
    todayProductionQty,
  };
}

function formatDashboardQuickReport(report: DashboardQuickReport): string {
  return [
    "Báo cáo nhanh hôm nay",
    "",
    `Doanh thu hôm nay (${report.todayIso}): ${formatVnd(report.todayRevenue)}`,
    `Doanh thu tháng ${report.monthLabel} tới hôm nay: ${formatVnd(report.monthRevenueToDate)}`,
    "",
    `Sản xuất hôm qua (${report.yesterdayIso}): ${report.yesterdayProductionQty.toLocaleString("vi-VN")} bánh`,
    `Sản xuất hôm nay (${report.todayIso}): ${report.todayProductionQty.toLocaleString("vi-VN")} bánh`,
  ].join("\n");
}

const revenueSummaryNumber = (summary: RevenueDailyReport["summary"] | undefined, ...keys: Array<keyof RevenueDailyReport["summary"]>) => {
  for (const key of keys) {
    const value = Number(summary?.[key] || 0);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  return 0;
};

const channelRows = (channel: RevenueDailyChannelSummary) => Number(channel.rows || channel.rowCount || 0);
const channelGross = (channel: RevenueDailyChannelSummary) => Number(channel.grossRevenue || channel.gross_revenue || 0);

function formatDelta(value: number, formatter: (n: number) => string = (n) => Number(n || 0).toLocaleString("vi-VN")) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatter(value)}`;
}

async function searchMaterialSuggestions(term: string): Promise<MaterialSuggestion[]> {
  const data = await invokePaymentAgentSearch<{ suggestions?: MaterialSuggestion[] }>({ action: "material_suggestions", term });
  return sortMaterialSuggestions(isNoAccentInput(term) ? normalizeVietnamese(term) : term, data.suggestions || []);
}

async function searchSupplierSuggestions(term: string): Promise<SupplierSuggestion[]> {
  const data = await invokePaymentAgentSearch<{ suggestions?: SupplierSuggestion[] }>({ action: "supplier_suggestions", term });
  return sortSuppliersForTerm(isNoAccentInput(term) ? normalizeVietnamese(term) : term, data.suggestions || []);
}

async function searchPaymentRequestsBySupplier(term: string, exactSupplier?: PaymentRequestSearchSupplier): Promise<{ suppliers: PaymentRequestSearchSupplier[]; rows: PaymentRequestSearchRow[] }> {
  const data = await invokePaymentAgentSearch<{ suppliers?: PaymentRequestSearchSupplier[]; rows?: PaymentRequestSearchRow[] }>({
    action: "supplier_search",
    term,
    exactSupplier,
  });
  return { suppliers: data.suppliers || [], rows: data.rows || [] };
}

async function searchPaymentRequestsByMaterial(term: string, exactProductName = false): Promise<PaymentRequestMaterialSearchRow[]> {
  const data = await invokePaymentAgentSearch<{ rows?: PaymentRequestMaterialSearchRow[] }>({
    action: "material_search",
    term,
    exactProductName,
  });
  return data.rows || [];
}

async function resolveStrongSupplierSuggestion(term: string): Promise<SupplierSuggestion | null> {
  const suggestions = await searchSupplierSuggestions(term);
  const topSuggestion = suggestions[0];
  if (!topSuggestion) return null;

  const topRank = getNormalizedMatchRank(term, supplierLabels(topSuggestion));
  if (topRank === null) return null;
  if (topRank <= 1) return topSuggestion;

  const secondRank = suggestions[1] ? getNormalizedMatchRank(term, supplierLabels(suggestions[1])) : null;
  if (topRank <= 3 && (secondRank === null || secondRank > topRank)) return topSuggestion;
  return null;
}

async function getNextKnowledgeProfileVersion(customerId: string) {
  const { data, error } = await (supabase as any)
    .from("mini_crm_knowledge_profile_versions")
    .select("version_no")
    .eq("customer_id", customerId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.version_no || 0) + 1;
}

export function GlobalAgentChatWidget() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isOwner } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [pendingCreateDraft, setPendingCreateDraft] = useState<CreateCustomerDraft | null>(null);
  const [pendingMissing, setPendingMissing] = useState<string[]>([]);
  const [executionArmed, setExecutionArmed] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isSearchingPaymentRequests, setIsSearchingPaymentRequests] = useState(false);
  const [pendingPaymentSupplierSearch, setPendingPaymentSupplierSearch] = useState(false);
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false);
  const [materialSearchDraft, setMaterialSearchDraft] = useState("");
  const [materialSuggestions, setMaterialSuggestions] = useState<MaterialSuggestion[]>([]);
  const [isLoadingMaterialSuggestions, setIsLoadingMaterialSuggestions] = useState(false);
  const [materialSuggestionError, setMaterialSuggestionError] = useState<string | null>(null);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierSearchDraft, setSupplierSearchDraft] = useState("");
  const [supplierSuggestions, setSupplierSuggestions] = useState<SupplierSuggestion[]>([]);
  const [isLoadingSupplierSuggestions, setIsLoadingSupplierSuggestions] = useState(false);
  const [supplierSuggestionError, setSupplierSuggestionError] = useState<string | null>(null);
  const [dailyReport, setDailyReport] = useState<RevenueDailyReport | null>(null);
  const [dailyReportLoaded, setDailyReportLoaded] = useState(false);
  const [dailyReportError, setDailyReportError] = useState<string | null>(null);
  const [isLoadingDailyReport, setIsLoadingDailyReport] = useState(false);
  const [dailyCompare, setDailyCompare] = useState<RevenueDailyCompare | null>(null);
  const [isRunningDailyCompare, setIsRunningDailyCompare] = useState(false);
  const [isPostingDailyCompare, setIsPostingDailyCompare] = useState(false);
  const [dashboardQuickReportLoadedKey, setDashboardQuickReportLoadedKey] = useState<string | null>(null);
  const [isLoadingDashboardQuickReport, setIsLoadingDashboardQuickReport] = useState(false);
  const dashboardQuickReportInFlightRef = useRef<string | null>(null);

  const routeContext = useMemo(() => getRouteContext(location.pathname), [location.pathname]);
  const isRevenueMobileContext = location.pathname.startsWith("/finance-control/revenue");
  const isSkuCostsMobileContext = location.pathname.startsWith("/sku-costs");

  const pushAgent = (text: string) => setMessages((prev) => [...prev, { role: "agent", text }]);

  const loadDashboardQuickReport = useCallback(async () => {
    const reportKey = getVietnamDateParts(0).iso;
    if (dashboardQuickReportLoadedKey === reportKey || dashboardQuickReportInFlightRef.current === reportKey) return;
    dashboardQuickReportInFlightRef.current = reportKey;
    setIsLoadingDashboardQuickReport(true);
    try {
      const report = await fetchDashboardQuickReport();
      setMessages((prev) => [...prev, { role: "agent", text: formatDashboardQuickReport(report) }]);
      setDashboardQuickReportLoadedKey(reportKey);
    } catch {
      setMessages((prev) => [...prev, { role: "agent", text: "Em chưa tải được báo cáo nhanh Dashboard lúc này. Anh thử mở lại sau giúp em." }]);
      setDashboardQuickReportLoadedKey(reportKey);
    } finally {
      dashboardQuickReportInFlightRef.current = null;
      setIsLoadingDashboardQuickReport(false);
    }
  }, [dashboardQuickReportLoadedKey]);

  useEffect(() => {
    if (open && routeContext.key === "home") {
      loadDashboardQuickReport();
    }
  }, [open, routeContext.key, loadDashboardQuickReport]);

  const loadDailyReport = useCallback(async () => {
    if (!isRevenueMobileContext) return;
    setIsLoadingDailyReport(true);
    setDailyReportError(null);
    setDailyCompare(null);
    try {
      const result = await invokeRevenueDailyAction({ action: "latest_auto_daily_report" });
      setDailyReport(result.report || null);
      setDailyReportLoaded(true);
    } catch (error) {
      setDailyReport(null);
      setDailyReportLoaded(true);
      setDailyReportError(error instanceof Error ? error.message : "Không tải được báo cáo daily.");
    } finally {
      setIsLoadingDailyReport(false);
    }
  }, [isRevenueMobileContext]);

  useEffect(() => {
    if (open && isRevenueMobileContext) {
      loadDailyReport();
    }
    if (!open) {
      setDailyCompare(null);
    }
  }, [open, isRevenueMobileContext, loadDailyReport]);

  const openDailyLedgerDetail = () => {
    if (!dailyReport?.sourceDocumentId || !dailyReport.revenueDate) return;
    const params = new URLSearchParams({
      period: dailyReport.period || dailyReport.revenueDate.slice(0, 7),
      sourceDocumentId: dailyReport.sourceDocumentId,
      revenue_date: dailyReport.revenueDate,
    });
    setOpen(false);
    navigate(`/finance-control/revenue/sources?${params.toString()}`);
  };

  const runDailyCompare = async () => {
    setIsRunningDailyCompare(true);
    setDailyReportError(null);
    setDailyCompare(null);
    try {
      const result = await invokeRevenueDailyAction({
        action: "preview_daily_compare",
        ...(dailyReport?.revenueDate ? { revenueDate: dailyReport.revenueDate } : {}),
      });
      if (!result.runId || !result.comparison || !result.previewSummary || !result.revenueDate || !result.period) {
        throw new Error("Preview daily compare không trả đủ dữ liệu.");
      }
      setDailyCompare({
        runId: result.runId,
        revenueDate: result.revenueDate,
        period: result.period,
        existingReport: result.existingReport || null,
        previewSummary: result.previewSummary,
        requiresCancellationConfirmation: result.requiresCancellationConfirmation === true,
        dailyCancellationResolution: result.dailyCancellationResolution || null,
        comparison: result.comparison,
      });
    } catch (error) {
      setDailyReportError(error instanceof Error ? error.message : "Không chạy được preview daily.");
    } finally {
      setIsRunningDailyCompare(false);
    }
  };

  const confirmDailyCompare = async () => {
    if (!dailyCompare?.runId) return;
    setIsPostingDailyCompare(true);
    setDailyReportError(null);
    try {
      await invokeRevenueDailyAction({
        action: "confirm_daily_overwrite",
        runId: dailyCompare.runId,
        ...(dailyCompare.requiresCancellationConfirmation ? { confirmCancelReplacement: true } : {}),
      });
      pushAgent(dailyCompare.requiresCancellationConfirmation
        ? `Đã xác nhận huỷ PO cũ và ghi PO mới cho daily revenue ngày ${dailyCompare.revenueDate}. Số liệu vẫn là controlled/not trusted cho đến kỳ audit cuối tháng.`
        : `Đã ghi daily revenue ngày ${dailyCompare.revenueDate} vào ledger tạm kiểm soát. Số liệu vẫn là controlled/not trusted cho đến kỳ audit cuối tháng.`);
      setDailyCompare(null);
      await loadDailyReport();
    } catch (error) {
      setDailyReportError(error instanceof Error ? error.message : "Không ghi được daily revenue.");
    } finally {
      setIsPostingDailyCompare(false);
    }
  };

  const cancelDailyCompare = async () => {
    const runId = dailyCompare?.runId;
    setDailyCompare(null);
    if (!runId) return;
    try {
      await invokeRevenueDailyAction({ action: "cancel_daily_preview", runId });
    } catch {
      // Staging cleanup failure should not block the user from canceling the chat action.
    }
  };

  const openMaterialPicker = () => {
    setMaterialPickerOpen(true);
    setMaterialSearchDraft("");
    setMaterialSuggestions([]);
    setMaterialSuggestionError(null);
    setSupplierPickerOpen(false);
    setSupplierSuggestions([]);
    setSupplierSuggestionError(null);
    setPendingPaymentSupplierSearch(false);
  };

  const openSupplierPicker = () => {
    setSupplierPickerOpen(true);
    setSupplierSearchDraft("");
    setSupplierSuggestions([]);
    setSupplierSuggestionError(null);
    setMaterialPickerOpen(false);
    setMaterialSuggestions([]);
    setMaterialSuggestionError(null);
    setPendingPaymentSupplierSearch(true);
  };

  useEffect(() => {
    const term = materialSearchDraft.trim();
    if (!materialPickerOpen || term.length < 2) {
      setMaterialSuggestions([]);
      setIsLoadingMaterialSuggestions(false);
      setMaterialSuggestionError(null);
      return;
    }

    let cancelled = false;
    setIsLoadingMaterialSuggestions(true);
    setMaterialSuggestionError(null);

    const handle = window.setTimeout(() => {
      searchMaterialSuggestions(term)
        .then((suggestions) => {
          if (!cancelled) setMaterialSuggestions(suggestions);
        })
        .catch((e: any) => {
          if (!cancelled) {
            setMaterialSuggestions([]);
            setMaterialSuggestionError(isPaymentAgentAccessError(e) ? PAYMENT_AGENT_ACCESS_DENIED_MESSAGE : "Không tải được gợi ý NVL lúc này.");
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoadingMaterialSuggestions(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [materialPickerOpen, materialSearchDraft]);

  useEffect(() => {
    const term = supplierSearchDraft.trim();
    if (!supplierPickerOpen || term.length < 2) {
      setSupplierSuggestions([]);
      setIsLoadingSupplierSuggestions(false);
      setSupplierSuggestionError(null);
      return;
    }

    let cancelled = false;
    setIsLoadingSupplierSuggestions(true);
    setSupplierSuggestionError(null);

    const handle = window.setTimeout(() => {
      searchSupplierSuggestions(term)
        .then((suggestions) => {
          if (!cancelled) setSupplierSuggestions(suggestions);
        })
        .catch((e: any) => {
          if (!cancelled) {
            setSupplierSuggestions([]);
            setSupplierSuggestionError(isPaymentAgentAccessError(e) ? PAYMENT_AGENT_ACCESS_DENIED_MESSAGE : "Không tải được gợi ý NCC lúc này.");
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoadingSupplierSuggestions(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [supplierPickerOpen, supplierSearchDraft]);

  const runPaymentSupplierSearch = async (term: string, exactSupplier?: PaymentRequestSearchSupplier) => {
    setIsSearchingPaymentRequests(true);
    try {
      const result = await searchPaymentRequestsBySupplier(term, exactSupplier);
      pushAgent(formatPaymentSearchResults(term, result.suppliers, result.rows));
    } catch (e: any) {
      pushAgent(isPaymentAgentAccessError(e) ? PAYMENT_AGENT_ACCESS_DENIED_MESSAGE : PAYMENT_AGENT_SEARCH_ERROR_MESSAGE);
    } finally {
      setIsSearchingPaymentRequests(false);
    }
  };

  const runPaymentMaterialSearch = async (term: string, exactProductName = false) => {
    setIsSearchingPaymentRequests(true);
    try {
      const rows = await searchPaymentRequestsByMaterial(term, exactProductName);
      pushAgent(formatPaymentMaterialSearchResults(term, rows));
    } catch (e: any) {
      pushAgent(isPaymentAgentAccessError(e) ? PAYMENT_AGENT_ACCESS_DENIED_MESSAGE : PAYMENT_AGENT_SEARCH_ERROR_MESSAGE);
    } finally {
      setIsSearchingPaymentRequests(false);
    }
  };

  const submitMaterialPickerSearch = async () => {
    const term = materialSearchDraft.trim();
    if (term.length < 2 || isSearchingPaymentRequests) return;
    setMessages((prev) => [...prev, { role: "user", text: `Tìm NVL: ${term}` }]);
    setMaterialPickerOpen(false);
    await runPaymentMaterialSearch(term);
  };

  const submitSupplierPickerSearch = async () => {
    const term = supplierSearchDraft.trim();
    if (term.length < 2 || isSearchingPaymentRequests) return;
    setMessages((prev) => [...prev, { role: "user", text: `Tìm NCC: ${term}` }]);
    setSupplierPickerOpen(false);
    setPendingPaymentSupplierSearch(false);
    try {
      const normalizedSupplier = await resolveStrongSupplierSuggestion(term);
      if (normalizedSupplier) {
        const supplierName = normalizedSupplier.name || normalizedSupplier.short_code || normalizedSupplier.id;
        setSupplierSearchDraft(supplierName);
        await runPaymentSupplierSearch(supplierName, normalizedSupplier);
        return;
      }
    } catch {
      // The final search path below will show the friendly access/error message.
    }
    await runPaymentSupplierSearch(term);
  };

  const selectSupplierSuggestion = async (suggestion: SupplierSuggestion) => {
    if (isSearchingPaymentRequests) return;
    const supplierName = suggestion.name || suggestion.short_code || suggestion.id;
    setMessages((prev) => [...prev, { role: "user", text: `Chọn NCC: ${supplierName}` }]);
    setSupplierPickerOpen(false);
    setPendingPaymentSupplierSearch(false);
    setSupplierSearchDraft(supplierName);
    setSupplierSuggestions([]);
    await runPaymentSupplierSearch(supplierName, suggestion);
  };

  const selectMaterialSuggestion = async (suggestion: MaterialSuggestion) => {
    if (isSearchingPaymentRequests) return;
    setMessages((prev) => [...prev, { role: "user", text: `Chọn NVL: ${suggestion.product_name}` }]);
    setMaterialPickerOpen(false);
    setMaterialSearchDraft(suggestion.product_name);
    setMaterialSuggestions([]);
    await runPaymentMaterialSearch(suggestion.product_name, true);
  };

  const executeCreateCustomer = async () => {
    if (!pendingCreateDraft) return;
    setIsExecuting(true);
    let createdCustomerId: string | null = null;
    try {
      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({
          customer_name: pendingCreateDraft.customer_name,
          customer_group: pendingCreateDraft.customer_group,
          product_group: pendingCreateDraft.product_group,
          is_active: true,
        })
        .select("id, customer_name")
        .single();
      if (createError || !created?.id) throw createError || new Error("Không tạo được khách hàng");
      createdCustomerId = created.id;

      if (pendingCreateDraft.emails.length) {
        const { error } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(pendingCreateDraft.emails.map((email, idx) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
        if (error) throw error;
      }

      const { data: kbInserted, error: kbError } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .insert({
          customer_id: created.id,
          profile_name: pendingCreateDraft.kb_profile_name,
          po_mode: pendingCreateDraft.kb_po_mode,
          profile_status: "active",
          calculation_notes: pendingCreateDraft.kb_calc_notes,
          operational_notes: pendingCreateDraft.kb_ops_notes,
        })
        .select("id,profile_name,po_mode,profile_status,calculation_notes,operational_notes")
        .single();
      if (kbError) throw kbError;

      const versionNo = await getNextKnowledgeProfileVersion(created.id);
      const { error: verError } = await (supabase as any)
        .from("mini_crm_knowledge_profile_versions")
        .insert({
          customer_id: created.id,
          knowledge_profile_id: kbInserted?.id || null,
          version_no: versionNo,
          profile_name: kbInserted?.profile_name || pendingCreateDraft.kb_profile_name,
          po_mode: kbInserted?.po_mode || pendingCreateDraft.kb_po_mode,
          profile_status: kbInserted?.profile_status || "active",
          calculation_notes: kbInserted?.calculation_notes || pendingCreateDraft.kb_calc_notes || null,
          operational_notes: kbInserted?.operational_notes || pendingCreateDraft.kb_ops_notes || null,
          changed_by: "agent-ui-global",
          change_note: "Created from Global Agent Chat",
          is_active: true,
          effective_from: new Date().toISOString(),
        });
      if (verError) throw verError;

      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profiles"] });
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-knowledge-profile-versions"] });

      pushAgent(`✅ Đã tạo khách hàng ${created.customer_name} thành công từ Global Chat.`);
      setPendingCreateDraft(null);
      setPendingMissing([]);
      setExecutionArmed(false);
    } catch (e: any) {
      if (createdCustomerId) {
        await (supabase as any).from("mini_crm_customers").delete().eq("id", createdCustomerId);
      }
      pushAgent(`❌ Tạo khách hàng thất bại. Đã rollback nếu có dữ liệu tạm. Lỗi: ${e?.message || "Không rõ"}`);
    } finally {
      setIsExecuting(false);
    }
  };

  const sendMessage = async (text?: string) => {
    const content = String(text ?? draft).trim();
    if (!content || isSearchingPaymentRequests) return;
    setMessages((prev) => [...prev, { role: "user", text: content }]);
    setDraft("");

    if (routeContext.key === "payment_requests" && content === "Tìm đề nghị chi theo NCC") {
      openSupplierPicker();
      pushAgent('Anh nhập tên hoặc mã NCC ở khung tìm kiếm bên dưới. Ví dụ: "Thiên An Sinh" hoặc mã viết tắt NCC.');
      return;
    }

    if (routeContext.key === "payment_requests" && content === "Tìm đề nghị chi theo NVL") {
      openMaterialPicker();
      pushAgent('Anh nhập tên nguyên vật liệu/mặt hàng ở thanh tìm kiếm bên dưới. Ví dụ: "bơ anchor", "bột mì".');
      return;
    }

    if (isPaymentRequestMaterialSearch(content, routeContext.key)) {
      const term = extractMaterialSearchTerm(content);
      if (!term) {
        openMaterialPicker();
        pushAgent('Anh nhập tên nguyên vật liệu/mặt hàng ở thanh tìm kiếm bên dưới. Ví dụ: "bơ anchor", "bột mì".');
        return;
      }
      setMaterialPickerOpen(false);
      setMaterialSearchDraft(term);
      await runPaymentMaterialSearch(term);
      return;
    }

    if (routeContext.key === "payment_requests" && pendingPaymentSupplierSearch) {
      setPendingPaymentSupplierSearch(false);
      if (!isPaymentRequestNonSupplierCommand(content) && !isPaymentRequestControlCommand(content)) {
        const term = extractSupplierSearchTerm(content);
        if (term.length >= 2) {
          await runPaymentSupplierSearch(term);
          return;
        }
      }
    }

    if (routeContext.key === "crm" && /t[aạ]o\s+kh[aá]ch\s+h[aà]ng|customer/i.test(content)) {
      const { draft: parsed, missing } = parseCreateCustomerCommand(content);
      setPendingCreateDraft(parsed);
      setPendingMissing(missing);
      setExecutionArmed(false);
      if (missing.length) {
        pushAgent(`Em đã parse intent tạo khách hàng nhưng còn thiếu: ${missing.join(", ")}. Anh nhập lại đủ thông tin giúp em.`);
      } else {
        pushAgent(
          `Em đã chuẩn bị execution plan tạo khách hàng:\n- Tên: ${parsed.customer_name}\n- Group: ${parsed.customer_group}\n- Product: ${parsed.product_group}\n- Emails: ${parsed.emails.join(", ")}\n- PO mode: ${parsed.kb_po_mode}\nAnh bấm 'Confirm kế hoạch' rồi 'Thực thi ngay'.`
        );
      }
      return;
    }

    if (isPaymentRequestSupplierSearch(content, routeContext.key)) {
      const term = extractSupplierSearchTerm(content);
      if (!term) {
        openSupplierPicker();
        pushAgent('Anh nhập tên hoặc mã NCC ở khung tìm kiếm bên dưới. Ví dụ: "Thiên An Sinh" hoặc mã viết tắt NCC.');
        return;
      }

      setPendingPaymentSupplierSearch(false);
      await runPaymentSupplierSearch(term);
      return;
    }

    if (isBarePaymentRequestSupplierPhrase(content, routeContext.key)) {
      await runPaymentSupplierSearch(content);
      return;
    }

    const lower = content.toLowerCase();
    if (lower.includes("tóm tắt")) {
      pushAgent(`Em đang ở ngữ cảnh ${routeContext.label}. Em có thể hỗ trợ checklist, parse intent, và execution plan theo module này.`);
      return;
    }
    if (lower.includes("checklist")) {
      pushAgent(`Checklist nhanh cho ${routeContext.label}: 1) kiểm tra dữ liệu đầu vào, 2) preview plan, 3) confirm, 4) execute + audit.`);
      return;
    }
    pushAgent(`Em đã nhận yêu cầu trong ngữ cảnh ${routeContext.label}. Anh có thể dùng quick actions hoặc mô tả mục tiêu cụ thể hơn.`);
  };

  return (
    <>
      <Button
        type="button"
        size="icon"
        className={cn(
          "fixed z-50 rounded-full shadow-lg",
          "bg-primary text-primary-foreground hover:bg-primary/90",
          isRevenueMobileContext || isSkuCostsMobileContext
            ? "bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 h-11 w-11 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:right-6 sm:h-14 sm:w-14"
            : "right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] h-14 w-14"
        )}
        onClick={() => setOpen(true)}
        aria-label="Mở AI Agent Chat"
      >
        <MessageCircle className="h-6 w-6" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-[92vw] sm:max-w-[420px] p-0 flex flex-col">
          <SheetHeader className="px-4 pt-4 pb-3 border-b">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-primary/10 text-primary grid place-items-center"><Sparkles className="h-4 w-4" /></div>
                <div>
                  <SheetTitle className="text-base">AI Agent</SheetTitle>
                </div>
              </div>
              <Button type="button" size="icon" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-auto p-4 space-y-3 text-sm">
            {messages.length === 0 && <div className="rounded-lg border bg-muted/30 p-3">Kính chào Quý khách. Hệ thống đã nhận diện ngữ cảnh hiện tại là <b>{routeContext.label}</b>. Vui lòng nhập yêu cầu để AI Agent hỗ trợ.</div>}
            {routeContext.key === "home" && isLoadingDashboardQuickReport ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/20 p-3 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Đang tải báo cáo nhanh Dashboard...
              </div>
            ) : null}

            {isRevenueMobileContext && (
              <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Auto daily cron report</div>
                    <div className="font-semibold">Doanh thu tạm kiểm soát</div>
                  </div>
                  {isLoadingDailyReport ? <Loader2 className="mt-1 h-4 w-4 animate-spin text-muted-foreground" /> : null}
                </div>

                {dailyReportError ? <div className="text-xs text-destructive">{dailyReportError}</div> : null}

                {dailyReportLoaded && !isLoadingDailyReport && dailyReport ? (
                  <>
                    <div className="rounded-md border bg-background p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Ngày doanh thu</span>
                        <b>{dailyReport.revenueDate}</b>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-md bg-muted/40 p-2">
                          <div className="text-muted-foreground">Gross</div>
                          <div className="font-semibold">{formatVnd(revenueSummaryNumber(dailyReport.summary, "grossRevenue", "grossTotal"))}</div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-2">
                          <div className="text-muted-foreground">Dòng / SL</div>
                          <div className="font-semibold">{revenueSummaryNumber(dailyReport.summary, "lineCount", "rowCount").toLocaleString("vi-VN")} / {revenueSummaryNumber(dailyReport.summary, "quantity").toLocaleString("vi-VN")}</div>
                        </div>
                        <div className="rounded-md bg-muted/40 p-2 col-span-2">
                          <div className="text-muted-foreground">Status</div>
                          <div className="font-semibold">controlled</div>
                        </div>
                      </div>
                      <div className="text-xs text-amber-700">
                        Số này là tạm kiểm soát, chưa phải trusted/month-end audited source.
                      </div>
                      <div className="space-y-1">
                        {(dailyReport.summary.channels || []).slice(0, 4).map((channel) => (
                          <div key={channel.channel} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate">{channel.channel}</span>
                            <span className="whitespace-nowrap font-medium">{formatVnd(channelGross(channel))} · {channelRows(channel)} dòng</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={openDailyLedgerDetail}>
                        Ledger chi tiết
                      </Button>
                      {isOwner ? (
                        <Button type="button" size="sm" onClick={runDailyCompare} disabled={isRunningDailyCompare || isPostingDailyCompare}>
                          {isRunningDailyCompare ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Đang preview</> : "Chạy parse daily"}
                        </Button>
                      ) : (
                        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          Chỉ owner mới được chạy lại parse daily. Tài khoản có quyền Quản lý doanh thu vẫn xem được báo cáo daily.
                        </div>
                      )}
                    </div>
                  </>
                ) : null}

                {dailyReportLoaded && !isLoadingDailyReport && !dailyReport ? (
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground">
                      Chưa tìm thấy auto daily cron source đang active. Anh có thể chạy preview/compare cho ngày daily hiện tại trước khi quyết định ghi ledger.
                    </div>
                    {isOwner ? (
                      <Button type="button" size="sm" onClick={runDailyCompare} disabled={isRunningDailyCompare || isPostingDailyCompare}>
                        {isRunningDailyCompare ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Đang preview</> : "Chạy parse daily"}
                      </Button>
                    ) : (
                      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                        Chỉ owner mới được chạy lại parse daily. Tài khoản có quyền Quản lý doanh thu vẫn xem được báo cáo daily.
                      </div>
                    )}
                  </div>
                ) : null}

                {dailyCompare ? (
                  <div className="rounded-md border bg-background p-3 space-y-2">
                    <div className="font-medium">
                      {dailyCompare.existingReport
                        ? `So sánh parse daily ngày ${dailyCompare.revenueDate}`
                        : `Chưa có daily revenue ngày ${dailyCompare.revenueDate}`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {dailyCompare.existingReport
                        ? "Xác nhận sẽ overwrite daily revenue cũ bằng preview mới."
                        : "Xác nhận sẽ ghi vào ledger cho ngày này và cộng vào tháng hiện tại."}
                    </div>
                    {dailyCompare.requiresCancellationConfirmation ? (
                      <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 space-y-1">
                        <div className="font-semibold">Phát hiện email huỷ + PO mới trong ngày</div>
                        <div>{dailyCompare.dailyCancellationResolution?.message || "Cần xác nhận huỷ PO cũ và ghi PO mới trước khi post ledger."}</div>
                        <div>
                          Huỷ: {dailyCompare.dailyCancellationResolution?.cancelSignals?.length || 0} mail · Loại PO cũ: {dailyCompare.dailyCancellationResolution?.excludedRows?.length || 0} · PO mới: {dailyCompare.dailyCancellationResolution?.replacementRows?.length || 0}
                        </div>
                        {dailyCompare.dailyCancellationResolution?.excludedRows?.slice(0, 2).map((row, index) => (
                          <div key={`excluded-${index}`} className="text-amber-800">
                            Huỷ {String(row.poNumber || "PO cũ")} · {String(row.subject || "")}
                          </div>
                        ))}
                        {dailyCompare.dailyCancellationResolution?.replacementRows?.slice(0, 2).map((row, index) => (
                          <div key={`replacement-${index}`} className="text-amber-800">
                            Ghi mới {String(row.poNumber || "PO mới")} · {Number(row.totalAmount || 0).toLocaleString("vi-VN")}đ
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md bg-muted/40 p-2">
                        <div className="text-muted-foreground">Gross delta</div>
                        <div className="font-semibold">{formatDelta(dailyCompare.comparison.totals.delta.grossRevenue, formatVnd)}</div>
                      </div>
                      <div className="rounded-md bg-muted/40 p-2">
                        <div className="text-muted-foreground">Dòng delta</div>
                        <div className="font-semibold">{formatDelta(dailyCompare.comparison.totals.delta.lineCount)}</div>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-auto space-y-1">
                      {dailyCompare.comparison.channels.map((channel) => (
                        <div key={channel.channel} className="rounded border px-2 py-1 text-xs">
                          <div className="font-medium">{channel.channel}</div>
                          <div className="text-muted-foreground">
                            Gross {formatVnd(channel.current.grossRevenue)} → {formatVnd(channel.preview.grossRevenue)} ({formatDelta(channel.delta.grossRevenue, formatVnd)})
                          </div>
                          <div className="text-muted-foreground">
                            Dòng {channel.current.rows} → {channel.preview.rows} ({formatDelta(channel.delta.rows)}), SL {formatDelta(channel.delta.quantity)}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" onClick={confirmDailyCompare} disabled={isPostingDailyCompare}>
                        {isPostingDailyCompare
                          ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Đang ghi</>
                          : dailyCompare.requiresCancellationConfirmation
                          ? "Confirm huỷ PO cũ & ghi PO mới"
                          : dailyCompare.existingReport
                          ? "Confirm overwrite"
                          : "Confirm ghi ledger"}
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={cancelDailyCompare} disabled={isPostingDailyCompare}>
                        Hủy
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {messages.map((m, idx) => {
              const isTableLikeAgentMessage = m.role === "agent" && /\n.*\|/.test(m.text);
              return (
                <div key={`${m.role}-${idx}`} className={cn("rounded-lg border p-3", m.role === "user" ? "bg-primary/5" : "bg-background")}>
                  <div className="text-xs text-muted-foreground mb-1">{m.role === "user" ? "Anh" : "Agent"}</div>
                  {isTableLikeAgentMessage ? (
                    <pre className="overflow-x-auto whitespace-pre text-xs leading-relaxed font-mono text-foreground pb-1">{m.text}</pre>
                  ) : (
                    <div className="whitespace-pre-wrap">{m.text}</div>
                  )}
                </div>
              );
            })}

            {pendingCreateDraft && routeContext.key === "crm" && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">Execution plan (CRM)</div>
                <div>Tạo customer: <b>{pendingCreateDraft.customer_name || "-"}</b></div>
                <div>Email: <b>{pendingCreateDraft.emails.join(", ") || "-"}</b></div>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="secondary" onClick={() => setExecutionArmed(true)} disabled={pendingMissing.length > 0}>Confirm kế hoạch</Button>
                  <Button size="sm" onClick={executeCreateCustomer} disabled={!executionArmed || pendingMissing.length > 0 || isExecuting}>
                    {isExecuting ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Đang chạy</> : "Thực thi ngay"}
                  </Button>
                </div>
                {pendingMissing.length > 0 && <div className="text-amber-600 text-xs">Thiếu: {pendingMissing.join(", ")}</div>}
              </div>
            )}

            {routeContext.key === "payment_requests" && supplierPickerOpen && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
                <div className="text-xs text-muted-foreground">Tìm theo nhà cung cấp / NCC</div>
                <Input
                  value={supplierSearchDraft}
                  onChange={(event) => setSupplierSearchDraft(event.target.value)}
                  placeholder='Nhập tên/mã NCC, ví dụ "Thiên An Sinh"'
                  autoFocus
                  disabled={isSearchingPaymentRequests}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitSupplierPickerSearch();
                    }
                  }}
                />
                {supplierSearchDraft.trim().length > 0 && supplierSearchDraft.trim().length < 2 && (
                  <div className="text-xs text-muted-foreground">Nhập ít nhất 2 ký tự để tìm gợi ý.</div>
                )}
                {isLoadingSupplierSuggestions && (
                  <div className="flex items-center text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Đang tìm gợi ý...
                  </div>
                )}
                {supplierSuggestionError && <div className="text-xs text-destructive">{supplierSuggestionError}</div>}
                {supplierSearchDraft.trim().length >= 2 && !isLoadingSupplierSuggestions && !supplierSuggestionError && supplierSuggestions.length === 0 && (
                  <div className="text-xs text-muted-foreground">Chưa có gợi ý. Bấm Enter để tìm theo nội dung đã nhập.</div>
                )}
                <div className="max-h-56 overflow-auto space-y-1">
                  {supplierSuggestions.map((supplier) => {
                    const supplierName = supplier.name || supplier.short_code || supplier.id;
                    return (
                      <button
                        type="button"
                        key={supplier.id}
                        className="w-full min-w-0 rounded-md border bg-background px-2 py-2 text-left hover:bg-muted disabled:opacity-60"
                        onClick={() => selectSupplierSuggestion(supplier)}
                        disabled={isSearchingPaymentRequests}
                      >
                        <div className="min-w-0 break-words font-medium text-foreground">{supplierName}</div>
                        <div className="min-w-0 break-words text-xs text-muted-foreground">
                          {supplier.short_code ? `${supplier.short_code} · ` : ""}{supplier.pr_count ?? 0} PR
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">Chọn một NCC để tìm chính xác các đề nghị chi liên quan.</div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setSupplierPickerOpen(false);
                      setPendingPaymentSupplierSearch(false);
                    }}
                    disabled={isSearchingPaymentRequests}
                  >
                    Hủy
                  </Button>
                </div>
              </div>
            )}

            {routeContext.key === "payment_requests" && materialPickerOpen && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
                <div className="text-xs text-muted-foreground">Tìm theo nguyên vật liệu / mặt hàng</div>
                <Input
                  value={materialSearchDraft}
                  onChange={(event) => setMaterialSearchDraft(event.target.value)}
                  placeholder='Nhập NVL/mặt hàng, ví dụ "bơ anchor"'
                  autoFocus
                  disabled={isSearchingPaymentRequests}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitMaterialPickerSearch();
                    }
                  }}
                />
                {materialSearchDraft.trim().length > 0 && materialSearchDraft.trim().length < 2 && (
                  <div className="text-xs text-muted-foreground">Nhập ít nhất 2 ký tự để tìm gợi ý.</div>
                )}
                {isLoadingMaterialSuggestions && (
                  <div className="flex items-center text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Đang tìm gợi ý...
                  </div>
                )}
                {materialSuggestionError && <div className="text-xs text-destructive">{materialSuggestionError}</div>}
                {materialSearchDraft.trim().length >= 2 && !isLoadingMaterialSuggestions && !materialSuggestionError && materialSuggestions.length === 0 && (
                  <div className="text-xs text-muted-foreground">Chưa có gợi ý. Bấm Enter để tìm theo nội dung đã nhập.</div>
                )}
                <div className="max-h-56 overflow-auto space-y-1">
                  {materialSuggestions.map((item) => (
                    <button
                      type="button"
                      key={`${item.product_name}-${item.unit || ""}`}
                      className="w-full min-w-0 rounded-md border bg-background px-2 py-2 text-left hover:bg-muted disabled:opacity-60"
                      onClick={() => selectMaterialSuggestion(item)}
                      disabled={isSearchingPaymentRequests}
                    >
                      <div className="min-w-0 break-words font-medium text-foreground">{item.product_name}</div>
                      <div className="min-w-0 break-words text-xs text-muted-foreground">
                        {item.product_code ? `${item.product_code} · ` : ""}{item.unit || "-"} · {item.pr_count} PR · {item.line_count} dòng
                      </div>
                    </button>
                  ))}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">Chọn một dòng để tìm các đề nghị chi liên quan.</div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setMaterialPickerOpen(false)} disabled={isSearchingPaymentRequests}>
                    Hủy
                  </Button>
                </div>
              </div>
            )}

            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground mb-2">Quick actions theo module</div>
              <div className="flex flex-wrap gap-2">
                {routeContext.suggestions.map((s) => <Button key={s} type="button" size="sm" variant="outline" onClick={() => sendMessage(s)} disabled={isSearchingPaymentRequests}>{s}</Button>)}
              </div>
            </div>
          </div>

          <div className="border-t p-3 space-y-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Nhập yêu cầu cho AI Agent..."
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={isSearchingPaymentRequests}
            />
            <Button type="button" className="w-full" variant="secondary" onClick={() => sendMessage()} disabled={isSearchingPaymentRequests}>
              {isSearchingPaymentRequests ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Đang tìm</> : "Gửi"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
