import { useEffect, useState, type ReactNode } from "react";
import { C } from "./theme";
import { CLASS_META, asClass, fmtQty, type GameClass } from "./meta";
import { GoodsIcon } from "./GoodsArt";
import { Van } from "./Yard";
import type { WarehouseGameSnapshot } from "@/lib/warehouse-game";

export interface ShelfEntry { id: string; name: string; code: string; unit: string; qty: number; aliases: number; isSku: boolean; pastry?: boolean; usedRecently?: boolean }

/** ON/OFF per item (owner 21/10): editors switch goods in and out of use; stopped ones wait on the last plank. */
export interface ShelfPower {
  off: ShelfEntry[];
  busyId: string | null;
  onSwitch: (entry: ShelfEntry, on: boolean) => void;
}

/** Groups an item can be moved to by hand (same set as the item sheet's "Nhóm"). */
export type BulkClass = "raw_material" | "packaging_supply" | "finished_goods" | "non_stock";
const BULK_CLASSES: BulkClass[] = ["raw_material", "packaging_supply", "finished_goods", "non_stock"];

export function entriesFor(cls: GameClass, snapshot: WarehouseGameSnapshot): ShelfEntry[] {
  if (cls === "finished_goods" && snapshot.skus.length) {
    return snapshot.skus.map((sku) => ({ id: sku.id, name: sku.product_name, code: sku.sku_code, unit: sku.unit.toLowerCase(), qty: sku.on_hand, aliases: 0, isSku: true }));
  }
  return snapshot.items
    .filter((item) => asClass(item.item_class) === cls)
    .map((item) => ({ id: item.id, name: item.name, code: item.code, unit: item.unit, qty: item.on_hand, aliases: item.aliases.length, isSku: false, pastry: snapshot.location === "tan_tao" && item.pastry_q7 }));
}

type Where = "all" | "tan_tao" | "q7";

