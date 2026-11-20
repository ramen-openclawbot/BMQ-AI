/* Báo cáo đặt hàng (dathang · Đơn hàng → Báo cáo). Owner-approved demo 20/11/2026.
 * Reads dealer-report for the signed-in dealer only; NPP accounts also get per-point rows.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import "@/styles/dealer-report.css";

export type DealerReport = {
  period: { month: string; start_date: string; end_date: string; days_elapsed: number };
  summary: {
    order_count: number; quantity: number; amount_vnd: number; exchange_quantity: number;
    makeup_quantity: number; delivery_days: number; avg_per_day: number;
  };
  comparison: {
    prev_same_period_quantity: number; same_period_change_pct: number | null;
    prev_avg_per_day: number; avg_change_pct: number | null;
  };
  daily: Array<{ date: string; quantity: number }>;
  weekday: number[];
  recent_orders: Array<{ order_number: string; delivery_date: string; quantity: number; extra_quantity: number; amount_vnd: number }>;
  months: Array<{ month: string; order_count: number; quantity: number; avg_per_day: number; amount_vnd: number }>;
  points: Array<{ name: string; quantity: number; avg_per_day: number; prev_avg_per_day: number; change_pct: number | null }> | null;
};

type Props = {
  sessionToken: string;
  onLocked: (message?: string | null) => void;
  onSessionExpired: () => void;
  isLockedPayload: (payload: Record<string, unknown> | null | undefined) => boolean;
};

const WEEKDAYS = ["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"];
const qty = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value || 0));
const vnd = (value: number) => `${qty(value)}đ`;
const millions = (value: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: value >= 10_000_000 ? 0 : 1 }).format((value || 0) / 1_000_000);

const vietnamMonth = (offsetMonths = 0) => {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  const total = now.getUTCFullYear() * 12 + now.getUTCMonth() + offsetMonths;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
};
const monthLabel = (month: string) => `T${Number(month.slice(5))}/${month.slice(0, 4)}`;
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const cleanPointName = (name: string) =>
  name.normalize("NFC").replace(/^\s*đại\s+lý\s+/i, "").replace(/_/g, " · ");

function Change({ value, suffix }: { value: number | null; suffix: string }) {
  if (value === null || !Number.isFinite(value)) return null;
  const tone = value > 0.005 ? "up" : value < -0.005 ? "down" : "flat";
  const arrow = tone === "up" ? "▲" : tone === "down" ? "▼" : "■";
  const pct = new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value) * 100);
  return (
    <span className="dealer-report-change-wrap">
      <span className="dealer-report-change" data-tone={tone}>{arrow} {pct}%</span>
      <span>{suffix}</span>
    </span>
  );
}

export function DealerReportPanel({ sessionToken, onLocked, onSessionExpired, isLockedPayload }: Props) {
  const thisMonth = vietnamMonth(0);
  const lastMonth = vietnamMonth(-1);
  const [month, setMonth] = useState(thisMonth);
  const [report, setReport] = useState<DealerReport | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const cache = useRef(new Map<string, DealerReport>());

  useEffect(() => {
    let cancelled = false;
    const key = `${sessionToken}|${month}`;
    const cached = cache.current.get(key);
    setReport(cached || null);
    setStatus(cached ? "ready" : "loading");
    setError("");
    (async () => {
      const { data, error: requestError, isSessionExpired } = await callEdgeFunction<{ success?: boolean; report?: DealerReport }>(
        "dealer-report", { dealer_token: sessionToken, month }, undefined, 15000,
      );
      if (cancelled) return;
      if (isLockedPayload({ error: requestError })) { onLocked(requestError); return; }
      if (isSessionExpired) { onSessionExpired(); return; }
      if (requestError || data?.success !== true || !data.report) {
        if (!cached) {
          setError(requestError || "Không tải được báo cáo. Vui lòng thử lại.");
          setStatus("error");
        }
        return;
      }
      cache.current.set(key, data.report);
      setReport(data.report);
      setStatus("ready");
    })();
    return () => { cancelled = true; };
  }, [sessionToken, month, reloadKey, onLocked, onSessionExpired, isLockedPayload]);

  const chartMax = useMemo(() => Math.max(1, ...(report?.daily || []).map((d) => d.quantity)), [report]);
  const weekdayMax = useMemo(() => Math.max(1, ...(report?.weekday || [])), [report]);
  const pointMax = useMemo(() => Math.max(1, ...(report?.points || []).map((p) => p.quantity)), [report]);
  const isCurrent = month === thisMonth;
  const prevLabel = report ? `tháng ${Number(report.months[1]?.month.slice(5) || 0)}` : "tháng trước";
  const rangeLabel = report ? `${dayMonth(report.period.start_date)}–${dayMonth(report.period.end_date)}` : "";

  return (
    <section className="dealer-report" data-dealer-report aria-label="Báo cáo đặt hàng">
      <div className="dealer-report-periods" role="group" aria-label="Chọn tháng báo cáo">
        <button type="button" data-active={month === thisMonth} onClick={() => setMonth(thisMonth)}>Tháng này</button>
        <button type="button" data-active={month === lastMonth} onClick={() => setMonth(lastMonth)}>Tháng trước</button>
        <label data-active={month !== thisMonth && month !== lastMonth}>
          <span aria-hidden="true">{month !== thisMonth && month !== lastMonth ? monthLabel(month) : "Chọn tháng"}</span>
          <input
            className="dealer-report-month-input"
            onClick={(event) => { try { event.currentTarget.showPicker?.(); } catch { /* picker needs a user gesture */ } }}
            type="month"
            value={month}
            max={thisMonth}
            min={vietnamMonth(-24)}
            onChange={(event) => { if (/^\d{4}-\d{2}$/.test(event.target.value)) setMonth(event.target.value); }}
            aria-label="Chọn tháng"
          />
        </label>
      </div>

      {status === "loading" && !report ? (
        <div className="dealer-report-skeleton" aria-busy="true" aria-label="Đang tải báo cáo">
          <div /><div /><div />
        </div>
      ) : null}

      {status === "error" && !report ? (
        <div className="dealer-report-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>Thử lại</button>
        </div>
      ) : null}

      {report ? (
        <>
          <div className="dealer-report-kpis">
            <div className="dealer-report-kpi dealer-report-kpi--hero">
              <span className="dealer-report-label">Bánh đã đặt · {rangeLabel}</span>
              <strong>{qty(report.summary.quantity)} <small>que</small></strong>
              <Change
                value={report.comparison.same_period_change_pct}
                suffix={`so với cùng kỳ ${prevLabel} (${qty(report.comparison.prev_same_period_quantity)} que)`}
              />
              <span className="dealer-report-meta">
                {qty(report.summary.order_count)} đơn · {report.summary.delivery_days}/{report.period.days_elapsed} ngày có giao
              </span>
            </div>
            <div className="dealer-report-kpi">
              <span className="dealer-report-label">Tiền hàng</span>
              <strong>{millions(report.summary.amount_vnd)}<small> tr đ</small></strong>
              <span className="dealer-report-meta">{vnd(report.summary.amount_vnd)}</span>
            </div>
            <div className="dealer-report-kpi">
              <span className="dealer-report-label">Bình quân/ngày</span>
              <strong>{qty(report.summary.avg_per_day)}<small> que</small></strong>
              <Change value={report.comparison.avg_change_pct} suffix={`so ${prevLabel}`} />
            </div>
          </div>

          <section className="dealer-report-block">
            <h2>Bánh đặt theo ngày giao</h2>
            <p className="dealer-report-hint">Cột xám là ngày không đặt.{isCurrent ? " Tính đến hôm nay." : ""}</p>
            <div className="dealer-report-chart" role="img" aria-label={`Biểu đồ số que theo ngày giao, ${rangeLabel}`}>
              {report.daily.map((day) => (
                <div key={day.date} className="dealer-report-chart-col" title={`${dayMonth(day.date)}: ${qty(day.quantity)} que`}>
                  <div
                    className="dealer-report-chart-bar"
                    data-empty={day.quantity <= 0}
                    style={{ height: day.quantity > 0 ? `${(day.quantity / chartMax) * 100}%` : "2px" }}
                  />
                  <i>{Number(day.date.slice(8))}</i>
                </div>
              ))}
            </div>
          </section>

          <div className="dealer-report-grid">
            {report.points && report.points.length > 0 ? (
              <section className="dealer-report-block" data-dealer-report-points>
                <h2>Theo điểm giao</h2>
                <p className="dealer-report-hint">Sắp theo số bánh. % là bình quân/ngày so với {prevLabel}.</p>
                <ul className="dealer-report-points">
                  {report.points.map((point) => (
                    <li key={point.name}>
                      <div className="dealer-report-point-head">
                        <b>{cleanPointName(point.name)}</b>
                        <span>{qty(point.quantity)} que</span>
                      </div>
                      <div className="dealer-report-track"><div style={{ width: `${(point.quantity / pointMax) * 100}%` }} /></div>
                      <div className="dealer-report-point-meta">
                        <span>{qty(point.avg_per_day)} que/ngày</span>
                        <Change value={point.change_pct} suffix={`so T${Number(report.months[1]?.month.slice(5) || 0)}`} />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <section className="dealer-report-block">
                <h2>Bình quân theo thứ</h2>
                <p className="dealer-report-hint">8 tuần gần nhất, giúp ước số bánh cho từng ngày.</p>
                <ul className="dealer-report-weekdays">
                  {report.weekday.map((value, index) => (
                    <li key={WEEKDAYS[index]}>
                      <span>{WEEKDAYS[index]}</span>
                      <div className="dealer-report-track"><div style={{ width: `${(value / weekdayMax) * 100}%` }} /></div>
                      <b>{qty(value)}</b>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div>
              <section className="dealer-report-block">
                <h2>Đổi · bù trong tháng</h2>
                <p className="dealer-report-hint">Giao thêm, không tính tiền.</p>
                <div className="dealer-report-extras">
                  <div><b>{qty(report.summary.quantity)}</b><span>Que tính tiền</span></div>
                  <div><b>{qty(report.summary.exchange_quantity)}</b><span>Que đổi</span></div>
                  <div><b>{qty(report.summary.makeup_quantity)}</b><span>Que bù</span></div>
                </div>
              </section>

              {report.recent_orders.length > 0 ? (
                <section className="dealer-report-block">
                  <h2>Đơn gần nhất</h2>
                  <table className="dealer-report-table">
                    <thead><tr><th scope="col">Ngày giao</th><th scope="col">Que</th><th scope="col">Tiền</th></tr></thead>
                    <tbody>
                      {report.recent_orders.map((order) => (
                        <tr key={order.order_number}>
                          <td>{dayMonth(order.delivery_date)}</td>
                          <td>{qty(order.quantity)}{order.extra_quantity > 0 ? <em> +{qty(order.extra_quantity)} đổi/bù</em> : null}</td>
                          <td>{vnd(order.amount_vnd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ) : null}

              <section className="dealer-report-block">
                <h2>3 tháng gần nhất</h2>
                <table className="dealer-report-table dealer-report-table--months">
                  <thead><tr><th scope="col">Tháng</th><th scope="col">Đơn</th><th scope="col">Que</th><th scope="col">BQ/ngày</th><th scope="col">Tiền</th></tr></thead>
                  <tbody>
                    {report.months.map((row) => (
                      <tr key={row.month} data-current={row.month === report.period.month}>
                        <td>{monthLabel(row.month)}</td>
                        <td>{qty(row.order_count)}</td>
                        <td>{qty(row.quantity)}</td>
                        <td>{qty(row.avg_per_day)}</td>
                        <td>{millions(row.amount_vnd)} tr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </div>

          <p className="dealer-report-foot">
            Số liệu theo ngày giao, đã bỏ đơn huỷ, cập nhật ngay khi đặt đơn. Tiền hàng tính theo giá trên đơn, chưa gồm công nợ và thanh toán.
          </p>
        </>
      ) : null}
    </section>
  );
}

export default DealerReportPanel;
