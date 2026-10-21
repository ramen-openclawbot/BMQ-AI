import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { KHO_ITEMS_QUERY_KEY, useKhoCountItem, useKhoItems, useKhoSaveItem } from "@/hooks/useKhoItems";
import { useItemReceiptLines, useSetStockItemClass, useWarehouseGameSnapshot, WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, type StockItemClass } from "@/hooks/useWarehouseGame";
import { filterItems, khoErrorText, searchKey, standardUnitFactor, type KhoItem, type KhoLocation, type KhoSaveResult } from "@/lib/kho-items";
import type { WarehouseGamePendingRow } from "@/lib/warehouse-game";
import { Sheet } from "@/game/Sheet";
import { GamePicker } from "@/game/GamePicker";
import { ReceiptNotes } from "@/game/ReceiptNotes";
import { GameLoading } from "@/game/Loading";
import { askGame } from "@/game/ConfirmDialog";
import { usePageZoomGuard } from "@/game/zoomGuard";
import { ITEM_UNITS, newRequestId } from "@/game/meta";
import { crateKey } from "@/game/Warehouse";
import { CrateSheet } from "@/pages/WarehouseGame";
import "@/game/game.css";
import "@/game/kho2.css";

/**
 * Game kho — 2 việc (owner 21/10/2026): Danh mục (one name, one unit, on/off; documents grouped under
 * the confirmed name; three groups) and Kiểm kê (type the counted quantity, the ledger updates at once).
 * Everything else that used to live in the game is hidden; the old game stays at ?ban=cu.
 */

type View = "home" | "names" | "new" | "count";
const KHO_LABEL: Record<KhoLocation, string> = { tan_tao: "Tân Tạo", q7: "Q7" };

/** Danh mục groups (owner 21/10): Nguyên liệu · Bao bì & vật tư · Thành phẩm. */
type Group = "nl" | "bb" | "tp";
const GROUPS: { id: Group; label: string }[] = [
  { id: "nl", label: "Nguyên liệu" },
  { id: "bb", label: "Bao bì & vật tư" },
  { id: "tp", label: "Thành phẩm" },
];
/** Kho items carry item_class; non_stock (cleaning goods, ice) are supplies. Unclassified reads as Nguyên liệu. */
function groupOf(item: KhoItem): Group {
  if (item.item_class === "packaging_supply" || item.item_class === "non_stock") return "bb";
  if (item.item_class === "finished_goods") return "tp";
  return "nl";
}
const CLASS_OF: Record<Exclude<Group, "tp">, StockItemClass> = { nl: "raw_material", bb: "packaging_supply" };

/**
 * Thành phẩm in the warehouse are the Tân Tạo SKUs the owner named: frozen bánh mì que and pate 200g / 500g.
 * Fresh bánh mì que (BMQ-001) is not a stocked finished good. Stock comes from the Tân Tạo SKU ledger.
 */
const FINISHED: { sku: string; name: string }[] = [
  { sku: "BMQ-002", name: "Bánh mì que đông lạnh" },
  { sku: "PATE-200G", name: "Pate 200g" },
  { sku: "PATE-500G", name: "Pate 500g" },
];
type FinishedRow = { sku: string; name: string; unit: string; onHand: number | null };
type TanTaoSnapshot = { items?: { sku_code: string; unit?: string; on_hand_quantity?: number | string | null }[] };

