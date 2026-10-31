import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  useDispatchReportPhotos,
  useKfmDailyDeliveryReport,
  useKfmDeliveryVsPo,
  useSetKfmDeliveredQty,
} from "@/hooks/useKfmDelivery";
import { deliveryRatioBand, monthRange, type KfmDeliveryRow, type KfmDispatchPhoto } from "@/lib/kfm-delivery";
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

/** Dashboard: delivered vs ordered for one month, KPIs on top, one row per PO below. */
export function KfmDeliveryVsPoCard({ todayIso }: { todayIso: string }) {
  const [month, setMonth] = useState(() => `${todayIso.slice(0, 7)}-01`);
  const [shortOnly, setShortOnly] = useState(false);
  const range = useMemo(() => monthRange(month), [month]);
  const query = useKfmDeliveryVsPo(range.from, range.to);
  const data = query.data;
  const rows = useMemo(() => (data?.rows ?? []).filter((row) => !shortOnly || row.shortfall < 0), [data, shortOnly]);
  const t = data?.totals;
  const thisMonth = month.slice(0, 7) === todayIso.slice(0, 7);

  return (
    <section className="d3-pp-card kd-card" data-bmq-kfm-delivery-card>
      <div className="d3-pp-card-h">
        <h2>Giao hàng so với PO</h2>
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
      ) : (
        <>
          <dl className="kd-kpis">
            <div className={cn("kd-kpi is-lead", `is-${deliveryRatioBand(t.ratio)}`)}>
              <dt>Tỷ lệ giao</dt>
              <dd data-bmq-kfm-delivery-ratio>{pct(t.ratio)}</dd>
            </div>
            <div className="kd-kpi"><dt>SL PO</dt><dd>{num(t.poQty)}</dd></div>
            <div className="kd-kpi"><dt>SL giao</dt><dd>{num(t.deliveredQty)}</dd></div>
            <div className={cn("kd-kpi", t.shortfall < 0 && "is-bad")}><dt>Chênh lệch</dt><dd data-bmq-kfm-delivery-short>{signed(t.shortfall)}</dd></div>
            <div className={cn("kd-kpi", t.under95Count > 0 && "is-bad")}><dt>PO dưới 95%</dt><dd>{t.under95Count}/{t.poCount}</dd></div>
          </dl>
          <p className="kd-note">
            {t.confirmedCount}/{t.poCount} PO đã có số giao thực tế. PO còn lại tạm tính 100% cho đến khi kho xác nhận.
          </p>

          <div className="kd-tools">
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
    </li>
  );
}

/** End-of-day production report: the day's KFM POs with delivered quantity, then the dispatch photos. */
export function KfmDailyDeliveryReport({ todayIso, canEdit }: { todayIso: string; canEdit: boolean }) {
  const [date, setDate] = useState(todayIso);
  const report = useKfmDailyDeliveryReport(date);
  const photos = useDispatchReportPhotos();
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const data = report.data;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) { toast.error(`${file.name} lớn hơn 10 MB`); continue; }
        await photos.uploadDispatchReportPhoto(date, file);
      }
      await report.refetch();
      toast.success("Đã tải ảnh báo cáo xuất kho");
    } catch {
      toast.error("Chưa tải được ảnh. Thử lại.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
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
        {canEdit ? (
          <li>
            <button type="button" className="kd-photo-add" onClick={() => fileRef.current?.click()} disabled={uploading} data-bmq-kfm-daily-photo-add>
              {uploading ? <Loader2 className="animate-spin" /> : <Camera />}
              <span>{uploading ? "Đang tải" : "Thêm ảnh"}</span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
          </li>
        ) : null}
      </ul>
      {!canEdit && !(data?.photos ?? []).length ? <p className="kd-quiet">Chưa có ảnh.</p> : null}
    </section>
  );
}
