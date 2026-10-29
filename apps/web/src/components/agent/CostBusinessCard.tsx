import type { CostLineBlock } from "@/lib/bmqAnalytics";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, FileText, HelpCircle } from "lucide-react";
import {
  COST_BLOCK_LABELS,
  costBlockExplanationSummary,
  costBlockHeading,
  costBlockVisibleWarning,
  type CostBlockLanguage,
} from "./costBlockPresentation";

// Renders exactly the validated structured block produced by the read-only
// warehouse cost lane. No prose is generated here and no value is inferred: the
// component only formats the server-verified fields and the server-localized
// evidence notes.
//
// Layout contract (owner-approved concept):
// - example turn  -> compact document card: "PHIẾU CHI PHÍ" + status, date and
//   supplier, then item with a prominent exact VND amount. Document number,
//   category, confidence, classification source, stored rule/alias metadata and
//   the long evidence notes all live under the collapsed "Chi tiết nguồn".
// - explanation turn -> a separate, concise explanation block (never the monetary
//   card again) with a descriptive heading and one grounded sentence.
// A follow-up is offered only on the newest example card whose signed context the
// widget has independently confirmed; explanation blocks do not repeat it.
type CostBusinessCardProps = {
  block: CostLineBlock;
  language: "en" | "vi";
  followUpEnabled: boolean;
  followUpDisabledReason?: string;
  onFollowUp: () => void;
};

const STATUS_STYLE: Record<string, string> = {
  needs_review: "is-warn",
  suggested: "is-info",
  approved: "is-pos",
  rejected: "is-neg",
};

// Disclosed meaning of the one selection rule the backend accepts. The exact rule
// id always renders; this adds back the human-readable disclosure in the collapsed
// source details so the card never hides how the example row was chosen.
const SELECTION_RULE_NOTES: Record<string, Record<CostBlockLanguage, string>> = {
  largest_line_amount_then_source_date_then_classification_id: {
    vi: "Quy tắc chọn (công khai): số tiền lớn nhất trước, rồi ngày nguồn, rồi mã phân loại. Đây là ví dụ xác định, không phải xếp hạng mức độ quan trọng.",
    en: "Selection rule (disclosed): largest exact line_amount first, then source date, then classification id. This is a deterministic example, not a ranking of importance.",
  },
};

const text = (value: string | null, missing: string) => (value && value.trim() ? value : missing);

function formatDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatVnd(amount: number, language: CostBlockLanguage) {
  return new Intl.NumberFormat(language === "en" ? "en-US" : "vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="ac-label">{label}</dt>
      <dd className="ac-strong mt-0.5 break-words text-[13px]">{value}</dd>
    </div>
  );
}

