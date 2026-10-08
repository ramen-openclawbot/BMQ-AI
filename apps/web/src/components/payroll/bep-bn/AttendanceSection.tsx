import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2, ShieldCheck, Upload, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { AttendanceParseError, parseAttendanceFile, type AttendanceFileParseResult } from "@/lib/payroll-bn/attendance-parser.ts";
import { detectAnomalies, type Anomaly } from "@/lib/payroll-bn/anomalies.ts";
import { issueKey, requiresReview, reviewKey, summarizeIssues } from "@/lib/payroll-bn/issue-review.ts";
import type { AttendanceRow } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";
import { ANOMALY_LABELS, datesBetween, formatDayMonth, formatTime } from "./format";

// The month is taken from the file itself, so parsing accepts any date and the
// data layer refuses a file that spans two months.
const ANY_DATE = { dateFrom: "2000-01-01", dateTo: "2099-12-31" };

interface PendingFile {
  fileName: string;
  parsed: AttendanceFileParseResult;
  month: string;
}

/** Step 1 — upload. Creates the month's period and catalogue automatically. */
export function UploadCard({
  source,
  canEdit,
  onImported,
}: {
  source: BepBnDataSource;
  canEdit: boolean;
  onImported: (periodId: string) => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setPending(null);
    setParsing(true);
    try {
      const parsed = await parseAttendanceFile(new Uint8Array(await file.arrayBuffer()), ANY_DATE);
      const months = [...new Set(parsed.rows.map((row) => row.date.slice(0, 7)))].sort();
      if (months.length !== 1) {
        throw new AttendanceParseError(
          "date_out_of_period",
          months.length === 0 ? "File không có ngày chấm công nào." : "File có ngày của nhiều tháng; mỗi lần chỉ nhập một tháng.",
        );
      }
      const [year, month] = months[0].split("-");
      setPending({ fileName: file.name, parsed, month: `${month}/${year}` });
    } catch (error) {
      setParseError(error instanceof AttendanceParseError ? error.message : "Không đọc được file chấm công.");
    } finally {
      setParsing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleSave = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      const result = await source.importFile({
        fileName: pending.fileName,
        sha256: pending.parsed.sha256,
        rows: pending.parsed.rows,
      });
      const added = result.addedEmployees > 0 ? ` Đã thêm ${result.addedEmployees} nhân viên vào danh mục.` : "";
      toast({
        title: result.alreadyImported ? "File này đã được nhập trước đó" : `Đã nhập chấm công tháng ${pending.month}`,
        description: (result.alreadyImported ? "Không tạo bản ghi trùng." : `${result.insertedRows} dòng đã lưu.`) + added,
      });
      setPending(null);
      onImported(result.periodId);
    } catch (error) {
      toast({
        title: "Không lưu được chấm công",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileSpreadsheet className="h-4 w-4" />
          Upload bảng chấm công
        </CardTitle>
        <CardDescription>
          File xuất từ máy chấm công (.xls hoặc .xlsx). Hệ thống tự nhận tháng, tạo kỳ lương và thêm nhân viên mới vào danh mục.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            ref={inputRef}
            type="file"
            accept=".xls,.xlsx"
            disabled={!canEdit || parsing || saving}
            onChange={(event) => void handleFile(event.target.files?.[0])}
            className="sm:max-w-sm"
            aria-label="Chọn file chấm công"
          />
          {pending ? (
            <div className="flex gap-2">
              <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Lưu tháng {pending.month}
              </Button>
              <Button variant="outline" onClick={() => setPending(null)} disabled={saving}>
                Huỷ
              </Button>
            </div>
          ) : null}
          {parsing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
        </div>
        {!canEdit ? <p className="text-sm text-muted-foreground">Chỉ người có quyền sửa lương mới upload được.</p> : null}
        {parseError ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {parseError}
          </div>
        ) : null}
        {pending ? (
          <div className="rounded-md border border-blue-500/30 bg-blue-50/40 px-3 py-2 text-sm dark:bg-blue-950/10">
            <p className="font-medium break-all">{pending.fileName}</p>
            <p className="text-muted-foreground">
              Tháng {pending.month} · {pending.parsed.rows.length} dòng ·{" "}
              {new Set(pending.parsed.rows.map((row) => row.employeeCode)).size} mã nhân viên · chưa lưu
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface AttendanceSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
  onOpenEmployees: () => void;
  onApproved: () => void;
}

/** Steps 2–3 — see the attendance, decide each issue, approve. */
export function AttendanceSection({ data, source, canEdit, onOpenEmployees, onApproved }: AttendanceSectionProps) {
  const anomalies = useMemo(
    () => detectAnomalies({ period: data.period, employees: data.employees, rows: data.rows }),
    [data.period, data.employees, data.rows],
  );
  const unknownCodes = useMemo(
    () => new Set(anomalies.filter((item) => item.code === "unknown_employee").map((item) => item.employeeCode)),
    [anomalies],
  );

  return (
    <div className="space-y-4">
      <ImportHistory data={data} />
      {unknownCodes.size > 0 ? (
        <Card className="border-amber-500/40">
          <CardContent className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span>
              {unknownCodes.size} mã chấm công chưa có trong danh mục nhân viên: {[...unknownCodes].sort().join(", ")}.
            </span>
            <Button variant="outline" size="sm" className="gap-2 self-start" onClick={onOpenEmployees}>
              <Users className="h-4 w-4" />
              Mở tab Nhân viên
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <IssueReviewCard data={data} source={source} canEdit={canEdit} anomalies={anomalies} onApproved={onApproved} />
      <AttendanceGrid data={data} rows={data.rows} anomalies={anomalies} />
    </div>
  );
}

function ImportHistory({ data }: { data: BepBnPeriodData }) {
  if (data.imports.length === 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      File đã nhập:{" "}
      {data.imports.map((item, index) => (
        <span key={item.id}>
          {index > 0 ? "; " : ""}
          <span className="font-medium text-foreground break-all">{item.fileName}</span> ({item.rowCount} dòng,{" "}
          {item.importedAt.slice(0, 16).replace("T", " ")})
        </span>
      ))}
    </p>
  );
}

const BULK_CONCURRENCY = 6;

function IssueReviewCard({
  data,
  source,
  canEdit,
  anomalies,
  onApproved,
}: {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
  anomalies: Anomaly[];
  onApproved: () => void;
}) {
  const { toast } = useToast();
  const [onlyPending, setOnlyPending] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [excluding, setExcluding] = useState<Anomaly | null>(null);
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);

  const locked = data.period.status === "locked";
  const approved = Boolean(source.attendanceApprovedAt);
  const canDecide = canEdit && !locked && !approved;
  const reviewable = useMemo(() => anomalies.filter(requiresReview), [anomalies]);
  const reviews = useMemo(() => new Map(source.issueReviews.map((item) => [reviewKey(item), item])), [source.issueReviews]);
  const summary = summarizeIssues(anomalies, source.issueReviews);
  const visible = onlyPending ? reviewable.filter((item) => !reviews.has(issueKey(item))) : reviewable;

  const decide = async (item: Anomaly, decision: "accepted" | "excluded", reason?: string) => {
    await source.reviewIssue(data.id, {
      employeeCode: item.employeeCode,
      workDate: item.date as string,
      issueCode: item.code,
      decision,
      note: reason ?? null,
    });
  };

  const run = async (key: string, action: () => Promise<void>, success?: string) => {
    setBusy(key);
    try {
      await action();
      if (success) toast({ title: success });
    } catch (error) {
      toast({
        title: "Không lưu được",
        description: error instanceof Error ? error.message : "Vui lòng thử lại.",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const acceptAllPending = () =>
    run(
      "bulk",
      async () => {
        const queue = reviewable.filter((item) => !reviews.has(issueKey(item)));
        let next = 0;
        const worker = async () => {
          while (next < queue.length) {
            const item = queue[next++];
            await decide(item, "accepted");
          }
        };
        await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, worker));
      },
      "Đã chấp nhận các vấn đề còn lại",
    );

  const confirmExclude = () => {
    setNoteTouched(true);
    if (!excluding || note.trim() === "") return;
    const item = excluding;
    void run(issueKey(item), async () => {
      await decide(item, "excluded", note.trim());
      setExcluding(null);
    });
  };

  const approve = () =>
    run(
      "approve",
      async () => {
        await source.setAttendanceApproved(data.id, true);
        onApproved();
      },
      "Đã duyệt bảng chấm công — bảng lương đã được tạo",
    );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Vấn đề cần xử lý
          <Badge variant={summary.pending === 0 ? "secondary" : "outline"}>
            {summary.reviewed}/{summary.total} đã xử lý
          </Badge>
        </CardTitle>
        <CardDescription>
          Hệ thống tự tìm các ngày thiếu giờ vào/ra, máy không có số liệu, trùng giờ với người khác, chấm công ngày lễ. Chấp nhận để tính như bình thường, hoặc không tính ngày đó (bắt buộc ghi lý do).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-3 rounded-md border bg-muted/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          {approved ? (
            <span className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Đã duyệt bảng chấm công lúc {String(source.attendanceApprovedAt).slice(0, 16).replace("T", " ")}.
            </span>
          ) : (
            <span className="text-sm">
              {summary.pending > 0
                ? `Còn ${summary.pending} vấn đề chưa xử lý. Xử lý hết để duyệt bảng chấm công.`
                : "Đã xử lý hết. Duyệt bảng chấm công để tạo bảng lương."}
            </span>
          )}
          <div className="flex flex-wrap gap-2">
            {!approved && summary.pending > 0 && canDecide ? (
              <Button variant="outline" disabled={busy !== null} onClick={() => void acceptAllPending()} className="gap-2">
                {busy === "bulk" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Chấp nhận tất cả còn lại
              </Button>
            ) : null}
            {!approved && canEdit && !locked ? (
              <Button disabled={summary.pending > 0 || busy !== null} onClick={() => void approve()} className="gap-2">
                {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Duyệt bảng chấm công
              </Button>
            ) : null}
            {approved && canEdit && !locked ? (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void run("unapprove", () => source.setAttendanceApproved(data.id, false), "Đã bỏ duyệt, có thể sửa lại")}
              >
                Bỏ duyệt để sửa
              </Button>
            ) : null}
          </div>
        </div>

        {summary.total > 0 ? (
          <div className="flex items-center gap-2">
            <Switch id="bep-bn-only-pending" checked={onlyPending} onCheckedChange={setOnlyPending} />
            <Label htmlFor="bep-bn-only-pending" className="text-sm font-normal">
              Chỉ hiện vấn đề chưa xử lý
            </Label>
          </div>
        ) : null}

        {summary.total === 0 ? (
          <p className="text-sm text-muted-foreground">Không có vấn đề nào cần xử lý.</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Đã xử lý hết các vấn đề.</p>
        ) : (
          <ul className="max-h-[420px] divide-y overflow-y-auto rounded-md border">
            {visible.map((item) => {
              const key = issueKey(item);
              const review = reviews.get(key);
              return (
                <li key={key} className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={cn(item.severity === "error" && "border-destructive text-destructive")}>
                        {ANOMALY_LABELS[item.code]}
                      </Badge>
                      {review ? (
                        <Badge variant="secondary">{review.decision === "accepted" ? "Đã chấp nhận" : "Không tính ngày này"}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1">{item.detail}</p>
                    {review?.note ? <p className="text-xs text-muted-foreground">Lý do: {review.note}</p> : null}
                  </div>
                  {canDecide ? (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        size="sm"
                        variant={review?.decision === "accepted" ? "secondary" : "outline"}
                        disabled={busy !== null}
                        onClick={() => void run(key, () => decide(item, "accepted"))}
                      >
                        {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Chấp nhận"}
                      </Button>
                      <Button
                        size="sm"
                        variant={review?.decision === "excluded" ? "secondary" : "outline"}
                        disabled={busy !== null}
                        onClick={() => {
                          setExcluding(item);
                          setNote(review?.note ?? "");
                          setNoteTouched(false);
                        }}
                      >
                        Không tính
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog open={excluding !== null} onOpenChange={(open) => (!open ? setExcluding(null) : undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Không tính ngày này</DialogTitle>
            <DialogDescription>{excluding?.detail}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="bep-bn-exclude-note">Lý do</Label>
            <Textarea
              id="bep-bn-exclude-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Ví dụ: quên chấm công, đã xác nhận nghỉ"
            />
            {noteTouched && note.trim() === "" ? <p className="text-xs text-destructive">Bắt buộc ghi lý do.</p> : null}
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setExcluding(null)}>
              Huỷ
            </Button>
            <Button onClick={confirmExclude} disabled={busy !== null}>
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AttendanceGrid({ data, rows, anomalies }: { data: BepBnPeriodData; rows: AttendanceRow[]; anomalies: Anomaly[] }) {
  const dates = useMemo(() => datesBetween(data.period.dateFrom, data.period.dateTo), [data.period]);
  const holidays = useMemo(() => new Set(data.period.holidays), [data.period.holidays]);
  const names = useMemo(() => new Map(data.employees.map((employee) => [employee.code, employee.name])), [data.employees]);

  const byEmployee = useMemo(() => {
    const map = new Map<string, Map<string, AttendanceRow>>();
    for (const row of rows) {
      const days = map.get(row.employeeCode) ?? new Map<string, AttendanceRow>();
      days.set(row.date, row);
      map.set(row.employeeCode, days);
    }
    return map;
  }, [rows]);

  const flagged = useMemo(() => {
    const map = new Map<string, Anomaly["severity"]>();
    for (const item of anomalies) {
      // Unknown codes are shown on the name cell; colouring every day would hide real flags.
      if (!item.date || item.code === "unknown_employee") continue;
      const key = `${item.employeeCode}|${item.date}`;
      if (map.get(key) !== "error") map.set(key, item.severity);
    }
    return map;
  }, [anomalies]);

  const codes = [...byEmployee.keys()].sort();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Xem trước chấm công</CardTitle>
        <CardDescription>Nhân viên × ngày, giờ vào – giờ ra. Ô viền vàng/đỏ là có cờ bất thường; cột tô nền là ngày lễ.</CardDescription>
      </CardHeader>
      <CardContent>
        {codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có dữ liệu chấm công. Chọn file để xem trước.</p>
        ) : (
          <div className="max-h-[480px] overflow-auto rounded-md border">
            <table className="w-max border-collapse text-xs">
              <thead className="text-xs [&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-card [&_th]:shadow-[inset_0_-1px_0_hsl(var(--border))] [&_th:first-child]:z-30">
                <tr>
                  <th className="left-0 min-w-[132px] px-2 py-2 text-left font-medium">Nhân viên</th>
                  {dates.map((date) => (
                    <th
                      key={date}
                      className={cn("min-w-[64px] px-1 py-2 text-center font-medium", holidays.has(date) && "bg-primary/10")}
                    >
                      {formatDayMonth(date)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => {
                  const days = byEmployee.get(code)!;
                  const firstRow = days.values().next().value as AttendanceRow | undefined;
                  return (
                    <tr key={code} className="border-t">
                      <td className="sticky left-0 z-10 bg-card px-2 py-1.5">
                        <div className="font-medium">{code}</div>
                        <div className="max-w-[120px] truncate text-muted-foreground">{names.get(code) ?? firstRow?.employeeName ?? "Không có trong danh mục"}</div>
                      </td>
                      {dates.map((date) => {
                        const row = days.get(date);
                        const severity = flagged.get(`${code}|${date}`);
                        return (
                          <td
                            key={date}
                            className={cn(
                              "px-1 py-1 text-center tabular-nums",
                              holidays.has(date) && "bg-primary/5",
                            )}
                          >
                            {row && (row.checkIn || row.checkOut) ? (
                              <div
                                className={cn(
                                  "rounded border px-1 py-0.5 leading-tight",
                                  severity === "error"
                                    ? "border-destructive bg-destructive/10"
                                    : severity === "warning"
                                      ? "border-amber-500 bg-amber-500/10"
                                      : "border-transparent",
                                )}
                              >
                                <div>{formatTime(row.checkIn)}</div>
                                <div className="text-muted-foreground">{formatTime(row.checkOut)}</div>
                              </div>
                            ) : (
                              <span className="text-muted-foreground/50">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
