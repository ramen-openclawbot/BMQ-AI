import { useEffect, useState } from "react";
import { C, STROKE } from "./theme";
import { Buddy, CrateBuddy, Defs, Puffs } from "./Toon";
import { Van } from "./Yard";

const DEFAULT_LINES = ["Đang mở cửa kho", "Đếm thùng hàng", "Gọi Bé Mì dậy", "Lau kệ cho sạch"];

/** Waiting screen: the roller shutter lifts, the van pulls in, Bé Kho pushes a crate. */
export function GameLoading({ lines = DEFAULT_LINES }: { lines?: string[] }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setStep((value) => value + 1), 1500);
    return () => window.clearInterval(timer);
  }, []);
  const line = lines[step % lines.length];
  const door = { x: 120, y: 112, w: 120, h: 116 };
  return (
    <div className="kg-loading" role="status" aria-live="polite" aria-label={`${line}…`} data-bmq-game-loading>
      <svg viewBox="0 0 360 290" className="kg-loading-art" aria-hidden="true">
        <Defs />
        <clipPath id="kg-door-clip"><rect x={door.x} y={door.y} width={door.w} height={door.h} /></clipPath>
        {/* ground */}
        <ellipse cx={180} cy={252} rx={170} ry={22} fill={C.paperDeep} stroke={C.ink} strokeWidth={STROKE} />
        <ellipse cx={180} cy={252} rx={170} ry={22} fill="url(#dots)" />
        {/* building */}
        <rect x={76} y={70} width={214} height={168} rx={14} fill={C.shadow} transform="translate(6 7)" />
        <rect x={76} y={70} width={208} height={168} rx={14} fill={C.mustard} stroke={C.ink} strokeWidth={STROKE} />
        <rect x={86} y={80} width={188} height={20} rx={6} fill={C.cream} stroke={C.ink} strokeWidth={2.5} opacity={.9} />
        {[0, 1, 2, 3, 4, 5].map((i) => <line key={i} x1={100 + i * 32} y1={80} x2={100 + i * 32} y2={100} stroke={C.ink} strokeOpacity=".25" strokeWidth={2} />)}
        {/* inside, seen through the opening */}
        <rect x={door.x} y={door.y} width={door.w} height={door.h} fill={C.ink} />
        <g clipPath="url(#kg-door-clip)">
          <rect x={door.x} y={door.y + 34} width={door.w} height={6} fill={C.kraft} />
          <rect x={door.x} y={door.y + 74} width={door.w} height={6} fill={C.kraft} />
          {[0, 1, 2, 3].map((i) => <rect key={`a${i}`} x={door.x + 10 + i * 27} y={door.y + 14} width={20} height={20} rx={3} fill={i % 2 ? C.coral : C.sage} stroke={C.ink} strokeWidth={2} />)}
          {[0, 1, 2].map((i) => <rect key={`b${i}`} x={door.x + 20 + i * 32} y={door.y + 52} width={24} height={22} rx={3} fill={i % 2 ? C.mustardLight : C.kraft} stroke={C.ink} strokeWidth={2} />)}
          <rect className="kg-glow" x={door.x} y={door.y} width={door.w} height={door.h} fill={C.mustardLight} opacity={0} />
          {/* roller shutter */}
          <g className="kg-shutter">
            <rect x={door.x} y={door.y} width={door.w} height={door.h} fill={C.cream} />
            {Array.from({ length: 10 }).map((_, i) => <line key={i} x1={door.x} y1={door.y + 11 + i * 11} x2={door.x + door.w} y2={door.y + 11 + i * 11} stroke={C.ink} strokeOpacity=".35" strokeWidth={2} />)}
            <rect x={door.x + door.w / 2 - 14} y={door.y + door.h - 12} width={28} height={6} rx={3} fill={C.ink} />
          </g>
        </g>
        <rect x={door.x - 6} y={door.y - 8} width={door.w + 12} height={door.h + 8} rx={6} fill="none" stroke={C.ink} strokeWidth={STROKE + 1} />
        <rect x={door.x - 10} y={door.y - 14} width={door.w + 20} height={12} rx={5} fill={C.coral} stroke={C.ink} strokeWidth={STROKE} />
        {/* hanging sign */}
        <g className="kg-sign">
          <line x1={150} y1={30} x2={146} y2={52} stroke={C.ink} strokeWidth={2.5} />
          <line x1={210} y1={30} x2={214} y2={52} stroke={C.ink} strokeWidth={2.5} />
          <rect x={124} y={48} width={118} height={34} rx={9} fill={C.shadow} transform="translate(4 4)" />
          <rect x={124} y={48} width={118} height={34} rx={9} fill={C.cream} stroke={C.ink} strokeWidth={STROKE} />
          <text x={183} y={71} textAnchor="middle" className="t-hang" fontSize="17">KHO BMQ</text>
        </g>
        {/* Bé Kho pushes a crate toward the door */}
        <g className="kg-pusher">
          <CrateBuddy x={268} y={226} mood="happy" />
          <Buddy x={306} y={218} mood="happy" hat="cap" face={C.mustardLight} scale={0.85} flip />
        </g>
        {/* the van pulls in */}
        <g className="kg-van">
          <g transform="translate(46 242) scale(.55)">
            <Van color={C.sage} />
            <g transform="translate(-74 18)"><Puffs x={0} y={0} /></g>
          </g>
        </g>
      </svg>
      <p className="kg-loading-text"><span key={step}>{line}</span><i /><i /><i /></p>
      <div className="kg-loading-tape"><i /></div>
    </div>
  );
}
