/**
 * Trừ kho theo doanh thu (owner 28/10): shapes the revenue → recipe → stock snapshot into what the page shows.
 * One "PO" per channel per day = every approved revenue line of that channel that day. Each PO lists its finished
 * SKUs and the materials the cost recipe deducts, grouped by kho. Nothing here decides or writes: the deduction
 * runs automatically and the page only flags days far above the item's usual usage.
 */

export type RevenueKho = "q7" | "tan_tao";
export type MaterialState = "deducted" | "not_linked" | "not_tracked" | "no_recipe";

export interface RevenueSku { code: string; name: string; qty: number; value: number }

export interface ItemStock {
  id: string;
  name: string;
  code: string | null;
  unit: string;
  qty: Record<RevenueKho, number | null>;
  lastCount: Record<RevenueKho, string | null>;
}

export interface MaterialLine {
  key: string;
  itemId: string | null;
  name: string;
  unit: string;
  location: RevenueKho | null;
  qty: number;
  state: MaterialState;
  skus: string[];
  /**
   * "usual": the whole day for this item at this kho is more than WARN_MULTIPLE × its usual daily usage.
   * "per_unit": a weighed/measured material uses more than WARN_PER_UNIT g/ml per finished item of the channel,
   * which no bakery recipe does (catches unit mistakes on items without history).
   */
  warning:
    | { kind: "usual"; multiple: number; usual: number; dayTotal: number }
    | { kind: "per_unit"; perUnit: number }
    | null;
  /** Fewer than REFERENCE_DAYS days of history: shown as a note, never a warning. */
  noHistory: boolean;
}

export interface ChannelPo {
  channel: string;
  label: string;
  orders: number;
  customers: number;
  qty: number;
  value: number;
  skus: RevenueSku[];
  materials: Record<RevenueKho, MaterialLine[]>;
  unlinked: MaterialLine[];
  warnings: number;
}

export interface RevenueDay {
  day: string;
  generatedAt: string | null;
  channels: ChannelPo[];
  items: Map<string, ItemStock>;
  /** revenue_cogs net per kho/item/day (production_usage minus reversals). */
  posted: Map<string, { day: string; qty: number }[]>;
  totals: { channels: number; qty: number; warnings: number; materials: number };
}

export const WARN_MULTIPLE = 5;
export const REFERENCE_DAYS = 5;
export const WARN_PER_UNIT = 500;
export const KHO_ORDER: RevenueKho[] = ["tan_tao", "q7"];

const CHANNEL_LABELS: Record<string, string> = {
  "ĐẠI LÝ": "Đại lý",
  "BÁNH NGỌT": "Bánh ngọt",
};

const STATE_OF: Record<string, MaterialState> = {
  ok: "deducted",
  gap_ingredient: "not_linked",
  skipped: "not_tracked",
};

export const MATERIAL_STATE_LABELS: Record<MaterialState, string> = {
  deducted: "Tự trừ",
  not_linked: "Chưa nối kho",
  not_tracked: "Không theo dõi kho",
  no_recipe: "Thiếu công thức",
};

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const asKho = (value: unknown): RevenueKho | null => (value === "q7" || value === "tan_tao" ? value : null);
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : [];

export const channelLabel = (channel: string) =>
  CHANNEL_LABELS[channel.trim().toUpperCase()] ?? channel.trim();

const postedKey = (kho: RevenueKho, itemId: string) => `${kho}:${itemId}`;

