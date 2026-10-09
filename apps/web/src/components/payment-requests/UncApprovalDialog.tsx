/* CEO duyệt chi bằng UNC (and UNC with no payment request).
 * Flow: chọn ảnh → máy chủ đọc UNC → đối chiếu số tiền → xác nhận.
 * The server re-reads its own OCR draft; the amount typed here only counts for
 * a reasoned manual override.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Camera, Check, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PaymentUncApprovalError,
  usePaymentUncApproval,
  type UncExtractResponse,
  type UncAllocationInput,
  type UncPaymentRequestInput,
  type UncStandaloneCategory,
} from "@/hooks/usePaymentUncApproval";
import { areSameSupplier, evaluatePaymentUncMatch, evaluateUncAllocations, remainingAmount } from "@/lib/payment-unc-matching";
import "@/styles/bmq-unc-approval.css";

export type UncApprovalRequest = UncPaymentRequestInput & {
  createdAt?: string;
  requestNumber: string;
  supplierName?: string | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "approve": pay these pending requests with one UNC. "standalone": UNC with no request. */
  mode: "approve" | "standalone";
  requests?: UncApprovalRequest[];
  onDone?: () => void;
  /** "cash": pay with a cash slip (phiếu chi tiền mặt) instead of a bank UNC. */
  paymentMethod?: "bank_transfer" | "cash";
};

const LOW_CONFIDENCE = 0.85;

