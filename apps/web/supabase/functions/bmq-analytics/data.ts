/** Business contracts sourced from existing BMQ screens, not generic finance formulas.
 * All reads MUST use the caller's authenticated, RLS-scoped Supabase client.
 */
export const METRICS = {
  controlled_revenue: {
    label: "Doanh thu đã kiểm soát", unit: "VND",
    description: "Tổng gross_revenue của dòng approved, nguồn controlled/trusted. Không phải doanh thu thuần hay số đã audit.",
    dimensions: ["channel", "date"], source: "revenue_ledger_lines + revenue_source_documents",
  },
  purchase_order_count: {
    label: "Số đơn mua hàng", unit: "đơn mua",
    description: "Đếm purchase_orders theo order_date, mọi trạng thái giống báo cáo nhập hàng. Không phải đơn bán.",
    dimensions: ["status", "date"], source: "purchase_orders",
  },
  low_stock_count: {
    label: "Số mặt hàng tồn thấp hiện tại", unit: "mặt hàng",
    description: "Đếm inventory_items có quantity <= (min_stock hoặc 0). Snapshot hiện tại, không tái dựng tồn quá khứ, không cộng số lượng khác đơn vị.",
    dimensions: ["category"], source: "inventory_items",
  },
  supplier_debt: {
    label: "Công nợ phải trả NCC hiện tại", unit: "VND",
    description: "Đề nghị chi unpaid/partial: tổng max(total_amount - tổng payment_allocations.amount, 0). Snapshot hiện tại, không phải công nợ phải thu NPP.",
    dimensions: ["payment_method"], source: "payment_requests + payment_allocations",
  },
} as const;
export type MetricId = keyof typeof METRICS;
export type AnalyticsQuery = { metric: string; dimension: string | null; start: string; end: string; limit: number; sort?: "asc" | "desc" };
export type AnalyticsResult = { rows: Array<{ dimension: string; value: number }>; source: string; asOf: string; note: string; noteEn?: string };

// Query builders are deliberately opaque at this boundary: callers may use any
// Supabase schema generation, but only these fixed table/column lists are exposed.
// deno-lint-ignore no-explicit-any
export type ReadClient = { from(table: string): any };
type Row = Record<string, unknown>;
const MAX_ROWS = 10_000;
const PAGE_SIZE = 500;

function amount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if ((typeof value !== "number" && typeof value !== "string") || value === "") throw new Error("INVALID_NUMERIC_DATA");
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error("INVALID_NUMERIC_DATA");
  return result;
}

/** Exact counts detect server-side row caps; never report truncated totals as complete. */
async function allRows(
  // deno-lint-ignore no-explicit-any
  make: () => any, signal: AbortSignal, budget: { remaining: number },
): Promise<Row[]> {
  const rows: Row[] = [];
  const ids = new Set<string>();
  let total: number | undefined;
  do {
    signal.throwIfAborted();
    const { data, error, count } = await make().order("id", { ascending: true })
      .range(rows.length, rows.length + PAGE_SIZE - 1).abortSignal(signal);
    if (error) throw new Error("ANALYTICS_READ_FAILED");
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(data)) throw new Error("INCOMPLETE_ANALYTICS_READ");
    if (total !== undefined && count !== total) throw new Error("DATA_CHANGED_RETRY");
    total = Number(count);
    if (total > budget.remaining) throw new Error("QUERY_ROW_BUDGET_EXCEEDED");
    if (data.length !== Math.min(PAGE_SIZE, total - rows.length)) throw new Error("INCOMPLETE_ANALYTICS_READ");
    for (const row of data) {
      if (typeof row.id !== "string" || ids.has(row.id)) throw new Error("DATA_CHANGED_RETRY");
      ids.add(row.id);
      rows.push(row);
    }
  } while (rows.length < total);
  budget.remaining -= rows.length;
  signal.throwIfAborted();
  return rows;
}

