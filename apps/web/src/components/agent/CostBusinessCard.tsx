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
  needs_review: "border-amber-200 bg-amber-50 text-amber-800",
  suggested: "border-sky-200 bg-sky-50 text-sky-800",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
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
      <dt className="text-xs font-medium uppercase tracking-wide text-[#8a8f98]">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] font-semibold text-[#252932]">{value}</dd>
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
    <div className="mt-2 space-y-2 break-words px-3.5 pb-3 text-[#68707e]">
      <dl className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
        {block.line.sourceNumber ? <Detail label={labels.document} value={block.line.sourceNumber} /> : null}
        {block.line.categoryLabel || block.line.categoryCode ? <Detail label={labels.category} value={category} /> : null}
        {block.line.confidence ? <Detail label={labels.confidence} value={block.line.confidence} /> : null}
        {block.line.classificationSource ? <Detail label={labels.classificationSource} value={block.line.classificationSource} /> : null}
      </dl>

      {rule ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[#777e8b]">{labels.rule}</div>
          <div className="mt-0.5">
            {rule.name} · {rule.scope} · {labels.priority} {rule.priority} · {labels.ruleConfidence} {rule.confidence}
            {rule.effectiveFrom ? ` · ${rule.effectiveFrom} → ${rule.effectiveTo ?? labels.openEnded}` : ""}
          </div>
        </div>
      ) : null}

      {alias ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-[#777e8b]">{labels.alias}</div>
          <div className="mt-0.5">{alias.sourceName} → {alias.standardCode} · {alias.canonicalName}</div>
        </div>
      ) : block.evidence.aliasStatus ? (
        <div>{labels.aliasStatus}: {block.evidence.aliasStatus}</div>
      ) : null}

      {block.notes.length ? (
        <div data-bmq-cost-notes>
          <div className="text-xs font-semibold uppercase tracking-wide text-[#777e8b]">{labels.notes}</div>
          <ul className="mt-1 space-y-1.5 text-xs leading-relaxed text-[#4b515c]">
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
        <div className="text-[#8a8f98]">{block.source.disclaimer}</div>
      </div>
    </div>
  );
}

function SourceDisclosure({ block, language }: { block: CostLineBlock; language: CostBlockLanguage }) {
  const labels = COST_BLOCK_LABELS[language];
  return (
    <details data-bmq-cost-source className="border-t border-[#eef0f4] text-xs">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 px-3.5 font-semibold text-[#5e43c7]">
        <span className="flex items-center gap-1.5">
          <FileText className="h-4 w-4" aria-hidden="true" />
          <span>{labels.source}</span>
        </span>
        <ChevronDown className="h-4 w-4" aria-hidden="true" />
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
        className={cn(
          "overflow-hidden rounded-2xl border px-3.5 py-3",
          status === "needs_review" ? "border-amber-200 bg-amber-50/70 text-[#7c4a03]" : "border-sky-200 bg-sky-50/70 text-[#0c4a6e]",
        )}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <h3 data-bmq-cost-label className="text-xs font-bold uppercase tracking-[0.12em]">{costBlockHeading(block, language)}</h3>
        </div>
        <div className="mt-1.5 space-y-1">
          {summary.map((line) => <p key={line} data-bmq-cost-label className="text-sm leading-relaxed">{line}</p>)}
          {warning ? <p data-bmq-cost-warning data-bmq-cost-label className="text-sm font-semibold leading-relaxed">{warning}</p> : null}
          <p data-bmq-cost-label className="text-xs leading-relaxed opacity-80">{labels.openSourceHint}</p>
        </div>
        <div data-bmq-cost-row-identity className="mt-2 break-words text-xs opacity-80">{identity}</div>
        <div className="mt-2 -mx-3.5">
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
      className="overflow-hidden rounded-2xl border border-[#e4e5eb] bg-white text-[#252932]"
    >
      <header className="flex items-start justify-between gap-2 border-b border-[#eef0f4] px-3.5 pb-2.5 pt-3">
        <div className="min-w-0">
          <h3 data-bmq-cost-label className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8a8f98]">{labels.title}</h3>
          <div className="mt-0.5 text-xs font-medium uppercase tracking-wide text-[#9a9fab]">{labels.example}</div>
        </div>
        {statusLabel ? (
          <span data-bmq-cost-label className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold", STATUS_STYLE[status] ?? "border-[#e4e5eb] bg-[#f7f8fa] text-[#68707e]")}>{statusLabel}</span>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-x-3 border-b border-[#eef0f4] px-3.5 py-2.5">
        <div className="min-w-0">
          <div data-bmq-cost-label className="text-xs font-medium uppercase tracking-wide text-[#8a8f98]">{labels.date}</div>
          <div className="mt-0.5 break-words text-sm font-semibold">{date ?? labels.missing}</div>
        </div>
        <div className="min-w-0">
          <div data-bmq-cost-label className="text-xs font-medium uppercase tracking-wide text-[#8a8f98]">{labels.supplier}</div>
          <div className="mt-0.5 break-words text-sm font-semibold">{text(block.line.supplierName, labels.missing)}</div>
        </div>
      </div>

      <div className="mx-3.5 my-3 overflow-hidden rounded-xl border border-[#eef0f4]">
        <div className="grid grid-cols-[1fr_auto] items-center bg-[#f7f8fa]">
          <div data-bmq-cost-label className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-[#777e8b]">{labels.item}</div>
          <div data-bmq-cost-label className="px-3 py-1.5 text-right text-xs font-medium uppercase tracking-wide text-[#777e8b]">{labels.amount}</div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center">
          <div className="min-w-0 break-words px-3 py-2.5 text-sm font-semibold">{text(block.line.productName, labels.missing)}</div>
          <b data-bmq-cost-amount className="break-all px-3 py-2.5 text-right text-lg font-bold tabular-nums tracking-tight text-[#171a21]">{formatVnd(block.line.amount, language)}</b>
        </div>
      </div>

      {warning ? (
        <div data-bmq-cost-warning className="mx-3.5 mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span data-bmq-cost-label className="text-xs font-medium leading-relaxed">{warning}</span>
        </div>
      ) : null}

      <div className="border-t border-[#eef0f4]">
        <button
          type="button"
          data-bmq-cost-followup
          onClick={onFollowUp}
          disabled={!followUpEnabled}
          title={followUpEnabled ? undefined : followUpDisabledReason || labels.followUpDisabled}
          className={cn(
            "flex min-h-[44px] w-full items-center gap-1.5 px-3.5 text-left text-xs font-semibold transition",
            followUpEnabled ? "text-[#5e43c7] hover:bg-[#f7f5ff]" : "cursor-not-allowed text-[#a0a5af]",
          )}
        >
          <HelpCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span data-bmq-cost-label>{labels.followUp}</span>
        </button>
        {!followUpEnabled && followUpDisabledReason ? <div className="px-3.5 pb-2 text-[11px] text-[#a0a5af]">{followUpDisabledReason}</div> : null}
      </div>

      <SourceDisclosure block={block} language={language} />
    </article>
  );
}
