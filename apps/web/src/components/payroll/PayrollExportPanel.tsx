import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, FileSpreadsheet, BookOpenCheck, Factory } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { format } from "date-fns";

interface PeriodSummary {
  payroll_run_id: string;
  period_code: string;
  period_name: string;
  period_from: string;
  period_to: string;
  status: string;
  employee_count: number;
  total_base: number;
  total_late_deduction: number;
  total_adjustments: number;
  total_gross: number;
  total_net: number;
  total_withholdings: number;
}

interface JournalRow {
  payroll_run_id: string;
  period_code: string;
  employee_code: string;
  employee_name: string | null;
  department: string | null;
  account_code: string;
  account_name: string;
  entry_type: "debit" | "credit";
  amount: number;
}

interface LaborBySku {
  sku_id: string | null;
  sku_code: string | null;
  product_name: string | null;
  period_month: string;
  period_code: string;
  total_qty_produced: number;
  total_labor_cost: number;
  cost_per_unit: number;
  source_account_code: string;
  target_account_code: string;
  target_account_name: string;
}

const money = (v: number | null | undefined) =>
  new Intl.NumberFormat("vi-VN").format(Math.round(Number(v || 0)));

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const escape = (val: unknown) => {
    if (val === null || val === undefined) return "";
    const s = String(val);
    if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const head = headers.join(",");
  const body = rows
    .map((r) => headers.map((h) => escape((r as Record<string, unknown>)[h])).join(","))
    .join("\n");
  return `${head}\n${body}`;
}

