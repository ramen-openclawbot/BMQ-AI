import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMerchantValue } from "@/lib/merchantAgent";

// Card for the merchant agent's `revenue_snapshot` block (version 1): the server has
// already read the ledger and evaluated every rule, so this component only renders.
// Nothing here recomputes a number; a section the server could not read says so.

type Rec = Record<string, unknown>;

const num = (value: unknown): number | null => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};
const str = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const rec = (value: unknown): Rec | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null);
const list = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter((item): item is Rec => Boolean(rec(item))) : []);
const failed = (section: Rec | null) => !section || section.status === "error";
const dm = (iso: unknown) => {
  const text = str(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? `${Number(text.slice(8, 10))}/${Number(text.slice(5, 7))}` : text;
};
const money = (value: unknown) => formatMerchantValue(value, "VND");

function Delta({ value, className }: { value: unknown; className?: string }) {
  const delta = num(value);
  if (delta === null) return <span className={cn("ac-meta", className)}>chưa có cùng kỳ</span>;
  return (
    <span className={cn("ac-delta", delta > 0 ? "ac-pos" : delta < 0 ? "ac-neg" : "", className)}>
      {delta >= 0 ? "+" : ""}{delta.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
    </span>
  );
}

function Unreadable({ label }: { label: string }) {
  return <p className="ac-meta m-0">{label}: chưa đọc được dữ liệu</p>;
}

const SEVERITY: Record<string, { mark: string; label: string }> = {
  high: { mark: "is-red", label: "Cần xử lý" },
  medium: { mark: "is-amber", label: "Nên xem" },
  info: { mark: "", label: "Thông tin" },
};

export function RevenueSnapshotCard({ payload }: { payload: Rec }) {
  const periods = rec(payload.periods);
  const current = rec(periods?.current);
  const previous = rec(periods?.previous);
  const revenue = rec(payload.revenue);
  const total = rec(revenue?.total);
  const groups = list(revenue?.groups);
  const kiosk = rec(payload.kiosk);
  const kioskChannels = list(kiosk?.channels);
  const missing = list(kiosk?.missing_yesterday);
  const dealer = rec(payload.dealer_orders);
  const job = rec(payload.auto_job);
  const flags = list(payload.flags);
  const realFlags = flags.filter((flag) => flag.code !== "no_anomaly");
  const maxGroup = Math.max(1, ...groups.map((group) => num(group.current) ?? 0));
  const generated = str(payload.generated_at);
  const generatedLabel = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(generated) ? `${generated.slice(11, 16)} ${dm(generated)}` : "";

  return (
    <div className="ac-card" data-merchant-ui="revenue_snapshot">
      <div className="ac-card-head">
        <span className="ac-card-title">Snapshot doanh thu</span>
        {current && previous ? (
          <span className="ac-meta ac-num">{dm(current.start)}–{dm(current.end)} so với {dm(previous.start)}–{dm(previous.end)}</span>
        ) : null}
      </div>

      {failed(revenue) ? (
        <div className="ac-well"><Unreadable label="Doanh thu" /></div>
      ) : (
        <div className="ac-well">
          <div className="ac-label">Doanh thu từ đầu tháng · sổ đã kiểm soát</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="ac-value">{money(total?.current)}</span>
            <Delta value={total?.delta_pct} className="text-[13px]" />
            <span className="ac-meta">cùng kỳ <span className="ac-num">{money(total?.previous)}</span></span>
          </div>
          {groups.length ? (
            <ul className="mt-3 space-y-2" data-merchant-snapshot-groups>
              {groups.map((group) => {
                const value = num(group.current) ?? 0;
                const silent = num(group.silent_days) ?? 0;
                return (
                  <li key={str(group.group) || str(group.label)} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2 text-[13px] leading-5">
                      <span className="truncate">
                        <span className="ac-strong">{str(group.label) || str(group.group)}</span>
                        {silent >= 2 ? <span className="ac-neg ml-1.5">im lặng {silent} ngày</span> : null}
                      </span>
                      <span className="ac-num shrink-0">
                        {money(value)} <Delta value={group.delta_pct} className="ml-1 text-[12px]" />
                      </span>
                    </div>
                    <div className="ac-track mt-1" aria-hidden="true">
                      <span style={{ width: `${Math.max(2, (value / maxGroup) * 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="ac-meta mt-2">Tháng này chưa có doanh thu đã kiểm soát.</p>
          )}
        </div>
      )}

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="ac-well">
          <div className="ac-label">Điểm bán nộp báo cáo hôm qua</div>
          {failed(kiosk) ? (
            <Unreadable label="Điểm bán" />
          ) : (
            <>
              <div className="ac-value-sm">
                {num(kiosk?.reported_yesterday) ?? 0}<span className="text-[var(--ac-dim)]">/{num(kiosk?.active_count) ?? 0}</span>
              </div>
              {missing.length ? (
                <div className="ac-meta mt-0.5">Chưa nộp: {missing.map((item) => str(item.location_name) || str(item.location_code)).filter(Boolean).join(", ")}</div>
              ) : null}
            </>
          )}
        </div>
        <div className="ac-well">
          <div className="ac-label">Đơn đại lý 2 ngày qua</div>
          {failed(dealer) ? (
            <Unreadable label="Đơn đại lý" />
          ) : (
            <>
              <div className="ac-value-sm">{num(dealer?.orders_last_2_days) ?? 0} đơn</div>
              <div className="ac-meta mt-0.5">
                Tháng này {num(dealer?.count_current) ?? 0} đơn · <Delta value={dealer?.delta_pct} /> giá trị
              </div>
            </>
          )}
        </div>
        <div className="ac-well">
          <div className="ac-label">Job tự động 23:59</div>
          {failed(job) ? (
            <Unreadable label="Nhật ký job" />
          ) : (
            <>
              <div className="ac-value-sm">
                {job?.last_success_date ? `OK ${dm(job.last_success_date)}` : "chưa có lần thành công"}
              </div>
              <div className="ac-meta mt-0.5">
                {[
                  list(job?.failed_dates).length ? `lỗi ${list(job?.failed_dates).length}` : "",
                  (Array.isArray(job?.missing_dates) ? job!.missing_dates.length : 0) ? `thiếu ${(job!.missing_dates as unknown[]).length}` : "",
                  (Array.isArray(job?.stuck_dates) ? job!.stuck_dates.length : 0) ? `treo ${(job!.stuck_dates as unknown[]).length}` : "",
                ].filter(Boolean).join(" · ") || "7 ngày qua chạy đủ"}
              </div>
            </>
          )}
        </div>
      </div>

      {kioskChannels.length ? (
        <div className="ac-well mt-2">
          <div className="ac-label">Kênh giao hàng tại điểm bán</div>
          <ul className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {kioskChannels.map((channel) => (
              <li key={str(channel.channel_code)} className="flex items-baseline justify-between gap-2 text-[13px] leading-6">
                <span className="truncate">{str(channel.channel_name) || str(channel.channel_code)}</span>
                <span className="ac-num shrink-0">{money(channel.current)} <Delta value={channel.delta_pct} className="ml-1 text-[12px]" /></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="ac-well mt-2" data-merchant-snapshot-flags>
        <div className="flex items-center gap-1.5 text-[13px] font-semibold">
          {realFlags.length ? <AlertTriangle className="ac-neg h-4 w-4" aria-hidden="true" /> : <CheckCircle2 className="ac-pos h-4 w-4" aria-hidden="true" />}
          Bất thường ({realFlags.length})
        </div>
        {realFlags.length ? (
          <ul className="ac-rows mt-2">
            {realFlags.map((flag, index) => {
              const severity = SEVERITY[str(flag.severity)] || SEVERITY.info;
              return (
                <li key={`${str(flag.code)}-${index}`} data-merchant-snapshot-flag={str(flag.code)}>
                  <span className={cn("ac-mark", severity.mark)} aria-label={severity.label} />
                  <span className="min-w-0 text-[13px] leading-5">
                    <span className="ac-strong block">{str(flag.title)}</span>
                    {flag.detail ? <span className="ac-meta block">{str(flag.detail)}</span> : null}
                    {flag.action ? <span className="ac-action block text-[12.5px]">→ {str(flag.action)}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="ac-meta mt-1">Không phát hiện bất thường theo quy tắc hiện có. Tiếp tục theo dõi hằng ngày.</p>
        )}
      </div>

      <div className="ac-meta mt-2.5 flex items-start gap-1.5">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          {str(payload.caveat) || "Số đã kiểm soát theo sổ doanh thu, chưa phải số kiểm toán."}
          {generatedLabel ? ` · Chụp lúc ${generatedLabel}` : ""}
        </span>
      </div>
    </div>
  );
}
