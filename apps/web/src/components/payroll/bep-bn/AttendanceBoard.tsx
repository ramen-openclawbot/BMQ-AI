import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, LogOut, RefreshCw, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ictToday, useAttendanceBoard, usePunctualityRanking } from "@/hooks/usePayrollBnAttendanceBoard";
import {
  attendanceStatusLabel,
  attendanceStatusTone,
  type AttendanceBoardEmployee,
  type AttendanceStatusTone,
  type PunctualityRankingEmployee,
} from "@/lib/payroll-bn/attendance-board.ts";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

const TONE: Record<AttendanceStatusTone, { pill: string; bar: string }> = {
  success: { pill: "bg-emerald-100 text-emerald-800", bar: "bg-emerald-500" },
  warning: { pill: "bg-amber-100 text-amber-800", bar: "bg-amber-400" },
  danger: { pill: "bg-red-100 text-red-800", bar: "bg-red-500" },
  info: { pill: "bg-sky-100 text-sky-800", bar: "bg-sky-400" },
  neutral: { pill: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/30" },
  muted: { pill: "bg-muted text-muted-foreground", bar: "bg-muted-foreground/20" },
};

function addDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayLabel(date: string): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const [, m, d] = date.slice(0, 10).split("-");
  return Number.isNaN(value.getTime()) ? date : `${WEEKDAYS[value.getUTCDay()]} ${d}/${m}`;
}

function clock(value: string | null): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

const SOURCE_LABEL: Record<string, string> = { schedule: "theo lịch ca", manual: "giờ đặt tay", mission: "mốc nhiệm vụ" };