const CATEGORIES: { id: UncStandaloneCategory; label: string }[] = [
  { id: "luong", label: "Lương" },
  { id: "thue", label: "Thuế" },
  { id: "thue_nha", label: "Thuê nhà" },
  { id: "khac", label: "Khác" },
];

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))} đ`;

const ERROR_TEXT: Record<string, string> = {
  amount_mismatch: "Số tiền trên UNC không khớp số cần chi.",
  po_overpaid: "Khoản chi này làm tổng đã chi vượt giá trị PO. Xem tab Đối soát, hoặc CEO mở ngoại lệ có lý do.",
  po_over_requested: "Tổng phiếu đề nghị chi đã vượt giá trị PO. Kiểm tra phiếu tạo trùng.",
  goods_receipt_already_requested: "Phiếu nhập này đã có một phiếu đề nghị chi khác.",
  supplier_mismatch: "Các phiếu chi phải cùng một nhà cung cấp.",
  reference_reused: "Mã giao dịch này đã dùng cho một khoản chi khác.",
  file_reused: "Ảnh UNC này đã được dùng rồi.",
  not_pending: "Có phiếu không còn ở trạng thái chờ duyệt. Hãy tải lại danh sách.",
  not_owner: "Chỉ CEO (chủ) được duyệt bằng UNC.",
  self_approval_not_allowed: "Không tự duyệt phiếu do chính mình lập.",
  override_reason_required: "Duyệt tay cần ghi lý do.",
  evidence_not_found: "Máy chủ chưa có kết quả đọc ảnh này. Hãy chọn lại ảnh.",
  evidence_required: "Hãy chọn ảnh UNC.",
  ocr_failed: "Chưa đọc được ảnh. Thử ảnh rõ hơn, hoặc duyệt tay.",
  image_too_large: "Ảnh quá lớn. Hãy chụp lại hoặc chọn ảnh nhỏ hơn.",
  invalid_image_type: "Chỉ nhận ảnh JPG, PNG hoặc WEBP.",
  upload_failed: "Không tải được ảnh lên. Thử lại.",
  amount_required: "Chưa có số tiền. Hãy duyệt tay và nhập số tiền thực chuyển.",
  invalid_category: "Hãy chọn loại khoản chi.",
  request_not_found: "Không tìm thấy phiếu chi. Hãy tải lại danh sách.",
  no_requests: "Chưa chọn phiếu chi nào.",
  invalid_allocation: "Phần gán số tiền chưa hợp lệ. Kiểm tra lại từng phiếu.",
  allocation_exceeds_remaining: "Số gán cho một phiếu vượt quá số còn nợ của phiếu đó.",
};

const errorText = (error: unknown) => {
  if (error instanceof PaymentUncApprovalError) {
    const known = ERROR_TEXT[error.code];
    if (known) return known;
    return error.detail ? `Không duyệt được: ${error.detail}` : "Không duyệt được. Thử lại.";
  }
  return error instanceof Error && error.message ? `Không duyệt được: ${error.message}` : "Không duyệt được. Thử lại.";
};

/** Downscale phone photos so the upload stays well under the server limit. */
export async function fileToJpegBase64(file: File): Promise<{ base64: string; mime: string; preview: string }> {
  const readRaw = () =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime: "image/jpeg", preview: dataUrl };
  } catch {
    const dataUrl = await readRaw();
    const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || file.type || "image/jpeg";
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime, preview: dataUrl };
  }
}

export function UncApprovalDialog({ open, onOpenChange, mode, requests = [], onDone, paymentMethod = "bank_transfer" }: Props) {
  const isCash = paymentMethod === "cash";
  const docName = isCash ? "chứng từ tiền mặt" : "UNC";
  const { extract, confirm, record } = usePaymentUncApproval();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [draft, setDraft] = useState<UncExtractResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<UncStandaloneCategory | null>(null);
  const [note, setNote] = useState("");
  const [allocInputs, setAllocInputs] = useState<Record<string, string>>({});

  // Default: every selected request is paid in full. The CEO edits a row only when the transfer differs.
  // Filled during render (not in an effect) so the first frame never shows empty amounts.
  const requestKey = requests.map((r) => `${r.id}:${Math.round(remainingAmount(r))}`).join("|");
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const wantFilledFor = open ? requestKey : null;
  if (filledFor !== wantFilledFor) {
    setFilledFor(wantFilledFor);
    const next: Record<string, string> = {};
    if (open) {
      for (const r of requests) {
        const remaining = Math.round(Math.max(remainingAmount(r), 0));
        next[r.id] = remaining > 0 ? String(remaining) : "";
      }
    }
    setAllocInputs(next);
  }

  useEffect(() => {
    if (open) return;
    setPreview(null);
    setDraft(null);
    setError(null);
    setManual(false);
    setManualAmount("");
    setReason("");
    setCategory(null);
    setNote("");
    setAllocInputs({});
  }, [open]);

  const approve = mode === "approve";
  const reading = extract.isPending;
  const saving = confirm.isPending || record.isPending;
  const ocrAmount = draft?.ocr.amount ?? null;
  const typedAmount = manualAmount.trim() ? Number(manualAmount.replace(/[^\d]/g, "")) : null;

  // Many requests, or any request that is already approved, are paid by explicit per-request amounts.
  const allocMode = approve && (requests.length > 1 || requests.some((r) => r.status === "approved"));
  const evidenceAmount = manual ? typedAmount : ocrAmount;
  const remainingOf = (r: UncApprovalRequest) => Math.max(remainingAmount(r), 0);
  const allocAmount = (id: string) => {
    const raw = allocInputs[id];
    return raw ? Number(raw.replace(/[^\d]/g, "")) || 0 : 0;
  };
  // Oldest request first: fill each up to its remaining amount until the UNC amount is used up.
  const autoAllocate = (amount: number | null) => {
    const next: Record<string, string> = {};
    let left = Math.max(Math.round(amount ?? 0), 0);
    for (const r of requests) {
      const give = Math.min(left, Math.round(remainingOf(r)));
      next[r.id] = give > 0 ? String(give) : "";
      left -= give;
    }
    setAllocInputs(next);
  };
  const paidRequests = allocMode ? requests.filter((r) => allocAmount(r.id) > 0) : requests;
  const allocations: UncAllocationInput[] = paidRequests.map((r) => ({ paymentRequestId: r.id, amount: allocAmount(r.id) }));
  const allocatedTotal = allocations.reduce((sum, a) => sum + a.amount, 0);

  const match = useMemo(
    () =>
      approve && !allocMode
        ? evaluatePaymentUncMatch({
            requests,
            evidenceAmount,
            manualOverride: manual,
            overrideReason: reason,
          })
        : null,
    [approve, allocMode, requests, evidenceAmount, manual, reason],
  );
  const allocMatch = allocMode
    ? evaluateUncAllocations({
        requests: paidRequests,
        allocations,
        evidenceAmount,
        manualOverride: manual,
        overrideReason: reason,
      })
    : null;
  const needTotal = allocMode ? requests.reduce((sum, r) => sum + remainingOf(r), 0) : match?.remainingTotal ?? 0;
  const compareTotal = allocMode ? allocatedTotal : needTotal;
  const amountMatches = approve && ocrAmount !== null && Math.round(ocrAmount) === Math.round(compareTotal);
  const lowConfidence =
    !!draft && ((draft.ocr.confidence ?? 1) < LOW_CONFIDENCE || draft.ocr.amount_corrected_from_words);
  const supplierNames = Array.from(new Set(requests.map((r) => r.supplierName).filter(Boolean)));
  const supplierMismatch = allocMode ? !areSameSupplier(requests) : match?.code === "supplier_mismatch";

  const blocker = (() => {
    if (!draft) return `Chọn ảnh ${docName} để bắt đầu.`;
    if (manual && !reason.trim()) return "Duyệt tay cần ghi lý do.";
    if (manual && !(typedAmount && typedAmount > 0)) return "Nhập số tiền thực chuyển.";
    if (supplierMismatch) return ERROR_TEXT.supplier_mismatch;
    if (allocMode && allocMatch && !allocMatch.ok) {
      if (allocatedTotal === 0) return "Nhập số tiền gán cho ít nhất một phiếu.";
      return ERROR_TEXT[allocMatch.code] || "Chưa đủ điều kiện duyệt.";
    }
    if (approve && match && !match.ok) return ERROR_TEXT[match.code] || "Chưa đủ điều kiện duyệt.";
    if (!approve && !category) return "Chọn loại khoản chi.";
    if (!approve && !manual && !(ocrAmount && ocrAmount > 0)) return ERROR_TEXT.amount_required;
    return null;
  })();

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setDraft(null);
    setManual(false);
    setManualAmount("");
    try {
      const image = await fileToJpegBase64(file);
      setPreview(image.preview);
      const result = await extract.mutateAsync({ image_base64: image.base64, mime_type: image.mime, slip_type: isCash ? "cash" : "unc" });
      setDraft(result);
      if (result.ocr.amount) setManualAmount(String(Math.round(result.ocr.amount)));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const submit = async () => {
    if (!draft || blocker) return;
    setError(null);
    try {
      if (approve) {
        await confirm.mutateAsync({
          requests: paidRequests,
          ...(allocMode ? { allocations } : {}),
          file_sha256: draft.file_sha256,
          amount: manual ? typedAmount : ocrAmount,
          manual_override: manual,
          override_reason: manual ? reason.trim() : null,
          idempotency_key: draft.suggested_idempotency_key,
          payment_method: paymentMethod,
        });
        toast.success(isCash
          ? `Đã ghi chi ${paidRequests.length > 1 ? `${paidRequests.length} phiếu ` : ""}bằng tiền mặt`
          : paidRequests.length > 1 ? `Đã duyệt và ghi chi ${paidRequests.length} phiếu bằng UNC` : "Đã duyệt và ghi chi bằng UNC");
      } else {
        await record.mutateAsync({
          file_sha256: draft.file_sha256,
          category: category as UncStandaloneCategory,
          note: note.trim() || null,
          amount: manual ? typedAmount : null,
          manual_override: manual,
          override_reason: manual ? reason.trim() : null,
        });
        toast.success("Đã ghi nhận UNC");
      }
      onOpenChange(false);
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="d3-unc"
        data-bmq-unc-dialog={mode}
        data-bmq-unc-method={paymentMethod}
        // No capture attribute on the file input (iOS would offer the camera only), and do
        // not auto-focus the first amount field: on phones that pops the number pad on open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">{approve ? (isCash ? "Chi tiền mặt" : "Duyệt chi bằng UNC") : "UNC không có đề nghị chi"}</span>
          <DialogTitle className="d3-unc-title">
            {approve ? (
              <>
                {allocMode ? "Còn nợ" : "Cần chi"} <b data-bmq-unc-need>{vnd(needTotal)}</b>
              </>
            ) : (
              "Ghi nhận UNC"
            )}
          </DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {approve
              ? `${requests.length} phiếu · ${supplierNames.join(", ") || "Chưa rõ nhà cung cấp"}${allocMode ? ` · gán số tiền ${docName} cho từng phiếu` : ""}`
              : "Lương, thuế, thuê nhà hoặc khoản chuyển khoản khác. Số này cộng vào UNC trong ngày."}
          </DialogDescription>
        </DialogHeader>

        {approve && !allocMode && requests.length > 1 && (
          <ul className="d3-unc-reqs">
            {requests.map((r) => (
              <li key={r.id}>
                <span>{r.requestNumber}</span>
                <b>{vnd(remainingOf(r))}</b>
              </li>
            ))}
          </ul>
        )}

        {allocMode && (
          <div className="d3-unc-alloc" data-bmq-unc-alloc>
            <div className="d3-unc-alloc-head">
              <span>Gán số tiền cho từng phiếu</span>
              {draft && (
                <span className="d3-unc-alloc-tools">
                  <button type="button" className="d3-unc-link" onClick={() => autoAllocate(Number.MAX_SAFE_INTEGER)} data-bmq-unc-alloc-full>
                    Trả đủ số còn nợ
                  </button>
                  <button type="button" className="d3-unc-link" onClick={() => autoAllocate(evidenceAmount ?? null)} data-bmq-unc-alloc-auto>
                    Chia theo số {isCash ? "chứng từ" : "UNC"}, phiếu cũ trước
                  </button>
                </span>
              )}
            </div>
            <ul>
              {requests.map((r) => {
                const remaining = remainingOf(r);
                const value = allocAmount(r.id);
                const over = value > Math.round(remaining);
                return (
                  <li key={r.id} className={over ? "is-over" : undefined} data-bmq-unc-alloc-row={r.requestNumber}>
                    <div className="d3-unc-alloc-info">
                      <b>{r.requestNumber}</b>
                      <small>
                        {r.status === "approved" ? "Đã duyệt" : "Chờ duyệt"} · còn nợ {vnd(remaining)}
                      </small>
                    </div>
                    <Input
                      inputMode="numeric"
                      aria-label={`Số tiền gán cho ${r.requestNumber}`}
                      placeholder="0"
                                      value={allocInputs[r.id] ? new Intl.NumberFormat("vi-VN").format(value) : ""}
                      onChange={(e) => setAllocInputs((prev) => ({ ...prev, [r.id]: e.target.value.replace(/[^\d]/g, "") }))}
                    />
                  </li>
                );
              })}
            </ul>
            {(
              <p className="d3-unc-alloc-sum" data-bmq-unc-alloc-sum>
                Đã gán <b>{vnd(allocatedTotal)}</b>{draft ? <> / {isCash ? "chứng từ" : "UNC"} <b>{vnd(evidenceAmount ?? null)}</b></> : " · mặc định trả đủ số còn nợ, sửa nếu thực chuyển khác"}
                {paidRequests.length < requests.length && " · phiếu để trống 0 đ không được trả lần này"}
              </p>
            )}
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          data-bmq-unc-file
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.currentTarget.value = "";
          }}
        />

        {!preview ? (
          <button type="button" className="d3-unc-drop" onClick={() => fileRef.current?.click()} data-bmq-unc-pick>
            <Camera className="h-6 w-6" />
            <span>{isCash ? "Chụp hoặc chọn chứng từ tiền mặt" : "Chụp hoặc chọn ảnh UNC"}</span>
            <small>Máy chủ đọc số tiền và mã giao dịch</small>
          </button>
        ) : (
          <div className="d3-unc-slip">
            <img src={preview} alt={`Ảnh ${docName}`} />
            <div className="d3-unc-read" aria-live="polite">
              {reading ? (
                <p className="d3-unc-reading">
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang đọc {docName}…
                </p>
              ) : draft ? (
                <dl>
                  <div>
                    <dt>Số tiền trên {docName}</dt>
                    <dd className="d3-unc-num" data-bmq-unc-ocr>{vnd(ocrAmount)}</dd>
                  </div>
                  <div>
                    <dt>Mã giao dịch</dt>
                    <dd>{draft.ocr.reference || "Không đọc được"}</dd>
                  </div>
                  <div>
                    <dt>Ngày chuyển</dt>
                    <dd>{draft.ocr.transfer_date || "Không đọc được"}</dd>
                  </div>
                </dl>
              ) : null}
              <button type="button" className="d3-unc-link" onClick={() => fileRef.current?.click()} disabled={reading || saving}>
                <RotateCcw className="h-3.5 w-3.5" /> Chọn ảnh khác
              </button>
            </div>
          </div>
        )}

        {draft && approve && supplierMismatch ? (
          <p className="d3-unc-verdict is-bad" data-bmq-unc-verdict="supplier">
            <TriangleAlert className="h-4 w-4" /> {ERROR_TEXT.supplier_mismatch} Bỏ chọn bớt rồi duyệt từng nhà cung cấp.
          </p>
        ) : draft && approve && (
          <p className={amountMatches ? "d3-unc-verdict is-ok" : "d3-unc-verdict is-bad"} data-bmq-unc-verdict={amountMatches ? "match" : "mismatch"}>
            {amountMatches ? (
              <>
                <Check className="h-4 w-4" /> {allocMode ? `Tổng gán khớp số tiền trên ${docName}` : "Khớp số tiền cần chi"}
              </>
            ) : (
              <>
                <TriangleAlert className="h-4 w-4" />
                {ocrAmount === null
                  ? "Không đọc được số tiền"
                  : allocMode
                    ? `Tổng gán lệch ${vnd(Math.abs((ocrAmount ?? 0) - compareTotal))} so với ${docName}`
                    : `Lệch ${vnd(Math.abs((ocrAmount ?? 0) - compareTotal))} so với số cần chi`}
              </>
            )}
          </p>
        )}
        {draft && lowConfidence && (
          <p className="d3-unc-verdict is-warn">
            <TriangleAlert className="h-4 w-4" /> Đọc chưa chắc chắn. Hãy so lại số tiền với ảnh trước khi xác nhận.
          </p>
        )}

        {draft && !approve && (
          <div className="d3-unc-field">
            <span className="d3-unc-label">Loại khoản chi</span>
            <div className="d3-unc-chips" role="radiogroup" aria-label="Loại khoản chi">
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={category === c.id}
                  className={category === c.id ? "is-on" : undefined}
                  onClick={() => setCategory(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (không bắt buộc)" maxLength={200} />
          </div>
        )}

        {draft && (
          <div className="d3-unc-field">
            <label className="d3-unc-toggle">
              <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} data-bmq-unc-manual />
              <span>{isCash ? "Duyệt tay (số trên chứng từ khác số cần chi)" : "Duyệt tay (số trên UNC khác, ví dụ ngân hàng trừ phí)"}</span>
            </label>
            {manual && (
              <div className="d3-unc-manual">
                <Input
                  inputMode="numeric"
                  value={manualAmount ? new Intl.NumberFormat("vi-VN").format(Number(manualAmount.replace(/[^\d]/g, "")) || 0) : ""}
                  onChange={(e) => setManualAmount(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="Số tiền thực chuyển"
                  aria-label="Số tiền thực chuyển"
                />
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Lý do duyệt tay (bắt buộc)"
                  aria-label="Lý do duyệt tay"
                  rows={2}
                  maxLength={300}
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="d3-unc-verdict is-bad" role="alert" data-bmq-unc-error>
            <TriangleAlert className="h-4 w-4" /> {error}
          </p>
        )}

        {draft && blocker && !error && !supplierMismatch && <p className="d3-unc-hint">{blocker}</p>}

        <div className="d3-unc-actions">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Hủy
          </Button>
          <Button type="button" className="d3-unc-go" onClick={submit} disabled={!!blocker || reading || saving} title={blocker || undefined} data-bmq-unc-submit>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {approve ? (isCash ? "Ghi chi tiền mặt" : "Duyệt và ghi chi") : "Ghi nhận UNC"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
