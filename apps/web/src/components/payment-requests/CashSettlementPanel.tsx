/* Chi tiền mặt — quyết toán: after the CEO transferred the cash to the staff member, the
 * staff uploads every small receipt (bank slip, app screenshot, phiếu giao hàng). The pure
 * matcher proposes which receipt covers which khoản; unmatched receipts can be assigned by
 * hand; "Xác nhận đối chiếu" sends the allocation to submit_cash_settlement, which marks the
 * phiếu "Hoàn tất chi tiền mặt" once every khoản is covered. Read-only when completed or
 * when the viewer cannot edit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fileToJpegBase64 } from "@/components/payment-requests/UncApprovalDialog";
import { getUncEvidenceSignedUrl } from "@/hooks/usePaymentRequestUncEvidence";
import {
  useCashSettlement,
  type CashSettlementAllocationInput,
  type CashSettlementReceipt,
} from "@/hooks/useCashSettlement";
import { matchCashSettlement } from "@/lib/cash-settlement-match";
import { cn } from "@/lib/utils";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-cash-settlement.css";

const vnd = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value)))} đ`;

const ERROR_TEXT: Record<string, string> = {
  not_allowed: "Anh/chị chưa có quyền nộp chứng từ cho phiếu này.",
  image_too_large: "Ảnh quá lớn. Chụp lại hoặc chọn ảnh nhỏ hơn.",
  invalid_image_type: "Chỉ nhận ảnh JPG, PNG hoặc WEBP.",
  not_awaiting_receipts: "Phiếu này không còn chờ chứng từ.",
  item_over_allocated: "Tổng chứng từ vượt số tiền của khoản.",
  receipt_over_allocated: "Số ghép vượt số tiền trên chứng từ.",
  receipt_not_uploaded: "Chứng từ đã được ghép hoặc đã bỏ. Tải lại trang.",
  insufficient_privilege: "Anh/chị chưa có quyền nộp chứng từ cho phiếu này.",
};

const errorText = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error ?? "");
  const code = Object.keys(ERROR_TEXT).find((key) => message.includes(key));
  return code ? ERROR_TEXT[code] : "Chưa lưu được. Thử lại sau.";
};

function ReceiptThumb({ path, onOpen }: { path: string; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getUncEvidenceSignedUrl(path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [path]);
  return url ? (
    <button type="button" className="d3-cs-thumb" onClick={() => onOpen(url)} aria-label="Xem chứng từ">
      <img src={url} alt="Chứng từ" loading="lazy" />
    </button>
  ) : (
    <span className="d3-cs-thumb is-empty" />
  );
}

interface Props {
  requestId: string;
  /** Allow upload / match / confirm (still requires awaiting_receipts). */
  canEdit: boolean;
}

