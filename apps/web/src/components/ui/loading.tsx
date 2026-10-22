import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import "@/styles/bmq-loading.css";

/**
 * Shared loading states — "Sổ cái" ledger concept (owner 22/10/2026).
 * They only cover blank screens while data loads, so nothing is written on screen;
 * the label is kept for screen readers.
 * PageLoader: route bar + a ledger page whose entries are posted line by line.
 * LoadingState: the same ledger, sized like the data block it stands in for.
 * Everything stays invisible for the first moments so quick loads never flash.
 */

type DelayStyle = CSSProperties & { "--bmq-ld-delay"?: string };
type EntryStyle = CSSProperties & { "--i"?: number };

const delayStyle = (ms: number): DelayStyle => ({ "--bmq-ld-delay": `${ms}ms` });

// Each ledger entry: [y, description width, amount width].
const ENTRIES: Array<[number, number, number]> = [
  [25, 22, 10],
  [34, 16, 12],
  [43, 20, 8],
  [52, 13, 11],
];

/** A ledger page: entries are posted one by one, then the total is ruled off. */
export function LedgerMark({ className, delayMs = 300 }: { className?: string; delayMs?: number }) {
  return (
    <div className={cn("bmq-ld bmq-ld-oven bmq-ld-delay", className)} style={delayStyle(delayMs)} aria-hidden="true">
      <svg className="bmq-ld-ledger" viewBox="0 0 64 76">
        <rect className="bmq-ld-paper" x="1" y="1" width="62" height="74" rx="7" />
        <rect className="bmq-ld-head" x="8" y="9" width="20" height="4" rx="2" />
        <rect className="bmq-ld-head is-faint" x="44" y="9" width="12" height="4" rx="2" />
        <line className="bmq-ld-rule" x1="8" y1="18" x2="56" y2="18" />
        <line className="bmq-ld-rule is-margin" x1="15.5" y1="21" x2="15.5" y2="57" />
        {ENTRIES.map(([y, desc, amount], index) => (
          <g key={y} className="bmq-ld-entry" style={{ "--i": index } as EntryStyle}>
            <rect x="8" y={y} width="4" height="3" rx="1.5" />
            <rect x="19" y={y} width={desc} height="3" rx="1.5" />
            <rect x={56 - amount} y={y} width={amount} height="3" rx="1.5" />
          </g>
        ))}
        <g className="bmq-ld-entry is-total" style={{ "--i": ENTRIES.length } as EntryStyle}>
          <line x1="40" y1="60.5" x2="56" y2="60.5" />
          <rect x="42" y="64" width="14" height="4" rx="2" />
          <line x1="40" y1="71" x2="56" y2="71" />
        </g>
      </svg>
    </div>
  );
}

/** Thin indeterminate bar pinned to the top edge while a page loads. */
export function RouteProgressBar() {
  return <div className="bmq-ld bmq-ld-bar" aria-hidden="true" />;
}

/** Whole-page loading: the bar at once, the ledger only if the wait passes 0.6 s. */
export function PageLoader({ label, className }: { label?: string; className?: string }) {
  const text = label ?? (document.documentElement.lang === "en" ? "Loading…" : "Đang tải…");
  return (
    <div className={cn("bmq-ld bmq-ld-page", className)} role="status" aria-live="polite" aria-label={text}>
      <RouteProgressBar />
      <LedgerMark delayMs={600} />
    </div>
  );
}

type LoadingStateProps = {
  /** Read by screen readers only; nothing is written on screen. */
  label: string;
  /** Sizing hint only: rows ≈ 44 px each, cards ≈ 76 px each, ledger = compact. */
  variant?: "rows" | "cards" | "ledger";
  rows?: number;
  /** flat: no panel background, for blocks that already sit inside a card. */
  flat?: boolean;
  className?: string;
};

/**
 * Placeholder for a data block that is still loading.
 * Every variant shows the posting ledger (owner 22/10: shimmer bars alone read as an
 * empty page on a phone); rows/cards only size the block like the content to come,
 * so the page does not jump when the data arrives.
 */
export function LoadingState({ label, variant = "rows", rows = 3, flat = false, className }: LoadingStateProps) {
  const count = Math.max(1, Math.min(rows, 8));
  const minHeight = variant === "ledger" ? undefined : Math.max(160, count * (variant === "cards" ? 76 : 44) + 12);
  return (
    <div
      className={cn("bmq-ld bmq-ld-block is-center", flat && "is-flat", className)}
      style={minHeight ? { minHeight } : undefined}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <LedgerMark />
    </div>
  );
}
