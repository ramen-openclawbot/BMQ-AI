import { C, STROKE } from "./theme";
import { CLASS_META, CLASS_ORDER, asClass, type GameClass } from "./meta";
import { Bubble, Buddy, CrateBuddy, Defs, Goods, Panel } from "./Toon";
import type { WarehouseGameLocation, WarehouseGamePendingRow, WarehouseGameSnapshot } from "@/lib/warehouse-game";

export interface ShelfRow { cls: GameClass; count: number; units: string[] }

/** Shelf rows present at this warehouse (Tân Tạo also stocks finished-goods SKUs). */
export function layoutRows(snapshot: WarehouseGameSnapshot): ShelfRow[] {
  const rows: ShelfRow[] = [];
  const tanTao = snapshot.location === "tan_tao";
  if (tanTao && snapshot.skus.length) {
    rows.push({ cls: "finished_goods", count: snapshot.skus.length, units: snapshot.skus.map((sku) => sku.unit.toLowerCase()) });
  }
  for (const cls of CLASS_ORDER) {
    if (tanTao && cls === "finished_goods" && snapshot.skus.length) continue;
    const list = snapshot.items.filter((item) => asClass(item.item_class) === cls);
    if (list.length) rows.push({ cls, count: list.length, units: list.map((item) => item.unit) });
  }
  return rows;
}

export const crateKey = (row: WarehouseGamePendingRow) => `${row.supplier_id ?? "-"}|${row.normalized_name}`;

interface Geo { x: number; y: number; w: number; h: number }

function Pegs({ g }: { g: Geo }) {
  const n = Math.floor(g.w / 46);
  return (
    <g>
      {Array.from({ length: n }).map((_, i) => {
        const px = g.x + 30 + i * ((g.w - 60) / Math.max(1, n - 1));
        return (
          <g key={i}>
            <path d={`M${px - 6} ${g.y - 2} v-10 h12 v10`} fill="none" stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" />
            <path d={`M${px - 6} ${g.y + g.h + 2} v10 h12 v-10`} fill="none" stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" />
          </g>
        );
      })}
    </g>
  );
}

function ShelfTable({ g, row, onClick }: { g: Geo; row: ShelfRow; onClick: () => void }) {
  const meta = CLASS_META[row.cls];
  const slots = Math.max(1, Math.floor((g.w - 220) / 34));
  const shown = row.units.slice(0, slots);
  return (
    <g className="tap" role="button" tabIndex={0} aria-label={`${meta.label}, ${row.count} mặt hàng`} onClick={onClick} onKeyDown={(event) => { if (event.key === "Enter") onClick(); }}>
      <Pegs g={g} />
      <Panel x={g.x} y={g.y} w={g.w} h={g.h} r={14} fill={C.cream}>
        <rect x={g.x + 6} y={g.y + 6} width={g.w - 12} height={g.h - 12} rx={10} fill="none" stroke={C.ink} strokeOpacity=".15" strokeWidth={2} strokeDasharray="2 6" />
      </Panel>
      {shown.map((unit, i) => (
        <Goods key={i} x={g.x + 200 + i * 34} y={g.y + g.h / 2 + 2} unit={unit} color={i % 3 === 2 ? C.cream : i % 3 === 1 ? C.mustardLight : meta.tint} size={0.95} />
      ))}
      {row.count > shown.length ? <text x={g.x + g.w - 16} y={g.y + g.h / 2 + 6} textAnchor="end" className="t-more">+{row.count - shown.length}</text> : null}
      <Panel x={g.x + 10} y={g.y + 9} w={176} h={g.h - 18} r={10} fill={meta.tint} shadow={false}>
        <text x={g.x + 22} y={g.y + g.h / 2 + 6} className="t-sign">{meta.icon} {meta.label}</text>
      </Panel>
      <circle cx={g.x + 186} cy={g.y + 4} r={15} fill={C.white} stroke={C.ink} strokeWidth={STROKE} />
      <text x={g.x + 186} y={g.y + 9} textAnchor="middle" className="t-count">{row.count}</text>
    </g>
  );
}

