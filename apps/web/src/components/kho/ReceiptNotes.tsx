import { useEffect, useState, type KeyboardEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ImageOff, Minus, Plus, RotateCw, X } from "lucide-react";
import { getGoodsReceiptImageUrl } from "@/hooks/useGoodsReceipts";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { RotatedImage } from "@/components/RotatedImage";
import { useImageRotation, useSetImageRotation } from "@/hooks/useImageRotation";
import { imageRotationErrorCode, imageRotationErrorText, isSideways, nextRotation } from "@/lib/image-rotation";
import { receiptPhotos } from "@/lib/receipt-photos";
import { cn } from "@/lib/utils";
import { fmtQty } from "./kho-meta";

const money = (value: number | null) => (value === null ? null : `${Math.round(value).toLocaleString("vi-VN")}đ`);
const shortDate = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : iso;
};

/** Signed URL for a delivery-note storage path (bucket 'invoices'), cached ~50 minutes. */
export function useNoteUrl(path: string | null) {
  return useQuery({
    queryKey: ["gr-note-url", path],
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (path ? (await getGoodsReceiptImageUrl(path)) || null : null),
  });
}

function Thumb({ line, onOpen }: { line: ReceiptLine; onOpen: () => void }) {
  const photos = receiptPhotos(line.image_path, line.photo_paths);
  const first = photos[0]?.path ?? null;
  const url = useNoteUrl(first);
  const { data: rotation = 0 } = useImageRotation(first);
  const extraCount = Math.max(0, photos.length - 1);
  // Cover-cropped thumb: turning a sideways photo needs a slight zoom so the corners stay filled.
  const turn = rotation ? { transform: `rotate(${rotation}deg)${isSideways(rotation) ? " scale(1.35)" : ""}` } : undefined;
  return (
    <button type="button" className="d3-kho-note" onClick={onOpen} disabled={!first} data-bmq-note={line.receipt_number}>
      <span className="d3-kho-note-thumb">
        {extraCount ? <b className="d3-kho-note-more" aria-label={`${extraCount} ảnh thêm`}>+{extraCount}</b> : null}
        {first
          ? url.data ? <img src={url.data} alt={`Phiếu giao hàng ${line.receipt_number}`} loading="lazy" style={turn} /> : <i className="d3-kho-note-wait" aria-hidden="true" />
          : <span className="d3-kho-note-none"><ImageOff aria-hidden="true" />Chưa có ảnh</span>}
      </span>
      <span className="d3-kho-note-meta">
        <b>{line.receipt_number}</b>
        <small>{shortDate(line.receipt_date)} · {line.quantity > 0 ? `${fmtQty(line.quantity)} ${line.unit ?? ""}` : "chưa ghi số lượng"}</small>
        {line.unit_price !== null ? <small>{money(line.unit_price)}{line.unit ? `/${line.unit}` : ""}</small> : null}
      </span>
    </button>
  );
}

