import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { RotatedImage } from "@/components/RotatedImage";
import { useImageRotation, useSetImageRotation } from "@/hooks/useImageRotation";
import { imageRotationErrorCode, imageRotationErrorText, isSideways, nextRotation } from "@/lib/image-rotation";
import { fmtQty } from "./meta";

const money = (value: number | null) => (value === null ? null : `${Math.round(value).toLocaleString("vi-VN")}đ`);
const shortDate = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
};

/** Signed URL for a delivery-note storage path (bucket 'invoices'), cached ~50 minutes. */
function useNoteUrl(path: string | null) {
  return useQuery({
    queryKey: ["gr-note-url", path],
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (path ? (await getGoodsReceiptImageUrl(path)) || null : null),
  });
}

function Thumb({ line, onOpen }: { line: ReceiptLine; onOpen: () => void }) {
  const url = useNoteUrl(line.image_path);
  const { data: rotation = 0 } = useImageRotation(line.image_path);
  // Cover-cropped thumb: turning a sideways photo needs a slight zoom so the corners stay filled.
  const turn = rotation ? { transform: `rotate(${rotation}deg)${isSideways(rotation) ? " scale(1.35)" : ""}` } : undefined;
  return (
    <button type="button" className="note-card" onClick={onOpen} disabled={!line.image_path} data-bmq-note={line.receipt_number}>
      <span className="note-thumb">
        {line.image_path ? (url.data ? <img src={url.data} alt={`Phiếu giao hàng ${line.receipt_number}`} loading="lazy" style={turn} /> : <i className="note-wait" aria-hidden="true" />) : <em>chưa có ảnh</em>}
      </span>
      <span className="note-meta">
        <b>{line.receipt_number}</b>
        <small>{shortDate(line.receipt_date)} · {line.quantity > 0 ? `${fmtQty(line.quantity)} ${line.unit ?? ""}` : "chưa ghi số lượng"}</small>
        {line.unit_price !== null ? <small>{money(line.unit_price)}{line.unit ? `/${line.unit}` : ""}</small> : null}
      </span>
    </button>
  );
}

/** Full-screen delivery note: zoom in steps, scroll to pan, arrows between receipts. */
function NoteViewer({ lines, index, onIndex, onClose }: { lines: ReceiptLine[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const line = lines[index];
  const url = useNoteUrl(line.image_path);
  const [zoom, setZoom] = useState(1);
  const { data: rotation = 0 } = useImageRotation(line.image_path);
  const setRotation = useSetImageRotation();
  const [rotateError, setRotateError] = useState<string | null>(null);
  useEffect(() => { setZoom(1); setRotateError(null); }, [index]);
  const rotate = () => {
    if (!line.image_path) return;
    setRotateError(null);
    setRotation.mutate(
      { imagePath: line.image_path, rotation: nextRotation(rotation) },
      { onError: (error) => setRotateError(imageRotationErrorText(imageRotationErrorCode(error))) },
    );
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight" && index < lines.length - 1) onIndex(index + 1);
      if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, lines.length, onClose, onIndex]);
  return (
    <div className="note-viewer" role="dialog" aria-label={`Phiếu giao hàng ${line.receipt_number}`} data-bmq-note-viewer>
      <div className="note-bar">
        <span><b>{line.receipt_number}</b><small>{shortDate(line.receipt_date)} · {line.supplier_name ?? ""}</small></span>
        <button type="button" className="round-btn" onClick={rotate} disabled={!url.data || setRotation.isPending} aria-label="Xoay ảnh" data-bmq-rotate-image>↻</button>
        <button type="button" className="round-btn" onClick={() => setZoom((z) => Math.max(1, z - 1))} disabled={zoom === 1} aria-label="Thu nhỏ">−</button>
        <button type="button" className="round-btn" onClick={() => setZoom((z) => Math.min(4, z + 1))} disabled={zoom === 4} aria-label="Phóng to">＋</button>
        <button type="button" className="round-btn exit-btn" onClick={onClose} aria-label="Đóng">✕</button>
      </div>
      <div className="note-stage" onDoubleClick={() => setZoom((z) => (z >= 3 ? 1 : z + 1))}>
        {rotateError ? <p className="err" role="alert">{rotateError}</p> : null}
        {url.data ? <RotatedImage src={url.data} alt={`Phiếu giao hàng ${line.receipt_number}`} rotation={rotation} width={`${zoom * 100}%`} className="note-photo" /> : <p className="note-empty">{line.image_path ? "Đang tải ảnh…" : "Phiếu này chưa chụp ảnh giao hàng."}</p>}
      </div>
      <div className="note-line">
        <span>“{line.raw_name}” · <b>{line.quantity > 0 ? `${fmtQty(line.quantity)} ${line.unit ?? ""}` : "chưa ghi số lượng"}</b>{line.quantity > 0 && line.unit_price !== null ? ` × ${money(line.unit_price)}` : line.unit_price !== null ? ` · đơn giá ${money(line.unit_price)}/${line.unit ?? ""}` : ""}{line.quantity > 0 && line.line_total !== null ? ` = ${money(line.line_total)}` : ""}</span>
        <span className="note-nav">
          <button type="button" className="btn ghost" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Phiếu trước">‹</button>
          <small>{index + 1}/{lines.length}</small>
          <button type="button" className="btn ghost" disabled={index === lines.length - 1} onClick={() => onIndex(index + 1)} aria-label="Phiếu sau">›</button>
        </span>
      </div>
    </div>
  );
}

/** "📄 Phiếu giao hàng" strip: one card per receipt line, tap to open the photo full screen. */
export function ReceiptNotes({ title, lines, loading, error }: { title: string; lines: ReceiptLine[] | undefined; loading: boolean; error: unknown }) {
  const [open, setOpen] = useState<number | null>(null);
  const list = lines ?? [];
  const withPhoto = list.filter((line) => line.image_path).length;
  return (
    <section className="notes" data-bmq-receipt-notes>
      <div className="notes-h"><b>📄 {title}</b><small>{loading ? "đang tải…" : `${list.length} lần nhập · ${withPhoto} có ảnh`}</small></div>
      {error ? <div className="err">Chưa tải được phiếu nhập.</div> : null}
      {!loading && !error && list.length === 0 ? <p className="note" style={{ fontSize: 13 }}>Chưa có phiếu nhập nào.</p> : null}
      {list.length ? (
        <div className="notes-row">{list.map((line, i) => <Thumb key={line.goods_receipt_item_id} line={line} onOpen={() => setOpen(i)} />)}</div>
      ) : null}
      {open !== null && list[open]
        // The sheet is transformed (tilt animation), so a fixed overlay must live at the game root.
        ? createPortal(<NoteViewer lines={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />, document.querySelector("[data-bmq-warehouse-game]") ?? document.body)
        : null}
    </section>
  );
}
