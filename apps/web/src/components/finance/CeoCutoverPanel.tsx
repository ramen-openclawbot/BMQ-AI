import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RotateCcw, ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  useCloseCutoverMonth,
  useCollectCutoverEvidence,
  useCutoverHistory,
  useCutoverPreview,
  useRevertCutover,
  type PeriodCutover,
} from "@/hooks/useFinanceCutover";
import { mapCutoverError } from "@/lib/finance-cutover";

// The app mounts the sonner Toaster, so notifications go through sonner.
const notify = ({ title, description, variant }: { title: string; description?: string; variant?: "destructive" }) =>
  variant === "destructive" ? toast.error(title, { description }) : toast.success(title, { description });

const vnd = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
const tr = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format((value || 0) / 1_000_000);
const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`;
const shiftMonth = (key: string, delta: number) => {
  const [y, m] = key.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
};
const monthLabel = (key: string) => `${key.slice(5, 7)}/${key.slice(0, 4)}`;
const dayLabel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** The cutover RPCs only exist after the migration is applied; say so instead of a raw SQL error. */
const isNotInstalled = (error: unknown) => {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error ?? "");
  return /could not find the function|does not exist|PGRST202|42883/i.test(message);
};

/**
 * Owner-only month cutover for the backlog of unclosed CEO days: preview the
 * month, collect missing Drive evidence, then close the whole month at once.
 */
export function CeoCutoverPanel({ initialMonth }: { initialMonth: string }) {
  const [month, setMonth] = useState(initialMonth);
  const [autoJumped, setAutoJumped] = useState(false);
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rescanOpen, setRescanOpen] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [revertTarget, setRevertTarget] = useState<PeriodCutover | null>(null);
  const [revertNote, setRevertNote] = useState("");

  const preview = useCutoverPreview(month);
  const history = useCutoverHistory();
  const collect = useCollectCutoverEvidence();
  const closeMonth = useCloseCutoverMonth();
  const revert = useRevertCutover();
  const data = preview.data;

  // Start at the oldest month that still has unclosed days.
  useEffect(() => {
    if (autoJumped || !data) return;
    setAutoJumped(true);
    const first = data.prior_unclosed_before_month_date;
    if (data.prior_unclosed_before_month && first) setMonth(`${first.slice(0, 7)}-01`);
  }, [autoJumped, data]);

  useEffect(() => {
    setCounted("");
    setNote("");
  }, [month]);

  const countedValue = counted.trim() === "" ? null : Number(counted.replace(/[^\d-]/g, ""));
  const countedVariance = countedValue === null || !data ? 0 : countedValue - data.qtm_closing_computed;
  const needsNote = !!data && (data.unc_variance !== 0 || (countedValue !== null && countedVariance !== 0));
  const scannedDays = data ? data.day_count - data.days_missing_evidence.length : 0;
  const closedForMonth = (history.data || []).find((row) => row.period_month === month && row.status === "closed");
  const canClose =
    !!data && !closedForMonth && data.day_count > 0 && !data.prior_unclosed_before_month &&
    (!needsNote || note.trim().length > 0) && (countedValue === null || Number.isFinite(countedValue)) &&
    !closeMonth.isPending && !collect.isPending;

  const latestClosed = useMemo(
    () => (history.data || []).filter((row) => row.status === "closed").sort((a, b) => b.period_month.localeCompare(a.period_month))[0],
    [history.data],
  );

  const runCollect = (force = false) => {
    setProgress("Đang chuẩn bị…");
    collect.mutate(
      {
        month,
        force,
        onProgress: ({ batchIndex, batchCount, dates }) =>
          setProgress(`Đang quét đợt ${batchIndex + 1}/${batchCount} · ${dates.map(dayLabel).join(", ")}`),
      },
      {
        onSuccess: (result) => {
          setProgress(null);
          if (result.failed.length > 0) {
            notify({
              title: "Quét chứng từ dừng giữa chừng",
              description: `Đã quét ${result.collected.length} ngày. Chưa quét được: ${result.failed.map(dayLabel).join(", ")}.`,
              variant: "destructive",
            });
          } else {
            notify({ title: "Đã quét chứng từ", description: `${result.collected.length} ngày tháng ${monthLabel(month)}.` });
          }
        },
        onError: (error) => {
          setProgress(null);
          notify({ title: "Không quét được chứng từ", description: mapCutoverError(error), variant: "destructive" });
        },
      },
    );
  };

  const runClose = () => {
    if (!data) return;
    closeMonth.mutate(
      { month, expectedHash: data.preview_hash, qtmCounted: countedValue, note: note.trim() || null },
      {
        onSuccess: (result) => {
          setConfirmOpen(false);
          notify({
            title: result.already_closed ? "Tháng này đã chốt trước đó" : `Đã chốt tháng ${monthLabel(month)}`,
            description: result.already_closed ? "Không ghi thêm gì." : `Đã khoá ${result.day_count ?? 0} ngày.`,
          });
        },
        onError: (error) => {
          setConfirmOpen(false);
          notify({ title: "Chưa chốt được", description: error instanceof Error ? error.message : mapCutoverError(error), variant: "destructive" });
        },
      },
    );
  };

  const runRevert = () => {
    if (!revertTarget) return;
    revert.mutate(
      { cutoverId: revertTarget.id, note: revertNote.trim() },
      {
        onSuccess: () => {
          notify({ title: `Đã hoàn tác tháng ${monthLabel(revertTarget.period_month)}` });
          setRevertTarget(null);
          setRevertNote("");
        },
        onError: (error) => {
          notify({ title: "Chưa hoàn tác được", description: error instanceof Error ? error.message : mapCutoverError(error), variant: "destructive" });
        },
      },
    );
  };

  if (preview.isError && isNotInstalled(preview.error)) {
    return (
      <div className="d3-ceo-state" data-bmq-cutover-state="not-installed">
        <b>Chốt mốc tháng chưa được kích hoạt trên hệ thống.</b>
        <span>Cần áp dụng bản cập nhật database đã được duyệt trước khi dùng chức năng này.</span>
      </div>
    );
  }

  return (
    <div className="d3-ceo-cut" data-bmq-cutover-panel>
      <div className="d3-ceo-cut-head">
        <div className="d3-ceo-monthnav" role="group" aria-label="Chọn tháng">
          <Button type="button" variant="ghost" size="icon" aria-label="Tháng trước" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span>Tháng {monthLabel(month)}</span>
          <Button type="button" variant="ghost" size="icon" aria-label="Tháng sau" onClick={() => setMonth((m) => shiftMonth(m, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <p>
          Chốt cả tháng một lần cho các ngày đã khai báo nhưng chưa chốt. Phần lệch được ghi lại kèm ghi chú; có thể hoàn tác.
        </p>
      </div>

      {preview.isLoading ? (
        <div className="d3-ceo-state"><Loader2 className="h-5 w-5 animate-spin" /> Đang tải bảng so sánh…</div>
      ) : preview.isError ? (
        <div className="d3-ceo-state is-error" data-bmq-cutover-state="error">
          <b>Không tải được bảng so sánh tháng.</b>
          <span>{mapCutoverError(preview.error)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => preview.refetch()}>Thử lại</Button>
        </div>
      ) : !data ? null : (
        <>
          {closedForMonth ? (
            <div className="d3-ceo-banner is-ok" data-bmq-cutover-closed>
              Tháng {monthLabel(month)} đã chốt mốc lúc {new Date(closedForMonth.created_at).toLocaleString("vi-VN")} ({closedForMonth.day_count} ngày).
            </div>
          ) : data.prior_unclosed_before_month ? (
            <div className="d3-ceo-banner is-warn" data-bmq-cutover-prior>
              Còn ngày chưa chốt từ {data.prior_unclosed_before_month_date ? dayLabel(data.prior_unclosed_before_month_date) : "tháng trước"}.
              <button type="button" onClick={() => data.prior_unclosed_before_month_date && setMonth(`${data.prior_unclosed_before_month_date.slice(0, 7)}-01`)}>
                Chuyển đến tháng đó
              </button>
            </div>
          ) : null}

          <div className="d3-ceo-trio">
            <section className="d3-ceo-tile">
              <span className="d3-ceo-lvl"><i style={{ background: "#3c91e6" }} />UNC · chuyển khoản</span>
              <strong>{tr(data.unc_declared_total)}<small>tr khai báo</small></strong>
              <dl>
                <div><dt>Chứng từ</dt><dd>{vnd(data.unc_evidence_total)}</dd></div>
                <div className={data.unc_variance === 0 ? "" : "is-bad"}><dt>Lệch</dt><dd>{vnd(data.unc_variance)}</dd></div>
              </dl>
            </section>
            <section className="d3-ceo-tile">
              <span className="d3-ceo-lvl"><i style={{ background: "#29bf12" }} />QTM · quỹ tiền mặt</span>
              <strong>{tr(data.qtm_closing_computed)}<small>tr cuối kỳ (tính)</small></strong>
              <dl>
                <div><dt>Đầu kỳ</dt><dd>{vnd(data.qtm_opening_balance)}</dd></div>
                <div><dt>+ Nạp</dt><dd>{vnd(data.qtm_topup_total)}</dd></div>
                <div><dt>− Chi (chứng từ)</dt><dd>{vnd(data.qtm_spent_total)}</dd></div>
              </dl>
            </section>
            <section className="d3-ceo-tile">
              <span className="d3-ceo-lvl"><i style={{ background: "#f4442e" }} />Chứng từ đã quét</span>
              <strong>{scannedDays}<small>/{data.day_count} ngày</small></strong>
              <div className="d3-ceo-track" aria-hidden="true">
                <i style={{ width: `${data.day_count ? (scannedDays / data.day_count) * 100 : 0}%` }} />
              </div>
              {data.days_missing_evidence.length > 0 && !closedForMonth ? (
                <Button type="button" className="d3-ceo-scan" disabled={collect.isPending} onClick={() => runCollect()} data-bmq-cutover-scan>
                  {collect.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                  Quét chứng từ còn thiếu ({data.days_missing_evidence.length} ngày)
                </Button>
              ) : (
                <small className="d3-ceo-muted">{data.day_count === 0 ? "Không có ngày nào chờ chốt." : "Đã quét đủ các ngày."}</small>
              )}
              {data.day_count > 0 && !closedForMonth ? (
                <Button type="button" variant="outline" className="d3-ceo-scan" disabled={collect.isPending} onClick={() => setRescanOpen(true)} data-bmq-cutover-rescan>
                  <ScanLine className="h-4 w-4" />
                  Quét lại cả tháng ({data.day_count} ngày)
                </Button>
              ) : null}
              {progress ? <small className="d3-ceo-muted" aria-live="polite">{progress}</small> : null}
            </section>
          </div>

          {data.day_count > 0 ? (
            <section className="d3-ceo-card">
              <div className="d3-ceo-card-h"><h3>Các ngày chờ chốt</h3><span className="d3-ceo-pill">{data.day_count}</span></div>
              <div className="d3-ceo-days" data-bmq-cutover-days>
                {data.days.map((day) => {
                  const gap = day.unc_declared - day.unc_evidence_total;
                  return (
                    <div key={day.closing_date} className={`d3-ceo-day${day.evidence_scanned ? "" : " is-missing"}`}>
                      <b>{dayLabel(day.closing_date)}</b>
                      <span><small>UNC</small>{vnd(day.unc_declared)}</span>
                      <span><small>Chứng từ</small>{day.evidence_scanned ? vnd(day.unc_evidence_total) : "chưa quét"}</span>
                      <span className={day.evidence_scanned && gap !== 0 ? "is-bad" : ""}><small>Lệch</small>{day.evidence_scanned ? vnd(gap) : "—"}</span>
                      <span><small>QTM nạp / chi</small>{vnd(day.qtm_topup)} / {day.evidence_scanned ? vnd(day.qtm_spent_total) : "—"}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {!closedForMonth && data.day_count > 0 ? (
            <section className="d3-ceo-card d3-ceo-closeform" data-bmq-cutover-form>
              <div className="d3-ceo-card-h"><h3>Chốt tháng {monthLabel(month)}</h3></div>
              <div className="d3-ceo-form-grid">
                <label>
                  <span>Tiền mặt kiểm quỹ thực tế cuối tháng (tuỳ chọn)</span>
                  <Input inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder={`Tính theo chứng từ: ${vnd(data.qtm_closing_computed)}`} />
                  {countedValue !== null && countedVariance !== 0 ? <small className="is-bad">Lệch so với số tính: {vnd(countedVariance)}</small> : null}
                </label>
                <label>
                  <span>Ghi chú{needsNote ? " (bắt buộc vì có chênh lệch)" : ""}</span>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: Chốt mốc theo tổng tháng, phần lệch kế toán bổ sung sau" />
                </label>
              </div>
              <div className="d3-ceo-form-foot">
                {data.days_missing_evidence.length > 0 ? (
                  <small className="d3-ceo-muted">Còn {data.days_missing_evidence.length} ngày chưa quét chứng từ; các ngày này tính chi QTM = 0.</small>
                ) : <span />}
                <Button type="button" className="d3-ceo-go" disabled={!canClose} onClick={() => setConfirmOpen(true)} data-bmq-cutover-close>
                  Chốt tháng {monthLabel(month)}
                </Button>
              </div>
            </section>
          ) : null}
        </>
      )}

      <section className="d3-ceo-card">
        <div className="d3-ceo-card-h"><h3>Lịch sử chốt mốc</h3></div>
        {history.isLoading ? (
          <small className="d3-ceo-muted">Đang tải…</small>
        ) : history.isError ? (
          <small className="d3-ceo-muted">{isNotInstalled(history.error) ? "Chưa kích hoạt." : "Không tải được lịch sử."}</small>
        ) : (history.data || []).length === 0 ? (
          <small className="d3-ceo-muted">Chưa chốt mốc tháng nào.</small>
        ) : (
          <div className="d3-ceo-hist" data-bmq-cutover-history>
            {(history.data || []).map((row) => (
              <div key={row.id} className={`d3-ceo-hrow is-${row.status}`}>
                <b>Tháng {monthLabel(row.period_month)}</b>
                <span>{row.day_count} ngày · UNC lệch {vnd(row.unc_variance)} · QTM cuối {vnd(row.qtm_closing_counted ?? row.qtm_closing_computed)}</span>
                <span className="d3-ceo-pill">{row.status === "closed" ? "Đã chốt" : "Đã hoàn tác"}</span>
                {row.status === "closed" && latestClosed?.id === row.id ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRevertTarget(row)}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />Hoàn tác
                  </Button>
                ) : <span />}
              </div>
            ))}
          </div>
        )}
      </section>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Chốt tháng {monthLabel(month)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {data
                ? `Khoá ${data.day_count} ngày. UNC khai báo ${vnd(data.unc_declared_total)}, chứng từ ${vnd(data.unc_evidence_total)}, lệch ${vnd(data.unc_variance)}. Quỹ tiền mặt cuối tháng ${vnd(countedValue ?? data.qtm_closing_computed)}${countedValue !== null ? " (kiểm quỹ thực tế)" : " (tính theo chứng từ)"}. Có thể hoàn tác sau.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction disabled={closeMonth.isPending} onClick={(event) => { event.preventDefault(); runClose(); }}>
              {closeMonth.isPending ? "Đang chốt…" : "Chốt tháng"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rescanOpen} onOpenChange={setRescanOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quét lại chứng từ tháng {monthLabel(month)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {data ? `Quét lại ${data.day_count} ngày và ghi đè số chứng từ đã quét trước đó. Ảnh chưa từng đọc sẽ được đọc bằng OpenAI nên có phát sinh chi phí. Chưa chốt gì cho đến khi anh bấm Chốt tháng.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setRescanOpen(false); runCollect(true); }}>Quét lại</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revertTarget} onOpenChange={(open) => { if (!open) { setRevertTarget(null); setRevertNote(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hoàn tác chốt tháng {revertTarget ? monthLabel(revertTarget.period_month) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>Các ngày của tháng này sẽ trở lại trạng thái chưa chốt, đúng như trước khi chốt mốc.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={revertNote} onChange={(e) => setRevertNote(e.target.value)} placeholder="Lý do hoàn tác (bắt buộc)" />
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction disabled={!revertNote.trim() || revert.isPending} onClick={(event) => { event.preventDefault(); runRevert(); }}>
              {revert.isPending ? "Đang hoàn tác…" : "Hoàn tác"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
