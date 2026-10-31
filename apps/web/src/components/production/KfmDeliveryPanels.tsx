import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  useDispatchReportPhotos,
  useSaveDispatchReport,
  useKfmDailyDeliveryReport,
  useKfmDeliveryVsPo,
  useSetKfmDeliveredQty,
} from "@/hooks/useKfmDelivery";
import { deliveryRatioBand, jevKindLabel, monthRange, type KfmDeliveryRow, type KfmDispatchPhoto } from "@/lib/kfm-delivery";
import { cn } from "@/lib/utils";
import "@/styles/bmq-kfm-delivery.css";

/*
 * KFM delivery vs PO (owner 31/10): the warehouse confirms each day's delivered quantity
 * (100% unless changed) and attaches the dispatch report photo; the dashboard compares
 * delivered with ordered, month by month.
 */

const num = (value: number) => value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
const pct = (ratio: number | null) => (ratio === null ? "—" : `${(ratio * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`);
const signed = (value: number) => (value > 0 ? `+${num(value)}` : value < 0 ? `−${num(-value)}` : "0");
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const MONTH_VI = (iso: string) => `Tháng ${Number(iso.slice(5, 7))}/${iso.slice(0, 4)}`;

function shiftMonth(iso: string, delta: number) {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7)) - 1 + delta;
  const d = new Date(Date.UTC(year, month, 1));
  return d.toISOString().slice(0, 10);
}

function Ratio({ ratio }: { ratio: number | null }) {
  const band = deliveryRatioBand(ratio);
  const width = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <span className={cn("kd-ratio", `is-${band}`)}>
      <span className="kd-ratio-bar" aria-hidden="true"><i style={{ width: `${width}%` }} /></span>
      <b>{pct(ratio)}</b>
    </span>
  );
}

/** Key figure for the top of Sản xuất: this month's delivered share of KFM POs. */
export function KfmDeliveryKpi({ todayIso }: { todayIso: string }) {
  // Early in a month nothing is confirmed yet: the figure then shows last month, labelled as such.
  const thisRange = useMemo(() => monthRange(todayIso), [todayIso]);
  const lastRange = useMemo(() => monthRange(shiftMonth(`${todayIso.slice(0, 7)}-01`, -1)), [todayIso]);
  const thisQuery = useKfmDeliveryVsPo(thisRange.from, thisRange.to);
  const useLast = Boolean(thisQuery.data && thisQuery.data.totals.confirmedCount === 0);
  const lastQuery = useKfmDeliveryVsPo(useLast ? lastRange.from : null, useLast ? lastRange.to : null);
  const range = useLast ? lastRange : thisRange;
  const query = useLast ? lastQuery : thisQuery;
  const t = query.data?.totals;
  const band = deliveryRatioBand(t?.ratio ?? null);
  const pending = t ? t.poCount - t.confirmedCount : 0;
  return (
    <article className={cn("pp-kpi", `is-${band}`)} data-pp-kpi="delivery">
      <h2>Giao đạt so với PO · {MONTH_VI(range.from).replace("Tháng ", "T")}</h2>
      <p className="pp-kpi-num" data-bmq-kfm-delivery-ratio>{query.isLoading ? "…" : t?.poCount ? pct(t.ratio) : "—"}</p>
      <p className="pp-kpi-sub">
        {t?.poCount ? `${num(t.deliveredQty)}/${num(t.poQty)} · ${t.poCount} PO` : query.error ? "Không đọc được số giao" : "Chưa có PO trong tháng"}
      </p>
      {t?.poCount ? (
        <p className={cn("pp-kpi-flag", t.shortfall < 0 ? "is-bad" : "is-ok")}>
          {t.shortfall < 0 ? `Thiếu ${num(-t.shortfall)} · ${t.under95Count} PO dưới 95%` : "Giao đủ"}
          {pending > 0 ? ` · ${pending} tạm tính` : ""}
        </p>
      ) : null}
    </article>
  );
}

