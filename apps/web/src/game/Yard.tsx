import { C, STROKE } from "./theme";
import type { WarehouseGameLocation as Location } from "@/lib/warehouse-game";
import { Bubble, Buddy, Defs, Panel, Puffs } from "./Toon";

export interface Zone { id: string; label: string; icon: string; blurb: string; color: string }

export const ZONES: Zone[] = [
  { id: "deliver", label: "Giao hàng", icon: "🚛", color: C.kraft, blurb: "Nhập số thực giao và chụp ảnh hàng cho từng phiếu xuất." },
  { id: "ledger", label: "Tồn kho", icon: "📒", color: C.sage, blurb: "Tự cộng từ phiếu nhập, tự trừ từ phiếu xuất sản xuất. Kiểm kê hằng tuần." },
  { id: "count", label: "Kiểm kê", icon: "✅", color: C.plum, blurb: "Đếm thực tế rồi nhập số; sổ tự ghi phần chênh lệch." },
  { id: "auto", label: "Đặt hàng tự động", icon: "🤖", color: C.coral, blurb: "Kéo món sắp hết cho robot: PO mới + trả đơn cũ, lên Zalo Duyệt chi." },
  { id: "clean", label: "Danh mục hàng hóa", icon: "🧹", color: C.mustard, blurb: "Bé Mì gộp tên trùng, gán nhóm, học tên gọi khác từ phiếu nhập." },
];

interface Rect { x: number; y: number; w: number; h: number }

function Tap({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <g className="tap" role="button" tabIndex={0} aria-label={label} onClick={onClick} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onClick(); }}>
      {children}
    </g>
  );
}

/** Warehouse seen from above: corrugated roof, skylights, name plate, door + mat on the street side. */
function Building({ r, roof, title, sub, crates, door, onClick }: {
  r: Rect; roof: string; title: string; sub: string; crates: number; door: "left" | "bottom"; onClick: () => void;
}) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const mat = door === "left"
    ? { x: r.x - 34, y: cy - 34, w: 34, h: 68 }
    : { x: cx - 40, y: r.y + r.h, w: 80, h: 34 };
  const gap = door === "left"
    ? <rect x={r.x - 2} y={cy - 26} width={8} height={52} fill={C.cream} stroke={C.ink} strokeWidth={STROKE} />
    : <rect x={cx - 30} y={r.y + r.h - 6} width={60} height={8} fill={C.cream} stroke={C.ink} strokeWidth={STROKE} />;
  return (
    <Tap label={title} onClick={onClick}>
      <rect x={mat.x} y={mat.y} width={mat.w} height={mat.h} rx={4} fill="url(#checker)" stroke={C.ink} strokeWidth={2.5} />
      <Panel x={r.x} y={r.y} w={r.w} h={r.h} r={16} fill={roof}>
        <rect x={r.x + 10} y={r.y + 10} width={r.w - 20} height={r.h - 20} rx={10} fill="url(#roof)" stroke={C.ink} strokeOpacity=".25" strokeWidth={2} />
        {[0.22, 0.78].map((t) => (
          <rect key={t} x={r.x + r.w * t - 22} y={r.y + 22} width={44} height={26} rx={5} fill={C.cream} stroke={C.ink} strokeWidth={2.5} opacity={.92} />
        ))}
        {[0.22, 0.78].map((t) => (
          <rect key={`b${t}`} x={r.x + r.w * t - 22} y={r.y + r.h - 48} width={44} height={26} rx={5} fill={C.cream} stroke={C.ink} strokeWidth={2.5} opacity={.92} />
        ))}
      </Panel>
      {gap}
      {/* name plate */}
      <Panel x={cx - 92} y={cy - 38} w={184} h={76} r={14} fill={C.cream}>
        <text x={cx} y={cy - 6} textAnchor="middle" className="t-title">{title}</text>
        <text x={cx} y={cy + 18} textAnchor="middle" className="t-sub">{sub}</text>
      </Panel>
      {crates > 0 ? (
        <g className="bounce" style={{ transformOrigin: `${r.x + r.w - 6}px ${r.y + 6}px` }}>
          <circle cx={r.x + r.w - 6} cy={r.y + 6} r={19} fill={C.coral} stroke={C.ink} strokeWidth={STROKE} />
          <text x={r.x + r.w - 6} y={r.y + 12} textAnchor="middle" className="t-badge">{crates}</text>
        </g>
      ) : null}
    </Tap>
  );
}

