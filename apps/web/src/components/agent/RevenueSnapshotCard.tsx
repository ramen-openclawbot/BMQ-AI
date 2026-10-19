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
  if (delta === null) return <span className={cn("text-[11px] text-vn-paper/40", className)}>chưa có cùng kỳ</span>;
  return (
    <span className={cn("font-bold tabular-nums", delta >= 0 ? "text-vn-online" : "text-vn-red", className)}>
      {delta >= 0 ? "+" : ""}{delta.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
    </span>
  );
}

function Unreadable({ label }: { label: string }) {
  return <p className="text-[12px] leading-5 text-vn-paper/50">{label}: chưa đọc được dữ liệu</p>;
}

const SEVERITY: Record<string, { dot: string; label: string }> = {
  high: { dot: "bg-vn-red", label: "Cần xử lý" },
  medium: { dot: "bg-[#f2b134]", label: "Nên xem" },
  info: { dot: "bg-vn-paper/40", label: "Thông tin" },
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
    <div className="mt-3 rounded-xl border border-vn-paper/10 bg-vn-card2 p-3" data-merchant-ui="revenue_snapshot">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-xs font-bold text-vn-paper">Snapshot doanh thu</span>
        {current && previous ? (
          <span className="font-vnMono text-[10px] uppercase tracking-[0.08em] text-vn-paper/45">
            {dm(current.start)}–{dm(current.end)} so với {dm(previous.start)}–{dm(previous.end)}
          </span>
        ) : null}
      </div>

      {failed(revenue) ? (
        <div className="rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5"><Unreadable label="Doanh thu" /></div>
      ) : (
        <div className="rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5">
          <div className="text-[11px] font-semibold text-vn-paper/60">Doanh thu từ đầu tháng · sổ đã kiểm soát</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-black tabular-nums text-vn-paper">{money(total?.current)}</span>
            <Delta value={total?.delta_pct} className="text-xs" />
            <span className="text-[11px] text-vn-paper/45">cùng kỳ {money(total?.previous)}</span>
          </div>
          {groups.length ? (
            <ul className="mt-2.5 space-y-1.5" data-merchant-snapshot-groups>
              {groups.map((group) => {
                const value = num(group.current) ?? 0;
                const silent = num(group.silent_days) ?? 0;
                return (
                  <li key={str(group.group) || str(group.label)} className="min-w-0">
                    <div className="flex items-baseline justify-between gap-2 text-[12px] leading-5">
                      <span className="truncate font-semibold text-vn-paper">
                        {str(group.label) || str(group.group)}
                        {silent >= 2 ? <span className="ml-1.5 font-normal text-vn-red">im lặng {silent} ngày</span> : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-vn-paper">
                        {money(value)} <Delta value={group.delta_pct} className="ml-1 text-[11px]" />
                      </span>
                    </div>
                    <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-vn-paper/10" aria-hidden="true">
                      <span className="block h-full rounded-full bg-vn-lime/70" style={{ width: `${Math.max(2, (value / maxGroup) * 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] text-vn-paper/50">Tháng này chưa có doanh thu đã kiểm soát.</p>
          )}
        </div>
      )}

      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5">
          <div className="text-[11px] font-semibold text-vn-paper/60">Điểm bán nộp báo cáo hôm qua</div>
          {failed(kiosk) ? (
            <Unreadable label="Điểm bán" />
          ) : (
            <>
              <div className="text-base font-black tabular-nums text-vn-paper">
                {num(kiosk?.reported_yesterday) ?? 0}<span className="text-vn-paper/45">/{num(kiosk?.active_count) ?? 0}</span>
              </div>
              {missing.length ? (
                <div className="mt-0.5 text-[11px] leading-4 text-vn-paper/55">Chưa nộp: {missing.map((item) => str(item.location_name) || str(item.location_code)).filter(Boolean).join(", ")}</div>
              ) : null}
            </>
          )}
        </div>
        <div className="rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5">
          <div className="text-[11px] font-semibold text-vn-paper/60">Đơn đại lý 2 ngày qua</div>
          {failed(dealer) ? (
            <Unreadable label="Đơn đại lý" />
          ) : (
            <>
              <div className="text-base font-black tabular-nums text-vn-paper">{num(dealer?.orders_last_2_days) ?? 0} đơn</div>
              <div className="mt-0.5 text-[11px] leading-4 text-vn-paper/55">
                Tháng này {num(dealer?.count_current) ?? 0} đơn · <Delta value={dealer?.delta_pct} className="text-[11px]" /> giá trị
              </div>
            </>
          )}
        </div>
        <div className="rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5">
          <div className="text-[11px] font-semibold text-vn-paper/60">Job tự động 23:59</div>
          {failed(job) ? (
            <Unreadable label="Nhật ký job" />
          ) : (
            <>
              <div className="text-base font-black tabular-nums text-vn-paper">
                {job?.last_success_date ? `OK ${dm(job.last_success_date)}` : "chưa có lần thành công"}
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-vn-paper/55">
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
        <div className="mt-2 rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5">
          <div className="text-[11px] font-semibold text-vn-paper/60">Kênh giao hàng tại điểm bán</div>
          <ul className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {kioskChannels.map((channel) => (
              <li key={str(channel.channel_code)} className="flex items-baseline justify-between gap-2 text-[12px] leading-5">
                <span className="truncate text-vn-paper">{str(channel.channel_name) || str(channel.channel_code)}</span>
                <span className="shrink-0 tabular-nums text-vn-paper">{money(channel.current)} <Delta value={channel.delta_pct} className="ml-1 text-[11px]" /></span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-2 rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5" data-merchant-snapshot-flags>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-vn-paper/60">
          {realFlags.length ? <AlertTriangle className="h-3.5 w-3.5 text-vn-red" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5 text-vn-online" aria-hidden="true" />}
          Bất thường ({realFlags.length})
        </div>
        {realFlags.length ? (
          <ul className="mt-1.5 space-y-2">
            {realFlags.map((flag, index) => {
              const severity = SEVERITY[str(flag.severity)] || SEVERITY.info;
              return (
                <li key={`${str(flag.code)}-${index}`} className="flex gap-2" data-merchant-snapshot-flag={str(flag.code)}>
                  <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", severity.dot)} aria-label={severity.label} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold leading-5 text-vn-paper">{str(flag.title)}</span>
                    {flag.detail ? <span className="block text-[12px] leading-5 text-vn-paper/55">{str(flag.detail)}</span> : null}
                    {flag.action ? <span className="block text-[12px] leading-5 text-vn-lime">→ {str(flag.action)}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1 text-[12px] leading-5 text-vn-paper/70">Không phát hiện bất thường theo quy tắc hiện có. Tiếp tục theo dõi hằng ngày.</p>
        )}
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-4 text-vn-paper/45">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span>
          {str(payload.caveat) || "Số đã kiểm soát theo sổ doanh thu, chưa phải số kiểm toán."}
          {generatedLabel ? ` · Chụp lúc ${generatedLabel}` : ""}
        </span>
      </div>
    </div>
  );
}
