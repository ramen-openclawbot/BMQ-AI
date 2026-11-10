import { Fragment, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, ChevronDown, ChevronRight, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import {
  getPeriodScheduleSummary,
  importGpsAttendance,
  previewGpsAttendance,
  type BepBnClient,
} from "@/lib/payroll-bn/db-client.ts";
import type { GpsAttendancePreview, PeriodScheduleDetail, PeriodScheduleDetailKind } from "@/lib/payroll-bn/types.ts";
import type { BepBnPeriodData } from "./types";
import { formatDayMonth, formatTime } from "./format";

const client = supabase as unknown as BepBnClient;
const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const SUMMARY_KEY = "payroll-bn-schedule-summary";

function yesterdayVietnam(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const value = new Date(`${today}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function dayLabel(date: string): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? date : `${WEEKDAYS[value.getUTCDay()]} ${formatDayMonth(date)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Không thực hiện được. Vui lòng thử lại.";
}

/**
 * Pull GPS check-ins into the period, in place of (or next to) the machine
 * file. Days already present in the period are kept; only finished days, up to
 * yesterday, can be pulled.
 */
export function GpsAttendanceImportCard({ data, canEdit, approved }: { data: BepBnPeriodData; canEdit: boolean; approved: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const lastDay = yesterdayVietnam() < data.period.dateTo ? yesterdayVietnam() : data.period.dateTo;
  const [from, setFrom] = useState(data.period.dateFrom);
  const [to, setTo] = useState(lastDay < data.period.dateFrom ? data.period.dateFrom : lastDay);
  const [preview, setPreview] = useState<GpsAttendancePreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const locked = data.period.status === "locked";
  const nothingYet = lastDay < data.period.dateFrom;
  const rangeOk = from !== "" && to !== "" && from <= to;

  const runPreview = async () => {
    setBusy("preview");
    setError(null);
    try {
      setPreview(await previewGpsAttendance(client, data.id, from, to));
    } catch (err) {
      setPreview(null);
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    try {
      const result = await importGpsAttendance(client, data.id, from, to);
      toast({
        title: result.insertedRows > 0 ? `Đã lấy ${result.insertedRows} ngày công từ GPS` : "Không có ngày công mới",
        description: result.skippedExisting > 0 ? `${result.skippedExisting} ngày đã có trong kỳ được giữ nguyên.` : undefined,
      });
      setPreview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["payroll-bn", "period", data.id] }),
        queryClient.invalidateQueries({ queryKey: ["payroll-bn", "issue-reviews", data.id] }),
        queryClient.invalidateQueries({ queryKey: [SUMMARY_KEY, data.id] }),
      ]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-gps-import>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPin className="h-4 w-4" /> Lấy chấm công GPS
        </CardTitle>
        <CardDescription>
          Dùng thay file máy chấm công, hoặc bổ sung những ngày file máy không có. Ngày đã có dữ liệu trong kỳ được giữ nguyên. Chỉ lấy
          những ngày đã kết thúc (đến hết hôm qua).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {locked ? (
          <p className="text-muted-foreground">Kỳ lương đã chốt nên không lấy thêm chấm công được.</p>
        ) : !canEdit ? (
          <p className="text-muted-foreground">Chỉ người có quyền sửa lương mới lấy được chấm công GPS.</p>
        ) : nothingYet ? (
          <p className="text-muted-foreground">Kỳ này chưa có ngày nào kết thúc để lấy.</p>
        ) : (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="gps-from">Từ ngày</Label>
              <Input id="gps-from" type="date" value={from} min={data.period.dateFrom} max={lastDay} onChange={(e) => { setFrom(e.target.value); setPreview(null); }} className="sm:w-44" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gps-to">Đến ngày</Label>
              <Input id="gps-to" type="date" value={to} min={data.period.dateFrom} max={lastDay} onChange={(e) => { setTo(e.target.value); setPreview(null); }} className="sm:w-44" />
            </div>
            <Button variant="outline" className="gap-2" disabled={!rangeOk || busy !== null} onClick={() => void runPreview()} data-gps-preview>
              {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarRange className="h-4 w-4" />} Xem trước
            </Button>
          </div>
        )}

        {error ? <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}

        {preview ? (
          <div className="space-y-3" data-gps-preview-result>
            <p>
              <b>{dayLabel(preview.from)} – {dayLabel(preview.to)}:</b> {preview.totals.rows} ngày công của {preview.totals.employees} nhân viên ·{" "}
              <span className="font-medium text-emerald-700">{preview.totals.toInsert} sẽ thêm vào kỳ</span>
              {preview.totals.alreadyInPeriod > 0 ? ` · ${preview.totals.alreadyInPeriod} đã có trong kỳ (giữ nguyên)` : ""}
              {preview.totals.daysMissingOut > 0 ? ` · ${preview.totals.daysMissingOut} ngày thiếu giờ ra` : ""}.
            </p>
            {preview.skippedCodes.length > 0 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
                Có chấm công GPS nhưng không thuộc danh sách nhân viên của kỳ, nên không lấy: {preview.skippedCodes.join(", ")}. Thêm ở tab Nhân viên nếu cần tính lương.
              </p>
            ) : null}
            {preview.rows.length > 0 ? (
              <div className="max-h-80 overflow-auto rounded-md border">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="sticky top-0 bg-muted text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Nhân viên</th>
                      <th className="px-3 py-2 text-left font-medium">Ngày</th>
                      <th className="px-3 py-2 text-left font-medium">Vào</th>
                      <th className="px-3 py-2 text-left font-medium">Ra</th>
                      <th className="px-3 py-2 text-left font-medium">Ca xếp</th>
                      <th className="px-3 py-2 text-left font-medium">Ghi chú</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => {
                      const notes = [
                        row.alreadyInPeriod ? "đã có trong kỳ, giữ nguyên" : null,
                        row.checkIn && !row.checkOut ? "thiếu giờ ra" : null,
                        row.lateMinutes !== null && row.lateMinutes > 0 ? `trễ ${row.lateMinutes} phút` : null,
                        row.hasOverride ? "quản lý đã duyệt công" : null,
                      ].filter(Boolean);
                      return (
                        <tr key={`${row.employeeCode}-${row.date}`} className={cn("border-t", row.alreadyInPeriod && "text-muted-foreground")}>
                          <td className="px-3 py-1.5">{row.employeeName || row.employeeCode}</td>
                          <td className="whitespace-nowrap px-3 py-1.5">{dayLabel(row.date)}</td>
                          <td className="px-3 py-1.5">{formatTime(row.checkIn)}</td>
                          <td className="px-3 py-1.5">{formatTime(row.checkOut)}</td>
                          <td className="px-3 py-1.5">{row.scheduledStart ? formatTime(row.scheduledStart) : "—"}</td>
                          <td className="px-3 py-1.5 text-xs">{notes.join(" · ")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted-foreground">Không có lượt chấm công GPS hợp lệ nào trong khoảng ngày này.</p>
            )}
            {approved && preview.totals.toInsert > 0 ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">Bảng chấm công kỳ này đã duyệt. Lấy thêm sẽ bỏ trạng thái đã duyệt và cần duyệt lại.</p>
            ) : null}
            <Button className="gap-2" disabled={preview.totals.toInsert === 0 || busy !== null} onClick={() => void runImport()} data-gps-import-run>
              {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Lấy {preview.totals.toInsert} ngày công vào kỳ
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const KIND_LABEL: Record<PeriodScheduleDetailKind, string> = {
  no_show: "Vắng không báo",
  late: "Vào trễ",
  unscheduled: "Đi làm ngày không xếp ca",
  missing_out: "Thiếu giờ ra",
};

function detailText(detail: PeriodScheduleDetail): string {
  const shift = detail.shiftStart ? ` · ca ${formatTime(detail.shiftStart)}` : "";
  const times = detail.checkIn ? ` · vào ${formatTime(detail.checkIn)}${detail.checkOut ? `, ra ${formatTime(detail.checkOut)}` : ""}` : "";
  const late = detail.kind === "late" && detail.minutesLate !== null ? ` ${detail.minutesLate} phút` : "";
  return `${dayLabel(detail.workDate)}: ${KIND_LABEL[detail.kind]}${late}${shift}${times}`;
}

/** Attendance of the period against the published shift schedule, per employee. Read-only. */
export function ScheduleCompareCard({ periodId }: { periodId: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const query = useQuery({
    queryKey: [SUMMARY_KEY, periodId],
    queryFn: () => getPeriodScheduleSummary(client, periodId),
  });
  const summary = query.data;
  const cell = (value: number, warn = false) => <td className={cn("px-2 py-2 text-center tabular-nums", warn && value > 0 && "font-semibold text-red-700")}>{value}</td>;

  return (
    <Card data-schedule-compare>
      <CardHeader>
        <CardTitle className="text-base">Đối chiếu với lịch ca</CardTitle>
        <CardDescription>
          {summary?.coveredFrom && summary.coveredTo
            ? `So bảng chấm công của kỳ với lịch ca đã công bố, từ ${dayLabel(summary.coveredFrom)} đến ${dayLabel(summary.coveredTo)}. Chỉ để tham khảo trước khi duyệt, không tự đổi số công.`
            : "So bảng chấm công của kỳ với lịch ca đã công bố. Chỉ để tham khảo, không tự đổi số công."}
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {query.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
        ) : query.error ? (
          <p className="text-destructive">{errorText(query.error)}</p>
        ) : !summary || summary.employees.length === 0 ? (
          <p className="text-muted-foreground">Kỳ này chưa có ngày nào nằm trong tuần đã công bố lịch ca.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Nhân viên</th>
                  <th className="px-2 py-2 text-center font-medium">Xếp ca</th>
                  <th className="px-2 py-2 text-center font-medium">Đi làm</th>
                  <th className="px-2 py-2 text-center font-medium">Vắng</th>
                  <th className="px-2 py-2 text-center font-medium">Trễ</th>
                  <th className="px-2 py-2 text-center font-medium">Ngoài lịch</th>
                  <th className="px-2 py-2 text-center font-medium">Thiếu giờ ra</th>
                  <th className="px-2 py-2 text-center font-medium">Nghỉ có duyệt</th>
                </tr>
              </thead>
              <tbody>
                {summary.employees.map((employee) => {
                  const expanded = open.has(employee.employeeCode);
                  const hasDetails = employee.details.length > 0;
                  return (
                    <Fragment key={employee.employeeCode}>
                      <tr className="border-t" data-schedule-row={employee.employeeCode}>
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-left disabled:cursor-default"
                            disabled={!hasDetails}
                            aria-expanded={expanded}
                            onClick={() =>
                              setOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(employee.employeeCode)) next.delete(employee.employeeCode);
                                else next.add(employee.employeeCode);
                                return next;
                              })
                            }
                          >
                            {hasDetails ? (expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />) : <span className="w-4 shrink-0" />}
                            <span>{employee.employeeName || employee.employeeCode}</span>
                          </button>
                        </td>
                        {cell(employee.scheduledDays)}
                        {cell(employee.workedDays)}
                        {cell(employee.noShowDays, true)}
                        <td className={cn("whitespace-nowrap px-2 py-2 text-center tabular-nums", employee.lateDays > 0 && "font-semibold text-amber-700")}>
                          {employee.lateDays > 0 ? `${employee.lateDays} ngày · ${employee.lateMinutesTotal}′` : 0}
                        </td>
                        {cell(employee.unscheduledDays)}
                        {cell(employee.missingOutDays, true)}
                        {cell(employee.approvedLeaves)}
                      </tr>
                      {expanded ? (
                        <tr className="border-t bg-muted/30">
                          <td colSpan={8} className="px-3 py-2 text-xs leading-6 text-muted-foreground">
                            {employee.details.map((detail) => (
                              <div key={`${detail.workDate}-${detail.kind}`}>{detailText(detail)}</div>
                            ))}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                <tr className="border-t bg-muted/40 text-xs font-semibold">
                  <td className="px-3 py-2">Tổng {summary.totals.employees} nhân viên</td>
                  {cell(summary.totals.scheduledDays)}
                  {cell(summary.totals.workedDays)}
                  {cell(summary.totals.noShowDays)}
                  <td className="px-2 py-2 text-center tabular-nums">{summary.totals.lateDays}</td>
                  {cell(summary.totals.unscheduledDays)}
                  {cell(summary.totals.missingOutDays)}
                  {cell(summary.totals.approvedLeaves)}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