function downloadCsv(filename: string, csv: string) {
  // BOM so Excel opens UTF-8 correctly
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function PayrollExportPanel() {
  const { language } = useLanguage();
  const isVi = language === "vi";

  const copy = {
    title: isVi ? "Kết xuất kế toán" : "Accounting export",
    intro: isVi
      ? "Mỗi payroll run sinh ra 3 dòng sổ cái / nhân viên: Nợ 6420, Có 3341 (net), Có 3388 (khấu trừ)."
      : "Each payroll run produces 3 journal lines per employee: Dr 6420, Cr 3341 (net), Cr 3388 (withholdings).",
    period: isVi ? "Kỳ lương" : "Payroll period",
    selectPeriod: isVi ? "Chọn kỳ..." : "Select period...",
    summaryTitle: isVi ? "Tổng hợp kỳ" : "Period summary",
    journalTitle: isVi ? "Sổ nhật ký (draft)" : "Journal draft",
    skuTitle: isVi ? "Nhân công / SKU trong kỳ" : "Labor / SKU in period",
    download: isVi ? "Tải CSV" : "Download CSV",
    employeeCount: isVi ? "Số NV" : "Employees",
    totalGross: isVi ? "Tổng gross" : "Total gross",
    totalNet: isVi ? "Tổng net" : "Total net",
    totalWithholding: isVi ? "Khấu trừ" : "Withholdings",
    totalBase: isVi ? "Cơ bản" : "Base",
    totalLate: isVi ? "KT trễ" : "Late ded.",
    totalAdj: isVi ? "Điều chỉnh" : "Adj.",
    status: isVi ? "Trạng thái" : "Status",
    range: isVi ? "Thời gian" : "Date range",
    employeeCode: isVi ? "Mã NV" : "Emp code",
    employeeName: isVi ? "Tên" : "Name",
    department: isVi ? "Phòng ban" : "Department",
    accountCode: isVi ? "Số TK" : "Account",
    accountName: isVi ? "Tên TK" : "Account name",
    entryType: isVi ? "Nợ/Có" : "Dr/Cr",
    amount: isVi ? "Số tiền" : "Amount",
    sku: isVi ? "SKU" : "SKU",
    qty: isVi ? "SL" : "Qty",
    cost: isVi ? "Chi phí" : "Cost",
    perUnit: isVi ? "Đơn giá" : "Per unit",
    reclass: isVi ? "Kết chuyển" : "Reclass",
    noData: isVi ? "Chưa có dữ liệu cho kỳ này." : "No data for this period yet.",
    chooseFirst: isVi ? "Chọn kỳ lương để xem dữ liệu." : "Select a payroll period to view data.",
  };

  const [selectedPeriod, setSelectedPeriod] = useState<string>("");

  // Summary — always loaded to populate period dropdown
  const { data: summaries = [], isLoading: loadingSummary } = useQuery<PeriodSummary[]>({
    queryKey: ["v_payroll_period_summary"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_payroll_period_summary")
        .select("*")
        .order("period_from", { ascending: false });
      if (error) throw error;
      return (data as PeriodSummary[]) || [];
    },
  });

  const currentSummary = useMemo(
    () => summaries.find((s) => s.period_code === selectedPeriod) || null,
    [summaries, selectedPeriod],
  );

  // Journal — only loaded when period chosen
  const { data: journal = [], isLoading: loadingJournal } = useQuery<JournalRow[]>({
    queryKey: ["v_payroll_journal_draft", selectedPeriod],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_payroll_journal_draft")
        .select("*")
        .eq("period_code", selectedPeriod)
        .order("employee_code", { ascending: true });
      if (error) throw error;
      return (data as JournalRow[]) || [];
    },
    enabled: !!selectedPeriod,
  });

  // Labor by SKU — match period_code (period_month trunc to YYYY-MM)
  const { data: laborSku = [], isLoading: loadingSku } = useQuery<LaborBySku[]>({
    queryKey: ["v_labor_cost_by_sku", currentSummary?.period_from],
    queryFn: async () => {
      if (!currentSummary) return [];
      // period_month in view is date_trunc month; derive YYYY-MM from period_from
      const ym = currentSummary.period_from.slice(0, 7);
      const { data, error } = await (supabase as any)
        .from("v_labor_cost_by_sku")
        .select("*")
        .gte("period_month", `${ym}-01`)
        .lte("period_month", `${ym}-31`);
      if (error) throw error;
      return (data as LaborBySku[]) || [];
    },
    enabled: !!currentSummary,
  });

  const downloadSummary = () => {
    if (summaries.length === 0) return;
    const headers = [
      "period_code",
      "period_name",
      "period_from",
      "period_to",
      "status",
      "employee_count",
      "total_base",
      "total_late_deduction",
      "total_adjustments",
      "total_gross",
      "total_withholdings",
      "total_net",
    ];
    downloadCsv("payroll-period-summary.csv", toCsv(summaries as unknown as Record<string, unknown>[], headers));
  };

  const downloadJournal = () => {
    if (journal.length === 0) return;
    const headers = [
      "period_code",
      "employee_code",
      "employee_name",
      "department",
      "account_code",
      "account_name",
      "entry_type",
      "amount",
    ];
    downloadCsv(
      `payroll-journal-${selectedPeriod}.csv`,
      toCsv(journal as unknown as Record<string, unknown>[], headers),
    );
  };

  const downloadSku = () => {
    if (laborSku.length === 0) return;
    const headers = [
      "period_code",
      "sku_code",
      "product_name",
      "total_qty_produced",
      "total_labor_cost",
      "cost_per_unit",
      "source_account_code",
      "target_account_code",
    ];
    downloadCsv(
      `labor-by-sku-${selectedPeriod || "all"}.csv`,
      toCsv(laborSku as unknown as Record<string, unknown>[], headers),
    );
  };

  return (
    <div className="space-y-4">
      {/* Intro + period picker */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenCheck className="h-4 w-4" />
            {copy.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{copy.intro}</p>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[240px]">
              <label className="text-xs text-muted-foreground">{copy.period}</label>
              <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
                <SelectTrigger>
                  <SelectValue placeholder={copy.selectPeriod} />
                </SelectTrigger>
                <SelectContent>
                  {summaries.map((s) => (
                    <SelectItem key={s.period_code} value={s.period_code}>
                      {s.period_name} — {s.period_code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {currentSummary && (
              <Badge variant="outline">{currentSummary.status}</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            {copy.summaryTitle}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={downloadSummary} disabled={summaries.length === 0}>
            <Download className="h-4 w-4 mr-1" /> {copy.download}
          </Button>
        </CardHeader>
        <CardContent>
          {loadingSummary ? (
            <Skeleton className="h-16 w-full" />
          ) : summaries.length === 0 ? (
            <div className="text-sm text-muted-foreground">{copy.noData}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.period}</TableHead>
                  <TableHead>{copy.range}</TableHead>
                  <TableHead>{copy.status}</TableHead>
                  <TableHead className="text-right">{copy.employeeCount}</TableHead>
                  <TableHead className="text-right">{copy.totalBase}</TableHead>
                  <TableHead className="text-right">{copy.totalLate}</TableHead>
                  <TableHead className="text-right">{copy.totalAdj}</TableHead>
                  <TableHead className="text-right">{copy.totalGross}</TableHead>
                  <TableHead className="text-right">{copy.totalWithholding}</TableHead>
                  <TableHead className="text-right">{copy.totalNet}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaries.map((s) => (
                  <TableRow
                    key={s.payroll_run_id}
                    className={s.period_code === selectedPeriod ? "bg-muted/50" : ""}
                  >
                    <TableCell className="font-mono text-xs">{s.period_code}</TableCell>
                    <TableCell className="text-xs">
                      {format(new Date(s.period_from), "dd/MM")} — {format(new Date(s.period_to), "dd/MM/yyyy")}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{s.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{s.employee_count}</TableCell>
                    <TableCell className="text-right">{money(s.total_base)}</TableCell>
                    <TableCell className="text-right">{money(s.total_late_deduction)}</TableCell>
                    <TableCell className="text-right">{money(s.total_adjustments)}</TableCell>
                    <TableCell className="text-right font-semibold">{money(s.total_gross)}</TableCell>
                    <TableCell className="text-right">{money(s.total_withholdings)}</TableCell>
                    <TableCell className="text-right font-semibold text-emerald-600">
                      {money(s.total_net)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Journal draft */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <BookOpenCheck className="h-4 w-4" />
            {copy.journalTitle}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={downloadJournal} disabled={!selectedPeriod || journal.length === 0}>
            <Download className="h-4 w-4 mr-1" /> {copy.download}
          </Button>
        </CardHeader>
        <CardContent>
          {!selectedPeriod ? (
            <div className="text-sm text-muted-foreground">{copy.chooseFirst}</div>
          ) : loadingJournal ? (
            <Skeleton className="h-16 w-full" />
          ) : journal.length === 0 ? (
            <div className="text-sm text-muted-foreground">{copy.noData}</div>
          ) : (
            <div className="max-h-[480px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.employeeCode}</TableHead>
                    <TableHead>{copy.employeeName}</TableHead>
                    <TableHead>{copy.department}</TableHead>
                    <TableHead>{copy.accountCode}</TableHead>
                    <TableHead>{copy.accountName}</TableHead>
                    <TableHead>{copy.entryType}</TableHead>
                    <TableHead className="text-right">{copy.amount}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {journal.map((j, idx) => (
                    <TableRow key={`${j.payroll_run_id}-${j.employee_code}-${j.account_code}-${idx}`}>
                      <TableCell className="font-mono text-xs">{j.employee_code}</TableCell>
                      <TableCell>{j.employee_name ?? "—"}</TableCell>
                      <TableCell className="text-xs">{j.department ?? "—"}</TableCell>
                      <TableCell className="font-mono">{j.account_code}</TableCell>
                      <TableCell className="text-xs">{j.account_name}</TableCell>
                      <TableCell>
                        <Badge
                          variant={j.entry_type === "debit" ? "default" : "secondary"}
                          className="text-xs"
                        >
                          {j.entry_type === "debit" ? (isVi ? "Nợ" : "Dr") : (isVi ? "Có" : "Cr")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold">{money(j.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Labor by SKU */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Factory className="h-4 w-4" />
            {copy.skuTitle}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={downloadSku} disabled={laborSku.length === 0}>
            <Download className="h-4 w-4 mr-1" /> {copy.download}
          </Button>
        </CardHeader>
        <CardContent>
          {!selectedPeriod ? (
            <div className="text-sm text-muted-foreground">{copy.chooseFirst}</div>
          ) : loadingSku ? (
            <Skeleton className="h-16 w-full" />
          ) : laborSku.length === 0 ? (
            <div className="text-sm text-muted-foreground">{copy.noData}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.sku}</TableHead>
                  <TableHead className="text-right">{copy.qty}</TableHead>
                  <TableHead className="text-right">{copy.cost}</TableHead>
                  <TableHead className="text-right">{copy.perUnit}</TableHead>
                  <TableHead>{copy.reclass}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {laborSku.map((r, idx) => (
                  <TableRow key={`${r.sku_id}-${idx}`}>
                    <TableCell>
                      <span className="font-mono text-xs">{r.sku_code ?? "—"}</span>
                      <div className="text-muted-foreground">{r.product_name ?? "—"}</div>
                    </TableCell>
                    <TableCell className="text-right">{r.total_qty_produced}</TableCell>
                    <TableCell className="text-right">{money(r.total_labor_cost)}</TableCell>
                    <TableCell className="text-right font-semibold">{money(r.cost_per_unit)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.source_account_code} → {r.target_account_code}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default PayrollExportPanel;
