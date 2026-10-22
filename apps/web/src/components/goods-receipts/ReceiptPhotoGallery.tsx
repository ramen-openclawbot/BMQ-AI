import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Loader2, RotateCw, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RotatedImage } from "@/components/RotatedImage";
import { supabase } from "@/integrations/supabase/client";
import { getGoodsReceiptImageUrl, uploadDeliveryNoteImage } from "@/hooks/useGoodsReceipts";
import { useImageRotation, useSetImageRotation } from "@/hooks/useImageRotation";
import { imageRotationErrorCode, imageRotationErrorText, nextRotation } from "@/lib/image-rotation";
import { appendExtraPhotos, receiptPhotos, removeExtraPhoto, type ReceiptPhoto } from "@/lib/receipt-photos";
import { LoadingState } from "@/components/ui/loading";

function usePhotoUrl(path: string | null) {
  return useQuery({
    queryKey: ["goods-receipt-image", path],
    enabled: Boolean(path),
    staleTime: 50 * 60 * 1000,
    queryFn: async () => (path ? (await getGoodsReceiptImageUrl(path)) || null : null),
  });
}

/** Reads the receipt's photo columns fresh, so two people adding photos do not drop each other's. */
async function freshPhotoColumns(receiptId: string) {
  const { data, error } = await supabase.from("goods_receipts").select("image_url, product_photos").eq("id", receiptId).single();
  if (error) throw error;
  return data as { image_url: string | null; product_photos: string[] | null };
}

/**
 * Upload photos and attach them: extras append to `product_photos`; when the receipt has no main photo
 * yet, the first upload becomes it (so a receipt confirmed without a photo can still get its evidence).
 */
export async function addReceiptPhotos(receiptId: string, files: File[]): Promise<number> {
  const uploaded: string[] = [];
  for (const file of files) uploaded.push(await uploadDeliveryNoteImage(file, receiptId));
  if (!uploaded.length) return 0;
  const fresh = await freshPhotoColumns(receiptId);
  const main = fresh.image_url?.trim() ? fresh.image_url : uploaded[0];
  const { error } = await supabase
    .from("goods_receipts")
    .update({ image_url: main, product_photos: appendExtraPhotos(main, fresh.product_photos, uploaded) })
    .eq("id", receiptId);
  if (error) throw error;
  return uploaded.length;
}

function Thumb({ photo, index, onOpen }: { photo: ReceiptPhoto; index: number; onOpen: () => void }) {
  const url = usePhotoUrl(photo.path);
  const { data: rotation = 0 } = useImageRotation(photo.path);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative flex h-28 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/40 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-32 sm:w-28"
      aria-label={photo.main ? "Xem ảnh phiếu chính" : `Xem ảnh ${index + 1}`}
      data-bmq-receipt-photo={photo.main ? "main" : "extra"}
    >
      {url.data ? (
        <img
          src={url.data}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          style={rotation ? { transform: `rotate(${rotation}deg)${rotation % 180 ? " scale(1.3)" : ""}` } : undefined}
        />
      ) : (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}
      <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
        {photo.main ? "Phiếu" : index + 1}
      </span>
    </button>
  );
}

