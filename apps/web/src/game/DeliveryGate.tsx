import { useEffect, useMemo, useRef, useState } from "react";
import { uploadEvidencePhoto, useDispatchGameQueue, useRecordDispatchDelivery } from "@/hooks/useDispatchDelivery";
import { computeDeliveryVariance, evidencePath, shortfallErrorText, type DispatchQueueRow, type ShortfallAction } from "@/lib/dispatch-delivery";
import { Sheet } from "./Sheet";
import { fmtQty, newRequestId } from "./meta";

const MAX_PHOTOS = 8;
const dmy = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const parseQty = (text: string) => {
  const value = Number(text.replace(/\s/g, "").replace(",", "."));
  return text.trim() === "" ? NaN : Number.isFinite(value) ? value : NaN;
};

const STATUS_LABEL: Record<string, string> = { pending: "Chờ soạn", picked: "Đã soạn", dispatched: "Đang giao" };

const SERVER_ERRORS: Record<string, string> = {
  evidence_required: "Cần chụp ít nhất 1 ảnh hàng giao.",
  too_many_photos: `Tối đa ${MAX_PHOTOS} ảnh.`,
  dispatch_already_delivered: "Phiếu này đã được ghi giao rồi.",
  dispatch_delivery_forbidden: "Tài khoản chưa có quyền ghi giao hàng.",
  insufficient_stock: "Kho không đủ hàng để xuất phiếu này. Kiểm tra lại tồn kho.",
  inventory_item_not_found: "Không tìm thấy món này trong kho thành phẩm.",
  inventory_item_ambiguous: "Có hai món trùng tên trong kho thành phẩm.",
  invalid_quantity: "Số lượng xuất của phiếu không hợp lệ (phải là số nguyên).",
};

/** Map a Supabase / payload error onto one Vietnamese line. */
function deliveryError(error: unknown): string | null {
  if (!error) return null;
  const raw = error as { message?: string; details?: string };
  const text = `${raw.message ?? ""} ${raw.details ?? ""}`;
  for (const code of ["over_delivery_not_allowed", "shortfall_action_required", "shortfall_note_required"]) {
    if (text.includes(code)) return shortfallErrorText(code);
  }
  for (const [code, message] of Object.entries(SERVER_ERRORS)) if (text.includes(code)) return message;
  if (/at least 1 photo/.test(text)) return SERVER_ERRORS.evidence_required;
  return "Không ghi được giao hàng. Thử lại sau ít phút.";
}

interface LineDraft { qty: string; action: ShortfallAction | null; note: string }
interface Photo { id: string; file: File; url: string; path: string }

