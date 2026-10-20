import type {
  FinanceMonthKey,
  FinancePnl,
  FinancePnlSection,
} from "./types.ts";

export type FinanceStatementSection = FinancePnlSection | "summary";
export type FinanceStatementRowKind = "section" | "line" | "subtotal";

export interface FinanceStatementRow {
  key: string;
  kind: FinanceStatementRowKind;
  section: FinanceStatementSection;
  label: string;
  lineCode: string | null;
  amounts: Record<FinanceMonthKey, number | null>;
}

/** Ratio margin with a null result when revenue is unavailable or zero. */
export function marginPct(
  amount: number | null | undefined,
  revenue: number | null | undefined,
): number | null {
  if (amount === null || amount === undefined) return null;
  if (revenue === null || revenue === undefined || revenue === 0) return null;
  return amount / revenue;
}

function sectionAmounts(
  pnl: FinancePnl,
  section: FinancePnlSection,
): Record<FinanceMonthKey, number | null> {
  const amounts: Record<FinanceMonthKey, number | null> = {};
  for (const month of pnl.months) {
    const totals = pnl.totals[month];
    amounts[month] =
      section === "revenue" ? (totals?.revenue ?? null)
        : section === "cogs" ? (totals?.cogs ?? null)
          : section === "selling" ? (totals?.selling ?? null)
            : section === "operating" ? (totals?.operating ?? null)
              : section === "unclassified" ? (totals?.unclassified ?? null)
                : (totals?.capex ?? null);
  }
  return amounts;
}

function subtotalAmounts(
  pnl: FinancePnl,
  key: "gross_profit" | "ebitda",
): Record<FinanceMonthKey, number | null> {
  const amounts: Record<FinanceMonthKey, number | null> = {};
  for (const month of pnl.months) {
    amounts[month] = pnl.totals[month]?.[key] ?? null;
  }
  return amounts;
}

const SECTION_LABELS: Record<FinancePnlSection, string> = {
  revenue: "Revenue",
  cogs: "Cost of goods sold",
  selling: "Selling expenses",
  operating: "Operating expenses",
  unclassified: "Unclassified expenses",
  capex: "Capital expenditure",
};

/**
 * Build the statement view in the fixed section order:
 * revenue, cogs, gross profit, selling, operating, unclassified, EBITDA, capex.
 * Capex is deliberately below EBITDA and never folded into it.
 */
export function buildPnlStatement(pnl: FinancePnl): FinanceStatementRow[] {
  const rows: FinanceStatementRow[] = [];
  const pushSection = (section: FinancePnlSection) => {
    rows.push({
      key: `section:${section}`,
      kind: "section",
      section,
      label: SECTION_LABELS[section],
      lineCode: null,
      amounts: sectionAmounts(pnl, section),
    });

    pnl.lines
      .filter((line) => line.section === section)
      .slice()
      .sort((a, b) => a.line_code.localeCompare(b.line_code))
      .forEach((line) => {
        rows.push({
          key: `line:${section}:${line.line_code}`,
          kind: "line",
          section,
          label: line.label,
          lineCode: line.line_code,
          amounts: line.amounts,
        });
      });
  };

  pushSection("revenue");
  pushSection("cogs");
  rows.push({
    key: "subtotal:gross_profit",
    kind: "subtotal",
    section: "summary",
    label: "Gross profit",
    lineCode: "GROSS_PROFIT",
    amounts: subtotalAmounts(pnl, "gross_profit"),
  });
  pushSection("selling");
  pushSection("operating");
  pushSection("unclassified");
  rows.push({
    key: "subtotal:ebitda",
    kind: "subtotal",
    section: "summary",
    label: "EBITDA",
    lineCode: "EBITDA",
    amounts: subtotalAmounts(pnl, "ebitda"),
  });
  pushSection("capex");

  return rows;
}