/** Delivered vs ordered per PO for one month. Closed by default: the table renders only when asked for. */
export function KfmDeliveryVsPoCard({ todayIso }: { todayIso: string }) {
  const [month, setMonth] = useState(() => `${todayIso.slice(0, 7)}-01`);
  const [shortOnly, setShortOnly] = useState(false);
  const [open, setOpen] = useState(false);
  const range = useMemo(() => monthRange(month), [month]);
  const query = useKfmDeliveryVsPo(range.from, range.to);
  const data = query.data;
  const rows = useMemo(() => (data?.rows ?? []).filter((row) => !shortOnly || row.shortfall < 0), [data, shortOnly]);
  const t = data?.totals;
  const thisMonth = month.slice(0, 7) === todayIso.slice(0, 7);

  return (
    <section className="d3-pp-card kd-card" data-bmq-kfm-delivery-card>
      <div className="d3-pp-card-h">
        <h2>Giao hàng theo PO</h2>
        <div className="kd-month" role="group" aria-label="Chọn tháng">
          <button type="button" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Tháng trước"><ChevronLeft /></button>
          <span data-bmq-kfm-delivery-month>{MONTH_VI(month)}</span>
          <button type="button" onClick={() => setMonth(shiftMonth(month, 1))} disabled={thisMonth} aria-label="Tháng sau"><ChevronRight /></button>
        </div>
      </div>

      {query.isLoading ? (
        <p className="kd-quiet">Đang tải…</p>
      ) : query.error ? (
        <p className="kd-quiet">Không đọc được số liệu giao hàng.</p>
      ) : !t || !t.poCount ? (
        <p className="kd-quiet">Chưa có PO KFM trong tháng này.</p>
      ) : !open ? (
        <div className="kd-fold">
          <p>
            <b>{t.poCount} PO</b> · giao <b>{num(t.deliveredQty)}</b>/{num(t.poQty)}
            {t.shortfall < 0 ? <> · <span className="is-bad">thiếu {num(-t.shortfall)}</span></> : null}
            {t.under95Count ? <> · {t.under95Count} PO dưới 95%</> : null}
          </p>
          <button type="button" className="kd-open" onClick={() => setOpen(true)} data-bmq-kfm-delivery-open>Xem chi tiết</button>
        </div>
      ) : (
        <>
          <p className="kd-note">
            {t.confirmedCount}/{t.poCount} PO đã có số giao thực tế. PO còn lại tạm tính 100% cho đến khi kho xác nhận.
          </p>

          <div className="kd-tools">
            <button type="button" className="kd-chip" onClick={() => setOpen(false)} data-bmq-kfm-delivery-close>Thu gọn</button>
            <button type="button" className={cn("kd-chip", shortOnly && "is-on")} aria-pressed={shortOnly} onClick={() => setShortOnly((v) => !v)} data-bmq-kfm-delivery-short-only>
              Chỉ PO thiếu
            </button>
          </div>

          <div className="kd-table-wrap">
            <table className="kd-table" data-bmq-kfm-delivery-table>
              <thead>
                <tr>
                  <th scope="col">Ngày giao</th>
                  <th scope="col">Mã PO</th>
                  <th scope="col" className="is-num">SL PO</th>
                  <th scope="col" className="is-num">SL giao</th>
                  <th scope="col" className="is-num">CL</th>
                  <th scope="col" className="is-ratio">Tỷ lệ giao</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.poNumber} className={cn(row.isDefault && "is-default")} data-bmq-kfm-delivery-row={row.poNumber}>
                    <td className="is-date">{ddmm(row.deliveryDate)}</td>
                    <td className="is-po">
                      <span>{row.poNumber}</span>
                      {row.isDefault ? <small>tạm tính</small> : row.source === "ke_toan" ? <small>kế toán</small> : <small>kho</small>}
                    </td>
                    <td className="is-num" data-label="SL PO">{num(row.poQty)}</td>
                    <td className="is-num is-strong" data-label="SL giao">{num(row.deliveredQty)}</td>
                    <td className={cn("is-num", row.shortfall < 0 && "is-bad")} data-label="CL">{signed(row.shortfall)}</td>
                    <td className="is-ratio" data-label="Tỷ lệ"><Ratio ratio={row.ratio} /></td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr><td colSpan={6} className="kd-empty">Không có PO thiếu trong tháng.</td></tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2}>Tổng {t.poCount} PO</th>
                  <td className="is-num" data-label="SL PO">{num(t.poQty)}</td>
                  <td className="is-num is-strong" data-label="SL giao">{num(t.deliveredQty)}</td>
                  <td className={cn("is-num", t.shortfall < 0 && "is-bad")} data-label="CL">{signed(t.shortfall)}</td>
                  <td className="is-ratio" data-label="Tỷ lệ"><Ratio ratio={t.ratio} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function DeliveryLine({ row, canEdit }: { row: KfmDeliveryRow; canEdit: boolean }) {
  const save = useSetKfmDeliveredQty();
  const [text, setText] = useState(num(row.deliveredQty));
  const [note, setNote] = useState(row.note ?? "");
  useEffect(() => { setText(num(row.deliveredQty)); setNote(row.note ?? ""); }, [row.deliveredQty, row.note]);
  const value = Number(text.replace(/\./g, "").replace(",", "."));
  const bad = !Number.isFinite(value) || value < 0 || value > row.poQty * 2;
  const changed = !bad && (value !== row.deliveredQty || (note.trim() || null) !== (row.note || null));
  const short = !bad && value < row.poQty;
  const commit = () => {
    if (!changed || bad) return;
    save.mutate({ poNumber: row.poNumber, deliveredQty: value, note: note.trim() || null }, {
      onSuccess: () => toast.success(`Đã lưu SL giao ${row.poNumber}`),
      onError: (error) => toast.error((error as { code?: string }).code === "42501" ? "Chỉ người có quyền sửa kho mới đổi được SL giao." : "Chưa lưu được SL giao. Thử lại."),
    });
  };
  const ratio = row.poQty > 0 && !bad ? value / row.poQty : null;

  return (
    <li className={cn("kd-line", short && "is-short")} data-bmq-kfm-daily-line={row.poNumber}>
      <div className="kd-line-main">
        <b>{row.poNumber}</b>
        <small>SL PO {num(row.poQty)} · {row.isDefault ? "mặc định 100%" : row.source === "ke_toan" ? "số kế toán" : "kho đã xác nhận"}</small>
      </div>
      <div className="kd-line-qty">
        <Input inputMode="decimal" value={text} disabled={!canEdit || save.isPending} onChange={(e) => setText(e.target.value)}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          aria-label={`SL giao thực tế ${row.poNumber}`} aria-invalid={bad || undefined} data-bmq-kfm-daily-qty={row.poNumber}
          style={{ ["--ch" as string]: Math.max(4, text.length) }} />
        <Ratio ratio={ratio} />
      </div>
      {short || row.note ? (
        <Input className="kd-line-note" value={note} disabled={!canEdit || save.isPending} onChange={(e) => setNote(e.target.value)} onBlur={commit}
          maxLength={500} placeholder="Lý do giao thiếu" aria-label={`Lý do giao thiếu ${row.poNumber}`} data-bmq-kfm-daily-note={row.poNumber} />
      ) : null}
    </li>
  );
}

/**
 * Shrink one photo on the device before upload (owner 01/11): long side 1600 px, JPEG 0.76.
 * Text on a dispatch slip stays sharp enough for OCR while a 4 MB phone shot becomes ~300 KB.
 */
const PHOTO_MAX_SIDE = 1600;
const PHOTO_QUALITY = 0.76;
type StagedPhoto = { key: string; file: File; url: string; width: number; height: number; before: number };

async function compressPhoto(file: File): Promise<StagedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas_unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    canvas.width = canvas.height = 1;
    if (!blob) throw new Error("encode_failed");
    const out = blob.size < file.size ? new File([blob], "xuat-kho.jpg", { type: "image/jpeg" }) : file;
    return { key: crypto.randomUUID(), file: out, url: URL.createObjectURL(out), width, height, before: file.size };
  } finally {
    bitmap.close();
  }
}

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} MB` : `${Math.round(bytes / 1024)} KB`);

function JevChip({ photo }: { photo: KfmDispatchPhoto }) {
  if (!photo.savedAt) return <span className="kd-jev is-wait">Chưa lưu</span>;
  if (photo.jevStatus === "done") {
    return (
      <span className={cn("kd-jev", photo.jevMismatch ? "is-bad" : "is-ok")} title={photo.jevSummary ?? undefined}>
        {jevKindLabel(photo.jevKind) || "Đã đọc"}{photo.jevMismatch ? " · lệch SL" : ""}
      </span>
    );
  }
  if (photo.jevStatus === "failed") return <span className="kd-jev is-bad">Jev chưa đọc được</span>;
  if (photo.jevStatus === "skipped") return <span className="kd-jev is-wait">Đã lưu</span>;
  return <span className="kd-jev is-wait">Jev đang đọc…</span>;
}

function PhotoThumb({ photo, canEdit, onRemove }: { photo: KfmDispatchPhoto; canEdit: boolean; onRemove: () => void }) {
  const { getDispatchReportPhotoUrl } = useDispatchReportPhotos();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getDispatchReportPhotoUrl(photo.storagePath).then((u) => { if (live) setUrl(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [photo.storagePath, getDispatchReportPhotoUrl]);
  return (
    <li className="kd-photo">
      <a href={url ?? undefined} target="_blank" rel="noreferrer" aria-label="Mở ảnh báo cáo xuất kho">
        {url ? <img src={url} alt="Ảnh báo cáo xuất kho" loading="lazy" /> : <span className="kd-photo-wait" />}
      </a>
      {canEdit ? (
        <button type="button" onClick={onRemove} aria-label="Xoá ảnh"><X /></button>
      ) : null}
      <JevChip photo={photo} />
    </li>
  );
}

/** End-of-day production report: the day's KFM POs with delivered quantity, then the dispatch photos. */
export function KfmDailyDeliveryReport({ todayIso, canEdit }: { todayIso: string; canEdit: boolean }) {
  const [date, setDate] = useState(todayIso);
  const report = useKfmDailyDeliveryReport(date);
  const photos = useDispatchReportPhotos();
  const saveReport = useSaveDispatchReport();
  const [staged, setStaged] = useState<StagedPhoto[]>([]);
  const [busy, setBusy] = useState<"" | "compress" | "save">("");
  const fileRef = useRef<HTMLInputElement>(null);
  const data = report.data;
  const unsaved = (data?.photos ?? []).filter((photo) => !photo.savedAt);
  useEffect(() => () => staged.forEach((item) => URL.revokeObjectURL(item.url)), [staged]);
  useEffect(() => { setStaged([]); }, [date]);

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy("compress");
    const next: StagedPhoto[] = [];
    for (const file of Array.from(files).slice(0, 10 - staged.length)) {
      if (!file.type.startsWith("image/")) continue;
      try { next.push(await compressPhoto(file)); } catch { toast.error(`${file.name} chưa đọc được ảnh`); }
    }
    setStaged((prev) => [...prev, ...next]);
    setBusy("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const save = async () => {
    if (!staged.length && !unsaved.length) return;
    setBusy("save");
    try {
      const ids = unsaved.map((photo) => photo.id);
      for (const item of staged) {
        const photo = await photos.uploadDispatchReportPhoto(date, item.file, { sizeBytes: item.file.size, width: item.width, height: item.height });
        ids.push(photo.id);
      }
      setStaged([]);
      const result = await saveReport.mutateAsync({ date, photoIds: ids.slice(0, 10) });
      await report.refetch();
      const mismatch = result.results.filter((r) => r.mismatch).length;
      toast.success(mismatch ? `Đã lưu ${result.saved.length} ảnh · ${mismatch} ảnh lệch SL giao` : `Đã lưu ${result.saved.length} ảnh, Jev đã phân loại`);
    } catch {
      await report.refetch();
      toast.error("Chưa lưu xong ảnh. Bấm Lưu lại.");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="d3-pp-card kd-day" data-bmq-kfm-daily-report>
      <div className="d3-pp-card-h">
        <h2>Báo cáo cuối ngày</h2>
        <input type="date" className="kd-date" value={date} max={todayIso} onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label="Ngày giao" data-bmq-kfm-daily-date />
      </div>

      <h3 className="kd-sub">SL giao thực tế</h3>
      {report.isLoading ? (
        <p className="kd-quiet">Đang tải…</p>
      ) : report.error ? (
        <p className="kd-quiet">Không đọc được báo cáo ngày này.</p>
      ) : !data?.pos.length ? (
        <p className="kd-quiet">Không có PO KFM giao ngày {ddmm(date)}.</p>
      ) : (
        <ul className="kd-lines">
          {data.pos.map((row) => <DeliveryLine key={row.poNumber} row={row} canEdit={canEdit} />)}
        </ul>
      )}
      {!canEdit && data?.pos.length ? <p className="kd-note">Chỉ người có quyền sửa kho mới đổi được SL giao.</p> : null}

      <h3 className="kd-sub">Ảnh báo cáo xuất kho</h3>
      <ul className="kd-photos" data-bmq-kfm-daily-photos>
        {(data?.photos ?? []).map((photo) => (
          <PhotoThumb key={photo.id} photo={photo} canEdit={canEdit} onRemove={() => {
            photos.removeDispatchReportPhoto(photo).then(() => report.refetch()).catch(() => toast.error("Chưa xoá được ảnh."));
          }} />
        ))}
        {staged.map((item) => (
          <li key={item.key} className="kd-photo is-staged" data-bmq-kfm-daily-staged>
            <img src={item.url} alt="Ảnh chờ lưu" />
            <button type="button" onClick={() => setStaged((prev) => prev.filter((p) => p.key !== item.key))} aria-label="Bỏ ảnh"><X /></button>
            <span className="kd-jev is-wait">{kb(item.file.size)}</span>
          </li>
        ))}
        {canEdit && staged.length + (data?.photos.length ?? 0) < 10 ? (
          <li>
            <button type="button" className="kd-photo-add" onClick={() => fileRef.current?.click()} disabled={busy !== ""} data-bmq-kfm-daily-photo-add>
              {busy === "compress" ? <Loader2 className="animate-spin" /> : <Camera />}
              <span>{busy === "compress" ? "Đang nén" : "Thêm ảnh"}</span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void pick(e.target.files)} />
          </li>
        ) : null}
      </ul>
      {canEdit && (staged.length || unsaved.length) ? (
        <div className="kd-save">
          <span>
            {staged.length ? `${staged.length} ảnh mới · ${kb(staged.reduce((n, i) => n + i.file.size, 0))}` : ""}
            {staged.length && staged.some((i) => i.before > i.file.size) ? ` (gốc ${kb(staged.reduce((n, i) => n + i.before, 0))})` : ""}
            {unsaved.length ? `${staged.length ? " · " : ""}${unsaved.length} ảnh chưa lưu` : ""}
          </span>
          <button type="button" className="kd-open" onClick={() => void save()} disabled={busy !== ""} data-bmq-kfm-daily-save>
            {busy === "save" ? "Đang lưu…" : "Lưu"}
          </button>
        </div>
      ) : null}
      {!canEdit && !(data?.photos ?? []).length ? <p className="kd-quiet">Chưa có ảnh.</p> : null}
    </section>
  );
}
