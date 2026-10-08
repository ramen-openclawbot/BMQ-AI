import { useMemo, useRef, useState } from "react";
import { AlertTriangle, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { AttendanceParseError, parseAttendanceFile, type AttendanceFileParseResult } from "@/lib/payroll-bn/attendance-parser.ts";
import { detectAnomalies, type Anomaly } from "@/lib/payroll-bn/anomalies.ts";
import type { AttendanceRow } from "@/lib/payroll-bn/types.ts";
import type { BepBnDataSource, BepBnPeriodData } from "./types";
import { ANOMALY_LABELS, datesBetween, formatDayMonth, formatTime } from "./format";

interface AttendanceSectionProps {
  data: BepBnPeriodData;
  source: BepBnDataSource;
  canEdit: boolean;
}

interface PendingFile {
  fileName: string;
  parsed: AttendanceFileParseResult;
}

export function AttendanceSection({ data, source, canEdit }: AttendanceSectionProps) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const locked = data.period.status === "locked";

  const rows: AttendanceRow[] = pending ? pending.parsed.rows : data.rows;
  const anomalies = useMemo(
    () => detectAnomalies({ period: data.period, employees: data.employees, rows }),
    [data.period, data.employees, rows],
  );

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setParseError(null);
    setPending(null);
    setParsing(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseAttendanceFile(bytes, { dateFrom: data.period.dateFrom, dateTo: data.period.dateTo });
      setPending({ fileName: file.name, parsed });
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
      const result = await source.importAttendance({
        periodId: data.id,
        fileName: pending.fileName,
        sha256: pending.parsed.sha256,
        rows: pending.parsed.rows,
      });
      toast({
        title: result.alreadyImported ? "File này đã được nhập trước đó" : "Đã lưu chấm công",
        description: result.alreadyImported
          ? "Không tạo bản ghi trùng."
          : `${result.insertedRows} dòng đã lưu vào kỳ ${data.period.code}.`,
      });
      setPending(null);
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
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            File chấm công
          </CardTitle>
          <CardDescription>
            File xuất từ máy chấm công (sheet XuatLuoi), định dạng .xls hoặc .xlsx. Hệ thống chỉ đọc giờ vào/ra, không dùng cột Công, Tổng giờ, Tăng ca do máy tính.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              ref={inputRef}
              type="file"
              accept=".xls,.xlsx"
              disabled={!canEdit || locked || parsing}
              onChange={(event) => void handleFile(event.target.files?.[0])}
              className="sm:max-w-sm"
              aria-label="Chọn file chấm công"
            />
            {pending ? (
              <div className="flex gap-2">
                <Button onClick={() => void handleSave()} disabled={saving} className="gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Lưu vào kỳ
                </Button>
                <Button variant="outline" onClick={() => setPending(null)} disabled={saving}>
                  Huỷ
                </Button>
              </div>
            ) : null}
            {parsing ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>

          {locked ? <p className="text-sm text-muted-foreground">Kỳ đã chốt, không nhập thêm chấm công.</p> : null}

          {parseError ? (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {parseError}
            </div>
          ) : null}

          {pending ? (
            <div className="rounded-md border border-blue-500/30 bg-blue-50/40 px-3 py-2 text-sm dark:bg-blue-950/10">
              <p className="font-medium break-all">{pending.fileName}</p>
              <p className="text-muted-foreground">
                {pending.parsed.rows.length} dòng · {new Set(pending.parsed.rows.map((row) => row.employeeCode)).size} mã nhân viên · sha256 {pending.parsed.sha256.slice(0, 12)}… · chưa lưu
              </p>
            </div>
          ) : (
            <ImportHistory data={data} />
          )}
        </CardContent>
      </Card>

      <AnomalyList anomalies={anomalies} />

      <AttendanceGrid data={data} rows={rows} anomalies={anomalies} />
    </div>
  );
}

function ImportHistory({ data }: { data: BepBnPeriodData }) {
  if (data.imports.length === 0) {
    return <p className="text-sm text-muted-foreground">Kỳ này chưa có file chấm công nào.</p>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {data.imports.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <span className="font-medium text-foreground break-all">{item.fileName}</span>
          <span>{item.rowCount} dòng</span>
          <span>· {item.importedAt.slice(0, 16).replace("T", " ")}</span>
        </li>
      ))}
    </ul>
  );
}

function AnomalyList({ anomalies }: { anomalies: Anomaly[] }) {
  const counts = new Map<string, number>();
  for (const item of anomalies) counts.set(item.code, (counts.get(item.code) ?? 0) + 1);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Bất thường cần kiểm tra
          <Badge variant="secondary">{anomalies.length}</Badge>
        </CardTitle>
        <CardDescription>Hệ thống chỉ gắn cờ, không tự sửa. Người duyệt quyết định và điều chỉnh có lý do.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {anomalies.length === 0 ? (
          <p className="text-sm text-muted-foreground">Không có bất thường.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {[...counts.entries()].map(([code, count]) => (
                <Badge key={code} variant="outline">
                  {ANOMALY_LABELS[code as Anomaly["code"]]}: {count}
                </Badge>
              ))}
            </div>
            <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-sm">
              {anomalies.map((item, index) => (
                <li key={`${item.code}-${item.employeeCode}-${item.date}-${index}`} className="flex gap-2">
                  <span
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                      item.severity === "error" ? "bg-destructive" : "bg-amber-500",
                    )}
                  />
                  <span>{item.detail}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
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
              <thead className="sticky top-0 z-20 bg-muted">
                <tr>
                  <th className="sticky left-0 z-30 min-w-[132px] bg-muted px-2 py-2 text-left font-medium">Nhân viên</th>
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
