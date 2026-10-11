import type { ReactNode } from "react";
import { C, STROKE } from "./theme";

/** Shared SVG patterns: halftone dots, carpet squares, sidewalk tiles, checker mat. */
export function Defs() {
  return (
    <defs>
      <pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse">
        <circle cx="1.6" cy="1.6" r="0.9" fill={C.ink} opacity=".09" />
      </pattern>
      <pattern id="carpet" width="28" height="28" patternUnits="userSpaceOnUse">
        <rect x="6" y="6" width="16" height="16" rx="3" fill="none" stroke={C.ink} strokeOpacity=".07" strokeWidth="2" />
      </pattern>
      <pattern id="tiles" width="22" height="22" patternUnits="userSpaceOnUse">
        <rect x="3" y="3" width="16" height="16" rx="2" fill="none" stroke={C.ink} strokeOpacity=".1" strokeWidth="1.6" />
      </pattern>
      <pattern id="checker" width="24" height="24" patternUnits="userSpaceOnUse">
        <rect width="24" height="24" fill={C.cream} />
        <rect width="12" height="12" fill={C.paperDeep} />
        <rect x="12" y="12" width="12" height="12" fill={C.paperDeep} />
      </pattern>
      <pattern id="roof" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="none" />
        <line x1="0" y1="8" x2="16" y2="8" stroke={C.ink} strokeOpacity=".14" strokeWidth="3" />
      </pattern>
    </defs>
  );
}

/** Flat drop shadow under an outlined shape (offset down-right like printed stickers). */
export function Shadow({ x, y, w, h, r = 10 }: { x: number; y: number; w: number; h: number; r?: number }) {
  return <rect x={x + 5} y={y + 6} width={w} height={h} rx={r} fill={C.shadow} />;
}

export function Panel({ x, y, w, h, r = 12, fill = C.cream, stroke = C.ink, shadow = true, children }: {
  x: number; y: number; w: number; h: number; r?: number; fill?: string; stroke?: string; shadow?: boolean; children?: ReactNode;
}) {
  return (
    <g>
      {shadow ? <Shadow x={x} y={y} w={w} h={h} r={r} /> : null}
      <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke={stroke} strokeWidth={STROKE} />
      {children}
    </g>
  );
}

export type Mood = "happy" | "calm" | "worried" | "wow" | "sleepy";

/** A cute square-headed buddy seen from slightly above (like the reference game). */
export function Buddy({ x, y, face = C.white, mood = "calm", hat, scale = 1, flip = false, walk = false }: {
  x: number; y: number; face?: string; mood?: Mood; hat?: "chef" | "cap" | "none"; scale?: number; flip?: boolean; walk?: boolean;
}) {
  const eyes = mood === "sleepy"
    ? <><path d="M-8 -2 q3 2 6 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" /><path d="M2 -2 q3 2 6 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" /></>
    : <><circle cx={-5} cy={-2} r={mood === "wow" ? 3 : 2.2} fill={C.ink} /><circle cx={5} cy={-2} r={mood === "wow" ? 3 : 2.2} fill={C.ink} /></>;
  const mouth = mood === "happy" ? <path d="M-4 5 q4 4 8 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" />
    : mood === "worried" ? <path d="M-4 7 q4 -3 8 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" />
    : mood === "wow" ? <ellipse cx={0} cy={6} rx={2.5} ry={3} fill={C.ink} />
    : <line x1={-3} y1={6} x2={3} y2={6} stroke={C.ink} strokeWidth="2" strokeLinecap="round" />;
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}>
      <g className={walk ? "waddle" : "breathe"}>
        <ellipse cx={0} cy={26} rx={13} ry={4} fill={C.shadow} />
        {/* legs */}
        <line x1={-5} y1={14} x2={-5} y2={25} stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" />
        <line x1={5} y1={14} x2={5} y2={25} stroke={C.ink} strokeWidth={STROKE} strokeLinecap="round" />
        {/* head = body */}
        <rect x={-14} y={-14} width={28} height={29} rx={8} fill={face} stroke={C.ink} strokeWidth={STROKE} />
        {mood === "happy" || mood === "wow" ? <><ellipse cx={-9} cy={4} rx={3} ry={2} fill={C.coralLight} /><ellipse cx={9} cy={4} rx={3} ry={2} fill={C.coralLight} /></> : null}
        {eyes}
        {mouth}
        {hat === "chef" ? (
          <g>
            <rect x={-10} y={-21} width={20} height={8} rx={2} fill={C.white} stroke={C.ink} strokeWidth={2.5} />
            <circle cx={-7} cy={-25} r={6} fill={C.white} stroke={C.ink} strokeWidth={2.5} />
            <circle cx={1} cy={-28} r={7} fill={C.white} stroke={C.ink} strokeWidth={2.5} />
            <circle cx={8} cy={-24} r={5.5} fill={C.white} stroke={C.ink} strokeWidth={2.5} />
            <rect x={-9} y={-20} width={18} height={6} fill={C.white} />
          </g>
        ) : hat === "cap" ? (
          <path d="M-14 -10 q14 -14 28 0 l6 2 l-34 0 z" fill={C.coral} stroke={C.ink} strokeWidth={2.5} strokeLinejoin="round" />
        ) : null}
      </g>
    </g>
  );
}

