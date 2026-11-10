import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PayslipSessionExpiredError,
  type PayrollShiftRequest,
  type PayrollShiftRequestKind,
  type PayrollShiftSource,
  type PayrollShiftType,
  type PayrollShiftWeek,
} from "@/lib/payslip-portal/types";

const BRAND_GRADIENT = { background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" };
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const REASON_MIN = 3;
const REASON_MAX = 500;

function weekday(date: string): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? "" : WEEKDAYS[value.getUTCDay()];
}

function dayMonth(date: string): string {
  const [, m = "", d = ""] = date.slice(0, 10).split("-");
  return d && m ? `${d}/${m}` : date;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function timeOf(types: PayrollShiftType[], code: string | null): string {
  if (code === null) return "nghỉ";
  return types.find((item) => item.code === code)?.startTime ?? code;
}

const STATE_LABEL: Record<PayrollShiftRequest["state"], string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Không duyệt",
  cancelled: "Đã huỷ",
};

const STATE_TONE: Record<PayrollShiftRequest["state"], string> = {
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
  cancelled: "bg-[#f3f4f6] text-[#6b7280]",
};

function describe(types: PayrollShiftType[], request: PayrollShiftRequest): string {
  if (request.kind === "leave") return `Xin nghỉ ca ${timeOf(types, request.fromShiftCode)}`;
  return request.fromShiftCode === null
    ? `Xin đi làm ca ${timeOf(types, request.toShiftCode)}`
    : `Đổi ca ${timeOf(types, request.fromShiftCode)} → ${timeOf(types, request.toShiftCode)}`;
}

export interface ShiftRequestPanelProps {
  week: PayrollShiftWeek;
  today: string;
  source: PayrollShiftSource;
  onChanged: () => Promise<void> | void;
  onSessionExpired: (message: string) => void;
}

/**
 * Change / day-off requests for a week whose schedule is already fixed.
 * The schedule only changes after the manager approves; this panel shows the
 * state of each request. Hidden when the week takes no request and has none.
 */