/** Small kiosk for the other warehouse functions: striped awning + sign. */
function Kiosk({ r, zone, badge = 0, onClick }: { r: Rect; zone: Zone; badge?: number; onClick: () => void }) {
  const stripes = 6;
  return (
    <Tap label={zone.label} onClick={onClick}>
      <Panel x={r.x} y={r.y} w={r.w} h={r.h} r={12} fill={C.cream} />
      <g>
        {Array.from({ length: stripes }).map((_, i) => (
          <rect key={i} x={r.x + (r.w / stripes) * i} y={r.y} width={r.w / stripes} height={26} fill={i % 2 ? C.cream : zone.color} />
        ))}
        <rect x={r.x} y={r.y} width={r.w} height={26} rx={12} fill="none" stroke={C.ink} strokeWidth={STROKE} />
        <path d={`M${r.x} ${r.y + 26} h${r.w}`} stroke={C.ink} strokeWidth={STROKE} />
      </g>
      <circle cx={r.x + r.w / 2} cy={r.y + 64} r={22} fill={zone.color} stroke={C.ink} strokeWidth={STROKE} opacity={.9} />
      <text x={r.x + r.w / 2} y={r.y + 73} textAnchor="middle" fontSize="24">{zone.icon}</text>
      <text x={r.x + r.w / 2} y={r.y + r.h - 14} textAnchor="middle" className="t-kiosk">{zone.label}</text>
      {badge > 0 ? (
        <g className="bounce" style={{ transformOrigin: `${r.x + r.w - 4}px ${r.y + 4}px` }} data-bmq-kiosk-badge={zone.id}>
          <circle cx={r.x + r.w - 4} cy={r.y + 4} r={17} fill={C.coral} stroke={C.ink} strokeWidth={STROKE} />
          <text x={r.x + r.w - 4} y={r.y + 10} textAnchor="middle" className="t-badge">{badge}</text>
        </g>
      ) : null}
    </Tap>
  );
}

/** Pot with a round bush and pink flowers (the reference's table plants). */
function Plant({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse cx={3} cy={16} rx={16} ry={5} fill={C.shadow} />
      <circle r={16} fill="#8dbb7c" stroke={C.ink} strokeWidth={STROKE} />
      {[[-6, -5], [6, -2], [-1, 7], [8, 9]].map(([dx, dy]) => (
        <g key={`${dx}${dy}`} transform={`translate(${dx} ${dy})`}>
          {[0, 72, 144, 216, 288].map((a) => <circle key={a} cx={Math.cos((a * Math.PI) / 180) * 2.6} cy={Math.sin((a * Math.PI) / 180) * 2.6} r={1.9} fill={C.coral} />)}
          <circle r={1.3} fill={C.mustardLight} />
        </g>
      ))}
    </g>
  );
}

