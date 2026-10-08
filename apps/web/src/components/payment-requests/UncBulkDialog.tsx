/* Up nhiều UNC (CEO, Trình chi gấp): pick several UNC images at once, the server reads
 * each one, the pure matcher proposes the phiếu it pays, and the CEO reviews before
 * anything is paid. Each ticked UNC is then confirmed on its own through the existing
 * approve_payment_requests_with_unc path (usePaymentUncBulk.confirmItems).
 */
import { useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fileToJpegBase64 } from "@/components/payment-requests/UncApprovalDialog";
import { usePaymentUncBulk, type PaymentUncBulkChoice, type PaymentUncBulkItem } from "@/hooks/usePaymentUncBulk";
import type { UncBulkOption, UncBulkPaymentRequest } from "@/lib/payment-unc-bulk-match";
import { cn } from "@/lib/utils";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))}\u00a0đ`;

const STATUS: Record<PaymentUncBulkItem["status"], { label: string; tone: string }> = {
  reading: { label: "Đang đọc", tone: "" },
  matched: { label: "Khớp", tone: "is-green" },
  ambiguous: { label: "Cần chọn", tone: "is-amber" },
  unmatched: { label: "Không khớp", tone: "is-red" },
  duplicate: { label: "Trùng", tone: "is-red" },
  confirming: { label: "Đang chi", tone: "is-blue" },
  done: { label: "Đã chi", tone: "is-green" },
  error: { label: "Lỗi", tone: "is-red" },
};

const ERROR_TEXT: Record<string, string> = {
  ocr_failed: "Chưa đọc được ảnh. Chi UNC này trên từng phiếu.",
  amount_mismatch: "Số tiền trên UNC không khớp số cần chi.",
  supplier_mismatch: "Các phiếu phải cùng một nhà cung cấp.",
  duplicate_evidence: "UNC này đã được dùng trước đó.",
  duplicate_reference: "Mã giao dịch này đã được dùng trước đó.",
  allocation_exceeds_remaining: "Số chi vượt số còn nợ của phiếu.",
  request_not_found: "Phiếu đã thay đổi; tải lại rồi thử lại.",
  image_too_large: "Ảnh quá lớn.",
};

type Phase = "pick" | "reading" | "review" | "paying" | "done";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requests: UncBulkPaymentRequest[];
  onDone?: () => void;
}

export function UncBulkDialog({ open, onOpenChange, requests, onDone }: Props) {
  const { run, confirmItems, reset, items } = usePaymentUncBulk();
  const [phase, setPhase] = useState<Phase>("pick");
  const [previews, setPreviews] = useState<string[]>([]);
  // UNC index -> picked option index (absent = not paid this time).
  const [choice, setChoice] = useState<Map<number, number>>(new Map());
  const fileRef = useRef<HTMLInputElement>(null);
  // UNCs the CEO has ticked or unticked by hand; untouched sure matches default to ticked.
  const touched = useRef<Set<number>>(new Set());
  const byId = useMemo(() => new Map(requests.map((r) => [r.id, r])), [requests]);

  const close = (next: boolean) => {
    if (!next && (phase === "reading" || phase === "paying")) return;
    if (!next) {
      if (phase === "done") onDone?.();
      reset();
      setPhase("pick");
      setPreviews([]);
      setChoice(new Map());
      touched.current = new Set();
    }
    onOpenChange(next);
  };

  const pickFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type === "");
    if (files.length === 0) return;
    setPhase("reading");
    const images = await Promise.all(files.map((f) => fileToJpegBase64(f)));
    setPreviews(images.map((i) => i.preview));
    await run({
      files: images.map((i) => ({ image_base64: i.base64, mime_type: i.mime, slip_type: "unc" })),
      requests,
    });
    touched.current = new Set();
    setChoice(new Map());
    setPhase("review");
  };

  // Matched items are ticked by default once the hook has patched them.
  const effectiveChoice = useMemo(() => {
    const map = new Map(choice);
    if (phase === "review") {
      items.forEach((item) => {
        if (item.status === "matched" && !touched.current.has(item.index)) map.set(item.index, 0);
      });
    }
    return map;
  }, [choice, items, phase]);

  const setPick = (index: number, option: number | null) => {
    touched.current.add(index);
    setChoice((prev) => {
      const next = new Map(prev);
      if (option === null) next.delete(index);
      else next.set(index, option);
      return next;
    });
  };

  const usedBy = useMemo(() => {
    const used = new Map<string, number>();
    effectiveChoice.forEach((optionIndex, index) => {
      const item = items[index];
      item?.options[optionIndex]?.allocations.forEach((a) => used.set(a.paymentRequestId, index));
    });
    return used;
  }, [effectiveChoice, items]);

  const chosen: PaymentUncBulkChoice[] = [];
  let chosenTotal = 0;
  effectiveChoice.forEach((optionIndex, index) => {
    const item = items[index];
    const option = item?.options[optionIndex];
    if (!item || !option || (item.status !== "matched" && item.status !== "ambiguous")) return;
    chosen.push({ index, allocations: option.allocations });
    chosenTotal += option.total;
  });

  const pay = async () => {
    if (chosen.length === 0) return;
    setPhase("paying");
    await confirmItems(chosen.sort((a, b) => a.index - b.index));
    setPhase("done");
  };

  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  const optionLabel = (option: UncBulkOption) =>
    option.allocations.map((a) => byId.get(a.paymentRequestId)?.requestNumber ?? a.paymentRequestId).join(" + ");

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="d3-unc d3-ub"
        data-bmq-unc-bulk-dialog={phase}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">Up nhiều UNC</span>
          <DialogTitle className="d3-unc-title">
            {phase === "pick" ? "Ghép UNC vào phiếu" : phase === "done" ? <>Đã chi <b>{doneCount}</b> UNC</> : <><b>{previews.length || items.length}</b> ảnh UNC</>}
          </DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {phase === "pick"
              ? "Chọn tất cả ảnh UNC một lần. Hệ thống đọc số tiền, người nhận, nội dung chuyển khoản rồi đề xuất phiếu cho từng UNC. Chưa chi gì cho đến khi anh xác nhận."
              : phase === "reading"
                ? "Đang đọc từng ảnh…"
                : phase === "done"
                  ? errorCount > 0 ? `${errorCount} UNC lỗi — xem lý do bên dưới.` : "Các phiếu đã được ghi chi."
                  : "Kiểm tra từng UNC. UNC đã tick sẽ được chi; UNC còn lại chi riêng trên từng phiếu."}
          </DialogDescription>
        </DialogHeader>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          data-bmq-unc-bulk-file
          onChange={(e) => {
            void pickFiles(e.target.files);
            e.currentTarget.value = "";
          }}
        />

        {phase === "pick" ? (
          <button type="button" className="d3-unc-drop" onClick={() => fileRef.current?.click()} data-bmq-unc-bulk-pick>
            <ImagePlus className="h-6 w-6" />
            <span>Chọn nhiều ảnh UNC</span>
            <small>{requests.length} phiếu còn phải chi trong đợt này</small>
          </button>
        ) : (
          <ul className="d3-ub-list" aria-live="polite">
            {(items.length ? items : previews.map((_, index) => ({ index, status: "reading" }) as PaymentUncBulkItem)).map((item) => {
              const st = STATUS[item.status];
              const picked = effectiveChoice.get(item.index);
              const selectable = phase === "review" && (item.status === "matched" || item.status === "ambiguous");
              const showOptions = item.options?.length > 0 && item.status !== "done";
              return (
                <li key={item.index} className={cn("d3-ub-row", picked !== undefined && selectable && "is-on")} data-bmq-unc-bulk-row={item.status}>
                  <div className="d3-ub-top">
                    {previews[item.index] ? <img src={previews[item.index]} alt={`UNC ${item.index + 1}`} /> : <span className="d3-ub-ph" />}
                    <div className="d3-ub-read">
                      <span className="d3-ub-amt">{item.status === "reading" && item.amount == null ? <Loader2 className="h-4 w-4 animate-spin" /> : vnd(item.amount)}</span>
                      <small>{item.beneficiaryName || (item.status === "reading" ? "Đang đọc…" : "Không đọc được người nhận")}</small>
                      {item.reference && <small>Mã GD {item.reference}</small>}
                    </div>
                    <span className={cn("d3-up-chip", st.tone)}>{item.status === "confirming" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{st.label}</span>
                  </div>

                  {item.status === "error" ? (
                    <p className="d3-ub-why is-bad"><TriangleAlert className="h-3.5 w-3.5" /> {(item.errorCode && ERROR_TEXT[item.errorCode]) || item.errorDetail || "Chưa chi được UNC này."}</p>
                  ) : item.status === "done" && item.allocations.length > 0 ? (
                    <p className="d3-ub-why is-ok" data-bmq-unc-bulk-paid>
                      <Check className="h-3.5 w-3.5" /> Đã ghi chi {item.allocations
                        .map((a) => {
                          const r = byId.get(a.paymentRequestId);
                          return r ? `${r.requestNumber} (${r.supplierName || "—"})` : a.paymentRequestId;
                        })
                        .join(", ")}
                    </p>
                  ) : item.reason ? (
                    <p className="d3-ub-why">{item.reason}</p>
                  ) : null}

                  {showOptions && (
                    <div className="d3-ub-opts" role="radiogroup" aria-label={`Phiếu cho UNC ${item.index + 1}`}>
                      {item.options.map((option, optionIndex) => {
                        const on = picked === optionIndex;
                        const clash = option.allocations.some((a) => {
                          const owner = usedBy.get(a.paymentRequestId);
                          return owner !== undefined && owner !== item.index;
                        });
                        const first = byId.get(option.allocations[0]?.paymentRequestId ?? "");
                        return (
                          <button
                            key={optionIndex}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            disabled={!selectable || (clash && !on)}
                            className={cn("d3-ub-opt", on && "is-on")}
                            onClick={() => setPick(item.index, on ? null : optionIndex)}
                            data-bmq-unc-bulk-option={optionIndex}
                          >
                            <span className="d3-ub-tick">{on && <Check className="h-3.5 w-3.5" />}</span>
                            <span className="d3-ub-who">
                              <b>{first?.supplierName || "Chưa có nhà cung cấp"}</b>
                              <small>{optionLabel(option)}{clash && !on ? " · đã chọn cho UNC khác" : ""}</small>
                            </span>
                            <span className="d3-ub-sum">{vnd(option.total)}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {phase !== "pick" && (
          <div className="d3-ub-foot">
            {phase === "done" ? (
              <Button className="d3-ub-go" onClick={() => close(false)} data-bmq-unc-bulk-close>Xong</Button>
            ) : (
              <>
                <p>
                  {phase === "reading" ? "Đang đọc ảnh…" : <>Sẽ chi <b>{chosen.length}</b> UNC · <b>{vnd(chosenTotal)}</b></>}
                </p>
                <Button
                  className="d3-ub-go"
                  disabled={phase !== "review" || chosen.length === 0}
                  onClick={() => void pay()}
                  data-bmq-unc-bulk-confirm
                >
                  {phase === "paying" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Xác nhận chi ({chosen.length})
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