export function Warehouse({ portrait, location, rows, crates, flying, canAssign, onShelf, onCrate }: {
  portrait: boolean; location: WarehouseGameLocation; rows: ShelfRow[]; crates: WarehouseGamePendingRow[];
  flying: { key: string; to: GameClass } | null; canAssign: boolean;
  onShelf: (cls: GameClass) => void; onCrate: (crate: WarehouseGamePendingRow) => void;
}) {
  const cols = portrait ? 1 : 2;
  const W = portrait ? 600 : 1280;
  const roomX = 24;
  const roomW = W - 48;
  const top = 120;
  const rowH = 70;
  const rowGap = 124;
  const perCol = Math.max(1, Math.ceil(rows.length / cols));
  const colW = (roomW - 60 - (cols - 1) * 40) / cols;
  const geo = (index: number): Geo => {
    const col = Math.floor(index / perCol);
    const r = index % perCol;
    return { x: roomX + 30 + col * (colW + 40), y: top + r * rowGap, w: colW, h: rowH };
  };
  const rowsEnd = top + perCol * rowGap;
  const perLine = portrait ? 5 : 11;
  const visibleCrates = crates.slice(0, perLine * 2);
  const crateTop = rowsEnd + 40;
  const crateLines = Math.max(1, Math.ceil(visibleCrates.length / perLine));
  const roomBottom = crateTop + crateLines * 100 + 40;
  const H = roomBottom + 110;
  const cratePos = (i: number) => ({ x: roomX + 70 + (i % perLine) * ((roomW - 140) / Math.max(1, perLine - 1)), y: crateTop + 40 + Math.floor(i / perLine) * 100 });
  const rowIndex = (cls: GameClass) => rows.findIndex((row) => row.cls === cls);
  const title = location === "q7" ? "KHO Q7" : "KHO TÂN TẠO";
  const helper = { x: roomX + roomW - 56, y: 2 };
  const wall = location === "q7" ? C.mustard : C.coral;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label={`Trong ${title}`}>
      <Defs />
      <rect width={W} height={H} fill={C.paper} />
      <rect width={W} height={H} fill="url(#dots)" />
      <rect x={roomX + 6} y={50} width={roomW} height={roomBottom - 44} rx={22} fill={C.shadow} />
      <rect x={roomX} y={44} width={roomW} height={roomBottom - 44} rx={22} fill={wall} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={roomX + 12} y={56} width={roomW - 24} height={roomBottom - 68} rx={14} fill={C.paper} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={roomX + 12} y={56} width={roomW - 24} height={roomBottom - 68} rx={14} fill="url(#carpet)" />
      <g>
        <line x1={roomX + 60} y1={20} x2={roomX + 60} y2={44} stroke={C.ink} strokeWidth={STROKE} />
        <line x1={roomX + 200} y1={20} x2={roomX + 200} y2={44} stroke={C.ink} strokeWidth={STROKE} />
        <Panel x={roomX + 34} y={8} w={194} h={46} r={10} fill={C.cream}>
          <rect x={roomX + 40} y={14} width={182} height={34} rx={7} fill="none" stroke={wall} strokeWidth={3} />
          <text x={roomX + 131} y={39} textAnchor="middle" className="t-hang">{title}</text>
        </Panel>
      </g>

      {rows.map((row, index) => <ShelfTable key={row.cls} g={geo(index)} row={row} onClick={() => onShelf(row.cls)} />)}

      <rect x={roomX + 30} y={crateTop - 6} width={roomW - 60} height={crateLines * 100 + 12} rx={14} fill="url(#checker)" stroke={C.ink} strokeWidth={2.5} strokeDasharray="10 8" opacity={.9} />
      <text x={roomX + 44} y={crateTop + 14} className="t-zone">KHU CHỜ DÁN NHÃN · {crates.length}</text>
      {visibleCrates.map((crate, i) => {
        const p = cratePos(i);
        const key = crateKey(crate);
        const target = flying && flying.key === key ? rowIndex(flying.to) : -1;
        const dest = target >= 0 ? geo(target) : null;
        const style = dest ? { transform: `translate(${dest.x + dest.w - 60 - p.x}px, ${dest.y + dest.h / 2 - p.y}px) scale(.5)`, opacity: 0 } : undefined;
        return (
          <g key={key} className="tap crate-fly" style={style} role="button" tabIndex={0} aria-label={`Thùng chưa dán nhãn: ${crate.raw_name}`} onClick={() => onCrate(crate)} onKeyDown={(event) => { if (event.key === "Enter") onCrate(crate); }}>
            <CrateBuddy x={p.x} y={p.y} mood={dest ? "happy" : "worried"} label="?" />
          </g>
        );
      })}
      {crates.length > visibleCrates.length ? <text x={roomX + roomW - 44} y={crateTop + 14} textAnchor="end" className="t-zone">+{crates.length - visibleCrates.length} thùng nữa</text> : null}
      {crates.length === 0 ? <text x={W / 2} y={crateTop + 60} textAnchor="middle" className="t-sub">{canAssign ? "Không còn thùng nào chờ ✓" : "Chỉ chủ hoặc người sửa kho Q7 thấy thùng chờ"}</text> : null}

      <rect x={W / 2 - 50} y={roomBottom - 8} width={100} height={14} fill={C.cream} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={W / 2 - 44} y={roomBottom + 12} width={88} height={40} rx={6} fill="url(#checker)" stroke={C.ink} strokeWidth={2.5} />

      <Buddy x={helper.x} y={helper.y + 26} mood="happy" hat="chef" face={C.white} scale={0.9} />
      {crates.length ? <Bubble x={helper.x - 18} y={helper.y + 22} tail="side" name="Tổ trưởng kho" text={portrait ? "Thùng chờ ở cửa nha!" : "Có thùng chờ ở cửa, bấm vào để dán nhãn nha!"} max={portrait ? 22 : 46} /> : null}
    </svg>
  );
}