/** Delivery van from above, cut away like the reference bus: seats + driver. Drawn facing +x. */
export function Van({ color = C.mustard }: { color?: string }) {
  return (
    <g>
      <rect x={-66} y={-30} width={132} height={64} rx={14} fill={C.shadow} transform="translate(6 7)" />
      <rect x={-56} y={-35} width={12} height={8} rx={3} fill={C.ink} />
      <rect x={34} y={-35} width={12} height={8} rx={3} fill={C.ink} />
      <rect x={-56} y={29} width={12} height={8} rx={3} fill={C.ink} />
      <rect x={34} y={29} width={12} height={8} rx={3} fill={C.ink} />
      <rect x={-66} y={-30} width={132} height={62} rx={14} fill={color} stroke={C.ink} strokeWidth={STROKE} />
      <rect x={-58} y={-22} width={90} height={46} rx={8} fill={C.cream} stroke={C.ink} strokeWidth={2.5} />
      {/* cargo: crates */}
      {[[-46, -12], [-46, 8], [-24, -12], [-24, 8]].map(([dx, dy]) => (
        <rect key={`${dx}${dy}`} x={dx} y={dy} width={18} height={16} rx={3} fill={C.kraft} stroke={C.ink} strokeWidth={2} />
      ))}
      {/* cab */}
      <rect x={34} y={-22} width={26} height={46} rx={8} fill={C.sageLight} stroke={C.ink} strokeWidth={2.5} />
      <rect x={6} y={-12} width={18} height={26} rx={5} fill={C.sage} stroke={C.ink} strokeWidth={2} />
      <g transform="translate(16 1) scale(.6)"><Buddy x={0} y={-4} mood="happy" hat="cap" /></g>
      <text x={-11} y={-25} textAnchor="middle" className="t-van" transform="translate(0 0)">BMQ</text>
    </g>
  );
}

function Road({ r, vertical }: { r: Rect; vertical: boolean }) {
  const dashes = vertical ? Math.ceil(r.h / 90) : Math.ceil(r.w / 90);
  return (
    <g>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={C.road} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#dots)" />
      {vertical ? (
        <>
          <line x1={r.x + 10} y1={r.y} x2={r.x + 10} y2={r.y + r.h} stroke={C.ink} strokeWidth={STROKE} />
          <line x1={r.x + 16} y1={r.y} x2={r.x + 16} y2={r.y + r.h} stroke={C.ink} strokeWidth={1.5} />
          {Array.from({ length: dashes }).map((_, i) => <rect key={i} x={r.x + r.w / 2 - 4} y={r.y + 20 + i * 90} width={8} height={42} rx={4} fill={C.ink} />)}
        </>
      ) : (
        <>
          <line x1={r.x} y1={r.y + r.h - 10} x2={r.x + r.w} y2={r.y + r.h - 10} stroke={C.ink} strokeWidth={STROKE} />
          <line x1={r.x} y1={r.y + r.h - 16} x2={r.x + r.w} y2={r.y + r.h - 16} stroke={C.ink} strokeWidth={1.5} />
          {Array.from({ length: dashes }).map((_, i) => <rect key={i} x={r.x + 20 + i * 90} y={r.y + r.h / 2 - 4} width={42} height={8} rx={4} fill={C.ink} />)}
        </>
      )}
    </g>
  );
}