function Viewer({ receiptId, photos, index, onIndex, onClose }: {
  receiptId: string;
  photos: ReceiptPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const photo = photos[index];
  const queryClient = useQueryClient();
  const url = usePhotoUrl(photo?.path ?? null);
  const { data: rotation = 0 } = useImageRotation(photo?.path);
  const setRotation = useSetImageRotation();
  const [removing, setRemoving] = useState(false);
  if (!photo) return null;

  const rotate = () => setRotation.mutate(
    { imagePath: photo.path, rotation: nextRotation(rotation) },
    { onError: (error) => toast.error(imageRotationErrorText(imageRotationErrorCode(error))) },
  );
  const remove = async () => {
    if (photo.main || !window.confirm("Xoá ảnh này khỏi phiếu nhập?")) return;
    setRemoving(true);
    try {
      const fresh = await freshPhotoColumns(receiptId);
      const { error } = await supabase
        .from("goods_receipts")
        .update({ product_photos: removeExtraPhoto(fresh.image_url, fresh.product_photos, photo.path) })
        .eq("id", receiptId);
      if (error) throw error;
      await queryClient.invalidateQueries({ queryKey: ["goods-receipt", receiptId] });
      toast.success("Đã xoá ảnh");
      if (photos.length <= 1) onClose();
      else if (index === photos.length - 1) onIndex(index - 1);
    } catch {
      toast.error("Chưa xoá được ảnh");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3" data-bmq-receipt-photo-viewer>
      <p className="text-sm text-muted-foreground">
        {photo.main ? "Ảnh phiếu chính" : `Ảnh ${index + 1}`} · {index + 1}/{photos.length}
      </p>
      <div className="flex w-full items-center justify-center gap-2">
        {photos.length > 1 ? (
          <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={index === 0} onClick={() => onIndex(index - 1)} aria-label="Ảnh trước">
            <ChevronLeft className="h-5 w-5" />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 justify-center">
          {url.data ? (
            <RotatedImage src={url.data} alt={photo.main ? "Ảnh phiếu chính" : `Ảnh ${index + 1}`} rotation={rotation} maxHeight="65vh" className="max-h-[65vh] max-w-full rounded-lg object-contain" />
          ) : (
            <LoadingState variant="loaf" flat label="Đang tải ảnh…" className="my-6" />
          )}
        </div>
        {photos.length > 1 ? (
          <Button type="button" variant="ghost" size="icon" className="shrink-0" disabled={index === photos.length - 1} onClick={() => onIndex(index + 1)} aria-label="Ảnh sau">
            <ChevronRight className="h-5 w-5" />
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" onClick={rotate} disabled={setRotation.isPending || !url.data} data-bmq-rotate-image>
          {setRotation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCw className="mr-2 h-4 w-4" />}
          Xoay
        </Button>
        {url.data ? (
          <Button variant="outline" asChild>
            <a href={url.data} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Mở tab mới
            </a>
          </Button>
        ) : null}
        {!photo.main ? (
          <Button type="button" variant="outline" className="text-destructive hover:text-destructive" onClick={remove} disabled={removing} data-bmq-receipt-photo-remove>
            {removing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
            Xoá ảnh
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * All photos of a goods receipt: the main delivery note plus extras, a viewer with ← → / Xoay / Xoá,
 * and "＋ Thêm ảnh" (several at once, also after the receipt is confirmed).
 */
export function ReceiptPhotoGallery({ receiptId, imageUrl, extras, canAdd = true }: {
  receiptId: string;
  imageUrl: string | null | undefined;
  extras: string[] | null | undefined;
  canAdd?: boolean;
}) {
  const queryClient = useQueryClient();
  const photos = receiptPhotos(imageUrl, extras);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setOpen(null), [receiptId]);

  const add = async (files: File[]) => {
    if (!files.length) return;
    setAdding(true);
    try {
      const count = await addReceiptPhotos(receiptId, files);
      await queryClient.invalidateQueries({ queryKey: ["goods-receipt", receiptId] });
      toast.success(`Đã thêm ${count} ảnh`);
    } catch {
      toast.error("Chưa thêm được ảnh, thử lại");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div data-bmq-receipt-photos>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {photos.map((photo, i) => <Thumb key={photo.path} photo={photo} index={i} onOpen={() => setOpen(i)} />)}
        {canAdd ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={adding}
            className="flex h-28 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-primary/40 bg-primary/5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-60 sm:h-32 sm:w-28"
            data-bmq-receipt-photo-add
          >
            {adding ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
            {adding ? "Đang tải…" : "Thêm ảnh"}
          </button>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          /* No `capture`: on iPhone it forces the camera and hides the photo library. */
          className="sr-only"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void add(files);
          }}
        />
      </div>
      <Dialog open={open !== null} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Ảnh/chứng từ phiếu nhập kho</DialogTitle>
          </DialogHeader>
          {open !== null ? (
            <Viewer receiptId={receiptId} photos={photos} index={Math.min(open, photos.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