/** Turn the raw snapshot (or RPC payload) into channels → materials → stock. Unknown shapes become empty lists. */
export function buildRevenueDay(raw: unknown): RevenueDay {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const day = text(src.day).slice(0, 10);

  const items = new Map<string, ItemStock>();
  for (const it of arr(src.items)) {
    const id = text(it.id);
    if (!id) continue;
    const qty = (it.qty ?? {}) as Record<string, unknown>;
    const last = (it.last_count ?? {}) as Record<string, unknown>;
    items.set(id, {
      id,
      name: text(it.name) || "Món không rõ tên",
      code: text(it.code) || null,
      unit: text(it.unit) || "g",
      qty: { q7: qty.q7 == null ? null : num(qty.q7), tan_tao: qty.tan_tao == null ? null : num(qty.tan_tao) },
      lastCount: { q7: text(last.q7) || null, tan_tao: text(last.tan_tao) || null },
    });
  }

  const posted = new Map<string, { day: string; qty: number }[]>();
  for (const p of arr(src.posted)) {
    const kho = asKho(p.loc);
    const itemId = text(p.item_id);
    if (!kho || !itemId) continue;
    const list = posted.get(postedKey(kho, itemId)) ?? [];
    list.push({ day: text(p.d).slice(0, 10), qty: num(p.qty) });
    posted.set(postedKey(kho, itemId), list);
  }
  for (const list of posted.values()) list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const refs = new Map<string, { ref: number | null; days: number }>();
  for (const r of arr(src.refs)) {
    const kho = asKho(r.loc);
    const itemId = text(r.item_id);
    if (kho && itemId) refs.set(postedKey(kho, itemId), { ref: r.ref == null ? null : num(r.ref), days: num(r.days) });
  }

  // The usual-day comparison is per item per kho across every channel, like the deduction itself.
  const dayTotal = new Map<string, number>();
  const materialsRaw = arr(src.materials);
  for (const m of materialsRaw) {
    const kho = asKho(m.location);
    const itemId = text(m.item_id);
    if (kho && itemId && m.status === "ok") {
      dayTotal.set(postedKey(kho, itemId), (dayTotal.get(postedKey(kho, itemId)) ?? 0) + num(m.qty));
    }
  }

  const channels: ChannelPo[] = arr(src.channels).map((c) => {
    const channel = text(c.channel);
    const skus = arr(c.skus)
      .map((s) => ({ code: text(s.code), name: text(s.name), qty: num(s.qty), value: num(s.value) }))
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "vi"));
    const materials: Record<RevenueKho, MaterialLine[]> = { tan_tao: [], q7: [] };
    const unlinked: MaterialLine[] = [];
    let warnings = 0;

    for (const m of materialsRaw.filter((x) => text(x.channel) === channel)) {
      const status = text(m.status);
      const state: MaterialState = STATE_OF[status] ?? "no_recipe";
      const kho = asKho(m.location);
      const itemId = text(m.item_id) || null;
      const item = itemId ? items.get(itemId) : undefined;
      const deducted = state === "deducted" && kho !== null && itemId !== null;
      const key = deducted ? postedKey(kho, itemId) : `${status}:${text(m.material)}`;
      const ref = deducted ? refs.get(key) : undefined;
      const total = deducted ? dayTotal.get(key) ?? 0 : 0;
      const usual = ref?.ref ?? null;
      const hasHistory = Boolean(ref && ref.days >= REFERENCE_DAYS && usual !== null && usual > 0);
      const unit = (item?.unit ?? "").trim().toLowerCase();
      const perUnit = deducted && num(c.qty) > 0 ? num(m.qty) / num(c.qty) : 0;
      const warning: MaterialLine["warning"] = deducted && hasHistory && total > WARN_MULTIPLE * (usual as number)
        ? { kind: "usual", multiple: Math.round((total / (usual as number)) * 10) / 10, usual: usual as number, dayTotal: total }
        : deducted && (unit === "g" || unit === "ml") && perUnit > WARN_PER_UNIT
          ? { kind: "per_unit", perUnit: Math.round(perUnit) }
          : null;
      if (warning) warnings += 1;
      const line: MaterialLine = {
        key: `${channel}:${key}`,
        itemId,
        name: item?.name ?? (text(m.material) || "NVL không rõ tên"),
        unit: deducted ? item?.unit ?? "g" : text(m.recipe_unit) || "",
        location: kho,
        qty: deducted ? num(m.qty) : num(m.recipe_qty),
        state,
        skus: Array.isArray(m.skus) ? m.skus.map(text).filter(Boolean) : [],
        warning,
        noHistory: deducted && !hasHistory,
      };
      if (deducted) materials[kho].push(line);
      else unlinked.push(line);
    }
    for (const kho of KHO_ORDER) {
      materials[kho].sort((a, b) => Number(Boolean(b.warning)) - Number(Boolean(a.warning)) || a.name.localeCompare(b.name, "vi"));
    }
    unlinked.sort((a, b) => a.name.localeCompare(b.name, "vi"));

    return {
      channel,
      label: channelLabel(channel),
      orders: num(c.orders),
      customers: num(c.customers),
      qty: num(c.qty),
      value: num(c.value),
      skus,
      materials,
      unlinked,
      warnings,
    };
  }).sort((a, b) => b.qty - a.qty || a.label.localeCompare(b.label, "vi"));

  return {
    day,
    generatedAt: text(src.generated_at) || null,
    channels,
    items,
    posted,
    totals: {
      channels: channels.length,
      qty: channels.reduce((sum, c) => sum + c.qty, 0),
      warnings: channels.reduce((sum, c) => sum + c.warnings, 0),
      materials: channels.reduce((sum, c) => sum + c.materials.q7.length + c.materials.tan_tao.length, 0),
    },
  };
}

/** Deductions of one item at one kho over the snapshot's last days, oldest first. */
export function recentPosted(day: RevenueDay, kho: RevenueKho, itemId: string) {
  return day.posted.get(postedKey(kho, itemId)) ?? [];
}
