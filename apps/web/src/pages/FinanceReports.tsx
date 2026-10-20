import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, RotateCw, XCircle } from "lucide-react";

import { useAccrualSchedule, useApRollforward, useCloseChecklist, usePnl, useVariance } from "@/hooks/useFinance";
import { addMonths, formatPct, formatVndMillions, isMonthKey, monthEnd, monthStart, toMonthKey } from "@/lib/finance/format";
import {
  closeProgress,
  deltaTone,
  driverText,
  lineLabel,
  monthName,
  niceScale,
  signedMillions,
  varianceSummary,
} from "@/lib/finance/labels";
import { buildPnlStatement } from "@/lib/finance/statement";
import type {
  FinanceAccrualPolicy,
  FinanceCloseCheck,
  FinancePnl,
  FinanceVarianceLine,
} from "@/lib/finance/types";
import { cn } from "@/lib/utils";
import "@/styles/bmq-finance.css";

/**
 * Finance — English-only management reporting built on the finance_* RPCs
 * (migration 20261102450000). Read-only: nothing here writes to the ledger.
 */

type View = "pnl" | "variance" | "payables" | "accruals" | "close";

const VIEWS: { id: View; label: string }[] = [
  { id: "pnl", label: "P&L" },
  { id: "variance", label: "Variance" },
  { id: "payables", label: "Payables" },
  { id: "accruals", label: "Accruals" },
  { id: "close", label: "Close" },
];

const FIRST_MONTH = "2026-01";
const M = (value: number | null | undefined) => formatVndMillions(value ?? null) ?? "—";

