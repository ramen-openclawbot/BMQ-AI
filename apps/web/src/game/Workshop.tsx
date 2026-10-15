import { C, STROKE } from "./theme";
import { Bubble, Buddy, Defs, Panel } from "./Toon";

export type StationId = "merge" | "classify" | "pastry" | "links" | "jev" | "aliases" | "backlog" | "new" | "routing";

export interface Station { id: StationId; label: string; icon: string; tint: string; hint: string; count: number | null }

export const STATION_META: Record<StationId, Omit<Station, "id" | "count">> = {
  merge: { label: "Gộp tên trùng", icon: "🔗", tint: C.coral, hint: "Hai tên cùng một món" },
  classify: { label: "Phân nhóm hàng", icon: "🏷️", tint: C.mustard, hint: "Gắn nhóm mặt hàng" },
  pastry: { label: "Hàng chuyển sang Q7", icon: "🧁", tint: "#e79a6b", hint: "Món nào tự chuyển Q7" },
  links: { label: "Gắn mã hàng", icon: "🧩", tint: "#6fa3a0", hint: "Kho Q7 và Tân Tạo" },
  jev: { label: "Bé Mì rà soát", icon: "🤖", tint: C.plum, hint: "Quét trùng · phân loại · rà mã" },
  aliases: { label: "Tên đã ghép mã", icon: "📋", tint: C.sage, hint: "Tên đã học 7 ngày" },
  backlog: { label: "Tên chưa có mã", icon: "📦", tint: C.kraft, hint: "Danh sách thùng chờ" },
  new: { label: "Hàng mới chưa có mã", icon: "✨", tint: "#e5868f", hint: "Món mua 60 ngày chưa có mã" },
  routing: { label: "Nhà cung cấp về kho nào", icon: "🚚", tint: "#5f8fbf", hint: "NCC về kho nào · nhóm NVL" },
};

export const STATION_ORDER: StationId[] = ["merge", "classify", "pastry", "links", "new", "backlog", "aliases", "routing", "jev"];

interface Geo { x: number; y: number; w: number; h: number }

function StationTable({ g, station, onClick }: { g: Geo; station: Station; onClick: () => void }) {
  const cx = g.x + g.w / 2;
  return (
    <g className="tap" role="button" tabIndex={0} aria-label={`${station.label}${station.count ? `, ${station.count} việc` : ""}`} onClick={onClick} onKeyDown={(event) => { if (event.key === "Enter") onClick(); }}>
      <Panel x={g.x} y={g.y} w={g.w} h={g.h} r={18} fill={C.cream}>
        <rect x={g.x} y={g.y} width={g.w} height={30} rx={18} fill={station.tint} stroke={C.ink} strokeWidth={STROKE} />
        <rect x={g.x + 2} y={g.y + 16} width={g.w - 4} height={14} fill={station.tint} />
        <line x1={g.x} y1={g.y + 30} x2={g.x + g.w} y2={g.y + 30} stroke={C.ink} strokeWidth={STROKE} />
      </Panel>
      <circle cx={cx} cy={g.y + 72} r={27} fill={C.white} stroke={C.ink} strokeWidth={STROKE} />
      <text x={cx} y={g.y + 82} textAnchor="middle" fontSize="27">{station.icon}</text>
      <text x={cx} y={g.y + g.h - 34} textAnchor="middle" className="t-kiosk">{station.label}</text>
      <text x={cx} y={g.y + g.h - 15} textAnchor="middle" className="t-sub" fontSize="11.5">{station.hint}</text>
      {station.count ? (
        <g className="bounce" style={{ transformOrigin: `${g.x + g.w - 8}px ${g.y + 8}px` }}>
          <circle cx={g.x + g.w - 8} cy={g.y + 8} r={17} fill={C.coral} stroke={C.ink} strokeWidth={STROKE} />
          <text x={g.x + g.w - 8} y={g.y + 14} textAnchor="middle" className="t-badge" fontSize="15">{station.count > 99 ? "99+" : station.count}</text>
        </g>
      ) : null}
    </g>
  );
}

/** The catalog-cleanup workshop: one table per tool, seen from above. */
export function Workshop({ portrait, stations, onStation }: { portrait: boolean; stations: Station[]; onStation: (id: StationId) => void }) {
  const cols = portrait ? 2 : 4;
  const W = portrait ? 600 : 1280;
  const roomX = 24;
  const roomW = W - 48;
  const gap = portrait ? 26 : 34;
  const cardW = (roomW - 60 - (cols - 1) * gap) / cols;
  const cardH = 176;
  const top = 128;
  const rows = Math.ceil(stations.length / cols);
  const roomBottom = top + rows * (cardH + 34) + 40;
  const H = roomBottom + 80;
  const geo = (i: number): Geo => ({ x: roomX + 30 + (i % cols) * (cardW + gap), y: top + Math.floor(i / cols) * (cardH + 34), w: cardW, h: cardH });
  const busiest = stations.filter((s) => s.count).sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  const helper = { x: roomX + roomW - 56, y: 2 };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label="Danh mục hàng hóa">
      <Defs />
      <rect width={W} height={H} fill={C.paper} />
      <rect width={W} height={H} fill="url(#dots)" />
      <rect x={roomX + 6} y={50} width={roomW} height={roomBottom - 44} rx={22} fill={C.shadow} />
      <rect x={roomX} y={44} width={roomW} height={roomBottom - 44} rx={22} fill={C.plum} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={roomX + 12} y={56} width={roomW - 24} height={roomBottom - 68} rx={14} fill={C.paper} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={roomX + 12} y={56} width={roomW - 24} height={roomBottom - 68} rx={14} fill="url(#carpet)" />
      <g>
        <line x1={roomX + 60} y1={20} x2={roomX + 60} y2={44} stroke={C.ink} strokeWidth={STROKE} />
        <line x1={roomX + 240} y1={20} x2={roomX + 240} y2={44} stroke={C.ink} strokeWidth={STROKE} />
        <Panel x={roomX + 34} y={8} w={234} h={46} r={10} fill={C.cream}>
          <rect x={roomX + 40} y={14} width={222} height={34} rx={7} fill="none" stroke={C.plum} strokeWidth={3} />
          <text x={roomX + 151} y={39} textAnchor="middle" className="t-hang" fontSize="14" style={{ letterSpacing: 0 }} textLength={196} lengthAdjust="spacingAndGlyphs">DANH MỤC HÀNG HÓA</text>
        </Panel>
      </g>
      {stations.map((station, i) => <StationTable key={station.id} g={geo(i)} station={station} onClick={() => onStation(station.id)} />)}
      <rect x={W / 2 - 50} y={roomBottom - 8} width={100} height={14} fill={C.cream} stroke={C.ink} strokeWidth={STROKE} />
      <Buddy x={helper.x} y={helper.y + 26} mood="happy" hat="cap" face={C.mustardLight} scale={0.9} />
      <Bubble
        x={helper.x - 18}
        y={helper.y + 22}
        tail="side"
        name="Bé Mì"
        text={busiest ? `${busiest.label} đang có ${busiest.count} việc!` : "Mọi bàn đã gọn gàng ✓"}
        max={portrait ? 22 : 40}
      />
    </svg>
  );
}