// Everything that is not a primary document fact stays here, collapsed, so the
// card never fills the screen with metadata. Long evidence notes keep their full
// true wording; nothing is trimmed.
function SourceDetails({ block, language }: { block: CostLineBlock; language: CostBlockLanguage }) {
  const labels = COST_BLOCK_LABELS[language];
  const rule = block.evidence.rule;
  const alias = block.evidence.alias;
  // Auditability: keep both the human label and the exact canonical code here
  // (the card face only ever shows the primary document facts).
  const category = block.line.categoryLabel && block.line.categoryCode
    ? `${block.line.categoryLabel} (${block.line.categoryCode})`
    : text(block.line.categoryLabel, block.line.categoryCode ?? labels.missing);
  const selectionRuleNote = block.source.selectionRule ? SELECTION_RULE_NOTES[block.source.selectionRule]?.[language] : undefined;

  return (
    <div className="ac-meta space-y-2 break-words px-3 pb-3">
      <dl className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
        {block.line.sourceNumber ? <Detail label={labels.document} value={block.line.sourceNumber} /> : null}
        {block.line.categoryLabel || block.line.categoryCode ? <Detail label={labels.category} value={category} /> : null}
        {block.line.confidence ? <Detail label={labels.confidence} value={block.line.confidence} /> : null}
        {block.line.classificationSource ? <Detail label={labels.classificationSource} value={block.line.classificationSource} /> : null}
      </dl>

      {rule ? (
        <div>
          <div className="ac-label font-medium">{labels.rule}</div>
          <div className="mt-0.5">
            {rule.name} · {rule.scope} · {labels.priority} {rule.priority} · {labels.ruleConfidence} {rule.confidence}
            {rule.effectiveFrom ? ` · ${rule.effectiveFrom} → ${rule.effectiveTo ?? labels.openEnded}` : ""}
          </div>
        </div>
      ) : null}

      {alias ? (
        <div>
          <div className="ac-label font-medium">{labels.alias}</div>
          <div className="mt-0.5">{alias.sourceName} → {alias.standardCode} · {alias.canonicalName}</div>
        </div>
      ) : block.evidence.aliasStatus ? (
        <div>{labels.aliasStatus}: {block.evidence.aliasStatus}</div>
      ) : null}

      {block.notes.length ? (
        <div data-bmq-cost-notes>
          <div className="ac-label font-medium">{labels.notes}</div>
          <ul className="mt-1 space-y-1.5 text-[12px] leading-relaxed text-[var(--ac-ink-2)]">
            {block.notes.map((note, index) => <li key={index} className="break-words">- {note}</li>)}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1">
        <div>{labels.observed}: {block.source.observedAt}</div>
        <div>{labels.snapshot}: {block.source.snapshotId}</div>
        <div>{labels.semanticVersion}: {block.source.semanticVersion}</div>
        <div>{block.source.name}</div>
        {block.source.selectionRule ? <div>{labels.selectionRule}: {block.source.selectionRule}</div> : null}
        {selectionRuleNote ? <div>{selectionRuleNote}</div> : null}
        {block.source.matchCount !== null ? <div>{labels.matchCount}: {block.source.matchCount}</div> : null}
        {block.source.truncated ? <div>{labels.truncated}</div> : null}
        <div>{block.source.disclaimer}</div>
      </div>
    </div>
  );
}

function SourceDisclosure({ block, language }: { block: CostLineBlock; language: CostBlockLanguage }) {
  const labels = COST_BLOCK_LABELS[language];
  return (
    <details data-bmq-cost-source className="ac-details ac-divide">
      <summary className="px-3">
        <span className="flex items-center gap-1.5">
          <FileText className="h-4 w-4 text-[var(--ac-ink-2)]" aria-hidden="true" />
          <span>{labels.source}</span>
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <SourceDetails block={block} language={language} />
    </details>
  );
}

export function CostBusinessCard({ block, language, followUpEnabled, followUpDisabledReason, onFollowUp }: CostBusinessCardProps) {
  const labels = COST_BLOCK_LABELS[language];
  const status = block.line.reviewStatus ?? "";
  const statusLabel = labels.statuses[status] ?? status;
  const date = formatDate(block.line.sourceDate);

  if (block.mode === "explanation") {
    const summary = costBlockExplanationSummary(block, language);
    const warning = costBlockVisibleWarning(block, language);
    const identity = [block.line.classificationId, text(block.line.productName, labels.missing), date ?? labels.missing].join(" · ");
    return (
      <div
        data-bmq-business-block="cost-line-v1"
        data-bmq-business-block-mode="explanation"
        className="overflow-hidden rounded-[12px] bg-[var(--ac-well)] px-3 py-3 text-[var(--ac-ink)]"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className={cn("h-4 w-4 shrink-0", status === "needs_review" ? "text-[#92400e]" : "text-[var(--ac-ink-2)]")} aria-hidden="true" />
          <h3 data-bmq-cost-label className="m-0 text-[13px] font-semibold">{costBlockHeading(block, language)}</h3>
        </div>
        <div className="mt-1.5 space-y-1">
          {summary.map((line) => <p key={line} data-bmq-cost-label className="m-0 text-[13px] leading-relaxed">{line}</p>)}
          {warning ? <p data-bmq-cost-warning data-bmq-cost-label className="m-0 text-[13px] font-semibold leading-relaxed text-[#92400e]">{warning}</p> : null}
          <p data-bmq-cost-label className="ac-meta m-0">{labels.openSourceHint}</p>
        </div>
        <div data-bmq-cost-row-identity className="ac-meta ac-num mt-2 break-words">{identity}</div>
        <div className="-mx-3 mt-2">
          <SourceDisclosure block={block} language={language} />
        </div>
      </div>
    );
  }

  const warning = costBlockVisibleWarning(block, language);

  return (
    <article
      data-bmq-business-block="cost-line-v1"
      data-bmq-business-block-mode={block.mode}
      className="overflow-hidden rounded-[12px] bg-[var(--ac-well)] text-[var(--ac-ink)]"
    >
      <header className="flex items-start justify-between gap-2 px-3 pb-2 pt-3">
        <div className="min-w-0">
          <h3 data-bmq-cost-label className="m-0 text-[13px] font-semibold">{labels.title}</h3>
          <div className="ac-meta mt-0.5">{labels.example}</div>
        </div>
        {statusLabel ? (
          <span data-bmq-cost-label className={cn("ac-pill", STATUS_STYLE[status] ?? "")}>{statusLabel}</span>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-x-3 px-3 pb-2">
        <div className="min-w-0">
          <div data-bmq-cost-label className="ac-label">{labels.date}</div>
          <div className="ac-num mt-0.5 break-words text-[13px] font-semibold">{date ?? labels.missing}</div>
        </div>
        <div className="min-w-0">
          <div data-bmq-cost-label className="ac-label">{labels.supplier}</div>
          <div className="mt-0.5 break-words text-[13px] font-semibold">{text(block.line.supplierName, labels.missing)}</div>
        </div>
      </div>

      <div className="mx-3 mb-3 overflow-hidden rounded-[10px] bg-[var(--ac-surface)]">
        <div className="grid grid-cols-[1fr_auto] items-center border-b border-[var(--ac-line)]">
          <div data-bmq-cost-label className="ac-label px-3 py-1.5">{labels.item}</div>
          <div data-bmq-cost-label className="ac-label px-3 py-1.5 text-right">{labels.amount}</div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center">
          <div className="min-w-0 break-words px-3 py-2.5 text-[13px] font-semibold">{text(block.line.productName, labels.missing)}</div>
          <b data-bmq-cost-amount className="ac-value-sm break-all px-3 py-2.5 text-right">{formatVnd(block.line.amount, language)}</b>
        </div>
      </div>

      {warning ? (
        <div data-bmq-cost-warning className="ac-notice mx-3 mb-3">
          <AlertTriangle aria-hidden="true" />
          <span data-bmq-cost-label>{warning}</span>
        </div>
      ) : null}

      <div className="ac-divide">
        <button
          type="button"
          data-bmq-cost-followup
          onClick={onFollowUp}
          disabled={!followUpEnabled}
          title={followUpEnabled ? undefined : followUpDisabledReason || labels.followUpDisabled}
          className={cn(
            "flex min-h-[44px] w-full items-center gap-1.5 px-3 text-left text-[13px] font-medium transition-colors",
            followUpEnabled ? "text-[var(--ac-ink)] hover:bg-[var(--ac-surface)]" : "cursor-not-allowed text-[var(--ac-dim)]",
          )}
        >
          <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span data-bmq-cost-label>{labels.followUp}</span>
        </button>
        {!followUpEnabled && followUpDisabledReason ? <div className="ac-meta px-3 pb-2">{followUpDisabledReason}</div> : null}
      </div>

      <SourceDisclosure block={block} language={language} />
    </article>
  );
}
