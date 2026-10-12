import type { ReactNode } from "react";
import { C } from "./theme";
import { Goods } from "./Toon";
import { normalizeName } from "./meta";

/**
 * Item pictures chosen from the item name (owner request 12/10: "ảnh nguyên vật liệu giống tên").
 * Rules run in order on the accent-free name; the first match wins. Unknown names fall back to the unit shape.
 */
export type GoodsKind =
  | "glove" | "tape" | "box" | "bag" | "label" | "paper" | "ice" | "water" | "spray" | "mask"
  | "croissant" | "bread" | "floss" | "pate" | "flour" | "sugar" | "oil" | "vinegar" | "honey"
  | "butter" | "cheese" | "milk" | "egg" | "yeast" | "choco" | "nuts" | "carrot" | "chili" | "garlic" | "herb";

const RULES: Array<[GoodsKind, RegExp]> = [
  ["glove", /\bbao tay\b/],
  ["tape", /\bbang keo\b/],
  ["box", /^(hop|nap|khay)\b/],
  ["bag", /^(bao (pe|xop|kieng|tam giac)|bich|boc|tui|mang boc)\b/],
  ["label", /^(tem|nhan banh|nhan viet|giay decal|muc in)\b/],
  ["paper", /^(giay|khan giay)\b/],
  ["ice", /\bnuoc da\b/],
  ["water", /\b(nuoc uong|vihawa|vinh hao)\b/],
  ["spray", /\b(nuoc lau|nuoc rua|tay rua|xit|con \d+|do rua|cay lau)\b/],
  ["mask", /^(khau trang|non)\b/],
  ["croissant", /\b(croissant|croffle|banh cua)\b/],
  ["bread", /^banh\b/],
  ["floss", /\bcha bong\b/],
  ["pate", /\b(pate|gan|xuc xich)\b/],
  ["flour", /\b(bot mi|lua mach|peerless|yen mach|custard)\b/],
  ["oil", /\bdau\b/],
  ["nuts", /\bhat\b/],
  ["milk", /\bsua\b/],
  ["sugar", /\b(duong|bot ngot|muoi|phu gia|lam mem|bico)\b/],
  ["oil", /\bdau\b/],
  ["vinegar", /\bgiam\b/],
  ["honey", /\bmat ong\b/],
  ["butter", /^bo\b/],
  ["cheese", /\b(pho mai|phomai|cream cheese)\b/],
  ["milk", /\b(sua|whipping|creamyvit|kem)\b/],
  ["egg", /\btrung\b/],
  ["yeast", /^men\b/],
  ["choco", /\bsocola\b/],
  ["nuts", /\b(hanh nhan|hat|nho kho|tieu)\b/],
  ["carrot", /\b(ca rot|cu cai)\b/],
  ["chili", /\bot\b/],
  ["garlic", /\btoi\b/],
  ["herb", /\b(ngo|hanh la|mui tay|dua leo|re an khe)\b/],
  ["flour", /^bot\b/],
];

export function goodsKind(name: string): GoodsKind | null {
  const n = normalizeName(name).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  for (const [kind, re] of RULES) if (re.test(n)) return kind;
  return null;
}

