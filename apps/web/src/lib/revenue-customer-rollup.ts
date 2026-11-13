/**
 * One definition of "which customer / NPP does a revenue line belong to", shared by the revenue
 * dashboard (rows of "Doanh thu theo customer / NPP") and Chi tiết nguồn doanh thu (the page a row opens).
 * They used to compute the key differently, so a customer whose parent only lives in
 * raw_payload.parent_customer_name (e.g. Kingfoodmart) opened a source page with 0 rows.
 */

export type CustomerRollup = { key: string; name: string };

export type RollupLine = {
  customer_id?: string | null;
  parent_customer_id?: string | null;
  customer_name?: string | null;
  raw_payload?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const normalizedCustomerName = (value: string | null | undefined): string =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("vi-VN");

/** 'YYYY-MM' of the month before `period`. */
export function previousRevenuePeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const d = new Date(year, month - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Customer name → parent, learned from the previous period's lines (a child outlet keeps its parent). */
export function buildHistoricalParentMap(previousLines: readonly RollupLine[]): Map<string, CustomerRollup> {
  const map = new Map<string, CustomerRollup>();
  for (const row of previousLines) {
    const parentName = String(asRecord(row.raw_payload).parent_customer_name || "").trim();
    if (row.parent_customer_id || parentName) {
      map.set(normalizedCustomerName(row.customer_name), {
        key: row.parent_customer_id || parentName,
        name: parentName || row.customer_name || "Chưa rõ khách hàng",
      });
    }
  }
  return map;
}

export function resolveCustomerRollup(
  row: RollupLine,
  historicalParentByCustomerName: ReadonlyMap<string, CustomerRollup>,
): CustomerRollup {
  const parentName = String(asRecord(row.raw_payload).parent_customer_name || "").trim();
  if (row.parent_customer_id || parentName) {
    return {
      key: row.parent_customer_id || parentName,
      name: parentName || row.customer_name || "Chưa rõ khách hàng",
    };
  }
  const historicalParent = historicalParentByCustomerName.get(normalizedCustomerName(row.customer_name));
  if (historicalParent) return historicalParent;
  return {
    key: row.customer_id || row.customer_name || "",
    name: row.customer_name || "Chưa rõ khách hàng",
  };
}
