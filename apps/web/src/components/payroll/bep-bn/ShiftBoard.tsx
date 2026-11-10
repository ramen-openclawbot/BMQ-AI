import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Plus, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  usePayrollBnShiftsAdmin,
  type PayrollBnShiftBoard,
  type PayrollBnShiftEmployee,
  type PayrollBnShiftType,
} from "@/hooks/usePayrollBnShiftsAdmin";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const DOW_NAMES = ["", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"];
const OFF = "__off";
const TONES = ["bg-violet-100 text-violet-800", "bg-sky-100 text-sky-800", "bg-pink-100 text-pink-800", "bg-amber-100 text-amber-800", "bg-emerald-100 text-emerald-800", "bg-indigo-100 text-indigo-800"];

function addDays(date: string, days: number): string {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function nextMonday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  return addDays(today, 8 - dow);
}

function dayMonth(date: string): string {
  const [, m, d] = date.slice(0, 10).split("-");
  return `${d}/${m}`;
}

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay()];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Không thực hiện được. Vui lòng thử lại.";
}

/** Manager week board: who works which shift, coverage against the needed headcount, publish. */
export function ShiftBoard() {
  const [weekStart, setWeekStart] = useState(nextMonday);
  const admin = usePayrollBnShiftsAdmin({ weekStart });
  const { toast } = useToast();
  const [configOpen, setConfigOpen] = useState(false);
  const board = admin.board;

  const run = async (action: () => Promise<unknown>, done: string) => {
    try {
      await action();
      toast({ title: done });
    } catch (error) {
      toast({ title: "Không thực hiện được", description: errorText(error), variant: "destructive" });
    }
  };

  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const closed = new Set(board?.week?.closed_dates ?? []);
  const published = board?.week?.status === "published";
  const types = board?.shift_types ?? [];
  const toneOf = (code: string) => TONES[Math.max(0, types.findIndex((type) => type.code === code)) % TONES.length];
  const timeOf = (code: string) => types.find((type) => type.code === code)?.start_time ?? code;
  const nameOf = (code: string) => board?.employees.find((employee) => employee.employee_code === code)?.employee_name ?? code;

  return (
    <div className="space-y-4" data-shift-board>
      <Card>
        <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Tuần trước">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Xếp ca tuần {dayMonth(weekStart)} – {dayMonth(addDays(weekStart, 6))}</span>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Tuần sau">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </CardTitle>
            <CardDescription>
              {board
                ? `Đã đăng ký ${board.totals.employees - board.totals.unregistered}/${board.totals.employees} · ${published ? "đã công bố" : "chưa công bố"}`
                : "Đang tải…"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setConfigOpen(true)} disabled={!board}>
              <Settings2 className="h-4 w-4" /> Ca và số người cần
            </Button>
            {published ? (
              <Button variant="outline" size="sm" disabled={admin.reopen.isPending} onClick={() => run(() => admin.reopen.mutateAsync({ weekStart }), "Đã mở lại đăng ký")}>
                Mở lại đăng ký
              </Button>
            ) : (
              <Button size="sm" disabled={!board || types.length === 0 || admin.publish.isPending} data-shift-publish onClick={() => run(() => admin.publish.mutateAsync({ weekStart }), "Đã công bố lịch tuần")}>
                {admin.publish.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Duyệt và công bố
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {admin.boardQuery.isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Đang tải bảng xếp ca" /></div>
          ) : admin.boardQuery.error ? (
            <p className="text-sm text-destructive">{errorText(admin.boardQuery.error)}</p>
          ) : !board || types.length === 0 ? (
            <p className="text-sm text-muted-foreground">Chưa có ca nào. Bấm “Ca và số người cần” để thêm ca trước khi mở đăng ký.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-xs">
                  <tr className="bg-muted/40">
                    <th className="sticky left-0 z-10 min-w-[150px] bg-muted/40 px-3 py-2 text-left font-medium">Nhân viên</th>
                    {dates.map((date) => (
                      <th key={date} className="px-1.5 py-2 text-center font-medium">
                        <div>{weekdayOf(date)} {dayMonth(date)}</div>
                        <button
                          type="button"
                          className={cn("mt-0.5 rounded px-1.5 text-[10px] font-normal underline-offset-2 hover:underline", closed.has(date) ? "text-red-700" : "text-muted-foreground")}
                          onClick={() => {
                            const next = new Set(closed);
                            if (next.has(date)) next.delete(date);
                            else next.add(date);
                            void run(() => admin.setClosedDates.mutateAsync({ weekStart, dates: [...next].sort() }), next.has(date) ? "Đã đặt ngày bếp nghỉ" : "Đã mở lại ngày");
                          }}
                        >
                          {closed.has(date) ? "Bếp nghỉ · mở lại" : "Đặt bếp nghỉ"}
                        </button>
                      </th>
                    ))}
                    <th className="px-2 py-2 text-center font-medium">Ngày làm</th>
                  </tr>
                </thead>
                <tbody>
                  {board.employees.map((employee) => (
                    <EmployeeRow
                      key={employee.employee_code}
                      employee={employee}
                      dates={dates}
                      closed={closed}
                      types={types}
                      toneOf={toneOf}
                      busy={admin.setEntry.isPending}
                      onChange={(workDate, shiftCode) =>
                        run(
                          () => admin.setEntry.mutateAsync({ weekStart, employeeCode: employee.employee_code, workDate, shiftCode }),
                          `Đã xếp ${employee.employee_name} ${weekdayOf(workDate)}: ${shiftCode === null ? "Nghỉ" : timeOf(shiftCode)}`,
                        )
                      }
                    />
                  ))}
                  <CoverageRows board={board} dates={dates} closed={closed} timeOf={timeOf} />
                </tbody>
              </table>
            </div>
          )}
          {board && types.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {types.map((type) => (
                <span key={type.code} className={cn("rounded-md px-2 py-0.5 font-semibold", toneOf(type.code))}>{type.start_time}</span>
              ))}
              <span className="rounded-md bg-muted px-2 py-0.5 font-semibold">Nghỉ</span>
              <span>· ô nét đứt = gợi ý theo tuần trước (chưa đăng ký) · viền cam = danh sách chờ · số đỏ = thiếu người</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {board && types.length > 0 ? (
        <Card className={cn(hasWarnings(board) && "border-amber-300")}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className={cn("h-4 w-4", hasWarnings(board) ? "text-amber-600" : "text-muted-foreground")} /> Việc cần xử lý
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!hasWarnings(board) ? <p className="text-muted-foreground">Không có gì cần xử lý cho tuần này.</p> : null}
            {board.warnings.unregistered.length > 0 ? (
              <p><b>Chưa đăng ký ({board.warnings.unregistered.length}):</b> {board.warnings.unregistered.map(nameOf).join(", ")}. Khi công bố, app lấy lịch gợi ý theo tuần trước cho những người này.</p>
            ) : null}
            {dates.filter((date) => !closed.has(date)).map((date) => {
              const short = shortages(board, closed).filter((item) => item.workDate === date);
              const low = board.warnings.below_min_staff.find((item) => item.work_date === date);
              const off = board.warnings.off_above_max.find((item) => item.work_date === date);
              if (short.length === 0 && !low && !off) return null;
              const notes = [
                ...short.map((item) => `ca ${item.codes.map(timeOf).join(" + ")} có ${item.registered}/${item.needed}`),
                ...(low ? [`tổng ${low.total_staff} người, dưới tối thiểu ${low.min_staff_per_day}`] : []),
                ...(off ? [`${off.off_count} người nghỉ, quá giới hạn ${off.max_off_per_day}`] : []),
              ];
              return (
                <p key={date}><b>{weekdayOf(date)} {dayMonth(date)}:</b> {notes.join(" · ")}.</p>
              );
            })}
            {board.totals.waitlist > 0 ? <p><b>Danh sách chờ:</b> {board.totals.waitlist} ô viền cam. Chọn lại ca trong ô để xếp chính thức.</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {board ? (
        <ConfigDialog
          key={configOpen ? "open" : "closed"}
          open={configOpen}
          board={board}
          saving={admin.upsertConfig.isPending}
          onClose={() => setConfigOpen(false)}
          onSave={async (config) => {
            await run(() => admin.upsertConfig.mutateAsync({ config }), "Đã lưu ca và số người cần");
            setConfigOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Shifts short of people; shifts sharing a quota group are reported once. */
function shortages(board: PayrollBnShiftBoard, closed: Set<string>) {
  const list: { key: string; workDate: string; codes: string[]; registered: number; needed: number }[] = [];
  for (const day of board.coverage.dates) {
    if (closed.has(day.work_date)) continue;
    for (const shift of day.shifts) {
      if (!shift.quota_group && shift.registered < shift.needed) {
        list.push({ key: `${day.work_date}-${shift.code}`, workDate: day.work_date, codes: [shift.code], registered: shift.registered, needed: shift.needed });
      }
    }
    for (const group of day.quota_groups) {
      if (group.registered < group.needed) {
        list.push({
          key: `${day.work_date}-g-${group.quota_group}`,
          workDate: day.work_date,
          codes: day.shifts.filter((shift) => shift.quota_group === group.quota_group).map((shift) => shift.code),
          registered: group.registered,
          needed: group.needed,
        });
      }
    }
  }
  return list;
}

function hasWarnings(board: PayrollBnShiftBoard): boolean {
  const closed = new Set(board.week?.closed_dates ?? []);
  const open = <T extends { work_date: string }>(list: T[]) => list.some((item) => !closed.has(item.work_date));
  return board.warnings.unregistered.length > 0 || shortages(board, closed).length > 0 || open(board.warnings.below_min_staff) || open(board.warnings.off_above_max) || board.totals.waitlist > 0;
}

function EmployeeRow({
  employee,
  dates,
  closed,
  types,
  toneOf,
  busy,
  onChange,
}: {
  employee: PayrollBnShiftEmployee;
  dates: string[];
  closed: Set<string>;
  types: PayrollBnShiftType[];
  toneOf: (code: string) => string;
  busy: boolean;
  onChange: (workDate: string, shiftCode: string | null) => void;
}) {
  const workDays = employee.entries.filter((entry) => entry.shift_code !== null && entry.state === "registered").length;
  return (
    <tr className="border-t">
      <td className="sticky left-0 z-10 bg-card px-3 py-1.5">
        <div className="truncate font-medium">{employee.employee_name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {employee.employee_code}
          {employee.employment_type === "part_time" ? " · part-time" : ""}
          {!employee.has_entries ? <span className="text-destructive"> · chưa đăng ký</span> : null}
        </div>
      </td>
      {dates.map((date) => {
        if (closed.has(date)) return <td key={date} className="px-1.5 py-1.5 text-center text-xs text-muted-foreground">—</td>;
        const entry = employee.entries.find((item) => item.work_date === date);
        const suggestion = entry ? undefined : employee.suggestions.find((item) => item.work_date === date);
        const value = entry ? (entry.shift_code ?? OFF) : "";
        const suggestionLabel = suggestion ? `${suggestion.shift_code === null ? "Nghỉ" : types.find((type) => type.code === suggestion.shift_code)?.start_time ?? suggestion.shift_code}?` : "—";
        return (
          <td key={date} className="px-1.5 py-1.5 text-center">
            <select
              value={value}
              disabled={busy}
              aria-label={`${employee.employee_name} ${dayMonth(date)}`}
              title={entry?.source === "manager" ? "Quản lý xếp" : entry?.source === "carried" ? "Theo tuần trước" : undefined}
              data-shift-cell={`${employee.employee_code}|${date}`}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "") return;
                onChange(date, next === OFF ? null : next);
              }}
              className={cn(
                "h-8 w-[68px] cursor-pointer appearance-none rounded-md border px-1 text-center text-xs font-semibold [text-align-last:center]",
                !entry && "border-dashed border-muted-foreground/40 bg-background text-muted-foreground",
                entry && entry.shift_code === null && "border-transparent bg-muted text-muted-foreground",
                entry && entry.shift_code !== null && cn("border-transparent", toneOf(entry.shift_code)),
                entry?.state === "waitlist" && "outline outline-2 outline-amber-500",
              )}
            >
              {!entry ? <option value="">{suggestionLabel}</option> : null}
              {types.map((type) => (
                <option key={type.code} value={type.code}>{type.start_time}</option>
              ))}
              <option value={OFF}>Nghỉ</option>
            </select>
          </td>
        );
      })}
      <td className="px-2 py-1.5 text-center text-xs">{employee.has_entries ? workDays : "—"}</td>
    </tr>
  );
}

function CoverageRows({ board, dates, closed, timeOf }: { board: PayrollBnShiftBoard; dates: string[]; closed: Set<string>; timeOf: (code: string) => string }) {
  const first = board.coverage.dates[0];
  if (!first) return null;
  const grouped = new Set(first.shifts.filter((shift) => shift.quota_group).map((shift) => shift.code));
  const rows: { key: string; label: string; cell: (date: string) => { registered: number; needed: number } | null }[] = [];
  for (const shift of first.shifts) {
    if (grouped.has(shift.code)) continue;
    rows.push({
      key: shift.code,
      label: `Ca ${timeOf(shift.code)}`,
      cell: (date) => board.coverage.dates.find((day) => day.work_date === date)?.shifts.find((item) => item.code === shift.code) ?? null,
    });
  }
  for (const group of first.quota_groups) {
    const members = first.shifts.filter((shift) => shift.quota_group === group.quota_group).map((shift) => timeOf(shift.code));
    rows.push({
      key: `g-${group.quota_group}`,
      label: `Ca ${members.join(" + ")}`,
      cell: (date) => board.coverage.dates.find((day) => day.work_date === date)?.quota_groups.find((item) => item.quota_group === group.quota_group) ?? null,
    });
  }
  const minStaff = board.settings.min_staff_per_day;
  return (
    <>
      {rows.map((row) => (
        <tr key={row.key} className="border-t bg-muted/30 text-xs font-semibold">
          <td className="sticky left-0 z-10 bg-muted/60 px-3 py-1.5">{row.label} · cần {row.cell(dates[0])?.needed ?? 0}</td>
          {dates.map((date) => {
            const cell = row.cell(date);
            if (closed.has(date) || !cell) return <td key={date} className="py-1.5 text-center text-muted-foreground">—</td>;
            return <td key={date} className={cn("py-1.5 text-center", cell.registered < cell.needed ? "text-red-700" : "text-emerald-700")}>{cell.registered}/{cell.needed}</td>;
          })}
          <td />
        </tr>
      ))}
      <tr className="border-t bg-muted/30 text-xs font-semibold">
        <td className="sticky left-0 z-10 bg-muted/60 px-3 py-1.5">Tổng đi làm · tối thiểu {minStaff}</td>
        {dates.map((date) => {
          const day = board.coverage.dates.find((item) => item.work_date === date);
          if (closed.has(date) || !day) return <td key={date} className="py-1.5 text-center text-muted-foreground">—</td>;
          return <td key={date} className={cn("py-1.5 text-center", day.total_staff < minStaff ? "text-red-700" : "text-emerald-700")}>{day.total_staff}</td>;
        })}
        <td />
      </tr>
    </>
  );
}

interface ShiftDraft {
  code: string;
  startTime: string;
  needed: string;
  group: string;
  existing: boolean;
}

function ConfigDialog({
  open,
  board,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  board: PayrollBnShiftBoard;
  saving: boolean;
  onClose: () => void;
  onSave: (config: Parameters<ReturnType<typeof usePayrollBnShiftsAdmin>["upsertConfig"]["mutateAsync"]>[0]["config"]) => Promise<void>;
}) {
  const [rows, setRows] = useState<ShiftDraft[]>(() =>
    board.shift_types.map((type) => {
      const quota = board.quotas.find((item) => item.shift_code === type.code && item.iso_dow === null);
      return { code: type.code, startTime: type.start_time, needed: String(quota?.needed ?? 0), group: quota?.quota_group ?? "", existing: true };
    }),
  );
  const [maxOff, setMaxOff] = useState(String(board.settings.max_off_per_day));
  const [minStaff, setMinStaff] = useState(String(board.settings.min_staff_per_day));
  const [deadlineDow, setDeadlineDow] = useState(String(board.settings.deadline_iso_dow));
  const [deadlineTime, setDeadlineTime] = useState(String(board.settings.deadline_time).slice(0, 5));
  const [openDow, setOpenDow] = useState(String(board.settings.open_iso_dow));

  const set = (index: number, patch: Partial<ShiftDraft>) => setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const timeOk = (value: string) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  const numOk = (value: string) => /^\d+$/.test(value.trim());
  const starts = rows.map((row) => row.startTime);
  const valid =
    rows.length > 0 &&
    rows.every((row) => timeOk(row.startTime) && numOk(row.needed)) &&
    new Set(starts).size === starts.length &&
    numOk(maxOff) && numOk(minStaff) && timeOk(deadlineTime);

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !saving ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Ca và số người cần</DialogTitle>
          <DialogDescription>Áp dụng cho mọi tuần chưa công bố. Hai ca cùng “nhóm” dùng chung một số người cần.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs font-medium text-muted-foreground">
            <span>Giờ vào ca</span><span>Số người cần</span><span>Nhóm (tuỳ chọn)</span><span />
          </div>
          {rows.map((row, index) => (
            <div key={`${row.code}-${index}`} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
              <Input type="time" value={row.startTime} disabled={row.existing} onChange={(e) => set(index, { startTime: e.target.value })} aria-label="Giờ vào ca" />
              <Input inputMode="numeric" value={row.needed} onChange={(e) => set(index, { needed: e.target.value })} aria-label="Số người cần" />
              <Input value={row.group} onChange={(e) => set(index, { group: e.target.value })} placeholder="vd: sang" aria-label="Nhóm" />
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))} aria-label="Xoá ca">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => setRows((prev) => [...prev, { code: "", startTime: "", needed: "1", group: "", existing: false }])}>
            <Plus className="h-4 w-4" /> Thêm ca
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="shift-min-staff">Tối thiểu người đi làm mỗi ngày</Label><Input id="shift-min-staff" inputMode="numeric" value={minStaff} onChange={(e) => setMinStaff(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="shift-max-off">Tối đa người nghỉ mỗi ngày</Label><Input id="shift-max-off" inputMode="numeric" value={maxOff} onChange={(e) => setMaxOff(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="shift-open-dow">Mở đăng ký từ</Label>
            <select id="shift-open-dow" value={openDow} onChange={(e) => setOpenDow(e.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm">
              {[1, 2, 3, 4, 5, 6, 7].map((dow) => <option key={dow} value={dow}>{DOW_NAMES[dow]} tuần trước</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shift-deadline-dow">Hạn chót đăng ký</Label>
            <div className="flex gap-2">
              <select id="shift-deadline-dow" value={deadlineDow} onChange={(e) => setDeadlineDow(e.target.value)} className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm">
                {[1, 2, 3, 4, 5, 6, 7].map((dow) => <option key={dow} value={dow}>{DOW_NAMES[dow]}</option>)}
              </select>
              <Input type="time" className="w-28" value={deadlineTime} onChange={(e) => setDeadlineTime(e.target.value)} aria-label="Giờ hạn chót" />
            </div>
          </div>
        </div>
        {!valid ? <p className="text-xs text-destructive">Kiểm tra lại: giờ vào ca không trùng nhau và đúng dạng HH:MM, số người là số nguyên.</p> : null}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>Huỷ</Button>
          <Button
            disabled={!valid || saving}
            onClick={() =>
              void onSave({
                shift_types: rows.map((row, index) => ({
                  code: row.existing ? row.code : `ca-${row.startTime.replace(":", "")}`,
                  label: `Ca ${row.startTime}`,
                  start_time: row.startTime,
                  sort: index + 1,
                  active: true,
                })),
                quotas: rows.map((row) => ({
                  shift_code: row.existing ? row.code : `ca-${row.startTime.replace(":", "")}`,
                  iso_dow: null,
                  needed: Number(row.needed),
                  quota_group: row.group.trim() === "" ? null : row.group.trim(),
                })),
                settings: {
                  max_off_per_day: Number(maxOff),
                  min_staff_per_day: Number(minStaff),
                  deadline_iso_dow: Number(deadlineDow),
                  deadline_time: deadlineTime,
                  open_iso_dow: Number(openDow),
                },
              })
            }
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ShiftBoard;
