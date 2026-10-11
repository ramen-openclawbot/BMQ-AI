import { C } from "./theme";
import { CLASS_META, asClass, fmtQty, type GameClass } from "./meta";
import { Goods } from "./Toon";
import type { WarehouseGameSnapshot } from "@/lib/warehouse-game";

export interface ShelfEntry { id: string; name: string; code: string; unit: string; qty: number; aliases: number; isSku: boolean }

export function entriesFor(cls: GameClass, snapshot: WarehouseGameSnapshot): ShelfEntry[] {
  if (cls === "finished_goods" && snapshot.location === "tan_tao" && snapshot.skus.length) {
    return snapshot.skus.map((sku) => ({ id: sku.id, name: sku.product_name, code: sku.sku_code, unit: sku.unit.toLowerCase(), qty: sku.on_hand, aliases: 0, isSku: true }));
  }
  return snapshot.items
    .filter((item) => asClass(item.item_class) === cls)
    .map((item) => ({ id: item.id, name: item.name, code: item.code, unit: item.unit, qty: item.on_hand, aliases: item.aliases.length, isSku: false }));
}

/** One class opened up: a long shelf of goods cards, each tappable. */
export function Shelf({ cls, entries, started, query, onQuery, selectedId, justSaved, onPick }: {
  cls: GameClass; entries: ShelfEntry[]; started: boolean; query: string; onQuery: (q: string) => void;
  selectedId: string | null; justSaved: string | null; onPick: (entry: ShelfEntry) => void;
}) {
  const meta = CLASS_META[cls];
  const q = query.trim().toLowerCase();
  const list = q ? entries.filter((entry) => entry.name.toLowerCase().includes(q) || entry.code.toLowerCase().includes(q)) : entries;
  return (
    <div className="shelf-view">
      <div className="shelf-head">
        <div className="plaque" style={{ ["--tint" as string]: meta.tint }}>
          <span className="plaque-icon">{meta.icon}</span>
          <span>
            <b>{meta.label}</b>
            <small>{entries.length} mặt hàng · {started ? "tồn theo sổ" : "sổ chưa bắt đầu"} · bấm để xem</small>
          </span>
        </div>
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Tìm trên kệ…" aria-label="Tìm mặt hàng" />
        </label>
      </div>
      <div className="plank-wrap">
        <ul className="goods-grid">
          {list.map((entry, i) => (
            <li key={entry.id}>
              <button
                type="button"
                className={`good${entry.id === selectedId ? " is-selected" : ""}${entry.id === justSaved ? " is-saved" : ""}`}
                onClick={() => onPick(entry)}
                aria-label={entry.name}
                style={{ animationDelay: `${Math.min(i, 24) * 22}ms` }}
              >
                <svg viewBox="-24 -22 48 44" className="good-icon" aria-hidden="true">
                  <Goods x={0} y={2} unit={entry.unit} color={entry.isSku ? C.coral : i % 3 === 1 ? C.mustardLight : i % 3 === 2 ? C.cream : meta.tint} size={1.35} />
                </svg>
                <span className="good-name">{entry.name}</span>
                <span className="good-meta">
                  {started ? <><b>{fmtQty(entry.qty)}</b> {entry.unit}</> : <>{entry.isSku ? "SKU · " : ""}{entry.unit}</>}
                </span>
                {entry.aliases ? <span className="good-alias">🏷️ {entry.aliases}</span> : null}
                {entry.id === justSaved ? <span className="good-spark" aria-hidden="true">✨</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 ? <p className="empty">Không có mặt hàng nào khớp “{query}”.</p> : null}
      </div>
    </div>
  );
}