export function ShiftRequestPanel({ week, today, source, onChanged, onSessionExpired }: ShiftRequestPanelProps) {
  const [sheet, setSheet] = useState<PayrollShiftRequestKind | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { shiftTypes, days, requests } = week;
  const pendingDates = useMemo(
    () => new Set(requests.filter((item) => item.state === "pending").map((item) => item.workDate)),
    [requests],
  );
  // A day can take a request when it is today or later, the kitchen is open
  // and no other request is still waiting for that day.
  const openDays = days.filter((day) => !day.closed && day.workDate >= today && !pendingDates.has(day.workDate));
  const leaveDays = openDays.filter((day) => day.my !== null && day.my.shiftCode !== null && day.my.state === "registered");
  const canAsk = week.canRequest && openDays.length > 0;

  if (!week.canRequest && requests.length === 0) return null;

  const cancel = async (request: PayrollShiftRequest) => {
    setCancelling(request.id);
    setError(null);
    try {
      await source.cancelRequest(request.id);
      await onChanged();
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không huỷ được yêu cầu. Vui lòng thử lại.");
    } finally {
      setCancelling(null);
    }
  };

  return (
    <div className="mt-3 rounded-[22px] bg-white p-4 ring-1 ring-[#eee8e5]" data-shift-requests={week.week.weekStart}>
      <p className="text-[15px] font-extrabold">Đổi ca, báo nghỉ</p>
      <p className="mt-0.5 text-xs leading-5 text-[#85808a]">
        Tuần {dayMonth(week.week.weekStart)} – {dayMonth(addDays(week.week.weekStart, 6))} · lịch chỉ đổi sau khi quản lý duyệt.
      </p>

      {canAsk ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-2xl border-[#e5dcdf] px-2 text-[13.5px] font-bold text-[#4d4850]"
            onClick={() => setSheet("change")}
            data-shift-request="change"
          >
            Xin đổi ca
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-2xl border-[#e5dcdf] px-2 text-[13.5px] font-bold text-[#4d4850]"
            onClick={() => setSheet("leave")}
            disabled={leaveDays.length === 0}
            data-shift-request="leave"
          >
            Báo nghỉ đột xuất
          </Button>
        </div>
      ) : null}

      {error ? <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}

      {requests.length > 0 ? (
        <ul className="mt-3">
          {requests.map((request) => (
            <li key={request.id} className="border-t border-[#f1ebe8] py-3 first:border-t-0 first:pt-0 last:pb-0" data-shift-request-row={request.state}>
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 text-[13.5px] font-bold leading-5">
                  {weekday(request.workDate)} {dayMonth(request.workDate)} · {describe(shiftTypes, request)}
                </p>
                <span className={cn("shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-bold", STATE_TONE[request.state])}>
                  {STATE_LABEL[request.state]}
                </span>
              </div>
              <p className="mt-0.5 break-words text-xs leading-5 text-[#666263]">Lý do: {request.reason}</p>
              {request.decisionNote ? (
                <p className="mt-0.5 break-words text-xs leading-5 text-[#666263]">Quản lý: {request.decisionNote}</p>
              ) : null}
              {request.state === "pending" ? (
                <button
                  type="button"
                  className="mt-1 min-h-9 text-[12.5px] font-bold text-[#c2416a] underline-offset-2 hover:underline disabled:opacity-60"
                  disabled={cancelling !== null}
                  onClick={() => void cancel(request)}
                  data-shift-request-cancel
                >
                  {cancelling === request.id ? "Đang huỷ…" : "Huỷ yêu cầu"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {sheet ? (
        <RequestSheet
          kind={sheet}
          week={week}
          dayOptions={(sheet === "leave" ? leaveDays : openDays).map((day) => day.workDate)}
          onClose={() => setSheet(null)}
          onSubmit={async (input) => {
            await source.requestChange(input);
            setSheet(null);
            await onChanged();
          }}
          onSessionExpired={onSessionExpired}
        />
      ) : null}
    </div>
  );
}

function RequestSheet({
  kind,
  week,
  dayOptions,
  onClose,
  onSubmit,
  onSessionExpired,
}: {
  kind: PayrollShiftRequestKind;
  week: PayrollShiftWeek;
  dayOptions: string[];
  onClose: () => void;
  onSubmit: (input: { workDate: string; kind: PayrollShiftRequestKind; toShiftCode: string | null; reason: string }) => Promise<void>;
  onSessionExpired: (message: string) => void;
}) {
  const [workDate, setWorkDate] = useState<string | null>(dayOptions.length === 1 ? dayOptions[0] : null);
  const [toShift, setToShift] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const day = week.days.find((item) => item.workDate === workDate) ?? null;
  const current = day?.my && day.my.state === "registered" ? day.my.shiftCode : null;
  const targets = week.shiftTypes.filter((type) => type.code !== current);
  const reasonOk = reason.trim().length >= REASON_MIN;
  const ready = workDate !== null && reasonOk && (kind === "leave" || toShift !== null);

  const submit = async () => {
    if (!workDate) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ workDate, kind, toShiftCode: kind === "leave" ? null : toShift, reason: reason.trim() });
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không gửi được yêu cầu. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(20,9,13,0.55)] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="shift-request-title">
      <div className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-[28px] bg-[#fefbf9] shadow-xl sm:rounded-[28px]">
        <div className="flex items-start justify-between gap-3 border-b border-[#eee8e5] px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h2 id="shift-request-title" className="text-[18px] font-extrabold">{kind === "leave" ? "Báo nghỉ đột xuất" : "Xin đổi ca"}</h2>
            <p className="mt-0.5 text-xs leading-5 text-[#85808a]">Quản lý sẽ xem và duyệt. Trong lúc chờ, bạn vẫn theo lịch cũ.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#80566a]" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[13px] font-bold">Ngày</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {dayOptions.map((date) => {
              const mine = week.days.find((item) => item.workDate === date)?.my ?? null;
              const selected = workDate === date;
              return (
                <button
                  key={date}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    setWorkDate(date);
                    setToShift(null);
                  }}
                  className={cn(
                    "min-h-12 rounded-xl border-[1.5px] px-3 text-left text-[12.5px] font-bold leading-tight",
                    selected ? "border-[#211d1e] bg-[#211d1e] text-white" : "border-[#e9e2df] bg-white text-[#4d4850]",
                  )}
                  data-shift-request-day={date}
                >
                  {weekday(date)} {dayMonth(date)}
                  <span className={cn("block text-[11px] font-medium", selected ? "text-white/80" : "text-[#85808a]")}>
                    {mine && mine.state === "registered" ? (mine.shiftCode === null ? "đang nghỉ" : `ca ${timeOf(week.shiftTypes, mine.shiftCode)}`) : "chưa có ca"}
                  </span>
                </button>
              );
            })}
          </div>

          {kind === "change" ? (
            <>
              <p className="mt-4 text-[13px] font-bold">Muốn làm ca</p>
              {workDate === null ? (
                <p className="mt-2 text-xs text-[#85808a]">Chọn ngày trước.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {targets.map((type) => {
                    const selected = toShift === type.code;
                    return (
                      <button
                        key={type.code}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setToShift(type.code)}
                        className={cn(
                          "min-h-10 rounded-xl border-[1.5px] px-3 text-[12.5px] font-bold",
                          selected ? "border-[#211d1e] bg-[#211d1e] text-white" : "border-[#e9e2df] bg-white text-[#4d4850]",
                        )}
                        data-shift-request-target={type.code}
                      >
                        {type.startTime}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}

          <label htmlFor="shift-request-reason" className="mt-4 block text-[13px] font-bold">Lý do</label>
          <textarea
            id="shift-request-reason"
            value={reason}
            maxLength={REASON_MAX}
            rows={3}
            onChange={(event) => setReason(event.target.value)}
            placeholder={kind === "leave" ? "Ví dụ: bị ốm, có việc gia đình" : "Ví dụ: sáng đưa con đi khám"}
            className="mt-2 w-full resize-none rounded-2xl border-[1.5px] border-[#e9e2df] bg-white px-3.5 py-2.5 text-[16px] leading-6 outline-none focus:border-[#dc4f78]"
          />
        </div>

        <div className="border-t border-[#eee8e5] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
          {error ? <p role="alert" className="mb-2 rounded-2xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}
          <Button
            type="button"
            className="h-[52px] w-full rounded-2xl border-0 text-[17px] font-extrabold text-white shadow-none hover:brightness-95"
            style={BRAND_GRADIENT}
            disabled={busy || !ready}
            onClick={() => void submit()}
            data-shift-request-submit
          >
            {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
            Gửi yêu cầu
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ShiftRequestPanel;
