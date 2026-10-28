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
    | { kind: "per_unit"; perUnit: number; blocked?: boolean }
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

/**
 * Hao hụt học từ kiểm kê (owner 29/10). Between two counts of an item at a kho the deduction booked before the
 * second count is what the system expected to be used; the count's shortfall is what was used on top of it.
 * shrink = −count adjustment ÷ booked usage. Weighted over the last 3 valid periods (≥ MIN_PERIOD_DAYS, booked > 0);
 * under SHRINK_IGNORE it counts as none; within ±SHRINK_AUTO it is applied to future deductions; beyond, it is
 * not applied and flagged (wrong recipe or loss, not shrinkage).
 */
export type ShrinkState = "none" | "even" | "applied" | "blocked";
export interface ShrinkInfo {
  state: ShrinkState;
  rate: number | null;
  periods: number;
  lastCount: { day: string; adj: number } | null;
}

export const SHRINK_AUTO = 0.15;
export const SHRINK_IGNORE = 0.02;
export const MIN_PERIOD_DAYS = 3;
const SHRINK_PERIODS = 3;

export function learnShrink(
  periods: { from: string; to: string; adj: number; booked: number }[],
  lastCount: { day: string; adj: number } | null,
): ShrinkInfo {
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const valid = periods
    .filter((p) => p.booked > 0 && days(p.from, p.to) >= MIN_PERIOD_DAYS)
    .sort((a, b) => (a.to < b.to ? 1 : -1))
    .slice(0, SHRINK_PERIODS);
  if (!valid.length) return { state: "none", rate: null, periods: 0, lastCount };
  const booked = valid.reduce((s, p) => s + p.booked, 0);
  const rate = valid.reduce((s, p) => s + -p.adj, 0) / booked;
  const rounded = Math.round(rate * 1000) / 1000;
  const state: ShrinkState = Math.abs(rate) < SHRINK_IGNORE ? "even" : Math.abs(rate) <= SHRINK_AUTO ? "applied" : "blocked";
  return { state, rate: rounded, periods: valid.length, lastCount };
}

export interface UsageFactor {
  factor: number;
  source: string;
  effectiveFrom: string;
}

export interface RevenueDay {
  day: string;
  generatedAt: string | null;
  channels: ChannelPo[];
  items: Map<string, ItemStock>;
  /** revenue_cogs net per kho/item/day (production_usage minus reversals). */
  posted: Map<string, { day: string; qty: number }[]>;
  /** Learned shrinkage per kho/item from stock counts. */
  shrink: Map<string, ShrinkInfo>;
  /** cogs_usage_factors in effect on the day, per kho/item. */
  factors: Map<string, UsageFactor>;
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

  const lastCounts = new Map<string, { day: string; adj: number }>();
  for (const c of arr(src.counts)) {
    const kho = asKho(c.loc);
    const itemId = text(c.item_id);
    if (kho && itemId) lastCounts.set(postedKey(kho, itemId), { day: text(c.d).slice(0, 10), adj: num(c.adj) });
  }
  const periodsBy = new Map<string, { from: string; to: string; adj: number; booked: number }[]>();
  for (const p of arr(src.count_periods)) {
    const kho = asKho(p.loc);
    const itemId = text(p.item_id);
    if (!kho || !itemId) continue;
    const list = periodsBy.get(postedKey(kho, itemId)) ?? [];
    list.push({ from: text(p.from).slice(0, 10), to: text(p.to).slice(0, 10), adj: num(p.adj), booked: num(p.deducted) });
    periodsBy.set(postedKey(kho, itemId), list);
  }
  const shrink = new Map<string, ShrinkInfo>();
  for (const key of new Set([...lastCounts.keys(), ...periodsBy.keys()])) {
    shrink.set(key, learnShrink(periodsBy.get(key) ?? [], lastCounts.get(key) ?? null));
  }

