import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/contexts/LanguageContext";
import { format } from "date-fns";
import { Factory, ArrowLeftRight } from "lucide-react";

interface MonthlyRow {
  sku_id: string | null;
  sku_code: string | null;
  product_name: string | null;
  period_month: string; // 'YYYY-MM-01'
  total_qty_produced: number;
  total_labor_cost: number;
  cost_per_unit: number;
}

const money = (v: number | null | undefined) =>
  new Intl.NumberFormat("vi-VN").format(Math.round(Number(v || 0)));

const qty = (v: number | null | undefined) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(Number(v || 0));

function getMonthOptions(rows: MonthlyRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.period_month) set.add(r.period_month);
  return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
}

export function ActualLaborCostPanel() {
  const { language } = useLanguage();
  const isVi = language === "vi";

  const [search, setSearch] = useState("");
  const [periodFilter, setPeriodFilter] = useState<string>("all");

  const copy = {
    title: isVi ? "Nhân công thực tế / SKU" : "Actual labor / SKU",
    subtitle: isVi
      ? "Chi phí nhân công được phân bổ vào SKU dựa trên ca sản xuất, công nhân ca, và sản lượng thực tế."
      : "Labor cost attributed to each SKU based on production shifts, shift workers, and actual output.",
    period: isVi ? "Kỳ (tháng)" : "Period (month)",
    allPeriods: isVi ? "Tất cả" : "All",
    search: isVi ? "Tìm SKU hoặc sản phẩm" : "Search SKU or product",
    empty: isVi ? "Chưa có dữ liệu — cần có ca sản xuất có công nhân và sản lượng." : "No data yet — shifts with workers and output are required.",
    sku: isVi ? "SKU" : "SKU",
    produced: isVi ? "Sản lượng" : "Output qty",
    labor: isVi ? "Tổng nhân công" : "Total labor cost",
    unitCost: isVi ? "Nhân công / đv" : "Labor / unit",
    period_col: isVi ? "Kỳ" : "Period",
    exportHint: isVi ? "Dùng số này làm input cho giá vốn SKU và kế toán nội bộ." : "Use this as input for SKU costing and internal accounting.",
  };

  const { data = [], isLoading } = useQuery<MonthlyRow[]>({
    queryKey: ["v_sku_labor_cost_monthly_enriched"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("v_sku_labor_cost_monthly_enriched")
        .select("*")
        .order("period_month", { ascending: false });
      if (error) throw error;
      return (data as MonthlyRow[]) || [];
    },
  });

  const periodOptions = useMemo(() => getMonthOptions(data), [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.filter((r) => {
      if (periodFilter !== "all" && r.period_month !== periodFilter) return false;
      if (!q) return true;
      return `${r.sku_code ?? ""} ${r.product_name ?? ""}`.toLowerCase().includes(q);
    });
  }, [data, search, periodFilter]);

  // Summary row
  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, r) => {
        acc.qty += Number(r.total_qty_produced || 0);
        acc.cost += Number(r.total_labor_cost || 0);
        return acc;
      },
      { qty: 0, cost: 0 },
    );
  }, [filtered]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Factory className="h-4 w-4" />
            {copy.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground flex items-start gap-2">
            <ArrowLeftRight className="h-4 w-4 mt-0.5" />
            <span>{copy.subtitle}</span>
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input
              placeholder={copy.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={periodFilter} onValueChange={setPeriodFilter}>
              <SelectTrigger>
                <SelectValue placeholder={copy.period} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{copy.allPeriods}</SelectItem>
                {periodOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {format(new Date(p), "MM/yyyy")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-end gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Σ {copy.produced}:</span>{" "}
                <span className="font-semibold">{qty(totals.qty)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Σ {copy.labor}:</span>{" "}
                <span className="font-semibold">{money(totals.cost)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground">{copy.empty}</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.sku}</TableHead>
                  <TableHead>{copy.period_col}</TableHead>
                  <TableHead className="text-right">{copy.produced}</TableHead>
                  <TableHead className="text-right">{copy.labor}</TableHead>
                  <TableHead className="text-right">{copy.unitCost}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, idx) => (
                  <TableRow key={`${r.sku_id}-${r.period_month}-${idx}`}>
                    <TableCell>
                      <span className="font-mono text-xs">{r.sku_code ?? "—"}</span>
                      <div className="text-muted-foreground">{r.product_name ?? "—"}</div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.period_month ? format(new Date(r.period_month), "MM/yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-right">{qty(r.total_qty_produced)}</TableCell>
                    <TableCell className="text-right">{money(r.total_labor_cost)}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {money(r.cost_per_unit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground italic">{copy.exportHint}</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default ActualLaborCostPanel;
