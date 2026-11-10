import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PayslipSessionExpiredError,
  type PayrollShiftDay,
  type PayrollShiftSource,
  type PayrollShiftType,
  type PayrollShiftWeek,
} from "@/lib/payslip-portal/types";
import { ShiftRequestPanel } from "./ShiftRequestPanel";

const BRAND_GRADIENT = { background: "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)" };
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

function parts(date: string): { y: string; m: string; d: string } {
  const [y = "", m = "", d = ""] = date.slice(0, 10).split("-");
  return { y, m, d };
}

function weekday(date: string): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? "" : WEEKDAYS[value.getUTCDay()];
}

function dayMonth(date: string): string {
  const { m, d } = parts(date);
  return d && m ? `${d}/${m}` : date;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function todayVietnam(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function mondayOf(date: string): string {
  const dow = new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay() || 7;
  return addDays(date, 1 - dow);
}

function deadlineText(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() + 7 * 3_600_000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const dd = String(local.getUTCDate()).padStart(2, "0");
  const mo = String(local.getUTCMonth() + 1).padStart(2, "0");
  return `${WEEKDAYS[local.getUTCDay()]} ${dd}/${mo}, ${hh}:${mm}`;
}

function shiftLabel(types: PayrollShiftType[], code: string | null): string {
  if (code === null) return "Nghỉ";
  const type = types.find((item) => item.code === code);
  return type ? `Ca ${type.startTime}` : code;
}

export interface ShiftPanelProps {
  source: PayrollShiftSource;
  onSessionExpired: (message: string) => void;
}

/**
 * Weekly shift registration on luong.banhmique.vn. Shift names, times, needed
 * headcount and the deadline all come from the server; nothing is fixed here.
 * Hidden for employees who are not eligible or while no shift is configured.
 */
export function ShiftPanel({ source, onSessionExpired }: ShiftPanelProps) {
  const [week, setWeek] = useState<PayrollShiftWeek | null>(null);
  // The running week, loaded separately: change/leave requests are mostly
  // about today and the next few days, not the week being registered.
  const [thisWeek, setThisWeek] = useState<PayrollShiftWeek | null>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await source.getShiftWeek();
      setWeek(next);
      const currentStart = mondayOf(todayVietnam());
      if (!next.eligible || next.shiftTypes.length === 0 || next.week.weekStart === currentStart) {
        setThisWeek(null);
        return;
      }
      setThisWeek(await source.getShiftWeek(currentStart));
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) onSessionExpired(err.message);
    }
  }, [source, onSessionExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!week || !week.eligible || week.shiftTypes.length === 0) return null;

  const { week: info, shiftTypes, days, currentWeek } = week;
  const today = todayVietnam();
  const todayEntry = currentWeek.find((entry) => entry.workDate === today) ?? null;
  const restOfWeek = currentWeek.filter((entry) => entry.workDate > today);
  const myDays = days.filter((day) => day.my !== null);
  const registered = myDays.length > 0;
  const published = info.status === "published";
  const weekRange = `${dayMonth(info.weekStart)} – ${dayMonth(addDays(info.weekStart, 6))}`;

  return (
    <section className="mt-6" aria-labelledby="shift-heading" data-shift-panel>
      <h2 id="shift-heading" className="text-[28px] font-extrabold leading-tight tracking-[-0.02em]">
        Ca làm
      </h2>

      {todayEntry || restOfWeek.length > 0 ? (
        <div className="mt-3 rounded-[22px] bg-white p-4 ring-1 ring-[#eee8e5]">
          {todayEntry ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-[#666263]">Hôm nay · {weekday(today)} {dayMonth(today)}</p>
                <p className="mt-0.5 text-[26px] font-extrabold leading-none">
                  {todayEntry.shiftCode === null ? "Nghỉ" : shiftTypes.find((t) => t.code === todayEntry.shiftCode)?.startTime ?? todayEntry.shiftCode}
                </p>
              </div>
              <ShiftPill types={shiftTypes} code={todayEntry.shiftCode} />
            </div>
          ) : null}
          {restOfWeek.length > 0 ? (
            <div className={cn("flex flex-wrap gap-x-3 gap-y-1.5 text-xs text-[#666263]", todayEntry && "mt-3 border-t border-[#f1ebe8] pt-3")}>
              {restOfWeek.map((entry) => (
                <span key={entry.workDate} className="whitespace-nowrap">
                  <b className="text-[#211d1e]">{weekday(entry.workDate)}</b> {shiftLabel(shiftTypes, entry.shiftCode)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {thisWeek ? (
        <ShiftRequestPanel week={thisWeek} today={today} source={source} onChanged={load} onSessionExpired={onSessionExpired} />
      ) : null}

      {info.canEdit ? (
        <div
          className="mt-3 rounded-[22px] p-4 text-white shadow-[0_14px_28px_rgba(220,79,120,0.28)]"
          style={{ background: "linear-gradient(135deg, #e0578a 0%, #c2416a 100%)" }}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-[11px] font-bold">
            <CalendarClock className="h-3.5 w-3.5" /> Đang mở · hạn {deadlineText(info.deadline)}
          </span>
          <h3 className="mt-2.5 text-[18px] font-extrabold leading-snug">Đăng ký ca tuần {weekRange}</h3>
          <p className="mt-1 text-[12.5px] leading-5 text-white/90">
            {registered
              ? "Bạn đã đăng ký. Sửa được đến hết hạn; lịch chính thức sau khi quản lý công bố."
              : "Chọn ca cho từng ngày. Quá hạn chưa đăng ký, quản lý sẽ xếp theo lịch tuần trước."}
          </p>
          <Button
            type="button"
            className="mt-3 h-12 w-full rounded-2xl border-0 bg-white text-[16px] font-extrabold text-[#c2416a] shadow-none hover:bg-white/90"
            onClick={() => {
              setNotice(null);
              setOpen(true);
            }}
            data-shift-open
          >
            {registered ? "Sửa đăng ký" : "Đăng ký ngay"}
          </Button>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="mt-3 flex items-start gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </p>
      ) : null}

      {registered ? (
        <div className="mt-3 rounded-[22px] bg-white px-4 py-2 ring-1 ring-[#eee8e5]" data-shift-week>
          <p className="border-b border-[#f1ebe8] py-2 text-xs font-semibold text-[#80566a]">
            Tuần {weekRange} · {published ? "quản lý đã công bố" : "đã đăng ký, chờ công bố"}
          </p>
          {days.map((day) => (
            <WeekRow key={day.workDate} day={day} types={shiftTypes} />
          ))}
        </div>
      ) : !info.canEdit ? (
        <p className="mt-3 rounded-2xl bg-[#f7f3f1] px-4 py-3 text-[12.5px] leading-5 text-[#666263]">
          Tuần {weekRange}: {published ? "bạn chưa có lịch, vui lòng hỏi quản lý." : "chưa mở hoặc đã hết hạn đăng ký. Quản lý sẽ xếp ca cho bạn."}
        </p>
      ) : null}

      <ShiftRequestPanel week={week} today={today} source={source} onChanged={load} onSessionExpired={onSessionExpired} />

      {open ? (
        <RegisterSheet
          week={week}
          onClose={() => setOpen(false)}
          onSubmit={async (entries) => {
            const next = await source.submitShiftRegistration(info.weekStart, entries);
            setWeek(next);
            setOpen(false);
            const waiting = next.days.filter((day) => day.my?.state === "waitlist").length;
            setNotice(
              waiting > 0
                ? `Đã gửi đăng ký. ${waiting} ngày đang ở danh sách chờ vì ca đã đủ người hoặc đã đủ người nghỉ; quản lý sẽ quyết định.`
                : "Đã gửi đăng ký. Bạn sửa được đến hết hạn.",
            );
          }}
          onSessionExpired={onSessionExpired}
        />
      ) : null}
    </section>
  );
}

function ShiftPill({ types, code, waitlist = false }: { types: PayrollShiftType[]; code: string | null; waitlist?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-bold",
        waitlist ? "bg-orange-50 text-orange-700" : code === null ? "bg-[#f3f4f6] text-[#6b7280]" : "bg-emerald-50 text-emerald-700",
      )}
    >
      {shiftLabel(types, code)}
      {waitlist ? " · chờ" : ""}
    </span>
  );
}

function WeekRow({ day, types }: { day: PayrollShiftDay; types: PayrollShiftType[] }) {
  const my = day.my;
  return (
    <div className="flex items-center gap-3 border-t border-[#f1ebe8] py-2.5 first:border-t-0">
      <div className="w-11 shrink-0 leading-tight">
        <b className="block text-[13px]">{weekday(day.workDate)}</b>
        <span className="text-[10.5px] text-[#85808a]">{dayMonth(day.workDate)}</span>
      </div>
      {day.closed ? (
        <span className="text-xs text-[#85808a]">Bếp nghỉ</span>
      ) : my ? (
        <>
          <ShiftPill types={types} code={my.shiftCode} waitlist={my.state === "waitlist"} />
          {my.source === "manager" ? (
            <span className="text-[11px] text-[#85808a]">
              quản lý xếp{my.previousShiftCode !== null && my.previousShiftCode !== my.shiftCode ? `, đổi từ ${shiftLabel(types, my.previousShiftCode).toLowerCase()}` : ""}
            </span>
          ) : my.source === "carried" ? (
            <span className="text-[11px] text-[#85808a]">theo tuần trước</span>
          ) : null}
        </>
      ) : (
        <span className="text-xs text-[#b9b2b4]">Chưa có</span>
      )}
    </div>
  );
}

type Choice = string | null | undefined; // shift code, null = day off, undefined = not chosen

function RegisterSheet({
  week,
  onClose,
  onSubmit,
  onSessionExpired,
}: {
  week: PayrollShiftWeek;
  onClose: () => void;
  onSubmit: (entries: { workDate: string; shiftCode: string | null }[]) => Promise<void>;
  onSessionExpired: (message: string) => void;
}) {
  const openDays = useMemo(() => week.days.filter((day) => !day.closed), [week.days]);
  const [choices, setChoices] = useState<Record<string, Choice>>(() => {
    const initial: Record<string, Choice> = {};
    for (const day of openDays) initial[day.workDate] = day.my ? day.my.shiftCode : undefined;
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = openDays.filter((day) => choices[day.workDate] !== undefined).length;
  const offDays = openDays.filter((day) => choices[day.workDate] === null).length;
  const complete = chosen === openDays.length;
  const suggestion = week.suggestion.filter((item) => openDays.some((day) => day.workDate === item.workDate));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(openDays.map((day) => ({ workDate: day.workDate, shiftCode: choices[day.workDate] ?? null })));
    } catch (err) {
      if (err instanceof PayslipSessionExpiredError) {
        onSessionExpired(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Không gửi được đăng ký. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(20,9,13,0.55)] sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="shift-sheet-title">
      <div className="flex max-h-[94vh] w-full max-w-md flex-col overflow-hidden rounded-t-[28px] bg-[#fefbf9] shadow-xl sm:rounded-[28px]">
        <div className="flex items-start justify-between gap-3 border-b border-[#eee8e5] px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h2 id="shift-sheet-title" className="text-[18px] font-extrabold">Đăng ký ca</h2>
            <p className="mt-0.5 text-xs text-[#85808a]">
              Tuần {dayMonth(week.week.weekStart)} – {dayMonth(addDays(week.week.weekStart, 6))} · hạn {deadlineText(week.week.deadline)}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#80566a]" aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {week.days.map((day) => (
            <div key={day.workDate} className="flex items-start gap-2 border-t border-[#f1ebe8] py-3 first:border-t-0" data-shift-day={day.workDate}>
              <div className="w-10 shrink-0 pt-1.5 leading-tight">
                <b className="block text-[13px]">{weekday(day.workDate)}</b>
                <span className="text-[10.5px] text-[#85808a]">{dayMonth(day.workDate)}</span>
              </div>
              {day.closed ? (
                <p className="pt-2 text-xs text-[#85808a]">Bếp nghỉ, không cần đăng ký</p>
              ) : (
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {week.shiftTypes.map((type) => {
                    const cell = day.shifts.find((item) => item.code === type.code);
                    const mine = day.my?.shiftCode === type.code && day.my.state === "registered";
                    const full = Boolean(cell?.full) && !mine;
                    const selected = choices[day.workDate] === type.code;
                    return (
                      <button
                        key={type.code}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setChoices((prev) => ({ ...prev, [day.workDate]: type.code }))}
                        className={cn(
                          "min-h-10 rounded-xl border-[1.5px] px-2.5 text-[12.5px] font-bold",
                          selected
                            ? "border-[#211d1e] bg-[#211d1e] text-white"
                            : cell?.needMore
                              ? "border-[#f59e0b] bg-[#fff7e0] text-[#92400e]"
                              : full
                                ? "border-[#e9e2df] bg-white text-[#b9b2b4] line-through"
                                : "border-[#e9e2df] bg-white text-[#4d4850]",
                        )}
                      >
                        {type.startTime}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    aria-pressed={choices[day.workDate] === null}
                    onClick={() => setChoices((prev) => ({ ...prev, [day.workDate]: null }))}
                    className={cn(
                      "min-h-10 rounded-xl border-[1.5px] px-2.5 text-[12.5px] font-bold",
                      choices[day.workDate] === null
                        ? "border-[#6b7280] bg-[#6b7280] text-white"
                        : day.offFull && day.my?.shiftCode !== null
                          ? "border-[#e9e2df] bg-white text-[#b9b2b4] line-through"
                          : "border-[#e9e2df] bg-white text-[#4d4850]",
                    )}
                  >
                    Nghỉ
                  </button>
                </div>
              )}
            </div>
          ))}
          <p className="mt-1 pb-2 text-[11.5px] leading-5 text-[#85808a]">
            Viền vàng: ca đang cần người. Gạch ngang: đã đủ người, vẫn chọn được nhưng vào danh sách chờ quản lý quyết định.
          </p>
        </div>

        <div className="border-t border-[#eee8e5] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
          <p className={cn("text-[12.5px]", complete && offDays === 0 ? "text-red-700" : "text-[#666263]")}>
            {complete
              ? offDays === 0
                ? "Mỗi tuần cần ít nhất 1 ngày nghỉ."
                : `${openDays.length - offDays} ngày làm · ${offDays} ngày nghỉ`
              : `Đã chọn ${chosen}/${openDays.length} ngày`}
          </p>
          {error ? <p role="alert" className="mt-2 rounded-2xl bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p> : null}
          <Button
            type="button"
            className="mt-2 h-[52px] w-full rounded-2xl border-0 text-[17px] font-extrabold text-white shadow-none hover:brightness-95"
            style={BRAND_GRADIENT}
            disabled={busy || !complete}
            onClick={() => void submit()}
            data-shift-submit
          >
            {busy ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
            Gửi đăng ký
          </Button>
          {suggestion.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              className="mt-2 h-11 w-full rounded-2xl border-[#e5dcdf] text-[14px] font-bold text-[#4d4850]"
              disabled={busy}
              onClick={() =>
                setChoices((prev) => {
                  const next = { ...prev };
                  for (const item of suggestion) next[item.workDate] = item.shiftCode;
                  return next;
                })
              }
            >
              Chép từ tuần trước
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default ShiftPanel;