  const refs = new Map<string, { ref: number | null; days: number }>();
  for (const r of arr(src.refs)) {
    const kho = asKho(r.loc);
    const itemId = text(r.item_id);
    if (kho && itemId) refs.set(postedKey(kho, itemId), { ref: r.ref == null ? null : num(r.ref), days: num(r.days) });
  }

  // Server warnings from cogs_backflush_warnings. Older snapshots (the 28/10 demo) also carry a
  // "warnings" key holding owner-decision rows without a kind; those are not server warnings and
  // keep the client-side detection below. An empty server list still means "the server checked".
  const warningRows = arr(src.warnings);
  const hasServerWarnings =
    Array.isArray(src.warnings) && !warningRows.some((w) => "reason" in w || "status" in w);
  const serverWarnings = new Map<string, Record<string, unknown>>();
  if (hasServerWarnings) {
    for (const w of warningRows) {
      const kho = asKho(w.loc ?? w.location);
      const itemId = text(w.item_id);
      const kind = text(w.kind);
      if (kho && itemId && (kind === "usual" || kind === "unit")) {
        serverWarnings.set(`${postedKey(kho, itemId)}:${kind}`, w);
      }
    }
  }

  const serverWarning = (kho: RevenueKho, itemId: string): MaterialLine["warning"] => {
    const unit = serverWarnings.get(`${postedKey(kho, itemId)}:unit`);
    if (unit) return { kind: "per_unit", perUnit: num(unit.per_unit), blocked: true };
    const usual = serverWarnings.get(`${postedKey(kho, itemId)}:usual`);
    if (!usual) return null;
    const desired = num(usual.desired);
    const reference = num(usual.reference);
    return {
      kind: "usual",
      multiple: reference > 0 ? desired / reference : 0,
      usual: reference,
      dayTotal: desired,
    };
  };

  const factors = new Map<string, UsageFactor>();
  for (const f of arr(src.factors)) {
    const kho = asKho(f.loc);
    const itemId = text(f.item_id);
    if (kho && itemId) {
      factors.set(postedKey(kho, itemId), {
        factor: num(f.factor),
        source: text(f.source),
        effectiveFrom: text(f.effective_from).slice(0, 10),
      });
    }
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
      const detected: MaterialLine["warning"] = deducted && hasHistory && total > WARN_MULTIPLE * (usual as number)
        ? { kind: "usual", multiple: Math.round((total / (usual as number)) * 10) / 10, usual: usual as number, dayTotal: total }
        : deducted && (unit === "g" || unit === "ml") && perUnit > WARN_PER_UNIT
          ? { kind: "per_unit", perUnit: Math.round(perUnit) }
          : null;
      const warning = deducted && kho && itemId
        ? (hasServerWarnings ? serverWarning(kho, itemId) : detected)
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
    shrink,
    factors,
    totals: {
      channels: channels.length,
      qty: channels.reduce((sum, c) => sum + c.qty, 0),
      warnings: channels.reduce((sum, c) => sum + c.warnings, 0),
      materials: channels.reduce((sum, c) => sum + c.materials.q7.length + c.materials.tan_tao.length, 0),
    },
  };
}

export function shrinkOf(day: RevenueDay, kho: RevenueKho, itemId: string): ShrinkInfo {
  return day.shrink.get(postedKey(kho, itemId)) ?? { state: "none", rate: null, periods: 0, lastCount: null };
}

/** The usage factor in effect on the snapshot's day for one item at one kho, or null when none. */
export function factorOf(day: RevenueDay, kho: RevenueKho, itemId: string): UsageFactor | null {
  return day.factors.get(postedKey(kho, itemId)) ?? null;
}

/** Deductions of one item at one kho over the snapshot's last days, oldest first. */
export function recentPosted(day: RevenueDay, kho: RevenueKho, itemId: string) {
  return day.posted.get(postedKey(kho, itemId)) ?? [];
}
