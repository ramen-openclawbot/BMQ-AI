import { useState } from "react";
import { Check, ClipboardList, Loader2, TimerOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type {
  PayrollBnShiftAttendanceFlag,
  PayrollBnShiftAttendanceFlagKind,
  PayrollBnShiftRequest,
  PayrollBnShiftRequestState,
} from "@/hooks/usePayrollBnShiftsAdmin";

const WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

function dayLabel(date: string): string {
  const [, m, d] = date.slice(0, 10).split("-");
  return `${WEEKDAYS[new Date(`${date.slice(0, 10)}T00:00:00Z`).getUTCDay()]} ${d}/${m}`;
}

function clock(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

const STATE_LABEL: Record<PayrollBnShiftRequestState, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Không duyệt",
  cancelled: "Nhân viên đã huỷ",
};

const STATE_TONE: Record<PayrollBnShiftRequestState, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  cancelled: "bg-muted text-muted-foreground",
};

const FLAG_LABEL: Record<PayrollBnShiftAttendanceFlagKind, string> = {
  no_show: "Vắng không báo",
  late: "Vào trễ",
  unscheduled: "Đi làm ngày không xếp ca",
  missing_out: "Thiếu giờ ra",
};

const FLAG_TONE: Record<PayrollBnShiftAttendanceFlagKind, string> = {
  no_show: "bg-red-100 text-red-800",
  late: "bg-amber-100 text-amber-800",
  unscheduled: "bg-sky-100 text-sky-800",
  missing_out: "bg-violet-100 text-violet-800",
};

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === "object") as Row[]) : [];
}

/** Plain-language consequences of approving, built from the server's impact block. */
function impactNotes(impact: PayrollBnShiftRequest["impact"], timeOf: (code: string) => string, groupLabel: (group: string) => string): string[] {
  const warnings = impact && typeof impact.warnings === "object" && impact.warnings ? (impact.warnings as Row) : null;
  const coverage = impact && typeof impact.coverage === "object" && impact.coverage ? (impact.coverage as Row) : null;
  if (!warnings) return [];
  const notes: string[] = [];
  for (const item of rows(warnings.below_needed)) notes.push(`ca ${timeOf(String(item.code))} còn ${item.registered}/${item.needed} người`);
  for (const item of rows(warnings.below_quota_group)) notes.push(`${groupLabel(String(item.quota_group))} còn ${item.registered}/${item.needed} người`);
  for (const item of rows(warnings.over_needed)) notes.push(`ca ${timeOf(String(item.code))} thành ${item.registered}/${item.needed} người`);
  for (const item of rows(warnings.over_quota_group)) notes.push(`${groupLabel(String(item.quota_group))} thành ${item.registered}/${item.needed} người`);
  if (warnings.below_min_staff === true) notes.push(`cả ngày còn ${coverage?.total_staff ?? "?"} người, dưới tối thiểu ${warnings.min_staff_per_day}`);
  if (warnings.off_above_max === true) notes.push(`${coverage?.off_count ?? "?"} người nghỉ, quá giới hạn ${warnings.max_off_per_day}`);
  return notes;
}

export interface ShiftRequestsAdminProps {
  published: boolean;
  requests: PayrollBnShiftRequest[];
  requestsLoading: boolean;
  flags: PayrollBnShiftAttendanceFlag[];
  flagsLoading: boolean;
  deciding: boolean;
  timeOf: (code: string) => string;
  groupLabel: (group: string) => string;
  onDecide: (request: PayrollBnShiftRequest, approve: boolean, note: string) => Promise<boolean>;
}