function currentMonthVN(): string {
  return toMonthKey(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()));
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Numbers count to their new value with a strong ease-out; instant under reduced motion. */
function CountUp({ value, format }: { value: number | null; format: (n: number | null) => string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<number | null>(value);
  const from = useRef<number | null>(value);
  useEffect(() => {
    if (value === null || reduced) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = from.current ?? 0;
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / 520);
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(start + (value - start) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced]);
  return <>{format(shown)}</>;
}

export default function FinanceReports() {
  const [params, setParams] = useSearchParams();
  const maxMonth = currentMonthVN();
  const rawView = params.get("view");
  const view: View = VIEWS.some((item) => item.id === rawView) ? (rawView as View) : "pnl";
  const rawMonth = params.get("month") ?? "";
  const month = isMonthKey(rawMonth) && rawMonth >= FIRST_MONTH && rawMonth <= maxMonth ? rawMonth : addMonths(maxMonth, -1);

  const set = (next: Partial<{ view: View; month: string }>) => {
    const query = new URLSearchParams(params);
    if (next.view) query.set("view", next.view);
    if (next.month) query.set("month", next.month);
    setParams(query, { replace: true });
  };

  const pnl = usePnl(monthStart(addMonths(month, -5)), monthEnd(month));
  const close = useCloseChecklist(month);
  const totals = pnl.data?.totals[month];
  const coverage = pnl.data?.coverage[month];
  const progress = close.data ? closeProgress(close.data.checks) : null;

  return (
    <div className="fin" lang="en" data-bmq-finance>
      <header className="fin-head">
        <div className="fin-title">
          <h1>Finance</h1>
          <p>
            {totals?.revenue != null
              ? <>{monthName(month)} · EBITDA <b>{M(totals.ebitda)}</b> on revenue of {M(totals.revenue)}
                {coverage?.classified_pct != null ? <> · {formatPct(coverage.classified_pct, 0)} of spend classified</> : null}</>
              : <>{monthName(month)} · management accounts from the controlled ledger and approved payment requests.</>}
          </p>
        </div>
        <MonthStepper month={month} min={FIRST_MONTH} max={maxMonth} onChange={(next) => set({ month: next })} />
      </header>

      <Tabs
        value={view}
        onChange={(next) => set({ view: next })}
        badges={{ close: progress?.attention ? String(progress.attention) : undefined }}
      />

      <div className="fin-view" key={`${view}-${month}`}>
        {view === "pnl" && <PnlView month={month} query={pnl} />}
        {view === "variance" && <VarianceView month={month} />}
        {view === "payables" && <PayablesView month={month} />}
        {view === "accruals" && <AccrualsView month={month} />}
        {view === "close" && <CloseView month={month} query={close} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

function MonthStepper({ month, min, max, onChange }: { month: string; min: string; max: string; onChange: (m: string) => void }) {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  return (
    <div className="fin-month" role="group" aria-label="Reporting month">
      <button type="button" className="fin-press fin-icon" aria-label={`Previous month, ${monthName(prev)}`} disabled={prev < min} onClick={() => onChange(prev)}>
        <ChevronLeft aria-hidden />
      </button>
      <span className="fin-month-label" aria-live="polite">{monthName(month)}{month === max ? <small>to date</small> : null}</span>
      <button type="button" className="fin-press fin-icon" aria-label={`Next month, ${monthName(next)}`} disabled={next > max} onClick={() => onChange(next)}>
        <ChevronRight aria-hidden />
      </button>
    </div>
  );
}

function Tabs({ value, onChange, badges }: { value: View; onChange: (v: View) => void; badges: Partial<Record<View, string>> }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>(`[data-view="${value}"]`);
      if (active) setBar({ x: active.offsetLeft, w: active.offsetWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value, badges.close]);

  return (
    <div className="fin-tabs" role="tablist" aria-label="Finance views" ref={listRef}>
      {VIEWS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          data-view={item.id}
          aria-selected={value === item.id}
          className={cn("fin-tab fin-press", value === item.id && "is-on")}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {badges[item.id] ? <span className="fin-tab-count" aria-label={`${badges[item.id]} need attention`}>{badges[item.id]}</span> : null}
        </button>
      ))}
      {bar ? <span className="fin-tab-bar" aria-hidden style={{ transform: `translateX(${bar.x}px) scaleX(${bar.w})` }} /> : null}
    </div>
  );
}

function Panel({ title, note, aside, children, className }: { title: string; note?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("fin-panel", className)}>
      <div className="fin-panel-h">
        <div>
          <h2>{title}</h2>
          {note ? <p>{note}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function QueryState({ query, children, empty }: { query: { isLoading: boolean; error: unknown; refetch: () => unknown }; children: ReactNode; empty?: boolean }) {
  if (query.isLoading) {
    return (
      <div className="fin-loading" aria-busy="true" aria-label="Loading">
        <span /><span /><span />
      </div>
    );
  }
  if (query.error) {
    const message = (query.error as { message?: string })?.message ?? "";
    const denied = /insufficient_privilege|permission/i.test(message);
    return (
      <div className="fin-error" role="alert">
        <XCircle aria-hidden />
        <div>
          <b>{denied ? "You don't have access to finance reports." : "Couldn't load this report."}</b>
          <p>{denied ? "Ask the owner for Cost classification or Revenue view access." : "Nothing was changed. Check the connection and try again."}</p>
        </div>
        {!denied ? (
          <button type="button" className="fin-btn fin-press" onClick={() => query.refetch()}>
            <RotateCw aria-hidden /> Retry
          </button>
        ) : null}
      </div>
    );
  }
  if (empty) return <p className="fin-empty">No data for this month yet.</p>;
  return <>{children}</>;
}

/* -------------------------------------------------------------------- P&L */

/** Plain-English data notes; null hides a flag that only states an absence. */
const FLAG_NOTES: Record<string, string | null> = {
  capex_missing: null,
  unclassified_missing: null,
  coverage_below_target: null,
  expense_missing: "No approved payment request has been dated in this month yet.",
  revenue_missing: "No approved revenue has been recorded for this month.",
  cogs_missing: "No spend is classified as cost of goods sold yet, so gross margin reads high.",
  selling_missing: "No spend is classified as selling expense yet.",
  operating_missing: "No spend is classified as operating expense yet.",
  payroll_missing: "No salary payout is recorded for this month.",
  payroll_double_count_risk: "Payroll appears both as payouts and as classified expense lines; check before closing.",
  unclassified_present: "Part of the spend is still unclassified or on a retired category.",
};

function PnlView({ month, query }: { month: string; query: ReturnType<typeof usePnl> }) {
  const data = query.data;
  const totals = data?.totals[month];
  const prior = data?.totals[addMonths(month, -1)];
  const coverage = data?.coverage[month];
  const rows = useMemo(() => (data ? buildPnlStatement(data) : []), [data]);
  const notes = (data?.flags ?? [])
    .filter((flag) => flag.month === month && FLAG_NOTES[flag.code] !== null)
    .map((flag) => ({ code: flag.code, text: FLAG_NOTES[flag.code] ?? flag.detail_en }));

  return (
    <QueryState query={query} empty={!data || totals?.revenue == null}>
      {data && totals ? (
        <>
          {coverage?.classified_pct != null && coverage.classified_pct < 0.9 ? (
            <div className="fin-notice" role="note">
              <Info aria-hidden />
              <p>
                <b>{formatPct(coverage.classified_pct, 0)} of {monthName(month, true)} spend is classified</b> ({M(coverage.classified_amount)} of {M(coverage.expense_total)}).
                The rest sits under Unclassified until Sushi and the controller finish review, so EBITDA is provisional.
              </p>
            </div>
          ) : null}

          <div className="fin-kpis" aria-label={`${monthName(month)} headline figures`}>
            <Kpi label="Revenue" value={totals.revenue} prior={prior?.revenue ?? null} section="revenue" code="REVENUE_TOTAL" />
            <Kpi label="Gross profit" value={totals.gross_profit} prior={prior?.gross_profit ?? null} section="summary" code="GROSS_PROFIT" sub={totals.gross_margin != null ? `${formatPct(totals.gross_margin)} margin` : undefined} />
            <Kpi label="EBITDA" value={totals.ebitda} prior={prior?.ebitda ?? null} section="summary" code="EBITDA" lead sub={totals.ebitda_margin != null ? `${formatPct(totals.ebitda_margin)} margin` : undefined} />
            <Kpi label="Unclassified spend" value={totals.unclassified} prior={prior?.unclassified ?? null} section="unclassified" code="UNCLASSIFIED_TOTAL" />
          </div>

          <div className="fin-grid">
            <Panel title="Revenue and EBITDA" note="Six months. The bar is revenue; the filled part is what is left as EBITDA.">
              <EbitdaChart data={data} month={month} />
            </Panel>
            <Panel title="By product line" note={`${monthName(month)}. Direct costs only; shared costs are not allocated.`}>
              <ProductLines data={data} month={month} />
            </Panel>
          </div>

          <Panel title="Income statement" note="Management view in VND millions. Capex sits below EBITDA and is not deducted from it.">
            <StatementTable rows={rows} months={data.months} month={month} totals={data.totals} />
          </Panel>

          {notes.length ? (
            <Panel title="Data notes" className="is-quiet">
              <ul className="fin-notes">
                {notes.map((note) => <li key={note.code}>{note.text}</li>)}
              </ul>
            </Panel>
          ) : null}
        </>
      ) : null}
    </QueryState>
  );
}

function Kpi({ label, value, prior, section, code, sub, lead }: { label: string; value: number | null; prior: number | null; section: string; code: string; sub?: string; lead?: boolean }) {
  const delta = value !== null && prior !== null ? value - prior : null;
  const tone = deltaTone(section, code, delta);
  return (
    <div className={cn("fin-kpi", lead && "is-lead")}>
      <span className="fin-kpi-label">{label}</span>
      <strong className="fin-num"><CountUp value={value} format={M} /></strong>
      <span className="fin-kpi-sub">
        {sub ? <>{sub} · </> : null}
        {delta === null ? <span className="fin-dim">no prior month</span> : <span className={`fin-tone-${tone}`}>{signedMillions(delta)} vs last month</span>}
      </span>
    </div>
  );
}

function EbitdaChart({ data, month }: { data: FinancePnl; month: string }) {
  const points = data.months.map((key) => ({ key, revenue: data.totals[key]?.revenue ?? null, ebitda: data.totals[key]?.ebitda ?? null }));
  const max = Math.max(0, ...points.map((p) => p.revenue ?? 0));
  const scale = niceScale(max / 1_000_000);
  return (
    <figure className="fin-chart" aria-label="Revenue and EBITDA by month">
      <div className="fin-chart-plot">
        <div className="fin-chart-grid" aria-hidden>
          {scale.ticks.slice().reverse().map((tick) => (
            <span key={tick} style={{ bottom: `${(tick / scale.top) * 100}%` }}><em>{tick.toLocaleString("en-US")}M</em></span>
          ))}
        </div>
        <ol className="fin-cols">
          {points.map((point, index) => {
            const rev = point.revenue ? point.revenue / 1_000_000 / scale.top : 0;
            const ebitda = point.revenue && point.ebitda && point.ebitda > 0 ? Math.min(1, point.ebitda / point.revenue) : 0;
            return (
              <li key={point.key} className={cn(point.key === month && "is-on")} style={{ ["--i" as string]: index }}>
                <div className="fin-col" style={{ height: `${rev * 100}%` }} title={`${monthName(point.key)}: revenue ${M(point.revenue)}, EBITDA ${M(point.ebitda)}`}>
                  <span className="fin-col-fill" style={{ height: `${ebitda * 100}%` }} />
                </div>
                <span className="fin-col-x">{monthName(point.key, true)}</span>
                <span className="sr-only">{monthName(point.key)}: revenue {M(point.revenue)}, EBITDA {M(point.ebitda)}</span>
              </li>
            );
          })}
        </ol>
      </div>
      <figcaption className="fin-legend">
        <span><i className="is-track" />Revenue</span>
        <span><i className="is-fill" />EBITDA</span>
      </figcaption>
    </figure>
  );
}

function ProductLines({ data, month }: { data: FinancePnl; month: string }) {
  const lines = data.by_product_line[month];
  if (!lines) return <p className="fin-empty">No product-line split for this month.</p>;
  const rows = [
    { key: "bmq_bread", label: "Bánh mì que & bread", ...lines.bmq_bread },
    { key: "sweet_kitchen", label: "Pastry kitchen", ...lines.sweet_kitchen },
  ];
  const max = Math.max(1, ...rows.map((row) => row.revenue ?? 0));
  return (
    <div className="fin-lines">
      {rows.map((row, index) => (
        <div key={row.key} className="fin-line-row" style={{ ["--i" as string]: index }}>
          <div className="fin-line-top">
            <span>{row.label}</span>
            <b className="fin-num">{M(row.contribution)}</b>
          </div>
          <div className="fin-line-track" aria-hidden>
            <span style={{ transform: `scaleX(${(row.revenue ?? 0) / max})` }} />
          </div>
          <span className="fin-line-sub">Revenue {M(row.revenue)} · direct costs {M(row.direct_costs)}</span>
        </div>
      ))}
      <div className="fin-line-shared">
        <span>Shared costs (not allocated)</span>
        <b className="fin-num">{M(lines.shared_costs)}</b>
      </div>
    </div>
  );
}

function StatementTable({ rows, months, month, totals }: { rows: ReturnType<typeof buildPnlStatement>; months: string[]; month: string; totals: FinancePnl["totals"] }) {
  // Without classified COGS a 100% gross margin would be an artefact, not a margin.
  const margin = (key: "gross_margin" | "ebitda_margin") =>
    months.map((m) => (key === "gross_margin" && totals[m]?.cogs == null ? "—" : formatPct(totals[m]?.[key] ?? null) ?? "—"));
  const wrapRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const cell = wrap?.querySelector<HTMLElement>("thead th.is-on");
    const first = wrap?.querySelector<HTMLElement>("thead th");
    if (!wrap || !cell || !first || wrap.scrollWidth <= wrap.clientWidth) return;
    wrap.scrollLeft = Math.max(0, cell.offsetLeft + cell.offsetWidth - wrap.clientWidth + 16);
  }, [month, months.length]);
  return (
    <div className="fin-table-wrap" ref={wrapRef} tabIndex={0} role="region" aria-label="Income statement, scrolls sideways">
      <table className="fin-table">
        <thead>
          <tr>
            <th scope="col">Line</th>
            {months.map((m) => <th key={m} scope="col" className={cn(m === month && "is-on")}>{monthName(m, true)} {m.slice(2, 4)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = row.kind === "line" ? lineLabel(row.section, row.lineCode ?? "", row.label) : row.label;
            return (
              <Fragment key={row.key}>
                <tr className={`is-${row.kind}`}>
                  <th scope="row">{label}</th>
                  {months.map((m) => {
                    const value = row.amounts[m] ?? null;
                    return (
                      <td key={m} className={cn("fin-num", m === month && "is-on", value !== null && value < 0 && "is-neg")}>
                        {value === null ? <span className="fin-dim">—</span> : M(value)}
                      </td>
                    );
                  })}
                </tr>
                {row.key === "subtotal:gross_profit" || row.key === "subtotal:ebitda" ? (
                  <tr className="is-margin">
                    <th scope="row">{row.key === "subtotal:ebitda" ? "EBITDA margin" : "Gross margin"}</th>
                    {margin(row.key === "subtotal:ebitda" ? "ebitda_margin" : "gross_margin").map((text, i) => (
                      <td key={months[i]} className={cn("fin-num", months[i] === month && "is-on")}>{text}</td>
                    ))}
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- Variance */

function VarianceView({ month }: { month: string }) {
  const query = useVariance(monthStart(month));
  const [all, setAll] = useState(false);
  const data = query.data;
  const lines = (data?.lines ?? []).filter((line) => all || line.flagged);
  const hidden = (data?.lines.length ?? 0) - (data?.lines.filter((line) => line.flagged).length ?? 0);

  return (
    <QueryState query={query} empty={!data}>
      {data ? (
        <Panel
          title="Month-on-month variance"
          note={<>{varianceSummary(data.lines, data.month, data.prior_month)} Lines are flagged above {formatPct(data.materiality.pct, 0)} of last month or {M(data.materiality.floor_vnd)}; revenue, payroll and EBITDA are always shown. No budget is set, so there is no budget column.</>}
          aside={hidden > 0 ? (
            <button type="button" className="fin-btn fin-press" aria-pressed={all} onClick={() => setAll((v) => !v)}>
              {all ? "Flagged only" : `Show all (${data.lines.length})`}
            </button>
          ) : null}
        >
          <div className="fin-var" role="table" aria-label="Variance by line">
            <div className="fin-var-row is-head" role="row">
              <span role="columnheader">Line</span>
              <span role="columnheader" className="fin-num">{monthName(data.month, true)}</span>
              <span role="columnheader" className="fin-num">{monthName(data.prior_month, true)}</span>
              <span role="columnheader" className="fin-num">Change</span>
              <span role="columnheader">Driver</span>
            </div>
            {lines.map((line, index) => <VarianceRow key={`${line.level}-${line.line_code}`} line={line} index={index} />)}
          </div>
        </Panel>
      ) : null}
    </QueryState>
  );
}

function VarianceRow({ line, index }: { line: FinanceVarianceLine; index: number }) {
  const tone = deltaTone(line.section, line.line_code, line.delta);
  const driver = driverText(line);
  return (
    <div className={cn("fin-var-row", line.level === "subtotal" && "is-subtotal")} role="row" style={{ ["--i" as string]: Math.min(index, 12) }}>
      <span role="cell" className="fin-var-line">{lineLabel(line.section, line.line_code, line.label)}</span>
      <span role="cell" className="fin-num" data-label="This month">{M(line.current)}</span>
      <span role="cell" className="fin-num" data-label="Last month">{M(line.prior)}</span>
      <span role="cell" className={cn("fin-num", `fin-tone-${tone}`)} data-label="Change">
        {signedMillions(line.delta)}
        {line.delta_pct != null ? <small>{formatPct(line.delta_pct, 1)}</small> : null}
      </span>
      <span role="cell" className={cn("fin-var-driver", driver?.startsWith("Driver unclear") && "is-unclear")}>{driver ?? <span className="fin-dim">Below threshold</span>}</span>
    </div>
  );
}

/* --------------------------------------------------------------- Payables */

const AGING_LABELS: Record<string, string> = { "0-30": "0–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "Over 90 days" };

function PayablesView({ month }: { month: string }) {
  const query = useApRollforward(monthStart(month));
  const data = query.data;
  const agingTotal = data ? data.aging.reduce((sum, bucket) => sum + bucket.amount, 0) : 0;
  const topMax = data ? Math.max(1, ...data.top_suppliers.map((s) => s.amount)) : 1;
  const sign: Record<string, string> = { additions: "+", payments: "−", adjustments: "−" };

  return (
    <QueryState query={query} empty={!data}>
      {data ? (
        <>
          <Panel
            title="Payables roll-forward"
            note="Approved payment requests not yet paid. Pending requests are not liabilities until approved."
            aside={<span className={cn("fin-chip", data.foot.pass ? "is-good" : "is-bad")}>{data.foot.pass ? <><CheckCircle2 aria-hidden /> Ties out</> : <><XCircle aria-hidden /> Gap {M(data.foot.unexplained_delta)}</>}</span>}
          >
            <ol className="fin-roll">
              {data.lines.map((line, index) => (
                <li key={line.code} className={cn(`is-${line.code}`)} style={{ ["--i" as string]: index }}>
                  <div>
                    <span>{sign[line.code] ? <i aria-hidden>{sign[line.code]}</i> : null}{rollLabel(line.code, line.label)}</span>
                    <small title={line.ties_to}>{rollSource(line.code, month)}</small>
                  </div>
                  <b className="fin-num">{M(line.amount)}</b>
                </li>
              ))}
            </ol>
            {data.flags.includes("adjustments_not_tracked") ? <p className="fin-foot">Rejections after approval carry no timestamp yet, so adjustments show as zero.</p> : null}
          </Panel>

          <div className="fin-grid">
            <Panel title="Aging" note={`${M(agingTotal)} open at the end of ${monthName(month)}, by age of the request.`}>
              <div className="fin-stack" role="img" aria-label={data.aging.map((b) => `${AGING_LABELS[b.bucket]} ${M(b.amount)}`).join(", ")}>
                {data.aging.map((bucket) => (
                  <span key={bucket.bucket} className={`is-${bucket.bucket.replace("+", "p")}`} style={{ flexGrow: bucket.amount || 0.0001 }} />
                ))}
              </div>
              <ul className="fin-aging">
                {data.aging.map((bucket) => (
                  <li key={bucket.bucket}>
                    <i className={`is-${bucket.bucket.replace("+", "p")}`} aria-hidden />
                    <span>{AGING_LABELS[bucket.bucket]}</span>
                    <span className="fin-dim">{bucket.count} req.</span>
                    <b className="fin-num">{M(bucket.amount)}</b>
                  </li>
                ))}
              </ul>
              {data.overdue.count > 0 ? (
                <p className="fin-foot is-bad">{data.overdue.count} requests ({M(data.overdue.amount)}) are older than {data.overdue.days_threshold} days.</p>
              ) : null}
            </Panel>
            <Panel title="Largest balances" note="Suppliers by open amount at month end.">
              <ol className="fin-rank">
                {data.top_suppliers.map((supplier, index) => (
                  <li key={supplier.supplier_id ?? supplier.supplier_name} style={{ ["--i" as string]: index }}>
                    <span className="fin-rank-fill" style={{ transform: `scaleX(${supplier.amount / topMax})` }} aria-hidden />
                    <span className="fin-rank-name">{supplier.supplier_name}</span>
                    <span className="fin-dim">{supplier.count}</span>
                    <b className="fin-num">{M(supplier.amount)}</b>
                  </li>
                ))}
              </ol>
            </Panel>
          </div>
        </>
      ) : null}
    </QueryState>
  );
}

/** Where each roll-forward line comes from, in words; the raw query stays in the tooltip. */
function rollSource(code: string, month: string): string {
  const start = `1 ${monthName(month, true)}`;
  const next = `1 ${monthName(addMonths(month, 1), true)}`;
  return (
    {
      opening: `Approved requests raised before ${start} and unpaid on that day.`,
      additions: `Approved requests raised from ${start} to month end.`,
      payments: "Approved requests marked paid during the month.",
      adjustments: "Requests rejected after approval during the month.",
      closing_computed: "Opening plus new requests, less payments and adjustments. Never plugged.",
      closing_actual: `Approved requests raised before ${next} and unpaid on that day.`,
    } as Record<string, string>
  )[code] ?? "";
}

function rollLabel(code: string, fallback: string): string {
  return (
    {
      opening: "Opening balance",
      additions: "New approved requests",
      payments: "Payments made",
      adjustments: "Adjustments",
      closing_computed: "Closing balance, computed",
      closing_actual: "Closing balance, per requests",
    } as Record<string, string>
  )[code] ?? fallback;
}

/* --------------------------------------------------------------- Accruals */

const ACCRUAL_FLAGS: Record<string, string> = {
  no_history: "No classified history yet; the basis needs at least one complete month.",
  no_current_bookings: "Nothing booked this month yet.",
  future_period: "Future month.",
};

function AccrualsView({ month }: { month: string }) {
  const query = useAccrualSchedule(monthStart(month));
  const data = query.data;
  const total = data?.policies.reduce((sum, p) => sum + (p.accrual ?? 0), 0) ?? 0;
  return (
    <QueryState query={query} empty={!data}>
      {data ? (
        <Panel
          title="Accrual schedule"
          note="Drafts for controller approval. Nothing is posted to the ledger; each entry reverses on day 1 of next month."
          aside={<span className="fin-chip">Draft — not posted</span>}
        >
          <div className="fin-acc">
            {data.policies.map((policy, index) => <AccrualRow key={policy.code} policy={policy} index={index} />)}
          </div>
          <div className="fin-acc-total">
            <span>Total proposed accruals</span>
            <b className="fin-num"><CountUp value={total} format={M} /></b>
          </div>
        </Panel>
      ) : null}
    </QueryState>
  );
}

function AccrualRow({ policy, index }: { policy: FinanceAccrualPolicy; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fin-acc-row" style={{ ["--i" as string]: index }}>
      <div className="fin-acc-main">
        <div>
          <b>{policy.name_en}</b>
          <small>{policy.basis_method === "payroll_last_month" ? "Basis: last month's payroll" : "Basis: average of the last three months"}</small>
        </div>
        <dl>
          <div><dt>Basis</dt><dd className="fin-num">{M(policy.basis)}</dd></div>
          <div><dt>Booked</dt><dd className="fin-num">{M(policy.already_booked)}</dd></div>
          <div><dt>Accrue</dt><dd className="fin-num is-strong">{M(policy.accrual)}</dd></div>
        </dl>
      </div>
      {policy.flags.length ? <p className="fin-acc-flags">{policy.flags.map((flag) => ACCRUAL_FLAGS[flag] ?? flag).join(" ")}</p> : null}
      {policy.draft_je ? (
        <>
          <button type="button" className="fin-link fin-press" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide journal entry" : "Show draft journal entry"}
          </button>
          <div className={cn("fin-je", open && "is-open")} aria-hidden={!open}>
            <div className="fin-je-inner">
              <div><span>Dr {policy.draft_je.debit}</span><b className="fin-num">{M(policy.draft_je.amount)}</b></div>
              <div className="is-cr"><span>Cr {policy.draft_je.credit}</span><b className="fin-num">{M(policy.draft_je.amount)}</b></div>
              <p>{policy.draft_je.memo}</p>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Close */

const CHECK_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, info: Info };

function CloseView({ month, query }: { month: string; query: ReturnType<typeof useCloseChecklist> }) {
  const data = query.data;
  const progress = data ? closeProgress(data.checks) : null;
  return (
    <QueryState query={query} empty={!data}>
      {data && progress ? (
        <Panel title={`Close checklist · ${monthName(month)}`} note="Read-only checks. Fix the source records; the list updates on reload.">
          <div className="fin-progress">
            <div className="fin-progress-top">
              <span><b className="fin-num">{progress.pass}</b> of {progress.total} checks pass</span>
              <span className="fin-dim">{progress.attention ? `${progress.attention} need attention` : "Ready for review"}</span>
            </div>
            <div className="fin-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.pass}>
              <span style={{ transform: `scaleX(${progress.total ? progress.pass / progress.total : 0})` }} />
            </div>
          </div>
          <ul className="fin-checks">
            {data.checks.map((check, index) => <CheckRow key={check.code} check={check} index={index} />)}
          </ul>
        </Panel>
      ) : null}
    </QueryState>
  );
}

function CheckRow({ check, index }: { check: FinanceCloseCheck; index: number }) {
  const Icon = CHECK_ICON[check.status];
  return (
    <li className={`fin-check is-${check.status}`} style={{ ["--i" as string]: index }}>
      <Icon aria-hidden />
      <div>
        <b>{check.title_en}</b>
        <p>{checkDetail(check)}</p>
      </div>
      <span className="sr-only">Status: {check.status}</span>
    </li>
  );
}

function checkDetail(check: FinanceCloseCheck): string {
  const v = (check.value ?? {}) as Record<string, number | boolean | null>;
  const n = (key: string) => (typeof v[key] === "number" ? (v[key] as number) : null);
  switch (check.code) {
    case "REVENUE_CONTROLLED":
      return `${n("approved_lines") ?? 0} approved lines, ${M(n("approved_amount"))}${n("pending_lines") ? `; ${n("pending_lines")} still pending` : ""}.`;
    case "EXPENSE_COVERAGE":
      return `${formatPct(n("classified_pct"), 0) ?? "—"} of ${M(n("expense_total"))} classified; target ${formatPct(n("target"), 0) ?? "—"}.`;
    case "REVIEW_QUEUE":
      return n("line_count") ? `${n("line_count")} lines (${M(n("amount"))}) waiting for classification review.` : "Nothing waiting for review.";
    case "PAYROLL_RECORDED":
      return n("payout_count") ? `${n("payout_count")} payouts, ${M(n("amount"))}.` : "No salary payout recorded for this month.";
    case "PAYROLL_DOUBLE_COUNT":
      return n("c6_expense_lines") ? `${n("c6_expense_lines")} payroll expense lines overlap the payouts; check before closing.` : "Payouts and payroll expense lines do not overlap.";
    case "AP_OVERDUE":
      return n("count") ? `${n("count")} approved requests (${M(n("amount"))}) unpaid for more than ${n("days_threshold")} days.` : "No approved request is overdue.";
    case "AP_ROLLFORWARD_FOOT":
      return v.pass ? "Opening plus activity ties to the closing balance." : `Unexplained gap of ${M(n("unexplained_delta"))}.`;
    case "LEGACY_CATEGORIES":
      return n("line_count") ? `${n("line_count")} lines (${M(n("amount"))}) still on retired categories.` : "Nothing left on retired categories.";
    case "BUDGET":
      return "No budget is set, so variance compares with last month only.";
    case "COLLECTIONS":
      return "Customer collections are not recorded yet, so receivables are not reported.";
    default:
      return check.detail_en;
  }
}

