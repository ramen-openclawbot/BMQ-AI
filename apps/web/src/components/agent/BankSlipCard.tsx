import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FilePlus2, Loader2, ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseDocLink, type DocLinkPayload, type MerchantChange } from "@/lib/merchantAgent";

// The merchant agent's bank-slip proposal (services/merchant-agent bank_slip.py). Nothing is
// written until the owner taps Duyệt; the chosen cost category travels with the approval.

type SlipCategory = { code: string; label: string };

export type BankSlipCardData = {
  changeId: string;
  status: string;
  amount: number | null;
  supplierName: string;
  beneficiaryName: string;
  beneficiaryAccount: string;
  content: string;
  transferDate: string;
  reference: string;
  mode: "pay_existing" | "create_new" | null;
  requestNumber: string;
  title: string;
  category: (SlipCategory & { source: string; evidence: string[] }) | null;
  categories: SlipCategory[];
  previous: { requestNumber: string; date: string; amount: number | null } | null;
  warnings: string[];
  docLink: DocLinkPayload | null;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const amountOf = (value: unknown) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export function parseBankSlipPayload(payload: Record<string, unknown>): BankSlipCardData {
  const slip = record(payload.slip);
  const target = record(payload.target);
  const category = record(payload.category);
  const previous = record(payload.previous);
  const evidence = record(category.evidence);
  const mode = target.mode === "pay_existing" || target.mode === "create_new" ? target.mode : null;
  return {
    changeId: text(payload.change_id),
    status: text(payload.status) || "staged",
    amount: amountOf(target.amount ?? slip.amount),
    supplierName: text(record(payload.supplier).name),
    beneficiaryName: text(slip.beneficiary_name),
    beneficiaryAccount: text(slip.beneficiary_account),
    content: text(slip.transfer_content),
    transferDate: text(slip.transfer_date),
    reference: text(slip.reference),
    mode,
    requestNumber: text(target.request_number) || text(payload.request_number),
    title: text(target.title),
    category: text(category.code)
      ? {
        code: text(category.code),
        label: text(category.label) || text(category.code),
        source: text(category.source),
        evidence: Array.isArray(evidence.request_numbers) ? evidence.request_numbers.map(text).filter(Boolean) : [],
      }
      : null,
    categories: Array.isArray(payload.categories)
      ? payload.categories.map(record).map((row) => ({ code: text(row.code), label: text(row.label) })).filter((row) => row.code && row.label)
      : [],
    previous: text(previous.request_number)
      ? { requestNumber: text(previous.request_number), date: text(previous.date), amount: amountOf(previous.amount) }
      : null,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(text).filter(Boolean) : [],
    docLink: parseDocLink(payload.doc_link),
  };
}

const formatVnd = (value: number | null) => (value == null ? "—" : `${Math.round(value).toLocaleString("vi-VN")} đ`);

function formatDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "—";
}

const WARNING_TEXT: Record<string, string> = {
  amount_differs: "Số tiền khác phiếu đang chờ của người nhận này, nên sẽ tạo phiếu mới.",
  already_paid_in_transfer_month: "Trong tháng chuyển tiền đã có phiếu của người nhận này được thanh toán. Anh kiểm tra để tránh chi trùng.",
  low_ocr_confidence: "Ảnh chưa rõ, anh đối chiếu lại số tiền trước khi duyệt.",
  missing_transfer_date: "Không đọc được ngày chuyển khoản, phiếu mới sẽ ghi theo ngày hôm nay.",
  multiple_pending_matches: "Có nhiều phiếu chờ cùng số tiền, VNAgent chọn phiếu cũ nhất.",
  needs_category: "Chưa có loại chi phí, anh chọn trước khi duyệt.",
};

const STATUS_LABEL: Record<string, string> = {
  staged: "Chờ duyệt",
  approved: "Đang ghi",
  applied: "Đã ghi sổ",
  discarded: "Đã bỏ",
  failed: "Chưa ghi được",
  already_recorded: "Đã ghi trước đó",
};