/** Manager board: today's check-ins against the shift start, plus the punctuality ranking of the month. */
export function AttendanceBoard() {
  const today = ictToday();
  const [date, setDate] = useState(today);
  const isToday = date === today;
  const board = useAttendanceBoard(date);
  const monthStart = `${today.slice(0, 8)}01`;
  const ranking = usePunctualityRanking(monthStart, today);
  const data = board.data;
  const totals = data?.totals;

  const summary = totals
    ? [
        { key: "in", label: "Đã vào ca", value: totals.checkedIn, tone: "text-foreground" },
        { key: "ok", label: "Đúng giờ", value: totals.onTime, tone: "text-emerald-700" },
        { key: "late", label: "Trễ", value: totals.late, tone: "text-amber-700" },
        { key: "wait", label: isToday ? "Chưa đến" : "Vắng", value: totals.notYet + totals.absentOverdue, tone: totals.absentOverdue > 0 ? "text-red-700" : "text-sky-700" },
        { key: "out", label: "Đã chấm ra", value: totals.checkedOut, tone: "text-foreground" },
      ]
    : [];

  return (
    <div className="space-y-4" data-attendance-board>
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setDate(addDays(date, -1))} aria-label="Ngày trước">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>{isToday ? "Hôm nay" : "Ngày"} {dayLabel(date)}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setDate(addDays(date, 1))} disabled={isToday} aria-label="Ngày sau">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </CardTitle>
            <CardDescription>
              {isToday ? "Tự cập nhật mỗi 20 giây" : "Xem lại ngày đã qua"}
              {data?.generatedAt ? ` · lúc ${clock(data.generatedAt)}` : ""}
              {data && data.lateGraceMinutes > 0 ? ` · cho phép trễ ${data.lateGraceMinutes} phút` : ""}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {!isToday ? (
              <Button variant="outline" size="sm" onClick={() => setDate(today)}>Về hôm nay</Button>
            ) : null}
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void board.refetch()} disabled={board.isFetching} aria-label="Làm mới">
              <RefreshCw className={cn("h-4 w-4", board.isFetching && "animate-spin")} /> Làm mới
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {board.isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Đang tải" /></div>
          ) : board.error ? (
            <p className="text-sm text-destructive">{board.error instanceof Error ? board.error.message : "Không tải được bảng chấm công."}</p>
          ) : data ? (
            <>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-board-summary>
                {summary.map((item) => (
                  <div key={item.key} className="rounded-lg border bg-card px-3 py-2">
                    <p className={cn("text-2xl font-bold tabular-nums leading-none", item.tone)}>{item.value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{item.label}</p>
                  </div>
                ))}
              </div>
              {data.employees.length === 0 ? (
                <p className="text-sm text-muted-foreground">Chưa có nhân viên nào bật chấm công GPS.</p>
              ) : (
                <ul className="divide-y rounded-lg border" data-board-rows>
                  {data.employees.map((employee) => (
                    <BoardRow key={employee.employeeCode} employee={employee} />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <RankingCard
        loading={ranking.isLoading}
        error={ranking.error ? (ranking.error instanceof Error ? ranking.error.message : "Không tải được bảng xếp hạng.") : null}
        employees={ranking.data?.employees ?? []}
        from={ranking.data?.from || monthStart}
        to={ranking.data?.to || today}
      />
    </div>
  );
}

function BoardRow({ employee }: { employee: AttendanceBoardEmployee }) {
  const tone = TONE[attendanceStatusTone(employee.status)];
  const label = attendanceStatusLabel(employee.status, employee.minutesLate ?? undefined);
  return (
    <li className="flex items-stretch gap-3 px-3 py-2.5" data-board-row={employee.status}>
      <span className={cn("w-1 shrink-0 rounded-full", tone.bar)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-medium leading-snug">
            {employee.name || employee.employeeCode}
            {employee.groupName ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{employee.groupName}</span> : null}
          </p>
          <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold", tone.pill)}>{label}</span>
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          <span>
            Ca <b className="text-foreground">{employee.shiftStart ?? "--:--"}</b>
            {employee.shiftSource ? ` (${SOURCE_LABEL[employee.shiftSource] ?? employee.shiftSource})` : ""}
          </span>
          <span>Vào <b className="text-foreground">{clock(employee.checkInAt)}</b></span>
          <span className="inline-flex items-center gap-1">
            <LogOut className="h-3 w-3" /> Ra <b className="text-foreground">{clock(employee.checkOutAt)}</b>
          </span>
          {employee.rejectedCount > 0 ? <span className="text-red-700">{employee.rejectedCount} lần bị từ chối</span> : null}
        </p>
      </div>
    </li>
  );
}

function RankingCard({
  loading,
  error,
  employees,
  from,
  to,
}: {
  loading: boolean;
  error: string | null;
  employees: PunctualityRankingEmployee[];
  from: string;
  to: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const ranked = useMemo(() => employees.filter((employee) => employee.workedDays > 0), [employees]);
  const shown = showAll ? ranked : ranked.slice(0, 8);
  const medal = ["bg-[#ffd34d] text-[#5c4300]", "bg-slate-200 text-slate-700", "bg-amber-200 text-amber-900"];

  return (
    <Card data-punctuality-ranking>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-4 w-4 text-amber-500" /> Xếp hạng đúng giờ
        </CardTitle>
        <CardDescription>Từ {dayLabel(from)} đến {dayLabel(to)} · xếp theo số ngày đúng giờ, rồi tỉ lệ đúng giờ, rồi tổng phút trễ.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
        ) : error ? (
          <p className="text-destructive">{error}</p>
        ) : ranked.length === 0 ? (
          <p className="text-muted-foreground">Tháng này chưa có ai chấm công.</p>
        ) : (
          <>
            <ol className="divide-y rounded-lg border">
              {shown.map((employee) => {
                const rate = employee.onTimeRate === null ? null : Math.round(employee.onTimeRate * 100);
                return (
                  <li key={employee.employeeCode} className="flex items-center gap-3 px-3 py-2.5" data-rank-row={employee.rank}>
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
                        employee.rank <= 3 ? medal[employee.rank - 1] : "bg-muted text-muted-foreground",
                      )}
                    >
                      {employee.rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium leading-snug">{employee.name || employee.employeeCode}</p>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${rate ?? 0}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                        Trễ {employee.lateDays} ngày{employee.lateMinutesTotal > 0 ? ` · ${employee.lateMinutesTotal} phút` : ""}
                        {employee.absentDays > 0 ? ` · vắng ${employee.absentDays}` : ""}
                        {employee.bestStreak > 1 ? ` · chuỗi dài nhất ${employee.bestStreak} ngày` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <p className="text-base font-bold leading-none">
                        {employee.onTimeDays}<span className="text-xs font-normal text-muted-foreground">/{employee.workedDays}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">{rate === null ? "chưa có giờ ca" : `${rate}% đúng giờ`}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {ranked.length > 8 ? (
              <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Thu gọn" : `Xem đủ ${ranked.length} người`}
              </Button>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default AttendanceBoard;