function Sidewalk({ r, vertical }: { r: Rect; vertical: boolean }) {
  const posts = vertical ? Math.floor(r.h / 150) : Math.floor(r.w / 150);
  return (
    <g>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={C.paperDeep} />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#tiles)" />
      {vertical
        ? <line x1={r.x} y1={r.y} x2={r.x} y2={r.y + r.h} stroke={C.ink} strokeWidth={STROKE} />
        : <line x1={r.x} y1={r.y + r.h} x2={r.x + r.w} y2={r.y + r.h} stroke={C.ink} strokeWidth={STROKE} />}
      {Array.from({ length: posts }).map((_, i) => {
        const px = vertical ? r.x + 14 : r.x + 70 + i * 150;
        const py = vertical ? r.y + 70 + i * 150 : r.y + r.h - 14;
        return (
          <g key={i}>
            {vertical
              ? <line x1={px} y1={py} x2={px + 26} y2={py} stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" />
              : <line x1={px} y1={py} x2={px} y2={py - 26} stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" />}
            <circle cx={vertical ? px + 26 : px} cy={vertical ? py : py - 26} r={6} fill={C.ink} />
          </g>
        );
      })}
    </g>
  );
}

export function Yard({ portrait, counts, crates, badges = {}, onEnter, onZone }: {
  portrait: boolean;
  badges?: Record<string, number>;
  counts: Record<Location, number>;
  crates: Record<Location, number>;
  onEnter: (loc: Location) => void;
  onZone: (zone: Zone) => void;
}) {
  const W = portrait ? 600 : 1280;
  const H = portrait ? 1230 : 760;
  const road: Rect = portrait ? { x: 0, y: 0, w: 168, h: H } : { x: 0, y: H - 160, w: W, h: 160 };
  const walk: Rect = portrait ? { x: 168, y: 0, w: 62, h: H } : { x: 0, y: H - 222, w: W, h: 62 };
  const q7: Rect = portrait ? { x: 270, y: 60, w: 300, h: 290 } : { x: 70, y: 70, w: 380, h: 380 };
  const tt: Rect = portrait ? { x: 270, y: 410, w: 300, h: 300 } : { x: 510, y: 70, w: 400, h: 380 };
  const kiosks: Rect[] = portrait
    ? ZONES.map((_, i) => ({ x: 262 + (i % 2) * 162, y: 770 + Math.floor(i / 2) * 150, w: 146, h: 126 }))
    : ZONES.map((_, i) => ({ x: 960 + (i % 2) * 158, y: 64 + Math.floor(i / 2) * 150, w: 142, h: 128 }));
  const door = portrait ? "left" : "bottom";
  const q7Door = portrait ? { x: q7.x - 58, y: q7.y + q7.h / 2 + 10 } : { x: q7.x + q7.w / 2 + 70, y: q7.y + q7.h + 40 };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={portrait ? "xMidYMin meet" : "xMidYMid meet"} role="img" aria-label="Kho BMQ">
      <Defs />
      <rect width={W} height={H} fill={C.paper} />
      <rect width={W} height={H} fill="url(#dots)" />
      <Road r={road} vertical={portrait} />
      <Sidewalk r={walk} vertical={portrait} />

      {/* the van drives along the road */}
      <g className={portrait ? "drive-v" : "drive-h"}>
        <g transform={portrait ? `translate(${road.x + road.w / 2 + 34} 0) rotate(90)` : `translate(0 ${road.y + road.h / 2 + 30})`}>
          <Van />
          <g transform="translate(-74 18)"><Puffs x={0} y={0} /></g>
        </g>
      </g>

      <Building r={q7} roof={C.mustard} title="KHO Q7" sub={`${counts.q7} mặt hàng · NVL bếp`} crates={crates.q7} door={door} onClick={() => onEnter("q7")} />
      <Building r={tt} roof={C.coral} title="KHO TÂN TẠO" sub={`${counts.tan_tao} mặt hàng · TP + NVL`} crates={crates.tan_tao} door={door} onClick={() => onEnter("tan_tao")} />

      {portrait
        ? <><Plant x={q7.x + q7.w - 4} y={q7.y + q7.h + 30} /><Plant x={tt.x + 30} y={tt.y + tt.h + 30} /></>
        : <><Plant x={q7.x - 30} y={q7.y + q7.h - 10} /><Plant x={tt.x + tt.w + 26} y={tt.y + 20} /></>}

      {kiosks.map((r, i) => <Kiosk key={ZONES[i].id} r={r} zone={ZONES[i]} badge={badges[ZONES[i].id] ?? 0} onClick={() => onZone(ZONES[i])} />)}

      {/* staff on the sidewalk */}
      <g className={portrait ? "stroll-v" : "stroll-h"}>
        <Buddy x={portrait ? walk.x + 34 : 0} y={portrait ? 0 : walk.y + 18} mood="calm" hat="chef" walk />
      </g>
      <Buddy x={q7Door.x} y={q7Door.y} mood="wow" face={C.mustardLight} />
      {crates.q7 > 0 ? (
        <Bubble x={q7Door.x + 4} y={q7Door.y - 22} name="Bé Kho" text={`Có ${crates.q7} thùng chưa dán nhãn! Vào xếp giúp mình nha`} max={portrait ? 16 : 24} />
      ) : null}
    </svg>
  );
}
