import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelGroup, RevenueChannelSummary } from "@/lib/overview/overview-summary";

export const CHANNEL_META: Record<ChannelGroup, { vi: string; en: string; color: string }> = {
  dealer: { vi: "Đại lý & NPP", en: "Dealers & distributors", color: "#f4442e" },
  bakery: { vi: "Bánh ngọt", en: "Bakery", color: "#d0679a" },
  b2b: { vi: "B2B & siêu thị", en: "B2B & supermarkets", color: "#29bf12" },
  retail: { vi: "Kiosk & bán lẻ", en: "Kiosk & retail", color: "#3c91e6" },
  other: { vi: "Khác", en: "Other", color: "#8a8a88" },
};

export const CHANNEL_ORDER: ChannelGroup[] = ["dealer", "bakery", "b2b", "retail", "other"];

export const formatMillions = (value: number, language: "vi" | "en" = "vi") =>
  (value / 1_000_000).toLocaleString(language === "en" ? "en-US" : "vi-VN", { maximumFractionDigits: 1 });

const dayLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

const H = 240;
const PAD = { top: 16, right: 12, bottom: 28, left: 36 };

/** 14-day revenue lines per channel group, with a hover/focus readout per day. */
export function RevenueChannelChart({ summary, language }: { summary: RevenueChannelSummary; language: "vi" | "en" }) {
  const [active, setActive] = useState<number | null>(null);
  const groups = CHANNEL_ORDER.filter((group) => summary.totals[group] > 0);
  const en = language === "en";

  // The SVG is drawn at its real pixel width so axis text stays legible on phones.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // The ledger lags a day or two: days after the last day with figures are
  // "not yet recorded", not zero revenue, so the lines stop there.
  const lastWithData = summary.days.reduce((last, day, i) => (day.total > 0 ? i : last), -1);
  const days = summary.days.slice(0, Math.max(lastWithData + 1, 2));
  const pending = summary.days.slice(days.length);

  const { max, ticks } = useMemo(() => {
    const peak = Math.max(1, ...days.flatMap((day) => groups.map((group) => day.byGroup[group])));
    const step = niceStep(peak / 4);
    const top = Math.ceil(peak / step) * step;
    return { max: top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
  }, [days, groups]);

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(innerW / 56))));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const path = (group: ChannelGroup) =>
    days.map((day, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(day.byGroup[group]).toFixed(1)}`).join("");

  const activeDay = active === null ? null : days[active];

  return (
    <div className="d3-ov-chart">
      <ul className="d3-ov-legend" aria-label={en ? "Channels" : "Kênh"}>
        {groups.map((group) => (
          <li key={group} style={{ ["--c" as string]: CHANNEL_META[group].color }}>
            {en ? CHANNEL_META[group].en : CHANNEL_META[group].vi}
          </li>
        ))}
      </ul>
      <div className="d3-ov-chart-box" ref={boxRef} onMouseLeave={() => setActive(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={en ? "Daily revenue by channel, last 14 days" : "Doanh thu theo kênh, 14 ngày gần nhất"}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="d3-ov-grid" x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} />
              <text className="d3-ov-axis" x={PAD.left - 8} y={y(tick) + 3} textAnchor="end">
                {formatMillions(tick, language)}
              </text>
            </g>
          ))}
          {days.map((day, i) =>
            (days.length - 1 - i) % labelEvery === 0 ? (
              <text key={day.day} className="d3-ov-axis" x={x(i)} y={H - 8} textAnchor="middle">
                {dayLabel(day.day)}
              </text>
            ) : null,
          )}
          {activeDay && <line className="d3-ov-guide" x1={x(active!)} x2={x(active!)} y1={PAD.top} y2={PAD.top + innerH} />}
          {groups.map((group, k) => (
            <path
              key={group}
              className="d3-ov-line"
              d={path(group)}
              pathLength={1}
              stroke={CHANNEL_META[group].color}
              style={{ animationDelay: `${300 + k * 160}ms` }}
            />
          ))}
          {activeDay &&
            groups.map((group) => (
              <circle key={group} className="d3-ov-dot" cx={x(active!)} cy={y(activeDay.byGroup[group])} r={4} fill={CHANNEL_META[group].color} />
            ))}
          {days.map((day, i) => (
            <rect
              key={day.day}
              className="d3-ov-hit"
              x={x(i) - innerW / (days.length - 1 || 1) / 2}
              y={PAD.top}
              width={innerW / (days.length - 1 || 1)}
              height={innerH}
              tabIndex={0}
              aria-label={`${dayLabel(day.day)}: ${formatMillions(day.total, language)} ${en ? "million" : "triệu"}`}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              onClick={() => setActive(i)}
            />
          ))}
        </svg>
        {activeDay && (
          <div className="d3-ov-tip" style={{ left: `${(x(active!) / W) * 100}%` }} data-side={active! > days.length / 2 ? "left" : "right"}>
            <b>{dayLabel(activeDay.day)}</b>
            {groups.map((group) => (
              <span key={group} style={{ ["--c" as string]: CHANNEL_META[group].color }}>
                {en ? CHANNEL_META[group].en : CHANNEL_META[group].vi}
                <em>{formatMillions(activeDay.byGroup[group], language)}</em>
              </span>
            ))}
            <span className="is-total">
              {en ? "Total" : "Tổng"}
              <em>{formatMillions(activeDay.total, language)} {en ? "M" : "tr"}</em>
            </span>
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <p className="d3-ov-pending">
          {en
            ? `${pending.map((day) => dayLabel(day.day)).join(", ")}: not yet in the controlled ledger`
            : `${pending.map((day) => dayLabel(day.day)).join(", ")}: chưa có số trong sổ đã kiểm soát`}
        </p>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}
