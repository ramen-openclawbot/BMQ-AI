import { useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, FilePlus2, Loader2, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <div className="mt-3 rounded-xl border border-vn-paper/15 bg-vn-card2 p-3" data-merchant-bank-slip="already_recorded">
        <div className="flex items-center gap-2 text-[13px] font-bold leading-5 text-vn-paper">
          <Check className="h-4 w-4 shrink-0 text-vn-online" />
          Bankslip này đã được ghi{requestNumber ? <> ở phiếu <span className="font-vnMono">{requestNumber}</span></> : null}. Không thanh toán lại.
        </div>
        {docLink ? <DocButton doc={docLink} onOpen={onOpenDoc} /> : null}
      </div>
    );
  }

  return (
    <div
      className="mt-3 rounded-xl border border-vn-lime/30 bg-vn-lime/[.05] p-3"
      data-merchant-bank-slip={data.changeId}
      data-merchant-bank-slip-status={status}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-vnMono text-[10px] uppercase tracking-[0.1em] text-vn-lime">Duyệt chi từ bankslip</div>
          <div className="mt-1 font-vnMono text-[22px] font-bold leading-7 tracking-[-0.02em] text-vn-paper tabular-nums" data-merchant-bank-slip-amount>{formatVnd(data.amount)}</div>
          <div className="break-words text-[13px] font-semibold leading-5 text-vn-paper/85">{data.supplierName || data.beneficiaryName || "Chưa rõ người nhận"}</div>
        </div>
        <span className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
          status === "applied" ? "bg-vn-online/15 text-vn-online"
            : status === "failed" ? "bg-vn-red/15 text-vn-red"
            : status === "discarded" ? "bg-vn-paper/10 text-vn-paper/50"
            : "bg-vn-lime/15 text-vn-lime",
        )}>{STATUS_LABEL[status] || status}</span>
      </div>

      <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-vn-paper/10 bg-vn-ink/40 px-2.5 py-2" data-merchant-bank-slip-mode={data.mode || "unknown"}>
        {data.mode === "create_new"
          ? <FilePlus2 className="mt-0.5 h-4 w-4 shrink-0 text-vn-lime" />
          : <ReceiptText className="mt-0.5 h-4 w-4 shrink-0 text-vn-lime" />}
        <div className="min-w-0 text-[12.5px] leading-5 text-vn-paper/85">
          {data.mode === "create_new" ? (
            <>Tạo phiếu mới rồi thanh toán{data.title ? <span className="block break-words text-vn-paper/60">{data.title}</span> : null}</>
          ) : (
            <>Thanh toán phiếu đang chờ <span className="font-vnMono font-bold text-vn-paper">{data.requestNumber || "—"}</span>{data.title ? <span className="block break-words text-vn-paper/60">{data.title}</span> : null}</>
          )}
        </div>
      </div>

      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px] leading-5">
        {data.content ? <><dt className="text-vn-paper/50">Nội dung</dt><dd className="break-words text-vn-paper/85">{data.content}</dd></> : null}
        <dt className="text-vn-paper/50">Ngày chuyển</dt><dd className="text-vn-paper/85">{formatDate(data.transferDate)}</dd>
        {data.reference ? <><dt className="text-vn-paper/50">Mã GD</dt><dd className="break-all font-vnMono text-vn-paper/85">{data.reference}</dd></> : null}
        {data.beneficiaryAccount ? <><dt className="text-vn-paper/50">TK nhận</dt><dd className="break-all font-vnMono text-vn-paper/85">{data.beneficiaryAccount}</dd></> : null}
        {data.previous ? (
          <><dt className="text-vn-paper/50">Kỳ trước</dt><dd className="break-words text-vn-paper/85" data-merchant-bank-slip-previous><span className="font-vnMono">{data.previous.requestNumber}</span> · <span className="whitespace-nowrap">{formatDate(data.previous.date)}</span> · <span className="whitespace-nowrap">{formatVnd(data.previous.amount)}</span></dd></>
        ) : null}
      </dl>

      <div className="mt-2.5 border-t border-vn-paper/10 pt-2.5">
        <label className="block text-[11px] font-bold uppercase tracking-[0.08em] text-vn-paper/55" htmlFor={`slip-category-${data.changeId}`}>Loại chi phí</label>
        {open && categoryOptions.length ? (
          <select
            id={`slip-category-${data.changeId}`}
            className="mt-1 h-11 w-full rounded-xl border border-vn-paper/20 bg-vn-card2 px-3 text-base text-vn-paper outline-none transition focus:border-vn-lime sm:h-10 sm:text-[13px]"
            value={categoryCode}
            onChange={(event) => setCategoryCode(event.target.value)}
            disabled={busy}
            data-merchant-bank-slip-category
          >
            {!categoryCode ? <option value="">Chọn loại chi phí…</option> : null}
            {categoryOptions.map((row) => <option key={row.code} value={row.code}>{row.label}</option>)}
          </select>
        ) : (
          <div className="mt-1 text-[13px] font-semibold text-vn-paper">{chosenLabel || "—"}</div>
        )}
        {open ? <div className="mt-1 text-[11.5px] leading-4 text-vn-paper/50" data-merchant-bank-slip-source>{sourceHint(data.category, categoryCode)}</div> : null}
      </div>

      {open && data.warnings.length ? (
        <ul className="mt-2.5 space-y-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2" data-merchant-bank-slip-warnings>
          {data.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5 text-[12px] font-semibold leading-5 text-amber-200">
              <AlertTriangle className="mt-[3px] h-3.5 w-3.5 shrink-0" />{WARNING_TEXT[warning] || warning}
            </li>
          ))}
        </ul>
      ) : null}

      {status === "failed" && state?.error ? <div className="mt-2 text-[12px] leading-5 text-vn-red" role="alert">{state.error}</div> : null}

      {status === "applied" ? (
        <div className="mt-2.5 rounded-lg border border-vn-online/30 bg-vn-online/10 px-2.5 py-2 text-[12.5px] font-semibold leading-5 text-vn-paper" data-merchant-bank-slip-done>
          <Check className="mr-1 inline h-4 w-4 align-[-3px] text-vn-online" />
          Đã thanh toán{requestNumber ? <> <span className="font-vnMono">{requestNumber}</span></> : null} và ghi vào {chosenLabel || "chi phí"}. Nhóm Zalo duyệt chi sẽ nhận thông báo như các phiếu khác.
        </div>
      ) : null}
      {status === "applied" && docLink ? <DocButton doc={docLink} onOpen={onOpenDoc} /> : null}

      {open ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            className="h-10 rounded-xl bg-vn-lime font-bold text-vn-ink hover:bg-vn-lime hover:brightness-105"
            disabled={busy || !categoryCode}
            onClick={() => onApprove(categoryCode)}
            data-merchant-bank-slip-action="approve"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {status === "failed" ? "Duyệt lại" : "Duyệt"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-xl border-vn-paper/20 bg-transparent font-bold text-vn-paper/80 hover:bg-vn-card hover:text-vn-paper"
            disabled={busy}
            onClick={onDiscard}
            data-merchant-bank-slip-action="discard"
          >
            Bỏ
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DocButton({ doc, onOpen }: { doc: DocLinkPayload; onOpen: (doc: DocLinkPayload) => void }) {
  return (
    <button
      type="button"
      className="mt-2 flex min-h-[44px] w-full items-center gap-3 rounded-[12px] border border-vn-paper/[.14] bg-vn-card2 px-3 py-2 text-left transition hover:border-vn-lime active:scale-[0.99]"
      onClick={() => onOpen(doc)}
      aria-label={`Mở phiếu ${doc.code}`}
      data-merchant-bank-slip-doc
    >
      <span className="shrink-0 rounded-md bg-vn-cobalt/25 px-1.5 py-0.5 font-vnMono text-[10px] font-bold uppercase tracking-[0.08em] text-vn-paper/80">PR</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-vn-paper">{doc.title || doc.code}</span>
      <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-vn-lime">Mở phiếu<ExternalLink className="h-3.5 w-3.5" /></span>
    </button>
  );
}