const sw = 2.4;
const ink = { stroke: C.ink, strokeWidth: sw, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
const line = { stroke: C.ink, strokeWidth: 1.8, strokeLinecap: "round" as const, fill: "none" };

function art(kind: GoodsKind): ReactNode {
  switch (kind) {
    case "flour":
      return <g>
        <path d="M-12 -10 q-2 -6 3 -7 l18 0 q5 1 3 7 l2 19 q0 6 -6 6 h-16 q-6 0 -6 -6 z" fill={C.cream} {...ink} />
        <path d="M-9 -12 l3 3 l3 -3 l3 3 l3 -3 l3 3 l3 -3" {...line} />
        <path d="M0 11 V-2" {...line} stroke={C.mustard} strokeWidth={2.2} />
        {[-1, 3, 7].map((y) => <g key={y}><ellipse cx={-3} cy={y - 2} rx={2.2} ry={1.3} fill={C.mustard} transform={`rotate(-35 -3 ${y - 2})`} /><ellipse cx={3} cy={y - 2} rx={2.2} ry={1.3} fill={C.mustard} transform={`rotate(35 3 ${y - 2})`} /></g>)}
      </g>;
    case "sugar":
      return <g>
        <path d="M-11 -9 h22 l-1 21 q0 3 -3 3 h-14 q-3 0 -3 -3 z" fill={C.white} {...ink} />
        <path d="M-11 -9 l3 -5 h16 l3 5" fill={C.plumLight} {...ink} />
        {[[-5, 2], [0, -1], [5, 3], [-2, 7], [4, 9], [-6, 9], [1, 4]].map(([x, y]) => <rect key={`${x}${y}`} x={x - 1.4} y={y - 1.4} width={2.8} height={2.8} rx={0.6} fill={C.plumLight} stroke={C.ink} strokeWidth={1} />)}
      </g>;
    case "oil":
    case "vinegar":
      return <g>
        <path d="M-4 -16 h8 v5 l4 4 v20 q0 4 -4 4 h-8 q-4 0 -4 -4 v-20 l4 -4 z" fill={kind === "oil" ? C.mustard : C.cream} {...ink} />
        <rect x={-5} y={-19} width={10} height={4} rx={1.5} fill={kind === "oil" ? C.coral : C.sage} {...ink} />
        <rect x={-6} y={0} width={12} height={8} rx={2} fill={C.white} {...ink} strokeWidth={1.8} />
        {kind === "oil" ? <path d="M0 2 q-2 2 0 4 q2 -2 0 -4" fill={C.mustard} stroke={C.ink} strokeWidth={1.2} /> : <path d="M-3 4 h6" {...line} />}
      </g>;
    case "honey":
      return <g>
        <path d="M-11 -6 h22 v15 q0 7 -7 7 h-8 q-7 0 -7 -7 z" fill={C.mustard} {...ink} />
        <rect x={-12} y={-12} width={24} height={6} rx={2} fill={C.kraft} {...ink} />
        <path d="M-6 -6 v4 q0 3 2 3 q2 0 2 -3 v-4" fill={C.mustardLight} stroke={C.ink} strokeWidth={1.6} />
        <path d="M-5 7 l5 -3 l5 3 v5 l-5 3 l-5 -3 z" fill={C.mustardLight} stroke={C.ink} strokeWidth={1.4} />
      </g>;
    case "floss":
      return <g>
        <path d="M-12 -4 h24 v14 q0 6 -6 6 h-12 q-6 0 -6 -6 z" fill={C.cream} {...ink} />
        <path d="M-12 -4 q-2 -8 6 -9 q2 -5 8 -3 q6 -3 9 3 q6 1 3 9 z" fill={C.kraft} {...ink} />
        <path d="M-6 -9 q3 -1 5 1 M2 -11 q3 0 4 3 M-2 -6 q3 -1 5 1" {...line} strokeWidth={1.4} />
        <rect x={-8} y={2} width={16} height={7} rx={2} fill={C.coralLight} stroke={C.ink} strokeWidth={1.6} />
      </g>;
    case "bread":
      return <g transform="rotate(-25)">
        <path d="M-18 0 q0 -8 10 -8 h16 q10 0 10 8 q0 8 -10 8 h-16 q-10 0 -10 -8 z" fill={C.kraft} {...ink} />
        {[-9, -1, 7].map((x) => <path key={x} d={`M${x} -5 q3 5 6 0`} fill="none" stroke={C.ink} strokeWidth={1.8} strokeLinecap="round" />)}
      </g>;
    case "croissant":
      return <g>
        <path d="M-17 6 q-2 -10 6 -14 q11 -6 22 0 q8 4 6 14 q-4 4 -9 1 q-8 -4 -16 0 q-5 3 -9 -1 z" fill={C.mustard} {...ink} />
        <path d="M-7 -8 q2 7 0 13 M0 -10 v14 M7 -8 q-2 7 0 13" {...line} />
      </g>;
    case "pate":
      return <g>
        <ellipse cx={0} cy={6} rx={14} ry={6} fill={C.coral} {...ink} />
        <path d="M-14 -3 v9 M14 -3 v9" {...ink} fill="none" />
        <ellipse cx={0} cy={-3} rx={14} ry={6} fill={C.coralLight} {...ink} />
        <ellipse cx={0} cy={-3} rx={8} ry={3} fill={C.kraft} stroke={C.ink} strokeWidth={1.6} />
      </g>;
    case "butter":
      return <g>
        <path d="M-15 -2 l8 -8 h22 l-8 8 z" fill={C.mustardLight} {...ink} />
        <path d="M-15 -2 h22 v12 h-22 z" fill={C.mustardLight} {...ink} />
        <path d="M7 -2 l8 -8 v12 l-8 8 z" fill={C.mustard} {...ink} />
        <path d="M-15 4 h22" {...line} stroke={C.sage} strokeWidth={4} />
      </g>;
    case "cheese":
      return <g>
        <path d="M-15 10 v-10 l26 -10 l4 10 v10 z" fill={C.mustard} {...ink} />
        <path d="M-15 0 h30" {...line} />
        {[[-7, 5, 2.4], [3, 6, 1.8], [8, 2, 1.4], [-1, 3, 1.2]].map(([x, y, r]) => <circle key={`${x}${y}`} cx={x} cy={y} r={r} fill={C.mustardLight} stroke={C.ink} strokeWidth={1.3} />)}
      </g>;
    case "milk":
      return <g>
        <path d="M-9 -6 l4 -7 h10 l4 7 v19 q0 3 -3 3 h-12 q-3 0 -3 -3 z" fill={C.white} {...ink} />
        <path d="M-9 -6 h18" {...line} />
        <rect x={-6} y={-16} width={12} height={4} rx={1} fill={C.sage} {...ink} strokeWidth={1.8} />
        <path d="M-9 3 q4 -3 9 0 q5 3 9 0 v6 h-18 z" fill={C.sageLight} stroke={C.ink} strokeWidth={1.6} />
      </g>;
    case "egg":
      return <g>
        <path d="M-16 4 h32 l-3 9 h-26 z" fill={C.kraft} {...ink} />
        {[-9, 0, 9].map((x) => <ellipse key={x} cx={x} cy={-2} rx={5} ry={6.5} fill={C.cream} {...ink} />)}
      </g>;
    case "yeast":
      return <g>
        <rect x={-13} y={-10} width={26} height={22} rx={3} fill={C.sageLight} {...ink} />
        <path d="M-13 -4 h26" {...line} />
        {[[-5, 4], [1, 2], [6, 6], [-1, 8]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r={2.2} fill={C.white} stroke={C.ink} strokeWidth={1.3} />)}
      </g>;
    case "choco":
      return <g transform="rotate(-12)">
        <rect x={-14} y={-10} width={28} height={20} rx={3} fill="#7a4b3a" {...ink} />
        <path d="M-14 0 h28 M-5 -10 v20 M5 -10 v20" stroke="#5a3428" strokeWidth={1.8} />
        <path d="M2 -10 h12 v20 h-6 l-6 -8 z" fill={C.coral} {...ink} />
      </g>;
    case "nuts":
      return <g>
        {[[-6, -4], [4, -6], [0, 2], [-9, 5], [9, 3]].map(([x, y], i) => <ellipse key={i} cx={x} cy={y} rx={5.5} ry={3.6} fill={i % 2 ? C.kraft : C.kraftDeep} {...ink} strokeWidth={1.8} transform={`rotate(${i * 37 - 30} ${x} ${y})`} />)}
        <path d="M-15 6 q15 10 30 0 v2 q-3 8 -15 8 q-12 0 -15 -8 z" fill={C.cream} {...ink} />
      </g>;
    case "carrot":
      return <g transform="rotate(30)">
        <path d="M-5 -6 h10 l-5 22 z" fill={C.mustard} {...ink} />
        <path d="M-2 0 h3 M-1 6 h2" {...line} strokeWidth={1.4} />
        <path d="M0 -6 q-6 -6 -4 -12 M0 -6 q0 -8 2 -12 M0 -6 q6 -5 6 -10" stroke={C.sageDeep} strokeWidth={2.4} fill="none" strokeLinecap="round" />
      </g>;
    case "chili":
      return <g>
        <path d="M-12 -8 q12 -2 18 6 q6 9 -1 16 q-1 -9 -8 -14 q-5 -4 -9 -8 z" fill={C.coral} {...ink} />
        <path d="M-12 -8 q-3 -1 -4 -6" stroke={C.sageDeep} strokeWidth={2.6} fill="none" strokeLinecap="round" />
      </g>;
    case "garlic":
      return <g>
        <path d="M0 -14 q2 4 4 5 q10 4 9 14 q-1 9 -13 9 q-12 0 -13 -9 q-1 -10 9 -14 q2 -1 4 -5 z" fill={C.white} {...ink} />
        <path d="M-2 -6 q-5 8 -2 18 M2 -6 q5 8 2 18" {...line} strokeWidth={1.5} />
      </g>;
    case "herb":
      return <g>
        <path d="M0 14 V-4" stroke={C.sageDeep} strokeWidth={2.4} strokeLinecap="round" />
        <path d="M0 -4 q-12 -2 -12 -12 q10 0 12 12 z" fill={C.sage} {...ink} />
        <path d="M0 2 q12 -2 12 -12 q-10 0 -12 12 z" fill={C.sageLight} {...ink} />
        <path d="M0 8 q-10 0 -11 -8 q9 0 11 8 z" fill={C.sage} {...ink} />
      </g>;
    case "glove":
      return <g>
        <path d="M-9 14 v-14 l-4 -6 q-1 -3 2 -3 l4 4 v-9 q0 -3 3 -3 q2 0 2 3 v-1 q0 -3 3 -3 q2 0 2 3 v1 q0 -3 3 -3 q2 0 2 3 v14 l-1 14 z" fill={C.plumLight} {...ink} />
        <path d="M-9 10 h16" {...line} />
      </g>;
    case "tape":
      return <g>
        <circle r={13} fill={C.mustardLight} {...ink} />
        <circle r={6} fill={C.cream} {...ink} />
        <path d="M11 6 l7 4 l-2 4 l-8 -4" fill={C.mustardLight} {...ink} strokeWidth={1.8} />
      </g>;
    case "box":
      return <g>
        <path d="M-15 -4 h30 l-3 17 h-24 z" fill={C.kraft} {...ink} />
        <path d="M-15 -4 l4 -9 h22 l4 9" fill={C.kraftDeep} {...ink} />
        <path d="M-4 3 h8" {...line} />
      </g>;
    case "bag":
      return <g>
        <path d="M-12 -10 h24 v22 q0 3 -3 3 h-18 q-3 0 -3 -3 z" fill="rgba(255,250,240,.75)" {...ink} />
        <path d="M-12 -5 h24" stroke={C.coral} strokeWidth={2.2} />
        <path d="M-7 3 l4 4 M2 0 l5 5" {...line} strokeWidth={1.4} opacity={0.5} />
      </g>;
    case "label":
      return <g transform="rotate(-10)">
        <path d="M-14 -9 h20 l8 9 l-8 9 h-20 z" fill={C.coralLight} {...ink} />
        <circle cx={6} cy={0} r={2.4} fill={C.cream} stroke={C.ink} strokeWidth={1.6} />
        <path d="M-10 -3 h10 M-10 3 h7" {...line} />
      </g>;
    case "paper":
      return <g>
        <rect x={-12} y={-8} width={24} height={20} rx={2} fill={C.cream} {...ink} transform="rotate(6)" />
        <rect x={-12} y={-12} width={24} height={20} rx={2} fill={C.white} {...ink} />
        <path d="M-7 -6 h14 M-7 -1 h14 M-7 4 h9" {...line} strokeWidth={1.5} opacity={0.6} />
      </g>;
    case "ice":
      return <g>
        <rect x={-14} y={-6} width={14} height={14} rx={3} fill={C.plumLight} {...ink} transform="rotate(-10 -7 1)" />
        <rect x={1} y={-10} width={13} height={13} rx={3} fill={C.sageLight} {...ink} transform="rotate(12 7 -3)" />
        <rect x={-4} y={4} width={12} height={11} rx={3} fill={C.white} {...ink} />
      </g>;
    case "water":
      return <g>
        <path d="M-10 -8 q0 -4 4 -4 h12 q4 0 4 4 v20 q0 4 -4 4 h-12 q-4 0 -4 -4 z" fill={C.sageLight} {...ink} />
        <rect x={-4} y={-17} width={8} height={5} rx={1.5} fill={C.plum} {...ink} />
        <path d="M-10 2 h20" {...line} />
        <path d="M0 4 q-3 4 0 6 q3 -2 0 -6" fill={C.white} stroke={C.ink} strokeWidth={1.2} />
      </g>;
    case "spray":
      return <g>
        <path d="M-9 -4 h14 v17 q0 3 -3 3 h-8 q-3 0 -3 -3 z" fill={C.sageLight} {...ink} />
        <path d="M-6 -4 v-5 h8 v5" fill={C.plum} {...ink} />
        <path d="M-6 -9 h-6 l2 -4 h12 v4" fill={C.plum} {...ink} />
        <path d="M10 -14 l3 -1 M10 -10 h4 M10 -6 l3 1" {...line} strokeWidth={1.4} />
      </g>;
    case "mask":
      return <g>
        <path d="M-12 -6 q12 -5 24 0 v8 q-12 9 -24 0 z" fill={C.white} {...ink} />
        <path d="M-12 -4 q-6 0 -6 4 q0 4 6 4 M12 -4 q6 0 6 4 q0 4 -6 4" {...line} />
        <path d="M-8 -2 h16 M-8 2 h16" {...line} strokeWidth={1.3} opacity={0.6} />
      </g>;
  }
}

/** The picture for one item: by name when we recognise it, else the unit shape. */
export function GoodsIcon({ name, unit, color, size = 1 }: { name: string; unit: string; color: string; size?: number }) {
  const kind = goodsKind(name);
  if (!kind) return <Goods x={0} y={2} unit={unit} color={color} size={size} />;
  return <g transform={`scale(${size * 0.95})`} data-goods-kind={kind}>{art(kind)}</g>;
}
