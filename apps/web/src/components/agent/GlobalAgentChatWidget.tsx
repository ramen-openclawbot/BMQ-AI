/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageCircle, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

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
  unit?: string | null;
  payment_request_id?: string | null;
  created_at?: string | null;
  quantity?: number | null;
  qty?: number | null;
  unit_price?: number | null;
  price?: number | null;
  line_total?: number | null;
  line_amount?: number | null;
  total_amount?: number | null;
  amount?: number | null;
  subtotal?: number | null;
  total?: number | null;
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
  if (pathname === "/finance-control/revenue") return { key: "finance_revenue", label: "Quản lý doanh thu", suggestions: ["Doanh thu tháng này", "Dòng cần audit", "Top customer"] };
  if (pathname.startsWith("/finance-control/revenue/sources")) return { key: "finance_revenue_sources", label: "Chi tiết nguồn doanh thu", suggestions: ["Dòng nào cần kiểm tra", "So sánh CSV và PO", "Gợi ý audit"] };
  if (pathname === "/finance-control/revenue/setup") return { key: "finance_revenue_setup", label: "Thiết lập doanh thu", suggestions: ["Checklist posting", "Đối soát doanh thu", "Cấu hình parser"] };
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

function getMaterialLineAmount(item: PaymentRequestMaterialItem): number {
  const directKeys: Array<keyof PaymentRequestMaterialItem> = ["line_total", "line_amount", "total_amount", "amount", "subtotal", "total"];
  for (const key of directKeys) {
    const value = Number(item[key] || 0);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const quantity = Number(item.quantity ?? item.qty ?? 0);
  const unitPrice = Number(item.unit_price ?? item.price ?? 0);
  if (Number.isFinite(quantity) && Number.isFinite(unitPrice) && quantity > 0 && unitPrice > 0) return quantity * unitPrice;
  return 0;
}

function aggregateMaterialSuggestions(rows: PaymentRequestMaterialItem[]): MaterialSuggestion[] {
  const suggestionMap = new Map<string, MaterialSuggestion & { requestIds: Set<string> }>();

  rows.forEach((row) => {
    const productName = String(row.product_name || "").trim();
    if (!productName) return;

    const unit = row.unit || null;
    const productCode = row.product_code || null;
    const key = `${productName.toLowerCase()}__${String(unit || "").toLowerCase()}`;
    const current = suggestionMap.get(key) || {
      product_name: productName,
      product_code: productCode,
      unit,
      pr_count: 0,
      line_count: 0,
      latest_item_at: row.created_at || null,
      requestIds: new Set<string>(),
    };

    current.line_count += 1;
    if (!current.product_code && productCode) current.product_code = productCode;
    if (row.payment_request_id) current.requestIds.add(row.payment_request_id);
    if (row.created_at && (!current.latest_item_at || new Date(row.created_at).getTime() > new Date(current.latest_item_at).getTime())) {
      current.latest_item_at = row.created_at;
    }
    current.pr_count = current.requestIds.size;
    suggestionMap.set(key, current);
  });

  return Array.from(suggestionMap.values())
    .sort((a, b) => {
      if (b.pr_count !== a.pr_count) return b.pr_count - a.pr_count;
      const dateA = new Date(a.latest_item_at || 0).getTime();
      const dateB = new Date(b.latest_item_at || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return b.line_count - a.line_count;
    })
    .slice(0, 10)
    .map(({ requestIds: _requestIds, ...suggestion }) => suggestion);
}

async function searchMaterialSuggestions(term: string): Promise<MaterialSuggestion[]> {
  const pattern = `%${term.replace(/[%_]/g, "\\$&")}%`;
  const { data, error } = await (supabase as any)
    .from("payment_request_items")
    .select("product_name,product_code,unit,payment_request_id,created_at")
    .or(`product_name.ilike.${pattern},product_code.ilike.${pattern}`)
    .order("created_at", { ascending: false })
    .limit(80);

  if (error) throw error;
  return aggregateMaterialSuggestions(data || []);
}

async function searchSupplierSuggestions(term: string): Promise<SupplierSuggestion[]> {
  const pattern = `%${term.replace(/[%_]/g, "\\$&")}%`;
  const [nameResult, shortCodeResult] = await Promise.all([
    (supabase as any).from("suppliers").select("id,name,short_code").ilike("name", pattern).limit(10),
    (supabase as any).from("suppliers").select("id,name,short_code").ilike("short_code", pattern).limit(10),
  ]);

  if (nameResult.error) throw nameResult.error;
  if (shortCodeResult.error) throw shortCodeResult.error;

  const supplierMap = new Map<string, PaymentRequestSearchSupplier>();
  [...(nameResult.data || []), ...(shortCodeResult.data || [])].forEach((supplier: PaymentRequestSearchSupplier) => {
    if (supplier?.id) supplierMap.set(supplier.id, supplier);
  });
  const suppliers = Array.from(supplierMap.values()).slice(0, 10);
  if (!suppliers.length) return [];

  const counts = new Map<string, number>();
  const { data: requestData } = await (supabase as any)
    .from("payment_requests")
    .select("id,supplier_id")
    .in("supplier_id", suppliers.map((supplier) => supplier.id))
    .limit(1000);

  (requestData || []).forEach((row: Pick<PaymentRequestSearchRow, "supplier_id">) => {
    if (row.supplier_id) counts.set(row.supplier_id, (counts.get(row.supplier_id) || 0) + 1);
  });

  return suppliers.map((supplier) => ({ ...supplier, pr_count: counts.get(supplier.id) || 0 }));
}

async function searchPaymentRequestsBySupplier(term: string, exactSupplier?: PaymentRequestSearchSupplier): Promise<{ suppliers: PaymentRequestSearchSupplier[]; rows: PaymentRequestSearchRow[] }> {
  let suppliers: PaymentRequestSearchSupplier[] = [];

  if (exactSupplier?.id) {
    suppliers = [exactSupplier];
  } else {
    const pattern = `%${term.replace(/[%_]/g, "\\$&")}%`;
    const [nameResult, shortCodeResult] = await Promise.all([
      (supabase as any).from("suppliers").select("id,name,short_code").ilike("name", pattern).limit(10),
      (supabase as any).from("suppliers").select("id,name,short_code").ilike("short_code", pattern).limit(10),
    ]);

    if (nameResult.error) throw nameResult.error;
    if (shortCodeResult.error) throw shortCodeResult.error;

    const supplierMap = new Map<string, PaymentRequestSearchSupplier>();
    [...(nameResult.data || []), ...(shortCodeResult.data || [])].forEach((supplier: PaymentRequestSearchSupplier) => {
      if (supplier?.id) supplierMap.set(supplier.id, supplier);
    });
    suppliers = Array.from(supplierMap.values()).slice(0, 10);
  }

  if (!suppliers.length) return { suppliers: [], rows: [] };

  let requestQuery = (supabase as any)
    .from("payment_requests")
    .select("id,request_number,title,total_amount,payment_status,payment_method,status,approved_at,created_at,updated_at,invoice_id,supplier_id,invoices!payment_requests_invoice_id_fkey(invoice_number,invoice_date),suppliers!payment_requests_supplier_id_fkey(name,short_code)")
    .order("created_at", { ascending: false })
    .limit(100);

  requestQuery = exactSupplier?.id
    ? requestQuery.eq("supplier_id", exactSupplier.id)
    : requestQuery.in("supplier_id", suppliers.map((supplier) => supplier.id));

  const { data, error } = await requestQuery;

  if (error) throw error;
  return { suppliers, rows: data || [] };
}

async function searchPaymentRequestsByMaterial(term: string, exactProductName = false): Promise<PaymentRequestMaterialSearchRow[]> {
  const pattern = `%${term.replace(/[%_]/g, "\\$&")}%`;
  let itemQuery = (supabase as any).from("payment_request_items").select("*").order("created_at", { ascending: false }).limit(200);

  if (exactProductName) {
    itemQuery = itemQuery.eq("product_name", term);
  } else {
    itemQuery = itemQuery.or(`product_name.ilike.${pattern},product_code.ilike.${pattern}`);
  }

  const { data: itemData, error: itemError } = await itemQuery;
  if (itemError) throw itemError;

  const items: PaymentRequestMaterialItem[] = itemData || [];
  const requestIds = Array.from(new Set(items.map((item) => item.payment_request_id).filter(Boolean))) as string[];
  if (!requestIds.length) return [];

  const { data: requestData, error: requestError } = await (supabase as any)
    .from("payment_requests")
    .select("id,request_number,title,total_amount,payment_status,payment_method,status,approved_at,created_at,updated_at,invoice_id,supplier_id,invoices!payment_requests_invoice_id_fkey(invoice_number,invoice_date),suppliers!payment_requests_supplier_id_fkey(name,short_code)")
    .in("id", requestIds)
    .order("created_at", { ascending: false })
    .limit(100);

  if (requestError) throw requestError;

  const requestMap = new Map<string, PaymentRequestSearchRow>((requestData || []).map((row: PaymentRequestSearchRow) => [row.id, row]));
  const itemAggregate = new Map<string, { matching_line_total: number; matching_line_count: number; matching_products: Set<string> }>();

  items.forEach((item) => {
    if (!item.payment_request_id) return;
    const current = itemAggregate.get(item.payment_request_id) || { matching_line_total: 0, matching_line_count: 0, matching_products: new Set<string>() };
    current.matching_line_total += getMaterialLineAmount(item);
    current.matching_line_count += 1;
    if (item.product_name) current.matching_products.add(item.product_name);
    itemAggregate.set(item.payment_request_id, current);
  });

  return Array.from(itemAggregate.entries()).flatMap(([requestId, aggregate]) => {
    const request = requestMap.get(requestId);
    if (!request) return [];
    return [{
      ...request,
      matching_line_total: aggregate.matching_line_total,
      matching_line_count: aggregate.matching_line_count,
      matching_products: Array.from(aggregate.matching_products),
    }];
  });
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
  const queryClient = useQueryClient();
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

  const routeContext = useMemo(() => getRouteContext(location.pathname), [location.pathname]);

  const pushAgent = (text: string) => setMessages((prev) => [...prev, { role: "agent", text }]);

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
            setMaterialSuggestionError(e?.message || "Không tải được gợi ý NVL");
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
            setSupplierSuggestionError(e?.message || "Không tải được gợi ý NCC");
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
      pushAgent(`Em chưa tìm được dữ liệu duyệt chi. Lỗi: ${e?.message || "Không rõ"}`);
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
      pushAgent(`Em chưa tìm được dữ liệu duyệt chi theo NVL. Lỗi: ${e?.message || "Không rõ"}`);
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
        className={cn("fixed z-50 right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))]", "h-14 w-14 rounded-full shadow-lg", "bg-primary text-primary-foreground hover:bg-primary/90")}
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
