import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useFoodManufacturers, useManufacturerSuggest, useScanLotLabel, useSetReceiptLineLot } from "@/hooks/useKhoLots";
import { daysLeft, expiryTone } from "@/lib/kho-lots";
import { cn } from "@/lib/utils";

/** The lot fields a goods-receipt line carries (owner 23/10, traceability GĐ1). */
export interface LotLine {
  id: string;
  product_name?: string | null;
  manufacture_date?: string | null;
  expiry_date?: string | null;
  manufacturer_lot?: string | null;
  manufacturer_id?: string | null;
}

const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");

/** Downscale a phone photo to a JPEG the OCR accepts quickly (longest side 1600 px). */
async function photoToBase64(file: File): Promise<{ base64: string; mime: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Không đọc được ảnh."));
      el.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { base64: dataUrl.split(",")[1] ?? "", mime: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ExpiryChip({ iso }: { iso?: string | null }) {
  const tone = expiryTone(iso ?? null);
  if (!iso || !tone) return null;
  const d = daysLeft(iso);
  const text = tone === "expired" ? "Quá hạn" : tone === "soon" ? `Còn ${d} ngày` : null;
  return text ? (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", tone === "expired" ? "bg-destructive/10 text-destructive" : "bg-amber-100 text-amber-800")} data-bmq-lot-tone={tone}>
      {text}
    </span>
  ) : null;
}

/**
 * NSX · HSD · lot · manufacturer for one receipt line, with an inline editor:
 * "Chụp nhãn" reads the package label (Indra OCR, DeepSeek fallback) and fills
 * the fields; the manufacturer is remembered per item and suggested next time.
 */
export function LotInfo({ line, canEdit }: { line: LotLine; canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [nsx, setNsx] = useState(line.manufacture_date ?? "");
  const [hsd, setHsd] = useState(line.expiry_date?.slice(0, 10) ?? "");
  const [lot, setLot] = useState(line.manufacturer_lot ?? "");
  const [maker, setMaker] = useState("");
  const [evidence, setEvidence] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const makers = useFoodManufacturers();
  const suggest = useManufacturerSuggest(open ? line.id : null);
  const scan = useScanLotLabel();
  const save = useSetReceiptLineLot();
  const makerName = makers.data?.find((m) => m.id === line.manufacturer_id)?.name ?? null;

  useEffect(() => {
    if (!open) return;
    setNsx(line.manufacture_date ?? "");
    setHsd(line.expiry_date?.slice(0, 10) ?? "");
    setLot(line.manufacturer_lot ?? "");
    setMaker(makerName ?? "");
    setEvidence(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset each time the editor opens
  }, [open]);
  useEffect(() => {
    if (open && !maker && suggest.data?.name) setMaker(suggest.data.name);
  }, [open, maker, suggest.data?.name]);

  const readLabel = async (file: File) => {
    try {
      const { base64, mime } = await photoToBase64(file);
      const r = await scan.mutateAsync({ imageBase64: base64, mimeType: mime });
      if (r.manufacture_date) setNsx(r.manufacture_date);
      if (r.expiry_date) setHsd(r.expiry_date);
      if (r.lot) setLot(r.lot);
      if (r.manufacturer) setMaker(r.manufacturer);
      const found = [r.manufacture_date && "NSX", r.expiry_date && "HSD", r.lot && "mã lô", r.manufacturer && "nhà sản xuất"].filter(Boolean);
      setEvidence(found.length ? `Đọc được ${found.join(", ")} từ nhãn. Kiểm tra lại trước khi lưu.` : "Không đọc được thông tin trên nhãn, anh/chị gõ tay giúp.");
    } catch {
      setEvidence("Chưa đọc được ảnh nhãn, anh/chị thử ảnh rõ hơn hoặc gõ tay.");
    }
  };
  const badDates = Boolean(nsx && hsd && hsd < nsx);
  const submit = () => {
    if (badDates) return;
    save.mutate({ receiptItemId: line.id, manufactureDate: nsx || null, expiryDate: hsd || null, lot: lot.trim() || null, manufacturerName: maker.trim() || null }, {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: ["goods-receipt-items"] });
        toast({ title: "Đã lưu lô & hạn dùng" });
        setOpen(false);
      },
      onError: () => toast({ title: "Chưa lưu được lô & hạn dùng", description: "Anh/chị thử lại giúp.", variant: "destructive" }),
    });
  };

  const parts = [
    line.manufacture_date ? `NSX ${dmy(line.manufacture_date)}` : null,
    line.expiry_date ? `HSD ${dmy(line.expiry_date)}` : null,
    line.manufacturer_lot ? `Lô ${line.manufacturer_lot}` : null,
    makerName,
  ].filter(Boolean);

  return (
    <div className="mt-2 rounded-xl border border-dashed border-border px-3 py-2" data-bmq-lot-info={line.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Lô & hạn</span>
          {parts.length ? <span className="min-w-0 break-words">{parts.join(" · ")}</span> : <span>chưa có NSX / HSD / mã lô</span>}
          <ExpiryChip iso={line.expiry_date} />
        </div>
        {canEdit && !open ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOpen(true)} data-bmq-lot-edit>
            <PencilLine className="mr-1 h-3.5 w-3.5" />{parts.length ? "Sửa" : "Nhập"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 grid gap-2" data-bmq-lot-editor>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readLabel(f); }} data-bmq-lot-photo />
          <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={scan.isPending} onClick={() => fileRef.current?.click()} data-bmq-lot-scan>
            {scan.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Camera className="mr-1.5 h-4 w-4" />}
            {scan.isPending ? "Đang đọc nhãn…" : "Chụp nhãn bao bì"}
          </Button>
          {evidence ? <p className="text-xs text-muted-foreground" data-bmq-lot-evidence>{evidence}</p> : null}
          <div className="grid grid-cols-1 gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground">NSX
              <Input type="date" value={nsx} onChange={(e) => setNsx(e.target.value)} className="h-9 min-w-0" data-bmq-lot-nsx />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">HSD
              <Input type="date" value={hsd} onChange={(e) => setHsd(e.target.value)} className="h-9 min-w-0" data-bmq-lot-hsd />
            </label>
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">Mã lô nhà sản xuất
            <Input value={lot} onChange={(e) => setLot(e.target.value)} maxLength={60} placeholder="Ví dụ: M829092026" className="h-9" data-bmq-lot-code />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">Nhà sản xuất
            <Input value={maker} onChange={(e) => setMaker(e.target.value)} list={`makers-${line.id}`} maxLength={160} placeholder="Ví dụ: Cty TNHH Interflour Vietnam" className="h-9" data-bmq-lot-maker />
            <datalist id={`makers-${line.id}`}>{(makers.data ?? []).map((m) => <option key={m.id} value={m.name} />)}</datalist>
          </label>
          {badDates ? <p className="text-xs text-destructive">HSD phải sau NSX.</p> : null}
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={save.isPending || badDates} onClick={submit} data-bmq-lot-save>{save.isPending ? "Đang lưu…" : "Lưu lô & hạn"}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Thôi</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
