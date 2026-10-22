import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import "@/styles/bmq-loading.css";

/**
 * Shared loading states — "Lò bánh" (owner 22/10/2026).
 * PageLoader: route bar + baking loaf for whole-page loads.
 * LoadingState: shimmering placeholder rows for a data block.
 * Both stay invisible for the first moments so quick loads never flash.
 */

type DelayStyle = CSSProperties & { "--bmq-ld-delay"?: string };

const delayStyle = (ms: number): DelayStyle => ({ "--bmq-ld-delay": `${ms}ms` });

/** The baking loaf: a light sweep crosses the crust while three crumbs hop. */
export function BreadLoader({ label, className, delayMs = 300 }: { label?: string; className?: string; delayMs?: number }) {
  const clipId = `bmq-ld-clip-${useId().replace(/:/g, "")}`;
  const glowId = `${clipId}-glow`;
  // Bánh mì: a short baguette with tapered tips and one long slit along the top.
  const crust = "M9 37 C6 30 15 20 31 16 C41 13.5 55 13.5 65 16 C81 20 90 30 87 37 C85 42 69 44 48 44 C27 44 11 42 9 37 Z";

  return (
    <div className={cn("bmq-ld bmq-ld-oven bmq-ld-delay", className)} style={delayStyle(delayMs)}>
      <svg className="bmq-ld-loaf" viewBox="0 0 96 62" aria-hidden="true">
        <defs>
          <clipPath id={clipId}><path d={crust} /></clipPath>
          <linearGradient id={glowId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".75" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <ellipse className="bmq-ld-shadow" cx="48" cy="49" rx="36" ry="3" />
        <path className="bmq-ld-crust" d={crust} />
        <g clipPath={`url(#${clipId})`}>
          <g className="bmq-ld-sweep"><rect x="0" y="0" width="22" height="50" fill={`url(#${glowId})`} transform="skewX(-18)" /></g>
        </g>
        <path className="bmq-ld-ear" d="M24 25 C36 18 60 18 72 25 C60 22 36 22 24 25 Z" />
        <path className="bmq-ld-cut" d="M24 25 C36 18 60 18 72 25" />
        <circle className="bmq-ld-crumb" cx="38" cy="58" r="2" />
        <circle className="bmq-ld-crumb" cx="48" cy="58" r="2" />
        <circle className="bmq-ld-crumb" cx="58" cy="58" r="2" />
      </svg>
      {label ? <p className="bmq-ld-label">{label}</p> : null}
    </div>
  );
}

/** Thin indeterminate bar pinned to the top edge while a page loads. */
export function RouteProgressBar() {
  return <div className="bmq-ld bmq-ld-bar" aria-hidden="true" />;
}

/** Whole-page loading: the bar at once, the loaf only if the wait passes 0.6 s. */
export function PageLoader({ label, className }: { label?: string; className?: string }) {
  const text = label ?? (document.documentElement.lang === "en" ? "Loading…" : "Đang tải…");
  return (
    <div className={cn("bmq-ld bmq-ld-page", className)} role="status" aria-live="polite" aria-label={text}>
      <RouteProgressBar />
      <BreadLoader delayMs={600} />
    </div>
  );
}

type LoadingStateProps = {
  /** Read by screen readers and shown as a small caption under the rows. */
  label: string;
  /** rows: list/table lines; cards: stacked tiles; loaf: the baking loaf, for media and dialogs. */
  variant?: "rows" | "cards" | "loaf";
  rows?: number;
  /** flat: no panel background, for blocks that already sit inside a card. */
  flat?: boolean;
  className?: string;
};

/** Placeholder for a data block that is still loading. */
export function LoadingState({ label, variant = "rows", rows = 3, flat = false, className }: LoadingStateProps) {
  if (variant === "loaf") {
    return (
      <div className={cn("bmq-ld bmq-ld-block is-center", flat && "is-flat", className)} role="status" aria-live="polite">
        <BreadLoader label={label} />
      </div>
    );
  }

  const count = Math.max(1, Math.min(rows, 8));
  return (
    <div
      className={cn("bmq-ld bmq-ld-block bmq-ld-delay", flat && "is-flat", className)}
      style={delayStyle(300)}
      role="status"
      aria-live="polite"
    >
      {Array.from({ length: count }, (_, index) => (
        variant === "cards"
          ? <span key={index} className="bmq-ld-line is-card" aria-hidden="true" />
          : (
            <span key={index} className="bmq-ld-row" aria-hidden="true">
              <span className="bmq-ld-line is-dot" />
              <span className="bmq-ld-line" style={{ maxWidth: `${88 - index * 13}%` }} />
              <span className="bmq-ld-line is-short" />
            </span>
          )
      ))}
      <p className="bmq-ld-label">{label}</p>
    </div>
  );
}
