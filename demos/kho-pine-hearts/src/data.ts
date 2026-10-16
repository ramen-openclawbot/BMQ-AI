import raw from "./data/demo.json";

export type WarehouseId = "tan_tao" | "q7";
export type Group = { code: string; label: string; color: string; icon: string };
export type Item = {
  id: string;
  code: string | null;
  name: string;
  unit: string;
  group: string;
  group_source: "master" | "guess";
  tan_tao: boolean;
  q7: boolean;
  supplier: string | null;
  last_price: number | null;
  last_unit: string | null;
  last_date: string | null;
  receipts: number;
  usage: number | null;
  days_left: number | null;
  basis: "cycle" | "cover" | null;
  suggest: number | null;
  suggest_unit: string | null;
  low: boolean;
  q7_forecast: boolean;
};

export type DebtRow = { id: string; kind: "pr" | "po"; number: string; po_number: string | null; doc_date: string; age_days: number; remaining: number; has_receipt: boolean };
export type SupplierDebt = { rows: DebtRow[]; count: number; total: number; stats: { last_paid_date?: string | null; median_lag_days?: number | null; paid_90d?: number } };
export type PendingPr = {
  id: string; number: string; title: string | null; supplier: string; amount: number; created_at: string; po_number: string | null;
  has_receipt: boolean; line_count: number; lines: Array<{ name: string; qty: number; unit: string | null; price: number | null; total: number | null }>;
};

export type DocLine = { name: string; qty: number; unit: string | null; price: number | null; total: number | null; change?: number | null };
export type DocRef = { number: string; date?: string | null; status?: string | null; amount?: number | null; has_image?: boolean; payment_status?: string | null };
export type PrDetail = {
  number: string; title: string | null; description: string | null; notes: string | null; status: string; payment_status: string; delivery_status: string | null;
  payment_type: string | null; payment_method: string | null; amount: number; vat: number | null; created_at: string; invoice_created: boolean | null;
  has_image: boolean; supplier: string | null; po: DocRef | null; gr: DocRef | null; lines: DocLine[];
};
export type PoDetail = {
  number: string; date: string | null; expected: string | null; status: string; amount: number; vat: number | null; notes: string | null; has_image: boolean;
  supplier: string | null; gr: DocRef | null; prs: DocRef[]; lines: DocLine[];
};
export const DETAILS = raw.details as unknown as { pr: Record<string, PrDetail>; po: Record<string, PoDetail> };

export const AS_OF: string = raw.as_of;
export const SUPPLIERS = raw.suppliers as unknown as Record<string, SupplierDebt>;
export const PENDING = raw.pending as unknown as PendingPr[];
export const GROUPS: Group[] = raw.groups;
export const ITEMS: Item[] = raw.items as Item[];
export const GROUP_BY_CODE = new Map(GROUPS.map((g) => [g.code, g]));

export const WAREHOUSES: Record<WarehouseId, { label: string; sub: string; emoji: string }> = {
  tan_tao: { label: "Kho Tân Tạo", sub: "Kho tổng · nhận mọi phiếu nhập", emoji: "🏭" },
  q7: { label: "Kho Q7", sub: "Bếp bánh ngọt", emoji: "🧁" },
};

export type WarehouseData = {
  id: WarehouseId;
  items: Item[];
  groups: Array<Group & { items: Item[]; low: Item[] }>;
  low: Item[];
};

export function warehouseData(id: WarehouseId): WarehouseData {
  const items = ITEMS.filter((item) => item[id]);
  const groups = GROUPS.map((g) => {
    const list = items.filter((item) => item.group === g.code);
    // Items bought recently first: they are what staff reorder; never-bought names go last.
    const byRecent = (a: Item, b: Item) => (b.last_date ?? "").localeCompare(a.last_date ?? "") || a.name.localeCompare(b.name, "vi");
    return { ...g, items: [...list].sort(byRecent), low: list.filter((item) => item.low).sort(byDaysLeft) };
  }).filter((g) => g.items.length > 0);
  return { id, items, groups, low: items.filter((item) => item.low).sort(byDaysLeft) };
}

function byDaysLeft(a: Item, b: Item) {
  return (a.days_left ?? 99) - (b.days_left ?? 99);
}

export function fold(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

export function searchItems(items: Item[], query: string): Item[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return items
    .map((item) => {
      const hay = fold(`${item.name} ${item.code ?? ""} ${item.supplier ?? ""} ${GROUP_BY_CODE.get(item.group)?.label ?? ""}`);
      if (!words.every((w) => hay.includes(w))) return null;
      const name = fold(item.name);
      const score = (name.startsWith(words[0]) ? 0 : 1) + (item.low ? -0.5 : 0) + (item.receipts ? 0 : 0.6) + name.length / 200;
      return { item, score };
    })
    .filter((row): row is { item: Item; score: number } => row !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, 30)
    .map((row) => row.item);
}

const nf = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 });
export const fmtNum = (n: number) => nf.format(n);
export const fmtMoney = (n: number) => `${nf.format(Math.round(n))}đ`;
export function fmtMillion(n: number) {
  if (n >= 1e6) return `${nf.format(Math.round(n / 1e5) / 10)} triệu`;
  if (n >= 1e3) return `${nf.format(Math.round(n / 1e3))} nghìn`;
  return fmtMoney(n);
}
export const fmtDate = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "—");

export function daysLabel(item: Item): string | null {
  if (item.days_left === null) return null;
  const d = Math.round(item.days_left);
  if (d < 0) return `Trễ ${-d} ngày`;
  if (d === 0) return "Hết hôm nay";
  return `Còn ~${d} ngày`;
}

/** Last delivery as the suggested order, in its own purchase unit. */
export function suggestLabel(item: Item): string | null {
  if (!item.suggest) return null;
  return `${fmtNum(item.suggest)} ${item.suggest_unit ?? item.unit}`;
}

/** Starting order quantity: the last delivery, else one pack-ish amount in the stock unit. */
export function startQty(item: Item): number {
  return item.suggest ?? (item.unit === "g" || item.unit === "ml" ? 1000 : 1);
}