function DispatchCard({ row, onOpen }: { row: DispatchQueueRow; onOpen: () => void }) {
  const total = row.items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <button type="button" className="pick dlv-card" onClick={onOpen} data-bmq-dlv-card={row.dispatch_number}>
      <span>
        <b>{row.dispatch_number}{row.customer_name ? ` · ${row.customer_name}` : ""}</b>
        <small>{dmy(row.dispatch_date)} · {row.items.length} món · {fmtQty(total)} sp{row.evidence_count ? ` · 📷 ${row.evidence_count}` : ""}</small>
      </span>
      <span className={`dlv-state is-${row.status}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
    </button>
  );
}

/** One open dispatch: actual quantities, shortfall choice per line, 1–8 photos. */
function DeliveryForm({ row, onBack, onDone }: { row: DispatchQueueRow; onBack: () => void; onDone: (message: string) => void }) {
  const record = useRecordDispatchDelivery();
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(row.items.map((item) => [item.id, { qty: String(item.quantity), action: null, note: "" }])));
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploaded, setUploaded] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [requestId] = useState(newRequestId);

  const photosRef = useRef(photos);
  photosRef.current = photos;
  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.url)), []);

  const setDraft = (id: string, patch: Partial<LineDraft>) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const lines = row.items.map((item) => {
    const draft = drafts[item.id];
    const qty = parseQty(draft.qty);
    const variance = computeDeliveryVariance(item.quantity, Number.isFinite(qty) ? qty : 0);
    const short = Number.isFinite(qty) && qty < item.quantity;
    const problem = !Number.isFinite(qty) ? "Nhập số thực giao"
      : qty < 0 ? "Không được âm"
      : qty > item.quantity ? `Tối đa ${fmtQty(item.quantity)}. Giao thêm thì lập phiếu xuất mới`
      : short && !draft.action ? "Chọn Trả lại kho hoặc Hao hụt"
      : short && draft.action === "write_off" && draft.note.trim().length < 3 ? "Ghi lý do hao hụt"
      : null;
    return { item, draft, qty, variance, short, problem };
  });
  const shortCount = lines.filter((line) => line.short).length;
  const busy = uploading || record.isPending;
  const ready = row.can_edit && photos.length > 0 && lines.every((line) => !line.problem) && !busy;

  const addPhotos = (files: FileList | null) => {
    if (!files) return;
    const room = MAX_PHOTOS - photos.length;
    const next = Array.from(files).filter((file) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name)).slice(0, room)
      .map((file, index) => {
        const id = newRequestId();
        return { id, file, url: URL.createObjectURL(file), path: evidencePath(row.id, `${Date.now()}-${photos.length + index + 1}.jpg`) };
      });
    setPhotos((prev) => [...prev, ...next]);
    setUploadError(null);
  };
  const removePhoto = (id: string) => {
    const gone = photos.find((photo) => photo.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    setPhotos((prev) => prev.filter((photo) => photo.id !== id));
  };

  const submit = async () => {
    setUploadError(null);
    setUploading(true);
    try {
      for (const photo of photos) {
        if (uploaded.has(photo.path)) continue;
        await uploadEvidencePhoto(photo.path, photo.file);
        setUploaded((prev) => new Set(prev).add(photo.path));
      }
    } catch {
      setUploadError("Tải ảnh lên chưa được. Kiểm tra mạng rồi bấm lại (ảnh đã lên sẽ không tải lại).");
      setUploading(false);
      return;
    }
    setUploading(false);
    record.mutate(
      {
        dispatchId: row.id,
        requestId,
        photoPaths: photos.map((photo) => photo.path),
        lines: lines.map(({ item, draft, qty, short }) => ({
          item_id: item.id,
          expected_qty: item.quantity,
          delivered_qty: qty,
          shortfall_action: short ? draft.action : null,
          shortfall_note: short ? draft.note.trim() || null : null,
          source_line_key: item.product_name,
        })),
      },
      {
        onSuccess: (result) => {
          const parts = [`✅ ${row.dispatch_number} đã giao`];
          if (result.shortfall_returned_qty > 0) parts.push(`trả kho ${fmtQty(result.shortfall_returned_qty)}`);
          if (result.shortfall_written_off_qty > 0) parts.push(`hao hụt ${fmtQty(result.shortfall_written_off_qty)}`);
          if (result.revenue_pending) parts.push("doanh thu chờ kế toán");
          onDone(parts.join(" · "));
        },
      },
    );
  };

  return (
    <Sheet title={row.dispatch_number} tag="🚛 Cổng giao hàng" sub={`${row.customer_name ?? "Khách lẻ"} · xuất ${dmy(row.dispatch_date)}`} onClose={onBack}>
      <div className="slip dlv" data-bmq-dlv-form>
        {!row.can_edit ? <div className="warn">Tài khoản này chỉ xem được. Cần quyền sửa Kho để ghi giao hàng.</div> : null}

        <h3 className="dlv-h">1 · Số thực giao</h3>
        <ul className="slip-lines dlv-lines">
          {lines.map(({ item, draft, variance, short, problem }, index) => (
            <li key={item.id} className={problem ? "is-bad" : undefined} data-bmq-dlv-line={item.product_name}>
              <span className="slip-no">{index + 1}</span>
              <span className="slip-name">
                <b>{item.product_name}</b>
                <small>Đã xuất {fmtQty(item.quantity)} {item.unit}{short ? ` · thiếu ${fmtQty(-variance.variance)}` : ""}</small>
              </span>
              <label className="slip-qty">
                <input inputMode="decimal" value={draft.qty} aria-label={`Thực giao ${item.product_name}`} onChange={(event) => setDraft(item.id, { qty: event.target.value })} />
                <i>{item.unit}</i>
              </label>
              {short ? (
                <div className="dlv-choice" role="radiogroup" aria-label={`Phần thiếu của ${item.product_name}`}>
                  <button type="button" role="radio" aria-checked={draft.action === "return_stock"} className={draft.action === "return_stock" ? "is-on" : undefined} onClick={() => setDraft(item.id, { action: "return_stock" })} data-bmq-dlv-return>↩ Trả lại kho</button>
                  <button type="button" role="radio" aria-checked={draft.action === "write_off"} className={draft.action === "write_off" ? "is-on is-loss" : undefined} onClick={() => setDraft(item.id, { action: "write_off" })} data-bmq-dlv-writeoff>✕ Hao hụt</button>
                  {draft.action === "write_off" ? (
                    <input className="dlv-note" value={draft.note} maxLength={200} placeholder="Lý do: vỡ, hỏng, khách trả…" aria-label={`Lý do hao hụt ${item.product_name}`} onChange={(event) => setDraft(item.id, { note: event.target.value })} />
                  ) : null}
                </div>
              ) : null}
              {problem ? <small className="slip-problem">{problem}</small> : null}
            </li>
          ))}
        </ul>

        <h3 className="dlv-h">2 · Ảnh hàng giao <small>{photos.length}/{MAX_PHOTOS}</small></h3>
        <div className="dlv-photos" data-bmq-dlv-photos>
          {photos.map((photo) => (
            <figure key={photo.id} className="dlv-photo">
              <img src={photo.url} alt="Ảnh hàng giao" />
              {uploaded.has(photo.path) ? <i className="dlv-up" aria-label="Đã tải lên">✓</i> : null}
              <button type="button" onClick={() => removePhoto(photo.id)} disabled={busy} aria-label="Bỏ ảnh">✕</button>
            </figure>
          ))}
          {photos.length < MAX_PHOTOS ? (
            <label className="dlv-add">
              <input type="file" accept="image/*" capture="environment" multiple onChange={(event) => { addPhotos(event.target.files); event.target.value = ""; }} disabled={busy} data-bmq-dlv-file />
              <span aria-hidden="true">📷</span>
              <b>{photos.length ? "Thêm ảnh" : "Chụp ảnh"}</b>
            </label>
          ) : null}
        </div>
        {!photos.length ? <p className="note">Chụp khay hàng trước khi giao, như ảnh nhóm Kho Q7 hay gửi.</p> : null}

        {uploadError ? <div className="err">{uploadError}</div> : null}
        {record.error ? <div className="err">{deliveryError(record.error)}</div> : null}
        <div className="row slip-actions">
          <button type="button" className={`btn submit${ready ? " is-ready" : ""}`} disabled={!ready} onClick={() => void submit()} data-bmq-dlv-submit>
            {uploading ? "Đang tải ảnh…" : record.isPending ? "Đang ghi…" : shortCount ? `✅ Giao · thiếu ${shortCount}` : "✅ Đã giao đủ"}
          </button>
          <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>Quay lại</button>
        </div>
      </div>
    </Sheet>
  );
}

/** "Cổng giao hàng" (owner 14/10): staff close a dispatch with actual quantities + photos. */
export function DeliveryGate({ onDone, onClose }: { onDone: (message: string) => void; onClose: () => void }) {
  const queue = useDispatchGameQueue();
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useMemo(() => queue.data ?? [], [queue.data]);
  const open = rows.find((row) => row.id === openId) ?? null;

  if (open) {
    return <DeliveryForm key={open.id} row={open} onBack={() => setOpenId(null)} onDone={(message) => { setOpenId(null); onDone(message); }} />;
  }

  const forbidden = /insufficient_privilege/.test(String((queue.error as { message?: string } | null)?.message ?? ""));
  return (
    <Sheet title="Cổng giao hàng" tag="🚛 Giao hàng" sub="Nhập số thực giao + chụp ảnh làm chứng từ" onClose={onClose}>
      <div data-bmq-dlv-queue>
        {queue.isLoading ? <p className="note">Đang tải phiếu xuất…</p>
          : forbidden ? <div className="warn">Tài khoản chưa có quyền xem Kho nên chưa thấy phiếu xuất.</div>
          : queue.error ? <div className="err">Chưa tải được phiếu xuất.</div>
          : rows.length ? (
            <div className="picks dlv-queue">
              {rows.map((row) => <DispatchCard key={row.id} row={row} onOpen={() => setOpenId(row.id)} />)}
            </div>
          ) : <p className="note">Không có phiếu xuất nào chờ giao trong 14 ngày qua. 🎉</p>}
      </div>
    </Sheet>
  );
}