export function CashSettlementPanel({ requestId, canEdit }: Props) {
  const { data, isLoading, error, extractReceipts, discard, submit } = useCashSettlement(requestId);
  const [reading, setReading] = useState(0);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Manual choices for receipts the matcher could not place: receipt id -> item id / typed amount.
  const [manualItem, setManualItem] = useState<Record<string, string>>({});
  const [manualAmount, setManualAmount] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const status = data?.payment_request.cash_settlement_status ?? null;
  const editable = canEdit && status === "awaiting_receipts";
  const items = useMemo(() => data?.items ?? [], [data]);
  const receipts = useMemo(() => (data?.receipts ?? []).filter((r) => r.status !== "discarded"), [data]);
  const open = receipts.filter((r) => r.status === "uploaded");

  const match = useMemo(
    () =>
      matchCashSettlement(
        items.map((i) => ({ id: i.id, label: i.product_name, amount: Number(i.amount), covered: Number(i.covered) })),
        open.map((r) => ({ id: r.id, amount: r.amount ?? r.ocr_amount, status: r.status })),
      ),
    [items, open],
  );

  // Proposed allocations: matcher output plus the receipts placed by hand.
  const allocations: CashSettlementAllocationInput[] = useMemo(() => {
    const auto = match.allocations.map((a) => ({ ...a }));
    const remaining = new Map(match.items.map((i) => [i.item_id, i.remaining]));
    for (const r of open) {
      if (auto.some((a) => a.receipt_id === r.id)) continue;
      const itemId = manualItem[r.id];
      if (!itemId) continue;
      const amount = Number(manualAmount[r.id] || r.amount || r.ocr_amount || 0);
      const left = remaining.get(itemId) ?? 0;
      if (amount > 0 && amount <= left) {
        auto.push({ receipt_id: r.id, item_id: itemId, amount });
        remaining.set(itemId, left - amount);
      }
    }
    return auto;
  }, [match, open, manualItem, manualAmount]);

  const allocatedFor = (receiptId: string) => allocations.find((a) => a.receipt_id === receiptId);
  const pendingByItem = (itemId: string) =>
    allocations.filter((a) => a.item_id === itemId).reduce((s, a) => s + a.amount, 0);

  const total = items.reduce((s, i) => s + Number(i.amount), 0);
  const covered = items.reduce((s, i) => s + Number(i.covered), 0);
  const afterSubmit = covered + allocations.reduce((s, a) => s + a.amount, 0);

  const pickFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type === "");
    if (files.length === 0) return;
    setReading(files.length);
    setReadErrors([]);
    try {
      const images = await Promise.all(files.map((f) => fileToJpegBase64(f)));
      const results = await extractReceipts(images.map((i) => ({ image_base64: i.base64, mime_type: i.mime })));
      setReadErrors(
        results
          .filter((r) => !r.ok)
          .map((r) => `Ảnh ${r.index + 1}: ${(r.errorCode && ERROR_TEXT[r.errorCode]) || "chưa tải lên được."}`),
      );
    } finally {
      setReading(0);
    }
  };

  const confirm = async () => {
    if (allocations.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await submit(allocations);
      setManualItem({});
      setManualAmount({});
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return <p className="d3-unc-ev-note"><Loader2 className="h-4 w-4 animate-spin" /> Đang tải chứng từ chi lẻ…</p>;
  }
  if (error || !data) {
    return (
      <p className="d3-unc-ev-note is-bad" role="alert" data-bmq-cash-settle-error>
        <TriangleAlert className="h-4 w-4" /> Không tải được phần quyết toán tiền mặt, hoặc anh/chị chưa có quyền xem.
      </p>
    );
  }

  const receiptsOf = (itemId: string) => receipts.filter((r) => r.status === "allocated" && r.payment_request_item_id === itemId);
  const receiptLine = (r: CashSettlementReceipt) => r.ocr_payee || r.ocr_content || r.ocr_reference || null;

  return (
    <section className="d3-cs" data-bmq-cash-settle={status ?? "none"} aria-label="Chứng từ chi lẻ">
      <div className="d3-cs-head">
        <h3>Chứng từ chi lẻ</h3>
        <span className={cn("d3-up-chip", status === "completed" ? "is-green" : "is-amber")} data-bmq-cash-settle-status>
          {status === "completed" ? "Hoàn tất chi tiền mặt" : "Chờ chứng từ chi lẻ"}
        </span>
      </div>
      <div className="d3-cs-bar" aria-label="Tiến độ chứng từ">
        <span style={{ width: `${total > 0 ? Math.min(100, (covered / total) * 100) : 0}%` }} />
      </div>
      <p className="d3-cs-sum">
        Đã có chứng từ <b>{vnd(covered)}</b> / <b>{vnd(total)}</b>
        {covered < total && <> · còn <b>{vnd(total - covered)}</b></>}
      </p>

      <ul className="d3-cs-items">
        {items.map((item) => {
          const done = Number(item.covered) >= Number(item.amount);
          const pending = pendingByItem(item.id);
          return (
            <li key={item.id} className={cn(done && "is-done")} data-bmq-cash-settle-item={done ? "done" : "open"}>
              <div className="d3-cs-item-top">
                <span className="d3-cs-tick">{done && <Check className="h-3.5 w-3.5" />}</span>
                <b>{item.product_name}</b>
                <span className="d3-cs-amt">{vnd(item.amount)}</span>
              </div>
              {!done && (
                <small className="d3-cs-left">
                  Còn thiếu {vnd(Number(item.amount) - Number(item.covered))}
                  {pending > 0 && <> · sẽ ghép {vnd(pending)}</>}
                </small>
              )}
              {receiptsOf(item.id).length > 0 && (
                <div className="d3-cs-strip">
                  {receiptsOf(item.id).map((r) => (
                    <figure key={r.id}>
                      <ReceiptThumb path={r.storage_path} onOpen={setZoom} />
                      <figcaption>{vnd(r.amount)}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {editable && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            data-bmq-cash-settle-file
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
          <button type="button" className="d3-unc-drop d3-cs-drop" onClick={() => fileRef.current?.click()} disabled={reading > 0} data-bmq-cash-settle-pick>
            {reading > 0 ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
            <span>{reading > 0 ? `Đang đọc ${reading} ảnh…` : "Up chứng từ chi lẻ"}</span>
            <small>Chọn nhiều ảnh một lần: bank slip, ảnh app giao hàng, phiếu giao hàng…</small>
          </button>
          {readErrors.length > 0 && (
            <p className="d3-ub-why is-bad" role="alert"><TriangleAlert className="h-3.5 w-3.5" /> {readErrors.join(" ")}</p>
          )}
        </>
      )}

      {open.length > 0 && (
        <ul className="d3-cs-receipts" aria-label="Chứng từ chưa ghép">
          {open.map((r) => {
            const alloc = allocatedFor(r.id);
            const auto = match.allocations.some((a) => a.receipt_id === r.id);
            const amount = r.amount ?? r.ocr_amount;
            const item = alloc ? items.find((i) => i.id === alloc.item_id) : null;
            return (
              <li key={r.id} className={cn(alloc && "is-on")} data-bmq-cash-settle-receipt={alloc ? (auto ? "auto" : "manual") : "open"}>
                <ReceiptThumb path={r.storage_path} onOpen={setZoom} />
                <div className="d3-cs-r-body">
                  <span className="d3-ub-amt">{vnd(amount)}</span>
                  {receiptLine(r) && <small>{receiptLine(r)}</small>}
                  {r.ocr_error && !amount && <small className="is-bad">Chưa đọc được số tiền, nhập tay giúp.</small>}
                  {alloc && item ? (
                    <p className="d3-ub-why is-ok"><Check className="h-3.5 w-3.5" /> Ghép vào: {item.product_name}</p>
                  ) : null}
                  {editable && !auto && (
                    <div className="d3-cs-manual">
                      {!amount && (
                        <Input
                          inputMode="numeric"
                          placeholder="Số tiền"
                          aria-label="Số tiền trên chứng từ"
                          value={manualAmount[r.id] ? new Intl.NumberFormat("vi-VN").format(Number(manualAmount[r.id])) : ""}
                          onChange={(e) => setManualAmount((m) => ({ ...m, [r.id]: e.target.value.replace(/[^\d]/g, "") }))}
                          data-bmq-cash-settle-amount
                        />
                      )}
                      <select
                        className="d3-cs-select"
                        value={manualItem[r.id] ?? ""}
                        onChange={(e) => setManualItem((m) => ({ ...m, [r.id]: e.target.value }))}
                        aria-label="Ghép vào khoản"
                        data-bmq-cash-settle-assign
                      >
                        <option value="">Ghép vào khoản…</option>
                        {match.items.filter((i) => i.remaining > 0).map((i) => (
                          <option key={i.item_id} value={i.item_id}>{`${i.label ?? "Khoản"} · còn ${vnd(i.remaining)}`}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {editable && manualItem[r.id] && !alloc && (
                    <small className="is-bad">Số tiền lớn hơn phần còn thiếu của khoản này.</small>
                  )}
                </div>
                {editable && (
                  <button type="button" className="d3-cs-x" onClick={() => void discard(r.id)} aria-label="Bỏ chứng từ" data-bmq-cash-settle-discard>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && open.length > 0 && (
        <div className="d3-cs-foot">
          <p>
            Sau khi ghép: <b>{vnd(afterSubmit)}</b> / {vnd(total)}
            {afterSubmit >= total && total > 0 && <> · <b className="is-ok">đủ, sẽ hoàn tất</b></>}
          </p>
          {saveError && <p className="d3-ub-why is-bad" role="alert"><TriangleAlert className="h-3.5 w-3.5" /> {saveError}</p>}
          <Button className="d3-ub-go" disabled={saving || allocations.length === 0} onClick={() => void confirm()} data-bmq-cash-settle-confirm>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Xác nhận đối chiếu ({allocations.length})
          </Button>
        </div>
      )}

      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="d3-unc-ev-zoom">
          <DialogTitle className="sr-only">Chứng từ</DialogTitle>
          {zoom && <img src={zoom} alt="Chứng từ" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
