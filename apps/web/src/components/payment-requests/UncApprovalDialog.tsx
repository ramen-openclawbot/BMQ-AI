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
  type UncPaymentRequestInput,
  type UncStandaloneCategory,
} from "@/hooks/usePaymentUncApproval";
import { evaluatePaymentUncMatch } from "@/lib/payment-unc-matching";
import "@/styles/bmq-unc-approval.css";

export type UncApprovalRequest = UncPaymentRequestInput & {
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
async function fileToJpegBase64(file: File): Promise<{ base64: string; mime: string; preview: string }> {
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

export function UncApprovalDialog({ open, onOpenChange, mode, requests = [], onDone }: Props) {
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
  }, [open]);

  const approve = mode === "approve";
  const reading = extract.isPending;
  const saving = confirm.isPending || record.isPending;
  const ocrAmount = draft?.ocr.amount ?? null;
  const typedAmount = manualAmount.trim() ? Number(manualAmount.replace(/[^\d]/g, "")) : null;

  const match = useMemo(
    () =>
      approve
        ? evaluatePaymentUncMatch({
            requests,
            evidenceAmount: manual ? typedAmount : ocrAmount,
            manualOverride: manual,
            overrideReason: reason,
          })
        : null,
    [approve, requests, manual, typedAmount, ocrAmount, reason],
  );
  const needTotal = match?.remainingTotal ?? 0;
  const amountMatches = approve && ocrAmount !== null && Math.round(ocrAmount) === Math.round(needTotal);
  const lowConfidence =
    !!draft && ((draft.ocr.confidence ?? 1) < LOW_CONFIDENCE || draft.ocr.amount_corrected_from_words);
  const supplierNames = Array.from(new Set(requests.map((r) => r.supplierName).filter(Boolean)));

  const blocker = (() => {
    if (!draft) return "Chọn ảnh UNC để bắt đầu.";
    if (manual && !reason.trim()) return "Duyệt tay cần ghi lý do.";
    if (manual && !(typedAmount && typedAmount > 0)) return "Nhập số tiền thực chuyển.";
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
      const result = await extract.mutateAsync({ image_base64: image.base64, mime_type: image.mime, slip_type: "unc" });
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
          requests,
          file_sha256: draft.file_sha256,
          amount: manual ? typedAmount : ocrAmount,
          manual_override: manual,
          override_reason: manual ? reason.trim() : null,
          idempotency_key: draft.suggested_idempotency_key,
        });
        toast.success(requests.length > 1 ? `Đã duyệt và ghi chi ${requests.length} phiếu bằng UNC` : "Đã duyệt và ghi chi bằng UNC");
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
      <DialogContent className="d3-unc" data-bmq-unc-dialog={mode}>
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">{approve ? "Duyệt chi bằng UNC" : "UNC không có đề nghị chi"}</span>
          <DialogTitle className="d3-unc-title">
            {approve ? (
              <>
                Cần chi <b data-bmq-unc-need>{vnd(needTotal)}</b>
              </>
            ) : (
              "Ghi nhận UNC"
            )}
          </DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {approve
              ? `${requests.length} phiếu · ${supplierNames.join(", ") || "Chưa rõ nhà cung cấp"}`
              : "Lương, thuế, thuê nhà hoặc khoản chuyển khoản khác. Số này cộng vào UNC trong ngày."}
          </DialogDescription>
        </DialogHeader>

        {approve && requests.length > 1 && (
          <ul className="d3-unc-reqs">
            {requests.map((r) => (
              <li key={r.id}>
                <span>{r.requestNumber}</span>
                <b>{vnd(Number(r.totalAmount ?? 0) - Number(r.allocatedAmount ?? 0))}</b>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
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
            <span>Chụp hoặc chọn ảnh UNC</span>
            <small>Máy chủ đọc số tiền và mã giao dịch</small>
          </button>
        ) : (
          <div className="d3-unc-slip">
            <img src={preview} alt="Ảnh UNC" />
            <div className="d3-unc-read" aria-live="polite">
              {reading ? (
                <p className="d3-unc-reading">
                  <Loader2 className="h-4 w-4 animate-spin" /> Đang đọc UNC…
                </p>
              ) : draft ? (
                <dl>
                  <div>
                    <dt>Số tiền trên UNC</dt>
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

        {draft && approve && match?.code === "supplier_mismatch" ? (
          <p className="d3-unc-verdict is-bad" data-bmq-unc-verdict="supplier">
            <TriangleAlert className="h-4 w-4" /> {ERROR_TEXT.supplier_mismatch} Bỏ chọn bớt rồi duyệt từng nhà cung cấp.
          </p>
        ) : draft && approve && (
          <p className={amountMatches ? "d3-unc-verdict is-ok" : "d3-unc-verdict is-bad"} data-bmq-unc-verdict={amountMatches ? "match" : "mismatch"}>
            {amountMatches ? (
              <>
                <Check className="h-4 w-4" /> Khớp số tiền cần chi
              </>
            ) : (
              <>
                <TriangleAlert className="h-4 w-4" />
                {ocrAmount === null ? "Không đọc được số tiền" : `Lệch ${vnd(Math.abs((ocrAmount ?? 0) - needTotal))} so với số cần chi`}
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
              <span>Duyệt tay (số trên UNC khác, ví dụ ngân hàng trừ phí)</span>
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

        {draft && blocker && !error && match?.code !== "supplier_mismatch" && <p className="d3-unc-hint">{blocker}</p>}

        <div className="d3-unc-actions">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Hủy
          </Button>
          <Button type="button" className="d3-unc-go" onClick={submit} disabled={!!blocker || reading || saving} title={blocker || undefined} data-bmq-unc-submit>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {approve ? "Duyệt và ghi chi" : "Ghi nhận UNC"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