export async function executeQuery(db: ReadClient, query: AnalyticsQuery, signal: AbortSignal): Promise<AnalyticsResult> {
  if (!Object.hasOwn(METRICS, query.metric)) throw new Error("UNKNOWN_METRIC");
  const metric = METRICS[query.metric as MetricId];
  if (query.dimension !== null && !(metric.dimensions as readonly string[]).includes(query.dimension)) throw new Error("INCOMPATIBLE_DIMENSION");
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 20) throw new Error("INVALID_LIMIT");
  if (query.sort !== undefined && query.sort !== "asc" && query.sort !== "desc") throw new Error("INVALID_SORT");
  const budget = { remaining: MAX_ROWS };
  let rows: Row[];
  let note: string;
  let noteEn: string;
  let value: (row: Row) => number;
  let dateColumn = "";
  if (query.metric === "controlled_revenue") {
    rows = await allRows(() => db.from("revenue_ledger_lines")
      .select("id,gross_revenue,channel,revenue_date,source_document:revenue_source_documents!inner(status)", { count: "exact" })
      .eq("approval_status", "approved").in("source_document.status", ["controlled", "trusted"])
      .gte("revenue_date", query.start).lte("revenue_date", query.end), signal, budget);
    dateColumn = "revenue_date";
    value = (row) => amount(row.gross_revenue);
    note = "Cùng định nghĩa dashboard Quản lý doanh thu: gross_revenue đã kiểm soát; không gọi là net revenue hay đã kiểm toán.";
    noteEn = "Same definition as the Revenue Management dashboard: controlled gross_revenue; not net or audited revenue.";
  } else if (query.metric === "purchase_order_count") {
    rows = await allRows(() => db.from("purchase_orders")
      .select("id,status,order_date", { count: "exact" })
      .gte("order_date", query.start).lte("order_date", query.end), signal, budget);
    dateColumn = "order_date";
    value = () => 1;
    note = "Đơn mua hàng theo order_date, gồm mọi trạng thái như báo cáo nhập hàng; không phải đơn bán hoặc số dòng doanh thu.";
    noteEn = "Purchase orders by order_date, all statuses as in the purchasing report; not sales orders or revenue line counts.";
  } else if (query.metric === "low_stock_count") {
    rows = await allRows(() => db.from("inventory_items")
      .select("id,category,quantity,min_stock", { count: "exact" }), signal, budget);
    rows = rows.filter((row) => amount(row.quantity) <= amount(row.min_stock));
    value = () => 1;
    note = "Snapshot tồn hiện tại trong inventory_items; không áp khoảng ngày yêu cầu, không bao quát sổ kho chuyên biệt. Đếm mặt hàng, không cộng lẫn đơn vị.";
    noteEn = "Current inventory_items snapshot; no historical date reconstruction or specialist warehouse ledgers. Counts items, not mixed-unit quantities.";
  } else {
    rows = await allRows(() => db.from("payment_requests")
      .select("id,total_amount,payment_method", { count: "exact" })
      .in("payment_status", ["unpaid", "partial"]), signal, budget);
    const allocations = new Map<string, number>();
    // Paginate child rows separately: embedded relation row caps must not inflate debt.
    for (let offset = 0; offset < rows.length; offset += 100) {
      const ids = rows.slice(offset, offset + 100).map((row) => row.id);
      const payments = await allRows(() => db.from("payment_allocations")
        .select("id,payment_request_id,amount", { count: "exact" })
        .in("payment_request_id", ids), signal, budget);
      for (const payment of payments) {
        const id = String(payment.payment_request_id);
        allocations.set(id, (allocations.get(id) ?? 0) + amount(payment.amount));
      }
    }
    value = (row) => Math.max(amount(row.total_amount) - (allocations.get(String(row.id)) ?? 0), 0);
    note = "Snapshot công nợ phải trả NCC hiện tại, giống useDebtStats; không áp khoảng ngày, không phải công nợ NPP/phải thu. Các lần đọc không phải một transaction snapshot.";
    noteEn = "Current supplier payables, as in useDebtStats; not historical balances or distributor receivables. Separate reads are not a transaction snapshot.";
  }
  const groups = new Map<string, number>();
  if (query.dimension === null) groups.set("Tổng", 0);
  for (const row of rows) {
    const key = query.dimension === null ? "Tổng" : String(row[query.dimension === "date" ? dateColumn : query.dimension] ?? "Chưa xác định");
    const sum = (groups.get(key) ?? 0) + value(row);
    if (!Number.isFinite(sum)) throw new Error("INVALID_NUMERIC_DATA");
    groups.set(key, sum);
  }
  signal.throwIfAborted();
  if (groups.size > query.limit) note += ` Hiển thị ${query.limit}/${groups.size} nhóm ${query.sort === "asc" ? "thấp" : "cao"} nhất, không phải toàn bộ nhóm.`;
  if (groups.size > query.limit) noteEn += ` Showing ${query.limit}/${groups.size} ${query.sort === "asc" ? "lowest" : "highest"} groups, not all groups.`;
  return {
    rows: Array.from(groups, ([dimension, value]) => ({ dimension, value }))
      .sort((a, b) => (query.sort === "asc" ? a.value - b.value : b.value - a.value) || a.dimension.localeCompare(b.dimension)).slice(0, query.limit),
    source: metric.source, asOf: new Date().toISOString(), note, noteEn,
  };
}
