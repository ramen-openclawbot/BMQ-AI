import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMonthlyReceiptStats, useDebtStats, useSupplierStats } from "@/hooks/useReportStats";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, PieChart, Pie, Cell, Legend } from "recharts";
import { format, addMonths, subMonths } from "date-fns";
import { ChevronLeft, ChevronRight, Landmark, TrendingUp, Wallet, Users } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";

const COLORS = ["hsl(216, 90%, 55%)", "hsl(142, 70%, 40%)", "hsl(35, 90%, 50%)", "hsl(0, 70%, 55%)"];

const chartConfig = {
  value: { label: "Amount", color: "hsl(216, 90%, 55%)" },
  debt: { label: "Debt", color: "hsl(0, 70%, 55%)" },
};

function useUsdVndFx() {
  return useQuery({
    queryKey: ["usd-vnd-fx"],
    queryFn: async () => {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      if (!res.ok) throw new Error(`FX API error: ${res.status}`);
      const json = await res.json();
      const rate = Number(json?.rates?.VND || 0);
      if (!rate) throw new Error("Invalid VND FX rate");
      return { rate, fetchedAt: new Date().toISOString() };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}

export default function NiraanDashboard() {
  const { language } = useLanguage();
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  const { data: fx, isLoading: fxLoading } = useUsdVndFx();

  const { data: monthlyStats, isLoading: monthlyLoading } = useMonthlyReceiptStats(selectedMonth);
  const { data: debtStats, isLoading: debtLoading } = useDebtStats();
  const { data: supplierStats, isLoading: supplierLoading } = useSupplierStats();
  const { data: paymentStats, isLoading: paymentLoading } = usePaymentStats();

  const isLoading = monthlyLoading || debtLoading || supplierLoading || paymentLoading || fxLoading;

  const vndToUsd = (vnd: number) => {
    const rate = fx?.rate || 0;
    return rate > 0 ? vnd / rate : 0;
  };

  const usd = (value: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value || 0);

  const supplierChartData = useMemo(
    () => (monthlyStats?.bySupplier || []).slice(0, 6).map((s) => ({ name: s.name, value: vndToUsd(s.value) })),
    [monthlyStats, fx]
  );

  const debtPieData = useMemo(() => {
    if (!paymentStats) return [];
    return [
      { name: language === "vi" ? "UNC" : "Bank Transfer", value: vndToUsd(paymentStats.uncTotal || 0) },
      { name: language === "vi" ? "Tiền mặt" : "Cash", value: vndToUsd(paymentStats.cashTotal || 0) },
    ].filter((d) => d.value > 0);
  }, [paymentStats, fx, language]);

  const handlePrevMonth = () => setSelectedMonth((m) => subMonths(m, 1));
  const handleNextMonth = () => setSelectedMonth((m) => addMonths(m, 1));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">
            {language === "vi" ? "Investor Dashboard" : "Investor Dashboard"}
          </h1>
          <p className="text-muted-foreground mt-1">
            {language === "vi"
              ? "Tổng quan nhà đầu tư theo USD (quy đổi từ VND theo tỷ giá trực tiếp)."
              : "Investor snapshot in USD (converted from VND with live FX)."}
          </p>
        </div>
        <div className="text-right text-sm text-muted-foreground">
          <div>{language === "vi" ? "Tỷ giá" : "FX"}: {fx?.rate ? `1 USD = ${new Intl.NumberFormat("en-US").format(Math.round(fx.rate))} VND` : (language === "vi" ? "Đang tải..." : "Loading...")}</div>
          <div>{language === "vi" ? "Cập nhật" : "Updated"}: {fx?.fetchedAt ? new Date(fx.fetchedAt).toLocaleString(language === "vi" ? "vi-VN" : "en-US") : "-"}</div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1"><Landmark className="h-4 w-4" />{language === "vi" ? "Giá trị mua hàng theo tháng" : "Monthly Procurement Value"}</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold">{isLoading ? "..." : usd(vndToUsd(monthlyStats?.totalValue || 0))}</div><p className="text-sm text-muted-foreground">{monthlyStats?.totalPOs || 0} {language === "vi" ? "PO trong" : "POs in"} {format(selectedMonth, "MMM yyyy")}</p></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1"><Wallet className="h-4 w-4" />{language === "vi" ? "Công nợ còn lại" : "Outstanding Debt"}</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold text-destructive">{isLoading ? "..." : usd(vndToUsd(debtStats?.totalDebt || 0))}</div><p className="text-sm text-muted-foreground">{language === "vi" ? "Trên" : "Across"} {debtStats?.bySupplier?.length || 0} {language === "vi" ? "nhà cung cấp" : "suppliers"}</p></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1"><TrendingUp className="h-4 w-4" />{language === "vi" ? "Chưa thanh toán qua UNC" : "Unpaid via Bank Transfer"}</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold text-blue-600">{isLoading ? "..." : usd(vndToUsd(paymentStats?.uncTotal || 0))}</div><p className="text-sm text-muted-foreground">{language === "vi" ? "Khoản phải trả vận hành (UNC)" : "Operational payable (UNC)"}</p></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardDescription className="flex items-center gap-1"><Users className="h-4 w-4" />{language === "vi" ? "Chưa thanh toán tiền mặt" : "Unpaid via Cash"}</CardDescription></CardHeader>
          <CardContent><div className="text-2xl font-bold text-green-600">{isLoading ? "..." : usd(vndToUsd(paymentStats?.cashTotal || 0))}</div><p className="text-sm text-muted-foreground">{language === "vi" ? "Khoản quyết toán tiền mặt đang chờ" : "Cash settlements pending"}</p></CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">{language === "vi" ? "Chi tiêu nhà cung cấp hàng đầu (USD)" : "Top Supplier Spend (USD)"}</CardTitle>
                <CardDescription>{format(selectedMonth, "MMMM yyyy")}</CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" onClick={handlePrevMonth}><ChevronLeft className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" onClick={handleNextMonth}><ChevronRight className="h-4 w-4" /></Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {supplierChartData.length > 0 ? (
              <ChartContainer config={chartConfig} className="h-[260px]">
                <BarChart data={supplierChartData} layout="vertical" margin={{ left: 8, right: 8 }}>
                  <XAxis type="number" tickFormatter={(v) => usd(Number(v))} />
                  <YAxis dataKey="name" type="category" width={170} tick={{ fontSize: 12 }} />
                  <ChartTooltip content={<ChartTooltipContent formatter={(value) => usd(Number(value))} />} />
                  <Bar dataKey="value" fill="hsl(216, 90%, 55%)" radius={4} />
                </BarChart>
              </ChartContainer>
            ) : <div className="h-[260px] flex items-center justify-center text-muted-foreground">{language === "vi" ? "Không có dữ liệu cho tháng này" : "No data for this month"}</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{language === "vi" ? "Cơ cấu khoản phải trả" : "Payable Mix"}</CardTitle>
            <CardDescription>{language === "vi" ? "Theo phương thức thanh toán (USD)" : "By payment method (USD)"}</CardDescription>
          </CardHeader>
          <CardContent>
            {debtPieData.length > 0 ? (
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={debtPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={85} dataKey="value" label={({ percent }) => `${((percent || 0) * 100).toFixed(0)}%`}>
                      {debtPieData.map((_, idx) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                    </Pie>
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : <div className="h-[260px] flex items-center justify-center text-muted-foreground">{language === "vi" ? "Không có dữ liệu công nợ" : "No payable data"}</div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{language === "vi" ? "Tổng hợp nhà cung cấp (Góc nhìn nhà đầu tư)" : "Supplier Snapshot (Investor View)"}</CardTitle>
          <CardDescription>{language === "vi" ? "Top 10 nhà cung cấp theo tổng giá trị mua hàng" : "Top 10 suppliers by total procurement value"}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-[340px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{language === "vi" ? "Nhà cung cấp" : "Supplier"}</TableHead>
                  <TableHead className="text-right">{language === "vi" ? "Đơn hàng" : "Orders"}</TableHead>
                  <TableHead className="text-right">{language === "vi" ? "Tổng giá trị (USD)" : "Total Value (USD)"}</TableHead>
                  <TableHead className="text-right">{language === "vi" ? "Phiếu nhập" : "Receipts"}</TableHead>
                  <TableHead className="text-right">{language === "vi" ? "Chưa thanh toán (USD)" : "Unpaid (USD)"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplierStats?.slice(0, 10).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-right">{s.totalOrders}</TableCell>
                    <TableCell className="text-right">{usd(vndToUsd(s.totalValue))}</TableCell>
                    <TableCell className="text-right">{s.totalReceipts}</TableCell>
                    <TableCell className="text-right">
                      {s.unpaidAmount > 0 ? <Badge variant="destructive">{usd(vndToUsd(s.unpaidAmount))}</Badge> : <span className="text-muted-foreground">-</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