function useFinishedGoods() {
  return useQuery({
    queryKey: ["tan-tao-warehouse-snapshot"],
    queryFn: async (): Promise<TanTaoSnapshot> => {
      const { data, error } = await (supabase as unknown as {
        rpc: (name: string) => Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc("get_tan_tao_warehouse_snapshot");
      if (error) throw new Error(error.message);
      return (data ?? {}) as TanTaoSnapshot;
    },
    staleTime: 60_000,
  });
}

function useGameFonts() {
  useEffect(() => {
    const id = "kg-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@600;700;800;900&display=swap";
    document.head.appendChild(link);
  }, []);
}

const todayVN = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const num = (value: number, digits = 2) => value.toLocaleString("vi-VN", { maximumFractionDigits: digits });
const dmy = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : null);

/** 166415 g reads as 166,42 kg; ml as lít. Other units stay as they are. */
export function fmtAmount(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const u = unit.trim().toLowerCase();
  if (u === "g" && Math.abs(value) >= 1000) return `${num(value / 1000)} kg`;
  if (u === "ml" && Math.abs(value) >= 1000) return `${num(value / 1000)} lít`;
  return `${num(value)} ${unit}`;
}

/** Units a person may type a count in: g items also take kg, ml items also take lít. */
function countUnits(unit: string): { label: string; factor: number }[] {
  const u = unit.trim().toLowerCase();
  if (u === "g") return [{ label: "kg", factor: 1000 }, { label: "g", factor: 1 }];
  if (u === "ml") return [{ label: "lít", factor: 1000 }, { label: "ml", factor: 1 }];
  return [{ label: unit, factor: 1 }];
}

/** Which items belong on a warehouse's count list. */
function inKho(item: KhoItem, loc: KhoLocation): boolean {
  if (!item.active) return false;
  if (loc === "q7") return item.in_q7;
  return !item.in_q7 || (item.qty.tan_tao ?? 0) !== 0;
}

/** "1,5" and "1.5" are both 1.5; with a comma present dots are thousands ("1.250,5"). */
const parseNum = (text: string) => {
  const t = text.trim().replace(/\s+/g, "");
  return Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
};

export default function KhoGame() {
  usePageZoomGuard();
  useGameFonts();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useKhoItems();
  const q7 = useWarehouseGameSnapshot("q7");
  const tt = useWarehouseGameSnapshot("tan_tao");
  const [view, setView] = useState<View>("home");
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  const data = list.data;
  const items = data?.items ?? [];
  const activeCount = items.filter((item) => item.active).length;
  const pending: { location: KhoLocation; crate: WarehouseGamePendingRow }[] = [
    ...(tt.data?.pending ?? []).map((crate) => ({ location: "tan_tao" as const, crate })),
    ...(q7.data?.pending ?? []).map((crate) => ({ location: "q7" as const, crate })),
  ];
  const today = todayVN();
  const countedToday = items.filter((item) => item.last_count_date.tan_tao === today || item.last_count_date.q7 === today).length;

  const back = () => setView(view === "new" ? "names" : "home");
  const title = view === "names" ? "Danh mục" : view === "new" ? "Hàng mới trên phiếu" : view === "count" ? "Kiểm kê" : "Game kho";
  const subtitle = view === "names" ? `${activeCount} món đang bật`
    : view === "new" ? `${pending.length} tên trên phiếu chưa có trong kho`
    : view === "count" ? "Gõ số đếm được, sổ cập nhật ngay"
    : "Danh mục · Kiểm kê";

  return (
    <div className="kg is-full k2" data-bmq-kho2 data-bmq-warehouse-game>
      <header className="hud">
        <button type="button" className="round-btn" onClick={back} disabled={view === "home"} aria-label="Quay lại">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="title-pill"><b>{title}</b><small>{subtitle}</small></div>
        <div className="k2-score" title="Số món đã đếm hôm nay" data-bmq-kho2-score><span aria-hidden="true">⭐</span><b>{countedToday}</b></div>
        <button type="button" className="round-btn exit-btn" onClick={() => navigate("/")} aria-label="Thoát về Tổng quan" title="Thoát về Tổng quan">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </header>

      <main className="stage k2-stage">
        {list.isLoading ? <GameLoading lines={["Đang mở sổ kho…", "Đang đọc danh mục…"]} />
          : list.isError ? (
            <div className="k2-wrap"><div className="err">{khoErrorText(list.error)}</div><button type="button" className="btn" onClick={() => list.refetch()}>Thử lại</button></div>
          ) : view === "home" ? (
            <Home activeCount={activeCount} offCount={items.length - activeCount} newCount={pending.length} countedToday={countedToday} onGo={setView} />
          ) : view === "names" ? (
            <NamesView items={items} canEdit={Boolean(data?.can_edit)} newCount={pending.length} onNew={() => setView("new")} onToast={setToast} />
          ) : view === "new" ? (
            <NewLinesView rows={pending} q7={q7.data} tt={tt.data} loading={q7.isLoading || tt.isLoading}
              onAssigned={(text) => {
                setToast(text);
                void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
                void list.refetch();
              }} />
          ) : (
            <CountView items={items} canCount={data?.can_count ?? { tan_tao: false, q7: false }} today={today} onToast={setToast} />
          )}
      </main>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function Home({ activeCount, offCount, newCount, countedToday, onGo }: {
  activeCount: number; offCount: number; newCount: number; countedToday: number; onGo: (view: View) => void;
}) {
  return (
    <div className="k2-home">
      <button type="button" className="k2-door is-names" onClick={() => onGo("names")} data-bmq-kho2-door="names">
        <span className="k2-door-icon" aria-hidden="true">🏷️</span>
        <span className="k2-door-text">
          <b>Danh mục</b>
          <small>Nguyên liệu, bao bì & vật tư, thành phẩm. Mỗi món một tên, một đơn vị, một nút bật/tắt.</small>
          <span className="k2-chips">
            <i>{activeCount} món đang bật</i>
            {offCount ? <i>{offCount} đã tắt</i> : null}
            {newCount ? <i className="is-hot">{newCount} tên mới trên phiếu</i> : null}
          </span>
        </span>
      </button>
      <button type="button" className="k2-door is-count" onClick={() => onGo("count")} data-bmq-kho2-door="count">
        <span className="k2-door-icon" aria-hidden="true">⚖️</span>
        <span className="k2-door-text">
          <b>Kiểm kê</b>
          <small>Chọn kho, gõ số đếm được. Sổ tồn cập nhật ngay.</small>
          <span className="k2-chips"><i>⭐ Hôm nay đã đếm {countedToday} món</i></span>
        </span>
      </button>
      <Link className="k2-slips-link" to="/warehouse/phieu" data-bmq-kho2-slips>Phiếu nhập/xuất thành phẩm Q7 và phiếu chuyển kho nằm ở trang <b>Phiếu kho</b> ›</Link>
    </div>
  );
}

/* ---------------------------------------------------------------- Danh mục */

function NamesView({ items, canEdit, newCount, onNew, onToast }: {
  items: KhoItem[]; canEdit: boolean; newCount: number; onNew: () => void; onToast: (text: string) => void;
}) {
  const [group, setGroup] = useState<Group>("nl");
  const [query, setQuery] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const save = useKhoSaveItem();
  const fg = useFinishedGoods();
  const finished = useMemo<FinishedRow[]>(() => {
    const bySku = new Map((fg.data?.items ?? []).map((row) => [row.sku_code, row]));
    return FINISHED.map(({ sku, name }) => {
      const row = bySku.get(sku);
      const onHand = row ? Number(row.on_hand_quantity ?? 0) : null;
      return { sku, name, unit: row?.unit ?? (sku.startsWith("PATE") ? "hộp" : "que"), onHand: Number.isFinite(onHand) ? onHand : null };
    });
  }, [fg.data]);
  const inGroup = useMemo(() => items.filter((item) => groupOf(item) === group), [items, group]);
  const off = inGroup.filter((item) => !item.active);
  const rows = useMemo(
    () => filterItems(inGroup, query).filter((item) => item.active !== showOff),
    [inGroup, query, showOff],
  );
  const fgRows = useMemo(() => {
    const key = searchKey(query);
    return group !== "tp" || showOff ? [] : finished.filter((row) => !key || searchKey(row.name).includes(key));
  }, [group, showOff, finished, query]);
  const counts = useMemo(() => {
    const c: Record<Group, number> = { nl: 0, bb: 0, tp: FINISHED.length };
    for (const item of items) if (item.active) c[groupOf(item)] += 1;
    return c;
  }, [items]);
  const open = items.find((item) => item.id === openId) ?? null;
  const groupLabel = GROUPS.find((g) => g.id === group)?.label.toLowerCase() ?? "";

  const flip = async (item: KhoItem) => {
    if (item.active) {
      const ok = await askGame({
        title: `Tắt “${item.name}”?`,
        message: "Món đã tắt không hiện khi đếm và khi đặt hàng. Sổ tồn giữ nguyên, bật lại lúc nào cũng được.",
        ok: "Tắt món này", cancel: "Thôi", tone: "danger",
      });
      if (!ok) return;
    }
    save.mutate(
      { itemId: item.id, name: item.name, unit: item.unit, active: !item.active, requestId: newRequestId() },
      {
        onSuccess: (result) => onToast(result.status === "saved" ? (result.item.active ? `Đã bật “${item.name}”` : `Đã tắt “${item.name}”`) : "Chưa lưu được, thử lại giúp."),
        onError: (error) => onToast(khoErrorText(error)),
      },
    );
  };

  return (
    <div className="k2-wrap">
      {newCount ? (
        <button type="button" className="k2-banner" onClick={onNew} data-bmq-kho2-new>
          <span aria-hidden="true">📦</span>
          <span><b>{newCount} tên mới trên phiếu</b><small>Chọn đúng tên trong kho một lần, các phiếu sau tự vào đúng tên.</small></span>
          <span className="pick-go">Xem</span>
        </button>
      ) : null}
      <div className="k2-groups" role="tablist" aria-label="Loại hàng" data-bmq-kho2-groups>
        {GROUPS.map((g) => (
          <button key={g.id} type="button" role="tab" aria-selected={group === g.id} className={group === g.id ? "is-on" : undefined}
            onClick={() => { setGroup(g.id); setShowOff(false); }} data-bmq-kho2-group={g.id}>
            <b>{g.label}</b><small>{counts[g.id]} món</small>
          </button>
        ))}
      </div>
      <div className="k2-tools">
        <input className="k2-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Tìm ${groupLabel}…`} aria-label={`Tìm ${groupLabel}`} />
        {group !== "tp" || off.length ? (
          <div className="loc-switch" role="tablist" aria-label="Lọc">
            <button type="button" role="tab" aria-selected={!showOff} className={!showOff ? "is-on" : undefined} onClick={() => setShowOff(false)}>Đang bật</button>
            <button type="button" role="tab" aria-selected={showOff} className={showOff ? "is-on" : undefined} onClick={() => setShowOff(true)}>Đã tắt {off.length ? `· ${off.length}` : ""}</button>
          </div>
        ) : null}
      </div>
      {!canEdit ? <p className="k2-hint">Tài khoản này chỉ xem được. Người có quyền sửa kho mới đổi được tên, đơn vị, loại hàng và bật/tắt.</p> : null}
      {group === "tp" && !showOff ? (
        <p className="k2-hint">Thành phẩm Kho Tân Tạo. Tồn lấy từ sổ thành phẩm, nhập/xuất qua phiếu kho Tân Tạo.</p>
      ) : null}
      {fgRows.length ? (
        <ul className="k2-list" data-bmq-kho2-finished>
          {fgRows.map((row) => (
            <li key={row.sku} className="k2-row is-fg" data-bmq-kho2-fg={row.sku}>
              <div className="k2-row-main">
                <b>{row.name}</b>
                <small>
                  <span className="k2-unit">{row.unit}</span>
                  <span>Tân Tạo</span>
                  <span>{fg.isLoading ? "đang đọc tồn…" : fg.isError ? "chưa đọc được tồn" : `Tồn ${fmtAmount(row.onHand, row.unit)}`}</span>
                </small>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="k2-list" data-bmq-kho2-names>
        {rows.map((item) => (
          <li key={item.id} className={`k2-row${item.active ? "" : " is-off"}`}>
            <button type="button" className="k2-row-main" onClick={() => setOpenId(item.id)} data-bmq-kho2-item={item.id}>
              <b>{item.name}</b>
              <small>
                <span className="k2-unit">{item.unit}</span>
                {item.in_q7 ? <span>Để ở Q7</span> : <span>Tân Tạo</span>}
                <span>{item.doc_lines ? `${item.doc_lines} dòng phiếu` : "chưa có phiếu"}</span>
                {!item.item_class || item.item_class === "unclassified" ? <span>chưa phân loại</span> : item.item_class === "non_stock" ? <span>không tính tồn</span> : null}
              </small>
            </button>
            {canEdit ? (
              <button type="button" role="switch" aria-checked={item.active} aria-label={item.active ? `Tắt ${item.name}` : `Bật ${item.name}`}
                className="kg-switch" disabled={save.isPending} onClick={() => void flip(item)} data-bmq-kho2-power={item.id}><i /></button>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length === 0 && fgRows.length === 0 ? <p className="k2-empty">{query ? `Không có món nào khớp “${query}”.` : showOff ? "Chưa có món nào tắt." : "Chưa có món nào."}</p> : null}
      {open ? <ItemSheet key={open.id} item={open} items={items} canEdit={canEdit} onDone={(text) => { onToast(text); setOpenId(null); }} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

type Ask = { kind: "merge"; other: { id: string; name: string; unit: string }; from: string; to: string } | { kind: "unit"; from: string; to: string };

function ItemSheet({ item, items, canEdit, onDone, onClose }: {
  item: KhoItem; items: KhoItem[]; canEdit: boolean; onDone: (text: string) => void; onClose: () => void;
}) {
  const save = useKhoSaveItem();
  const setClass = useSetStockItemClass();
  const queryClient = useQueryClient();
  const lines = useItemReceiptLines(item.id, true);
  const group = groupOf(item);
  const moveTo = (next: Exclude<Group, "tp">) => {
    if (next === group) return;
    setClass.mutate(
      { itemId: item.id, itemClass: CLASS_OF[next] },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
          onDone(`Đã chuyển “${item.name}” sang ${GROUPS.find((g) => g.id === next)?.label}`);
        },
      },
    );
  };
  const [name, setName] = useState(item.name);
  const [unit, setUnit] = useState(item.unit);
  const [active, setActive] = useState(item.active);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [factorText, setFactorText] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const unitOptions = useMemo(() => {
    const base = ITEM_UNITS.includes(item.unit) ? ITEM_UNITS : [item.unit, ...ITEM_UNITS];
    return base.map((value) => ({ value, label: value }));
  }, [item.unit]);
  // Name already used by another item? Say it before the save, the server decides.
  const twin = useMemo(() => {
    const key = searchKey(name);
    return key && key !== searchKey(item.name) ? items.find((other) => other.id !== item.id && searchKey(other.name) === key) ?? null : null;
  }, [name, items, item]);
  const changed = name.trim() !== item.name || unit !== item.unit || active !== item.active;
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const handle = (result: KhoSaveResult, other: { id: string; name: string; unit: string } | null) => {
    if (result.status === "saved") { onDone(`Đã lưu “${result.item.name}” · ${result.item.unit}${result.item.active ? "" : " · đã tắt"}`); return; }
    if (result.status === "merged") { onDone(`Đã gộp “${item.name}” vào “${result.into.name}”`); return; }
    if (result.status === "unit_factor_needed") {
      setRequestId(newRequestId());
      setFactorText("");
      setAsk(other ? { kind: "merge", other, from: result.from, to: result.to } : { kind: "unit", from: result.from, to: result.to });
      return;
    }
    // name_taken: ask once, then merge.
    void askGame({
      title: `Đã có món “${result.other.name}”`,
      message: `Gộp “${item.name}” vào “${result.other.name}” làm một? Hóa đơn, phiếu giao và tồn kho của hai tên sẽ về chung một tên.`,
      ok: "Gộp làm một", cancel: "Đặt tên khác",
    }).then((ok) => {
      if (!ok) return;
      const nextId = newRequestId();
      setRequestId(nextId);
      const target = { id: result.other.id, name: result.other.name, unit: result.other.unit };
      save.mutate({ itemId: item.id, name: name.trim(), unit, active, merge: true, requestId: nextId }, { onSuccess: (next) => handle(next, target) });
    });
  };

  const submit = () => {
    const other = ask?.kind === "merge" ? ask.other : null;
    // The server takes old -> new: 1 g = 1/x bao when 1 bao = x g.
    const unitFactor = ask && factorOk ? 1 / x : null;
    save.mutate(
      { itemId: item.id, name: name.trim(), unit, active, unitFactor, merge: other !== null, requestId },
      { onSuccess: (result) => handle(result, other) },
    );
  };

  const standard = ask ? standardUnitFactor(ask.from, ask.to) : null;

  return (
    <Sheet title={item.name} tag="🏷️ Danh mục" sub={`${item.in_q7 ? "Để ở Q7" : "Kho Tân Tạo"} · Tồn Tân Tạo ${fmtAmount(item.qty.tan_tao, item.unit)} · Q7 ${fmtAmount(item.qty.q7, item.unit)}`} onClose={onClose}>
      <label className="field">Tên duy nhất
        <input value={name} onChange={(event) => { setName(event.target.value); setAsk(null); }} maxLength={120} disabled={!canEdit} data-bmq-kho2-name />
      </label>
      {twin ? <p className="k2-hint is-warn">Đã có món “{twin.name}”. Lưu tên này sẽ hỏi gộp hai món làm một.</p> : null}
      <label className="field">Đơn vị duy nhất
        <GamePicker value={unit} onChange={(value) => { setUnit(value); setAsk(null); }} title="Đơn vị" ariaLabel="Đơn vị" options={unitOptions} disabled={!canEdit} />
      </label>
      <p className="k2-hint">Cân theo g, đong theo ml: 1 kg = 1000 g và 1 lít = 1000 ml máy tự đổi.</p>
      <div className="field">Loại hàng
        <div className="k2-units k2-class" role="group" aria-label="Loại hàng" data-bmq-kho2-class>
          {GROUPS.filter((g): g is { id: Exclude<Group, "tp">; label: string } => g.id !== "tp").map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} className={group === g.id ? "is-on" : undefined}
              disabled={!canEdit || setClass.isPending} onClick={() => moveTo(g.id)} data-bmq-kho2-class-pick={g.id}>{g.label}</button>
          ))}
        </div>
      </div>
      {setClass.error ? <div className="err">{khoErrorText(setClass.error)}</div> : null}
      <div className={`pastry-switch${active ? " is-on" : ""}`}>
        <span><b>{active ? "Đang bật" : "Đã tắt"}</b><small>{active ? "Hiện khi đếm và khi đặt hàng" : "Không hiện khi đếm, sổ tồn giữ nguyên"}</small></span>
        <button type="button" role="switch" aria-checked={active} aria-label="Bật/tắt món" className="kg-switch" disabled={!canEdit} onClick={() => setActive((v) => !v)}><i /></button>
      </div>
      {ask ? (
        <div className="k2-ask" data-bmq-kho2-ask={ask.kind}>
          <b>{ask.kind === "merge" ? `Gộp vào “${ask.other.name}” (đơn vị ${ask.to})` : `Đổi đơn vị ${ask.from} → ${ask.to}`}</b>
          {standard ? <small>Máy tự đổi theo chuẩn.</small> : (
            <>
              <small>Xem phiếu giao bên dưới rồi gõ: 1 {ask.to} bằng bao nhiêu {ask.from}?</small>
              <div className="conv">1 {ask.to} = <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`1 ${ask.to} bằng bao nhiêu ${ask.from}`} /> {ask.from}</div>
            </>
          )}
        </div>
      ) : null}
      {save.error ? <div className="err">{khoErrorText(save.error)}</div> : null}
      {canEdit ? (
        <div className="row">
          <button type="button" className="btn" disabled={save.isPending || name.trim().length < 2 || (!changed && !ask) || (ask !== null && !factorOk && !standard)} onClick={submit} data-bmq-kho2-save>
            {save.isPending ? "Đang lưu…" : ask?.kind === "merge" ? "Gộp làm một" : "Lưu"}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>Đóng</button>
        </div>
      ) : null}
      <ReceiptNotes title={`Hóa đơn, phiếu giao đã gộp vào tên này${item.doc_lines ? ` · ${item.doc_lines} dòng` : ""}`} lines={lines.data} loading={lines.isLoading} error={lines.error} />
    </Sheet>
  );
}

function NewLinesView({ rows, q7, tt, loading, onAssigned }: {
  rows: { location: KhoLocation; crate: WarehouseGamePendingRow }[];
  q7: ReturnType<typeof useWarehouseGameSnapshot>["data"]; tt: ReturnType<typeof useWarehouseGameSnapshot>["data"];
  loading: boolean; onAssigned: (text: string) => void;
}) {
  const [open, setOpen] = useState<{ location: KhoLocation; crate: WarehouseGamePendingRow } | null>(null);
  if (loading) return <GameLoading lines={["Đang đọc phiếu giao…"]} />;
  const snapshot = open ? (open.location === "q7" ? q7 : tt) : undefined;
  return (
    <div className="k2-wrap">
      <p className="k2-hint">Đây là các tên ghi trên hóa đơn, phiếu giao mà kho chưa biết là món nào. Chọn đúng tên một lần, các phiếu sau cùng nhà cung cấp tự vào đúng tên.</p>
      <ul className="k2-list" data-bmq-kho2-newlines>
        {rows.map(({ location, crate }) => (
          <li key={`${location}:${crateKey(crate)}`} className="k2-row">
            <button type="button" className="k2-row-main" onClick={() => setOpen({ location, crate })}>
              <b>“{crate.raw_name}”</b>
              <small><span>{crate.supplier_name ?? "chưa rõ nhà cung cấp"}</span><span>{crate.line_count} dòng phiếu</span><span>Kho {KHO_LABEL[location]}</span></small>
            </button>
            <span className="pick-go" aria-hidden="true">Chọn tên</span>
          </li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="k2-empty">Không còn tên mới nào. Mọi dòng phiếu đã có tên trong kho.</p> : null}
      {open && snapshot ? (
        <CrateSheet key={`${open.location}:${crateKey(open.crate)}`} location={open.location} crate={open.crate} snapshot={snapshot} autoPick
          onAssigned={(_cls, label) => { onAssigned(`“${open.crate.raw_name}” → ${label}`); setOpen(null); }}
          onClose={() => setOpen(null)} />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Kiểm kê */

function CountView({ items, canCount, today, onToast }: {
  items: KhoItem[]; canCount: { tan_tao: boolean; q7: boolean }; today: string; onToast: (text: string) => void;
}) {
  const [loc, setLoc] = useState<KhoLocation>(() => (canCount.tan_tao || !canCount.q7 ? "tan_tao" : "q7"));
  const [query, setQuery] = useState("");
  const [onlyLeft, setOnlyLeft] = useState(false);
  const all = useMemo(() => items.filter((item) => inKho(item, loc)), [items, loc]);
  const done = all.filter((item) => item.last_count_date[loc] === today).length;
  const rows = useMemo(
    () => filterItems(all, query).filter((item) => !onlyLeft || item.last_count_date[loc] !== today),
    [all, query, onlyLeft, loc, today],
  );
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div className="k2-wrap">
      <div className="k2-tools">
        <div className="loc-switch" role="tablist" aria-label="Kho">
          {(["tan_tao", "q7"] as KhoLocation[]).map((id) => (
            <button key={id} type="button" role="tab" aria-selected={loc === id} className={loc === id ? "is-on" : undefined} onClick={() => setLoc(id)} data-bmq-kho2-loc={id}>Kho {KHO_LABEL[id]}</button>
          ))}
        </div>
        <input className="k2-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm món…" aria-label="Tìm món để đếm" />
      </div>
      <div className="k2-progress" data-bmq-kho2-progress>
        <span><b>⭐ {done}</b> / {all.length} món đã đếm hôm nay</span>
        <i style={{ width: `${pct}%` }} />
        <button type="button" className={`k2-chip${onlyLeft ? " is-on" : ""}`} onClick={() => setOnlyLeft((v) => !v)}>{onlyLeft ? "Hiện tất cả" : "Chỉ món chưa đếm"}</button>
      </div>
      {!canCount[loc] ? <p className="k2-hint is-warn">Tài khoản này chưa có quyền đếm Kho {KHO_LABEL[loc]}.</p> : null}
      <ul className="k2-list" data-bmq-kho2-count={loc}>
        {rows.map((item) => <CountRow key={`${loc}:${item.id}`} item={item} loc={loc} today={today} canCount={canCount[loc]} onToast={onToast} />)}
      </ul>
      {rows.length === 0 ? <p className="k2-empty">{query ? `Không có món nào khớp “${query}”.` : onlyLeft ? "Đã đếm hết các món của kho này hôm nay. 🎉" : "Kho này chưa có món nào."}</p> : null}
    </div>
  );
}

function CountRow({ item, loc, today, canCount, onToast }: {
  item: KhoItem; loc: KhoLocation; today: string; canCount: boolean; onToast: (text: string) => void;
}) {
  const count = useKhoCountItem();
  const units = countUnits(item.unit);
  const [unitIdx, setUnitIdx] = useState(0);
  const [text, setText] = useState("");
  const [last, setLast] = useState<{ qty: number; diff: number | null } | null>(null);
  const book = item.qty[loc];
  const pendingQty = item.pending_count[loc];
  const countedToday = item.last_count_date[loc] === today;
  const value = parseNum(text);
  const ok = text.trim() !== "" && Number.isFinite(value) && value >= 0;

  const send = () => {
    const qty = Math.round(value * units[unitIdx].factor * 1000) / 1000;
    count.mutate(
      { location: loc, itemId: item.id, countedQty: qty, requestId: newRequestId() },
      {
        onSuccess: (result) => {
          const diff = Number((result.result as { difference_qty?: number }).difference_qty);
          setLast({ qty, diff: Number.isFinite(diff) ? diff : null });
          setText("");
          onToast(`⭐ ${item.name}: ${fmtAmount(qty, item.unit)}`);
        },
      },
    );
  };

  return (
    <li className={`k2-row k2-count${countedToday || last ? " is-done" : ""}`} data-bmq-kho2-countrow={item.id}>
      <div className="k2-count-head">
        <b>{item.name}</b>
        <small>
          <span>Sổ: {fmtAmount(book, item.unit)}</span>
          <span>{item.last_count_date[loc] ? `Đếm ${dmy(item.last_count_date[loc])}` : "Chưa đếm lần nào"}</span>
        </small>
      </div>
      {last ? (
        <p className="k2-done">✓ Đã ghi {fmtAmount(last.qty, item.unit)}{last.diff ? ` · chênh ${last.diff > 0 ? "+" : ""}${fmtAmount(last.diff, item.unit)}` : ""}</p>
      ) : null}
      {canCount ? (
        <div className="k2-count-input">
          <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder={countedToday ? "Đếm lại?" : "Số đếm"} aria-label={`Số đếm ${item.name}`} onKeyDown={(event) => { if (event.key === "Enter" && ok) send(); }} />
          {units.length > 1 ? (
            <div className="k2-units" role="group" aria-label="Đơn vị đếm">
              {units.map((u, idx) => <button key={u.label} type="button" className={idx === unitIdx ? "is-on" : undefined} onClick={() => setUnitIdx(idx)}>{u.label}</button>)}
            </div>
          ) : <span className="k2-unit">{units[0].label}</span>}
          <button type="button" className="btn" disabled={!ok || count.isPending} onClick={send} data-bmq-kho2-countsave>{count.isPending ? "…" : "Lưu"}</button>
        </div>
      ) : null}
      {canCount && pendingQty !== null && !last && !countedToday ? (
        <button type="button" className="k2-chip" onClick={() => { setUnitIdx(0); setText(String(num(pendingQty / units[0].factor, 3))); }}>
          Phiếu đếm cũ ghi {fmtAmount(pendingQty, item.unit)} · dùng số này
        </button>
      ) : null}
      {count.error ? <div className="err">{khoErrorText(count.error)}</div> : null}
    </li>
  );
}
