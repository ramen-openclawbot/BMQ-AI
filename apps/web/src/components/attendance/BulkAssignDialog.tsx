import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Upload, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface ShiftOption {
  id: string;
  shift_code: string;
  shift_name: string;
  start_time: string;
  end_time: string;
}

interface BulkAssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shifts: ShiftOption[];
  onCompleted?: () => void;
}

interface ParsedRow {
  employee_code: string;
  employee_name: string | null;
  work_date: string;
  shift_code: string;
  department: string | null;
  error?: string;
}

const EXPECTED_HEADERS = ["employee_code", "employee_name", "work_date", "shift_code", "department"];

function parseCsv(raw: string): { rows: ParsedRow[]; issues: string[] } {
  const issues: string[] = [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) return { rows: [], issues: ["empty input"] };

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const missing = EXPECTED_HEADERS.filter((h) => !header.includes(h) && h !== "employee_name" && h !== "department");
  if (missing.length) {
    issues.push(`missing required columns: ${missing.join(", ")}`);
    return { rows: [], issues };
  }
  const idxEmp = header.indexOf("employee_code");
  const idxName = header.indexOf("employee_name");
  const idxDate = header.indexOf("work_date");
  const idxShift = header.indexOf("shift_code");
  const idxDept = header.indexOf("department");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const row: ParsedRow = {
      employee_code: cols[idxEmp] || "",
      employee_name: idxName >= 0 ? cols[idxName] || null : null,
      work_date: cols[idxDate] || "",
      shift_code: cols[idxShift] || "",
      department: idxDept >= 0 ? cols[idxDept] || null : null,
    };
    if (!row.employee_code || !row.work_date || !row.shift_code) {
      row.error = "missing required field";
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(row.work_date)) {
      row.error = "invalid work_date (expected YYYY-MM-DD)";
    }
    rows.push(row);
  }
  return { rows, issues };
}

export default function BulkAssignDialog({ open, onOpenChange, shifts, onCompleted }: BulkAssignDialogProps) {
  const { language } = useLanguage();
  const { toast } = useToast();
  const isVi = language === "vi";

  const [raw, setRaw] = useState("");
  const { rows, issues } = useMemo(() => (raw.trim() ? parseCsv(raw) : { rows: [], issues: [] }), [raw]);

  const validRows = rows.filter((r) => !r.error);
  const invalidCount = rows.length - validRows.length;

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (validRows.length === 0) throw new Error(isVi ? "Không có dòng hợp lệ" : "No valid rows");
      const payload = validRows.map((r) => ({
        employee_code: r.employee_code,
        employee_name: r.employee_name,
        work_date: r.work_date,
        shift_code: r.shift_code,
        department: r.department,
      }));
      const { data, error } = await (supabase as any).rpc("attendance_bulk_upsert_roster", {
        _rows: payload,
      });
      if (error) throw error;
      return (data?.[0] || { inserted_count: 0, skipped_count: 0, error_messages: [] }) as {
        inserted_count: number;
        skipped_count: number;
        error_messages: string[];
      };
    },
    onSuccess: (result) => {
      toast({
        title: isVi ? "Đã upload roster" : "Roster uploaded",
        description: isVi
          ? `Thành công ${result.inserted_count} / Bỏ qua ${result.skipped_count}`
          : `Inserted ${result.inserted_count} / Skipped ${result.skipped_count}`,
      });
      if (result.error_messages?.length) {
        toast({
          title: isVi ? "Cảnh báo upload" : "Upload warnings",
          description: result.error_messages.slice(0, 3).join(" | "),
        });
      }
      setRaw("");
      onOpenChange(false);
      onCompleted?.();
    },
    onError: (err: any) => {
      toast({
        title: isVi ? "Upload thất bại" : "Upload failed",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  const sampleTemplate =
    "employee_code,employee_name,work_date,shift_code,department\nNV001,Nguyen Van A,2026-04-20,HC-SANG,Bakery\nNV002,Tran Thi B,2026-04-20,HC-CHIEU,Bakery";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isVi ? "Upload roster hàng loạt" : "Bulk roster upload"}</DialogTitle>
          <DialogDescription>
            {isVi
              ? "Dán CSV (header: employee_code, employee_name, work_date, shift_code, department). Hệ thống sẽ bỏ qua ngày thuộc kỳ đã khóa."
              : "Paste CSV (header: employee_code, employee_name, work_date, shift_code, department). Rows in locked periods are skipped."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRaw(sampleTemplate)}>
              <FileText className="h-4 w-4 mr-1" />
              {isVi ? "Mẫu CSV" : "Template"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {isVi ? "Ca khả dụng:" : "Available shifts:"}{" "}
              {shifts.map((s) => s.shift_code).join(", ")}
            </span>
          </div>
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={8}
            placeholder="employee_code,employee_name,work_date,shift_code,department"
            className="font-mono text-xs"
          />

          {issues.length > 0 ? (
            <div className="text-sm text-destructive">{issues.join(" | ")}</div>
          ) : null}

          {rows.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="outline">{isVi ? "Dòng" : "Rows"}: {rows.length}</Badge>
                <Badge variant="default">{isVi ? "Hợp lệ" : "Valid"}: {validRows.length}</Badge>
                {invalidCount > 0 ? (
                  <Badge variant="destructive">{isVi ? "Lỗi" : "Invalid"}: {invalidCount}</Badge>
                ) : null}
              </div>

              <div className="max-h-64 overflow-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>employee_code</TableHead>
                      <TableHead>work_date</TableHead>
                      <TableHead>shift_code</TableHead>
                      <TableHead>department</TableHead>
                      <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.slice(0, 50).map((r, idx) => (
                      <TableRow key={idx}>
                        <TableCell>{r.employee_code || "-"}</TableCell>
                        <TableCell>{r.work_date || "-"}</TableCell>
                        <TableCell>{r.shift_code || "-"}</TableCell>
                        <TableCell>{r.department || "-"}</TableCell>
                        <TableCell>
                          {r.error ? (
                            <Badge variant="destructive" className="text-[10px]">
                              {r.error}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">OK</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {isVi ? "Hủy" : "Cancel"}
          </Button>
          <Button
            onClick={() => uploadMutation.mutate()}
            disabled={uploadMutation.isPending || validRows.length === 0}
          >
            {uploadMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Upload className="h-4 w-4 mr-1" />
            )}
            {isVi ? "Upload" : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