/** Full-screen delivery note: zoom in steps, scroll to pan, turn a sideways photo, step between receipts. */
function NoteViewer({ lines, index, onIndex, onClose }: { lines: ReceiptLine[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const line = lines[index];
  const photos = receiptPhotos(line.image_path, line.photo_paths);
  const [photoIndex, setPhotoIndex] = useState(0);
  const photoPath = photos[Math.min(photoIndex, photos.length - 1)]?.path ?? null;
  const url = useNoteUrl(photoPath);
  const [zoom, setZoom] = useState(1);
  const { data: rotation = 0 } = useImageRotation(photoPath);
  const setRotation = useSetImageRotation();
  const [rotateError, setRotateError] = useState<string | null>(null);
  useEffect(() => { setZoom(1); setRotateError(null); setPhotoIndex(0); }, [index]);
  useEffect(() => { setZoom(1); setRotateError(null); }, [photoIndex]);
  const rotate = () => {
    if (!photoPath) return;
    setRotateError(null);
    setRotation.mutate(
      { imagePath: photoPath, rotation: nextRotation(rotation) },
      { onError: (error) => setRotateError(imageRotationErrorText(imageRotationErrorCode(error))) },
    );
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" && index < lines.length - 1) onIndex(index + 1);
    if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
  };
  const qty = line.quantity > 0 ? `${fmtQty(line.quantity)} ${line.unit ?? ""}` : "chưa ghi số lượng";
  const price = line.quantity > 0 && line.unit_price !== null ? ` × ${money(line.unit_price)}`
    : line.unit_price !== null ? ` · đơn giá ${money(line.unit_price)}/${line.unit ?? ""}` : "";
  const total = line.quantity > 0 && line.line_total !== null ? ` = ${money(line.line_total)}` : "";

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="d3-kho-viewer-scrim" />
        <DialogPrimitive.Content className="d3-kho-viewer" onKeyDown={step} aria-describedby={undefined} data-bmq-note-viewer>
          <div className="d3-kho-viewer-bar">
            <DialogPrimitive.Title className="d3-kho-viewer-title">
              <b>{line.receipt_number}</b>
              <small>{shortDate(line.receipt_date)}{line.supplier_name ? ` · ${line.supplier_name}` : ""}</small>
            </DialogPrimitive.Title>
            <button type="button" className="d3-kho-icon" onClick={rotate} disabled={!url.data || setRotation.isPending} aria-label="Xoay ảnh" title="Xoay ảnh" data-bmq-rotate-image><RotateCw /></button>
            <button type="button" className="d3-kho-icon" onClick={() => setZoom((z) => Math.max(1, z - 1))} disabled={zoom === 1} aria-label="Thu nhỏ" title="Thu nhỏ"><Minus /></button>
            <button type="button" className="d3-kho-icon" onClick={() => setZoom((z) => Math.min(4, z + 1))} disabled={zoom === 4} aria-label="Phóng to" title="Phóng to"><Plus /></button>
            <DialogPrimitive.Close className="d3-kho-icon" aria-label="Đóng" title="Đóng"><X /></DialogPrimitive.Close>
          </div>
          {photos.length > 1 ? (
            <div className="d3-kho-viewer-photos" role="tablist" aria-label="Ảnh của phiếu">
              {photos.map((photo, i) => (
                <button key={photo.path} type="button" role="tab" aria-selected={i === photoIndex} className={cn(i === photoIndex && "is-on")} onClick={() => setPhotoIndex(i)}>
                  {photo.main ? "Phiếu" : `Ảnh ${i + 1}`}
                </button>
              ))}
            </div>
          ) : null}
          <div className="d3-kho-viewer-stage" onDoubleClick={() => setZoom((z) => (z >= 3 ? 1 : z + 1))}>
            {rotateError ? <p className="d3-kho-error" role="alert">{rotateError}</p> : null}
            {url.data
              ? <RotatedImage src={url.data} alt={`Phiếu giao hàng ${line.receipt_number}`} rotation={rotation} width={`${zoom * 100}%`} className="d3-kho-viewer-photo" />
              : <p className="d3-kho-viewer-empty">{photoPath ? "Đang tải ảnh…" : "Phiếu này chưa chụp ảnh giao hàng."}</p>}
          </div>
          <div className="d3-kho-viewer-foot">
            <p>“{line.raw_name}” · <b>{qty}</b>{price}{total}</p>
            <span className="d3-kho-viewer-nav">
              <button type="button" className="d3-kho-icon" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Phiếu trước"><ChevronLeft /></button>
              <small>{index + 1}/{lines.length}</small>
              <button type="button" className="d3-kho-icon" disabled={index === lines.length - 1} onClick={() => onIndex(index + 1)} aria-label="Phiếu sau"><ChevronRight /></button>
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Delivery notes for one name: one card per receipt line, tap to open the photo full screen.
 * `pinned` documents (e.g. the owner's stock-count file) lead the strip and share the viewer,
 * but are not counted as receipts.
 */
export function ReceiptNotes({ title, lines, loading, error, pinned = [] }: { title: string; lines: ReceiptLine[] | undefined; loading: boolean; error: unknown; pinned?: ReceiptLine[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const receipts = lines ?? [];
  const list = [...pinned, ...receipts];
  const withPhoto = receipts.filter((line) => receiptPhotos(line.image_path, line.photo_paths).length > 0).length;
  return (
    <section className="d3-kho-notes" data-bmq-receipt-notes>
      <div className="d3-kho-notes-h">
        <h3>{title}</h3>
        <small>{loading ? "Đang tải…" : `${receipts.length} lần nhập · ${withPhoto} có ảnh`}</small>
      </div>
      {error ? <p className="d3-kho-error">Chưa tải được phiếu nhập.</p> : null}
      {!loading && !error && receipts.length === 0 && pinned.length === 0 ? <p className="d3-kho-quiet">Chưa có phiếu nhập nào.</p> : null}
      {loading && !list.length ? (
        <div className="d3-kho-notes-row" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="d3-kho-note is-ghost" />)}</div>
      ) : list.length ? (
        <div className="d3-kho-notes-row">{list.map((line, i) => <Thumb key={line.goods_receipt_item_id} line={line} onOpen={() => setOpen(i)} />)}</div>
      ) : null}
      {open !== null && list[open] ? <NoteViewer lines={list} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}