/** One class opened up: a long shelf of goods cards, each tappable. With `bulk`, editors can tick many and move them to a group (16/10). */
export function Shelf({ cls, entries, started, query, onQuery, selectedId, justSaved, onPick, bulk, tools, split, place, power }: {
  cls: GameClass; entries: ShelfEntry[]; started: boolean; query: string; onQuery: (q: string) => void;
  selectedId: string | null; justSaved: string | null; onPick: (entry: ShelfEntry) => void;
  bulk?: { busy: boolean; onApply: (ids: string[], target: BulkClass) => Promise<boolean> };
  /** Extra shelf actions under the search box (Q7 thành phẩm: Nhập / Xuất, 16/10). */
  tools?: ReactNode;
  /** Tân Tạo shelves: goods kept at Q7 sit on their own plank after the Tân Tạo goods (owner 16/10). */
  split?: boolean;
  /** "Để ở kho" in the bulk bar: resolves to the ids the server refused (empty = all moved), null when nothing moved. */
  place?: { busy: boolean; onApply: (ids: string[], toQ7: boolean) => Promise<string[] | null> };
  power?: ShelfPower;
}) {
  const meta = CLASS_META[cls];
  const q = query.trim().toLowerCase();
  const [where, setWhere] = useState<Where>("all");
  const [van, setVan] = useState<{ n: number; toQ7: boolean; key: number } | null>(null);
  useEffect(() => {
    if (!van) return;
    const timer = window.setTimeout(() => setVan(null), 2400);
    return () => window.clearTimeout(timer);
  }, [van]);
  const atQ7 = (entry: ShelfEntry) => Boolean(split && entry.pastry);
  const q7Count = split ? entries.filter(atQ7).length : 0;
  const matched = q ? entries.filter((entry) => entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q)) : entries;
  // The chips hide when nothing is kept at Q7, so the filter must not outlive them.
  const filter: Where = q7Count ? where : "all";
  const list = filter === "all" ? matched : matched.filter((entry) => atQ7(entry) === (filter === "q7"));
  const home = list.filter((entry) => !atQ7(entry));
  const away = list.filter(atQ7);
  const canBulk = Boolean(bulk) && entries.some((entry) => !entry.isSku);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Moved items leave this shelf: drop them from the selection.
  useEffect(() => {
    setPicked((prev) => {
      const alive = new Set(entries.map((entry) => entry.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const visibleIds = list.filter((entry) => !entry.isSku).map((entry) => entry.id);
  const allVisible = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));
  const stop = () => { setSelecting(false); setPicked(new Set()); };
  const apply = async (target: BulkClass) => {
    if (!bulk || picked.size === 0) return;
    const ok = await bulk.onApply([...picked], target);
    if (ok) stop();
  };
  const pickedEntries = entries.filter((entry) => picked.has(entry.id));
  const pickedAtQ7 = pickedEntries.filter(atQ7).length;
  const pickedAtTt = pickedEntries.length - pickedAtQ7;
  const applyPlace = async (toQ7: boolean) => {
    if (!place) return;
    const ids = pickedEntries.filter((entry) => atQ7(entry) !== toQ7).map((entry) => entry.id);
    if (!ids.length) return;
    const failed = await place.onApply(ids, toQ7);
    if (failed === null) return;
    if (ids.length > failed.length) setVan({ n: ids.length - failed.length, toQ7, key: Date.now() });
    if (failed.length) setPicked(new Set(failed)); else stop();
  };
  const offList = power ? (q ? power.off.filter((entry) => entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q)) : power.off) : [];
  const powerSwitch = (entry: ShelfEntry, on: boolean) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${entry.name}: ${on ? "đang dùng, bấm để tắt" : "đã tắt, bấm để bật lại"}`}
      className="good-power"
      disabled={power?.busyId === entry.id}
      onClick={() => power?.onSwitch(entry, !on)}
      data-bmq-power={on ? "on" : "off"}
      data-bmq-power-item={entry.id}
    >
      <span className="kg-switch" aria-hidden="true"><i /></span>
      <span className="good-power-label">{power?.busyId === entry.id ? "Đang lưu…" : on ? "Đang dùng" : "Đã tắt"}</span>
    </button>
  );
  const showPower = Boolean(power) && !selecting;
  const card = (entry: ShelfEntry, i: number) => {
    const ticked = selecting && picked.has(entry.id);
    const kept = atQ7(entry);
    return (
      <li key={entry.id} className={showPower && !entry.isSku ? "has-power" : undefined}>
        <button
          type="button"
          className={`good${kept ? " is-away" : ""}${entry.id === selectedId && !selecting ? " is-selected" : ""}${entry.id === justSaved ? " is-saved" : ""}${ticked ? " is-ticked" : ""}`}
          onClick={() => (selecting && !entry.isSku ? toggle(entry.id) : onPick(entry))}
          aria-label={entry.name}
          aria-pressed={selecting && !entry.isSku ? ticked : undefined}
          data-bmq-good={entry.id}
          data-bmq-good-at={split && !entry.isSku ? (kept ? "q7" : "tan_tao") : undefined}
          style={{ animationDelay: `${Math.min(i, 24) * 22}ms` }}
        >
          {selecting && !entry.isSku ? <span className="good-tick" aria-hidden="true">{ticked ? "✓" : ""}</span> : null}
          <svg viewBox="-24 -22 48 44" className="good-icon" aria-hidden="true">
            <GoodsIcon name={entry.name} unit={entry.unit} color={entry.isSku ? C.coral : i % 3 === 1 ? C.mustardLight : i % 3 === 2 ? C.cream : meta.tint} size={1.35} />
          </svg>
          <span className="good-name">{entry.name}</span>
          <span className="good-meta">
            {kept ? (
              // Kept at Q7: Tân Tạo only passes it on, so its place replaces the stock figure unless some is still here.
              <>{started && entry.qty ? <><b>{fmtQty(entry.qty)}</b> {entry.unit} </> : null}<b className="to-q7">→ Q7</b>{started && entry.qty ? null : <> · {entry.unit}</>}</>
            ) : started ? <><b>{fmtQty(entry.qty)}</b> {entry.unit}</> : <>{entry.isSku ? "SKU · " : ""}{entry.unit}</>}
          </span>
          {entry.aliases ? <span className="good-alias">🏷️ {entry.aliases}</span> : null}
          {entry.id === justSaved ? <span className="good-spark" aria-hidden="true">✨</span> : null}
        </button>
        {showPower && !entry.isSku ? powerSwitch(entry, true) : null}
      </li>
    );
  };
  const offCard = (entry: ShelfEntry, i: number) => (
    <li key={entry.id} className="has-power">
      <div className="good is-off" data-bmq-good-off={entry.id} style={{ animationDelay: `${Math.min(i, 24) * 22}ms` }}>
        <svg viewBox="-24 -22 48 44" className="good-icon" aria-hidden="true">
          <GoodsIcon name={entry.name} unit={entry.unit} color={C.cream} size={1.35} />
        </svg>
        <span className="good-name">{entry.name}</span>
        <span className="good-meta">{started ? <><b>{fmtQty(entry.qty)}</b> {entry.unit}</> : entry.unit}</span>
        {entry.usedRecently ? <span className="good-alias is-warn" title="7 ngày qua món này vẫn bị trừ theo công thức">⚠ còn trừ kho</span> : null}
      </div>
      {powerSwitch(entry, false)}
    </li>
  );
  return (
    <div className={`shelf-view${selecting ? " is-selecting" : ""}`}>
      <div className="shelf-head">
        <div className="plaque" style={{ ["--tint" as string]: meta.tint }}>
          <span className="plaque-icon">{meta.icon}</span>
          <span>
            <b>{meta.label}</b>
            <small>{entries.length} mặt hàng · {started ? "tồn theo sổ" : "sổ chưa bắt đầu"} · {selecting ? "bấm để chọn" : "bấm để xem"}</small>
          </span>
        </div>
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Tìm trên kệ…" aria-label="Tìm mặt hàng" />
        </label>
        {tools}
        {split && q7Count ? (
          <div className="where-chips" role="group" aria-label="Lọc theo nơi để" data-bmq-where>
            {([["all", `Tất cả ${entries.length}`], ["tan_tao", `🏭 Ở Tân Tạo ${entries.length - q7Count}`], ["q7", `🧁 Ở Q7 ${q7Count}`]] as Array<[Where, string]>).map(([key, label]) => (
              <button key={key} type="button" className={`where-chip${where === key ? " is-on" : ""}`} aria-pressed={where === key} onClick={() => setWhere(key)} data-bmq-where-chip={key}>{label}</button>
            ))}
          </div>
        ) : null}
        {canBulk ? (
          <div className="bulk-tools">
            <button type="button" className={`btn${selecting ? "" : " ghost"}`} onClick={() => (selecting ? stop() : setSelecting(true))} data-bmq-bulk-toggle aria-pressed={selecting}>
              {selecting ? "✕ Thôi chọn" : "☑ Chọn nhiều món"}
            </button>
            {selecting ? (
              <button type="button" className="btn ghost" onClick={() => setPicked((prev) => {
                const next = new Set(prev);
                if (allVisible) visibleIds.forEach((id) => next.delete(id)); else visibleIds.forEach((id) => next.add(id));
                return next;
              })} data-bmq-bulk-all>
                {allVisible ? "Bỏ chọn hết" : q ? `Chọn ${visibleIds.length} món đang lọc` : "Chọn hết"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {home.length || !away.length ? (
        <div className="plank-wrap">
          <ul className="goods-grid">{home.map((entry, i) => card(entry, i))}</ul>
          {list.length === 0 ? <p className="empty">{q ? `Không có mặt hàng nào khớp “${query}”.` : "Không có mặt hàng nào ở đây."}</p> : null}
        </div>
      ) : null}
      {away.length ? (
        <section className="plank-wrap is-q7" aria-label={`Để ở Q7, ${away.length} món`} data-bmq-q7-plank>
          <header className="q7-sign">
            <span className="q7-sign-icon" aria-hidden="true">🚚</span>
            <span><b>Để ở Q7 · {away.length} món</b><small>Nhập ở Tân Tạo xong tự chuyển sang Q7</small></span>
          </header>
          <ul className="goods-grid">{away.map((entry, i) => card(entry, home.length + i))}</ul>
        </section>
      ) : null}
      {offList.length && !selecting ? (
        <section className="plank-wrap is-off" aria-label={`Đã tắt, ${offList.length} món`} data-bmq-off-plank>
          <header className="q7-sign off-sign">
            <span className="q7-sign-icon" aria-hidden="true">🔌</span>
            <span><b>Đã tắt · {offList.length} món</b><small>Không vào robot kiểm tồn, đặt hàng, kiểm kê · tồn vẫn giữ</small></span>
          </header>
          <ul className="goods-grid">{offList.map((entry, i) => offCard(entry, i))}</ul>
        </section>
      ) : null}
      {selecting ? (
        <div className="bulk-bar" role="region" aria-label="Xếp nhóm các món đã chọn" data-bmq-bulk-bar>
          <b>{picked.size ? `Đã chọn ${picked.size} món — xếp vào nhóm:` : place ? "Bấm các món cần xếp nhóm hoặc đổi nơi để" : "Bấm các món cần xếp nhóm"}</b>
          <div className="bulk-classes">
            {BULK_CLASSES.filter((target) => target !== cls).map((target) => (
              <button key={target} type="button" className="class-chip" style={{ ["--chip" as string]: CLASS_META[target].tint }} disabled={!picked.size || bulk?.busy} onClick={() => void apply(target)} data-bmq-bulk-class={target}>
                <i aria-hidden="true">{CLASS_META[target].icon}</i>{CLASS_META[target].label}
              </button>
            ))}
          </div>
          {place ? (
            <>
              <small className="bulk-label">Để ở kho:</small>
              <div className="bulk-places">
                <button type="button" className="place-chip" disabled={!pickedAtQ7 || place.busy} onClick={() => void applyPlace(false)} data-bmq-bulk-place="tan_tao">
                  <i aria-hidden="true">🏭</i><span>Tân Tạo<small>{pickedAtQ7 ? `${pickedAtQ7} món về` : "—"}</small></span>
                </button>
                <button type="button" className="place-chip is-q7" disabled={!pickedAtTt || place.busy} onClick={() => void applyPlace(true)} data-bmq-bulk-place="q7">
                  <i aria-hidden="true">🧁</i><span>Q7<small>{place.busy ? "đang chở…" : pickedAtTt ? `${pickedAtTt} món sang` : "—"}</small></span>
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {van ? (
        <div key={van.key} className={`q7-van-run${van.toQ7 ? "" : " is-back"}`} role="status" data-bmq-q7-van={van.toQ7 ? "q7" : "tan_tao"}>
          <div className="q7-road">
            <span className="q7-end">🏭 Tân Tạo</span>
            <span className="q7-end">🧁 Q7</span>
            <svg className="q7-van" viewBox="-72 -42 146 84" aria-hidden="true"><g transform={van.toQ7 ? undefined : "scale(-1 1)"}><Van color="#e79a6b" /></g></svg>
          </div>
          <b>{van.n} món {van.toQ7 ? "đã để ở Q7" : "về lại Tân Tạo"}</b>
        </div>
      ) : null}
    </div>
  );
}