/** A kraft-paper crate with a face: one unlabeled receipt name waiting for a shelf. */
export function CrateBuddy({ x, y, mood = "worried", label }: { x: number; y: number; mood?: Mood; label?: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="breathe">
        <ellipse cx={0} cy={22} rx={20} ry={5} fill={C.shadow} />
        <rect x={-19} y={-18} width={38} height={38} rx={6} fill={C.kraft} stroke={C.ink} strokeWidth={STROKE} />
        <line x1={-19} y1={-6} x2={19} y2={-6} stroke={C.ink} strokeWidth={2} opacity=".55" />
        <rect x={-5} y={-18} width={10} height={12} fill={C.mustardLight} stroke={C.ink} strokeWidth={2} />
        <circle cx={-7} cy={4} r={2.2} fill={C.ink} />
        <circle cx={7} cy={4} r={2.2} fill={C.ink} />
        {mood === "happy"
          ? <path d="M-4 10 q4 4 8 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" />
          : <path d="M-4 12 q4 -3 8 0" stroke={C.ink} strokeWidth="2" fill="none" strokeLinecap="round" />}
        {label ? (
          <g>
            <circle cx={16} cy={-18} r={9} fill={C.coral} stroke={C.ink} strokeWidth={2.5} />
            <text x={16} y={-14} textAnchor="middle" fontSize="12" fontWeight="800" fill={C.white} fontFamily="Baloo 2, sans-serif">{label}</text>
          </g>
        ) : null}
      </g>
    </g>
  );
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max && line) { lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

/** Navy speech bubble with cream text, tail pointing down-left to the speaker. */
export function Bubble({ x, y, text, name, max = 22, tail = "left" }: { x: number; y: number; text: string; name?: string; max?: number; tail?: "left" | "right" | "none" | "side" }) {
  const lines = wrap(text, max);
  const w = Math.max(...lines.map((line) => line.length)) * 7.4 + 26;
  const h = lines.length * 17 + 16;
  // "side": the bubble sits to the left of (x, y) and points right at the speaker.
  const bx = tail === "side" ? x - w - 14 : tail === "right" ? x - w + 18 : x - 18;
  const by = tail === "side" ? y - h / 2 : y - h - 12;
  return (
    <g className="pop" style={{ transformOrigin: `${x}px ${y}px` }}>
      <rect x={bx + 3} y={by + 4} width={w} height={h} rx={10} fill={C.shadow} />
      <rect x={bx} y={by} width={w} height={h} rx={10} fill={C.ink} />
      {tail === "side"
        ? <path d={`M${bx + w - 1} ${y - 7} L${x - 2} ${y} L${bx + w - 1} ${y + 7} Z`} fill={C.ink} />
        : tail !== "none" ? <path d={`M${x - 6} ${by + h - 1} L${x} ${y} L${x + 8} ${by + h - 1} Z`} fill={C.ink} /> : null}
      {lines.map((line, i) => (
        <text key={i} x={bx + 13} y={by + 21 + i * 17} fontSize="13" fontWeight="700" fill={C.cream} fontFamily="Nunito, sans-serif">{line}</text>
      ))}
      {name ? (
        <g>
          <rect x={bx + 8} y={by - 12} width={name.length * 7 + 16} height={20} rx={10} fill={C.cream} stroke={C.ink} strokeWidth={2.5} />
          <text x={bx + 16} y={by + 2} fontSize="11.5" fontWeight="800" fill={C.ink} fontFamily="Nunito, sans-serif">{name}</text>
        </g>
      ) : null}
    </g>
  );
}

/** Little goods token drawn by unit: sack for g, bottle for ml, roll, box, bag. */
export function Goods({ x, y, unit, color, size = 1 }: { x: number; y: number; unit: string; color: string; size?: number }) {
  const s = size;
  const sw = 2.4;
  let shape: ReactNode;
  if (unit === "g" || unit === "bao") {
    shape = <path d="M-11 -9 q11 -9 22 0 l3 16 q-14 6 -28 0 z" fill={color} stroke={C.ink} strokeWidth={sw} strokeLinejoin="round" />;
  } else if (unit === "ml" || unit === "chai" || unit === "bình" || unit === "can") {
    shape = <g><rect x={-8} y={-8} width={16} height={18} rx={5} fill={color} stroke={C.ink} strokeWidth={sw} /><rect x={-4} y={-14} width={8} height={7} rx={2} fill={C.white} stroke={C.ink} strokeWidth={sw} /></g>;
  } else if (unit === "cuộn") {
    shape = <g><circle r={10} fill={color} stroke={C.ink} strokeWidth={sw} /><circle r={3.5} fill={C.cream} stroke={C.ink} strokeWidth={sw} /></g>;
  } else if (unit === "bịch" || unit === "gói") {
    shape = <path d="M-10 -8 h20 l-2 18 h-16 z" fill={color} stroke={C.ink} strokeWidth={sw} strokeLinejoin="round" />;
  } else {
    shape = <g><rect x={-10} y={-9} width={20} height={18} rx={3} fill={color} stroke={C.ink} strokeWidth={sw} /><line x1={-10} y1={-2} x2={10} y2={-2} stroke={C.ink} strokeWidth={1.6} opacity=".5" /></g>;
  }
  return <g transform={`translate(${x} ${y}) scale(${s})`}>{shape}</g>;
}

/** Puff of exhaust / steam. */
export function Puffs({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle className="puff" r={6} fill={C.sage} stroke={C.ink} strokeWidth={2} />
      <circle className="puff d2" r={6} fill={C.sage} stroke={C.ink} strokeWidth={2} />
      <circle className="puff d3" r={6} fill={C.sage} stroke={C.ink} strokeWidth={2} />
    </g>
  );
}