function sourceHint(category: BankSlipCardData["category"], chosen: string) {
  if (!category || category.code !== chosen) return chosen ? "Anh tự chọn" : "Chưa có lịch sử";
  if (category.source === "history") return category.evidence.length ? `Học từ ${category.evidence.join(", ")}` : "Học từ các phiếu trước";
  if (category.source === "jev") return "Jev đề xuất";
  return "Đề xuất";
}

export function BankSlipCard({
  data,
  state,
  busy,
  onApprove,
  onDiscard,
  onOpenDoc,
}: {
  data: BankSlipCardData;
  state?: MerchantChange;
  busy: boolean;
  onApprove: (categoryCode: string) => void;
  onDiscard: () => void;
  onOpenDoc: (doc: DocLinkPayload) => void;
}) {
  const status = state?.status || data.status;
  const [categoryCode, setCategoryCode] = useState(data.category?.code || "");
  useEffect(() => {
    if (!categoryCode && data.category?.code) setCategoryCode(data.category.code);
  }, [categoryCode, data.category?.code]);

  const docLink = parseDocLink(state?.doc_link) || data.docLink;
  const requestNumber = text(state?.request_number) || data.requestNumber;
  const chosenLabel = data.categories.find((row) => row.code === categoryCode)?.label || data.category?.label || categoryCode;
  const open = status === "staged" || status === "failed";
  const categoryOptions = data.categories.some((row) => row.code === categoryCode) || !categoryCode
    ? data.categories
    : [{ code: categoryCode, label: chosenLabel }, ...data.categories];

  if (status === "already_recorded") {
    return (
      <div className="ac-card" data-merchant-bank-slip="already_recorded">
        <div className="ac-done">
          <Check aria-hidden="true" />
          <span>Bankslip này đã được ghi{requestNumber ? <> ở phiếu <span className="ac-num font-semibold">{requestNumber}</span></> : null}. Không thanh toán lại.</span>
        </div>
        {docLink ? <DocButton doc={docLink} onOpen={onOpenDoc} /> : null}
      </div>
    );
  }

  const pill = status === "applied" ? "is-pos" : status === "failed" ? "is-neg" : status === "discarded" ? "" : "is-pink";

  return (
    <div className="ac-card" data-merchant-bank-slip={data.changeId} data-merchant-bank-slip-status={status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="ac-value" data-merchant-bank-slip-amount>{formatVnd(data.amount)}</div>
          <div className="ac-strong mt-0.5 break-words text-[14px] leading-5">{data.supplierName || data.beneficiaryName || "Chưa rõ người nhận"}</div>
          <div className="ac-meta mt-0.5">Duyệt chi từ bankslip</div>
        </div>
        <span className={cn("ac-pill", pill)}>{STATUS_LABEL[status] || status}</span>
      </div>

      <div className="ac-well mt-3 flex items-start gap-2.5" data-merchant-bank-slip-mode={data.mode || "unknown"}>
        {data.mode === "create_new"
          ? <FilePlus2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ac-ink-2)]" aria-hidden="true" />
          : <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ac-ink-2)]" aria-hidden="true" />}
        <div className="min-w-0 text-[13px] leading-5">
          {data.mode === "create_new" ? (
            <>Tạo phiếu mới rồi thanh toán{data.title ? <span className="ac-meta block break-words">{data.title}</span> : null}</>
          ) : (
            <>Thanh toán phiếu đang chờ <span className="ac-num font-semibold">{data.requestNumber || "—"}</span>{data.title ? <span className="ac-meta block break-words">{data.title}</span> : null}</>
          )}
        </div>
      </div>

      <dl className="ac-facts mt-3">
        {data.content ? <><dt>Nội dung</dt><dd>{data.content}</dd></> : null}
        <dt>Ngày chuyển</dt><dd className="ac-num">{formatDate(data.transferDate)}</dd>
        {data.reference ? <><dt>Mã GD</dt><dd className="ac-num">{data.reference}</dd></> : null}
        {data.beneficiaryAccount ? <><dt>TK nhận</dt><dd className="ac-num">{data.beneficiaryAccount}</dd></> : null}
        {data.previous ? (
          <><dt>Kỳ trước</dt><dd data-merchant-bank-slip-previous><span className="ac-num">{data.previous.requestNumber}</span> · <span className="ac-num whitespace-nowrap">{formatDate(data.previous.date)}</span> · <span className="ac-num whitespace-nowrap">{formatVnd(data.previous.amount)}</span></dd></>
        ) : null}
      </dl>

      <div className="ac-divide mt-3 pt-3">
        <label className="ac-label block" htmlFor={`slip-category-${data.changeId}`}>Loại chi phí</label>
        {open && categoryOptions.length ? (
          <select
            id={`slip-category-${data.changeId}`}
            className="ac-select"
            value={categoryCode}
            onChange={(event) => setCategoryCode(event.target.value)}
            disabled={busy}
            data-merchant-bank-slip-category
          >
            {!categoryCode ? <option value="">Chọn loại chi phí…</option> : null}
            {categoryOptions.map((row) => <option key={row.code} value={row.code}>{row.label}</option>)}
          </select>
        ) : (
          <div className="ac-strong mt-1 text-[14px]">{chosenLabel || "—"}</div>
        )}
        {open ? <div className="ac-meta mt-1" data-merchant-bank-slip-source>{sourceHint(data.category, categoryCode)}</div> : null}
      </div>

      {open && data.warnings.length ? (
        <ul className="mt-3 space-y-1.5" data-merchant-bank-slip-warnings>
          {data.warnings.map((warning) => (
            <li key={warning} className="ac-notice"><AlertTriangle aria-hidden="true" />{WARNING_TEXT[warning] || warning}</li>
          ))}
        </ul>
      ) : null}

      {status === "failed" && state?.error ? <div className="ac-fail" role="alert">{state.error}</div> : null}

      {status === "applied" ? (
        <div className="ac-done mt-3" data-merchant-bank-slip-done>
          <Check aria-hidden="true" />
          <span>Đã thanh toán{requestNumber ? <> <span className="ac-num font-semibold">{requestNumber}</span></> : null} và ghi vào {chosenLabel || "chi phí"}. Nhóm Zalo duyệt chi sẽ nhận thông báo như các phiếu khác.</span>
        </div>
      ) : null}
      {status === "applied" && docLink ? <DocButton doc={docLink} onOpen={onOpenDoc} /> : null}

      {open ? (
        <div className="ac-actions">
          <button
            type="button"
            className="ac-btn ac-btn-primary"
            disabled={busy || !categoryCode}
            onClick={() => onApprove(categoryCode)}
            data-merchant-bank-slip-action="approve"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />} {status === "failed" ? "Duyệt lại" : "Duyệt"}
          </button>
          <button
            type="button"
            className="ac-btn ac-btn-ghost"
            disabled={busy}
            onClick={onDiscard}
            data-merchant-bank-slip-action="discard"
          >
            Bỏ
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DocButton({ doc, onOpen }: { doc: DocLinkPayload; onOpen: (doc: DocLinkPayload) => void }) {
  return (
    <button
      type="button"
      className="ac-doc mt-2.5"
      onClick={() => onOpen(doc)}
      aria-label={`Mở phiếu ${doc.code}`}
      data-merchant-bank-slip-doc
    >
      <span className="ac-doc-kind">PR</span>
      <span className="ac-doc-title">{doc.title || doc.code}</span>
      <span className="ac-doc-open">Mở phiếu<ExternalLink aria-hidden="true" /></span>
    </button>
  );
}