/** Manager side of phase 2: change/leave requests to decide, and attendance that differs from the published schedule. */
export function ShiftRequestsAdmin({ published, requests, requestsLoading, flags, flagsLoading, deciding, timeOf, groupLabel, onDecide }: ShiftRequestsAdminProps) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const pending = requests.filter((item) => item.state === "pending");
  const decided = requests.filter((item) => item.state !== "pending");

  const describe = (request: PayrollBnShiftRequest) =>
    request.kind === "leave"
      ? `xin nghỉ ca ${request.from_shift_code ? timeOf(request.from_shift_code) : "—"}`
      : request.from_shift_code
        ? `đổi ca ${timeOf(request.from_shift_code)} → ${timeOf(request.to_shift_code ?? "")}`
        : `xin đi làm ca ${timeOf(request.to_shift_code ?? "")} (đang nghỉ)`;

  const decide = async (request: PayrollBnShiftRequest, approve: boolean) => {
    setActing(`${request.id}-${approve ? "a" : "r"}`);
    const ok = await onDecide(request, approve, (notes[request.id] ?? "").trim());
    if (ok) setNotes((prev) => ({ ...prev, [request.id]: "" }));
    setActing(null);
  };

  return (
    <>
      <Card className={cn(pending.length > 0 && "border-amber-300")} data-shift-requests-admin>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className={cn("h-4 w-4", pending.length > 0 ? "text-amber-600" : "text-muted-foreground")} />
            Yêu cầu đổi ca, nghỉ đột xuất
            {pending.length > 0 ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">{pending.length} chờ duyệt</span> : null}
          </CardTitle>
          <CardDescription>Duyệt thì lịch ngày đó đổi ngay, không cần mở lại tuần. Từ chối thì lịch giữ nguyên.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {requestsLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Đang tải yêu cầu" />
          ) : requests.length === 0 ? (
            <p className="text-muted-foreground">Tuần này chưa có yêu cầu nào.</p>
          ) : null}

          {pending.map((request) => {
            const stale = request.current_shift_code !== request.from_shift_code;
            const impact = impactNotes(request.impact, timeOf, groupLabel);
            return (
              <div key={request.id} className="rounded-lg border p-3" data-shift-request-pending={request.employee_code}>
                <p className="font-medium">
                  {request.employee_name || request.employee_code} · {dayLabel(request.work_date)} · {describe(request)}
                </p>
                <p className="mt-0.5 break-words text-muted-foreground">Lý do: {request.reason}</p>
                {stale ? (
                  <p className="mt-1.5 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
                    Ô lịch này đã được đổi sau khi nhân viên gửi yêu cầu nên không duyệt được. Hãy từ chối và nhờ nhân viên gửi lại nếu vẫn cần.
                  </p>
                ) : impact.length > 0 ? (
                  <p className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900" data-shift-request-impact>
                    Nếu duyệt: {impact.join(" · ")}.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-emerald-700">Nếu duyệt: ngày này vẫn đủ người.</p>
                )}
                <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={notes[request.id] ?? ""}
                    maxLength={1000}
                    onChange={(event) => setNotes((prev) => ({ ...prev, [request.id]: event.target.value }))}
                    placeholder="Ghi chú cho nhân viên (tuỳ chọn)"
                    aria-label="Ghi chú cho nhân viên"
                    className="h-9 min-w-0 flex-1"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1 gap-1.5 sm:flex-none" disabled={deciding || stale} onClick={() => void decide(request, true)} data-shift-decide="approve">
                      {acting === `${request.id}-a` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Duyệt
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1 gap-1.5 sm:flex-none" disabled={deciding} onClick={() => void decide(request, false)} data-shift-decide="reject">
                      {acting === `${request.id}-r` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Từ chối
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {decided.length > 0 ? (
            <ul className="divide-y rounded-lg border">
              {decided.map((request) => (
                <li key={request.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3" data-shift-request-decided={request.state}>
                  <div className="min-w-0">
                    <p>{request.employee_name || request.employee_code} · {dayLabel(request.work_date)} · {describe(request)}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      Lý do: {request.reason}{request.decision_note ? ` · Ghi chú: ${request.decision_note}` : ""}
                    </p>
                  </div>
                  <span className={cn("w-fit shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold", STATE_TONE[request.state])}>{STATE_LABEL[request.state]}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card data-shift-flags>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TimerOff className={cn("h-4 w-4", flags.length > 0 ? "text-amber-600" : "text-muted-foreground")} /> Chấm công lệch lịch
          </CardTitle>
          <CardDescription>So chấm công GPS với lịch đã công bố, tính đến hôm nay. Ngày đã được quản lý duyệt công thì không hiện.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {!published ? (
            <p className="text-muted-foreground">Chỉ có sau khi lịch tuần được công bố.</p>
          ) : flagsLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Đang tải" />
          ) : flags.length === 0 ? (
            <p className="text-muted-foreground">Chưa có ngày nào lệch lịch.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/40 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Ngày</th>
                    <th className="px-3 py-2 text-left font-medium">Nhân viên</th>
                    <th className="px-3 py-2 text-left font-medium">Ca</th>
                    <th className="px-3 py-2 text-left font-medium">Lệch</th>
                    <th className="px-3 py-2 text-left font-medium">Vào</th>
                    <th className="px-3 py-2 text-left font-medium">Ra</th>
                  </tr>
                </thead>
                <tbody>
                  {flags.map((flag) => (
                    <tr key={`${flag.work_date}-${flag.employee_code}-${flag.kind}`} className="border-t" data-shift-flag={flag.kind}>
                      <td className="whitespace-nowrap px-3 py-2">{dayLabel(flag.work_date)}</td>
                      <td className="px-3 py-2">{flag.name || flag.employee_code}</td>
                      <td className="whitespace-nowrap px-3 py-2">{flag.shift_start ?? "Không xếp"}</td>
                      <td className="px-3 py-2">
                        <span className={cn("inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold", FLAG_TONE[flag.kind])}>
                          {FLAG_LABEL[flag.kind]}{flag.kind === "late" && flag.minutes_late !== null ? ` ${flag.minutes_late} phút` : ""}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{clock(flag.check_in_at)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{clock(flag.check_out_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default ShiftRequestsAdmin;
