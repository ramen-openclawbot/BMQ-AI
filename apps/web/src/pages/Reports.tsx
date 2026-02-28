import { useState, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, TrendingUp, Wallet, Package, Users, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMonthlyReceiptStats, useDebtStats, useSupplierStats } from "@/hooks/useReportStats";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { format, addMonths, subMonths } from "date-fns";
import { vi } from "date-fns/locale";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, PieChart, Pie, Cell, Legend } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/contexts/LanguageContext";

const COLORS = ["hsl(35, 85%, 45%)", "hsl(142, 60%, 40%)", "hsl(25, 70%, 35%)", "hsl(200, 70%, 50%)", "hsl(280, 60%, 50%)"];

const formatCurrency = (value: number) => {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);
};

const formatNumber = (value: number) => {
  return new Intl.NumberFormat("vi-VN").format(value);
};

const truncateSupplierName = (name: string, maxLength = 20) => {
  if (!name) return "";
  return name.length > maxLength ? `${name.slice(0, maxLength)}...` : name;
};

export default function Reports() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const [selectedMonth, setSelectedMonth] = useState(new Date());

  const { data: monthlyStats, isLoading: monthlyLoading } = useMonthlyReceiptStats(selectedMonth);
  const { data: debtStats, isLoading: debtLoading } = useDebtStats();
  const { data: supplierStats, isLoading: supplierLoading } = useSupplierStats();
  const { data: paymentStats } = usePaymentStats();

  const handlePrevMonth = () => setSelectedMonth((m) => subMonths(m, 1));
  const handleNextMonth = () => setSelectedMonth((m) => addMonths(m, 1));

  const supplierChartData = useMemo(() => {
    return (monthlyStats?.bySupplier || []).slice(0, 5).map((s) => ({
      name: s.name,
      value: s.value,
    }));
  }, [monthlyStats]);

  const debtChartData = useMemo(() => {
    return (debtStats?.bySupplier || []).slice(0, 5).map((s) => ({
      name: s.name,
      debt: s.debt,
    }));
  }, [debtStats]);

  const debtPieData = useMemo(() => {
    if (!debtStats) return [];
    return [
      { name: isVi ? "Chuyển khoản (UNC)" : "Bank Transfer (UNC)", value: debtStats.uncDebt },
      { name: isVi ? "Tiền mặt" : "Cash", value: debtStats.cashDebt },
    ].filter((d) => d.value > 0);
  }, [debtStats, isVi]);

  const chartConfig = {
    value: { label: isVi ? "Giá trị nhập" : "Receipt value", color: "hsl(35, 85%, 45%)" },
    debt: { label: isVi ? "Công nợ" : "Debt", color: "hsl(0, 65%, 50%)" },
  };

  const isLoading = monthlyLoading || debtLoading || supplierLoading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground flex items-center gap-2">
          <BarChart3 className="h-8 w-8 text-primary" />
          {isVi ? "Dashboard Báo Cáo" : "Reports Dashboard"}
        </h1>
        <p className="text-muted-foreground">{isVi ? "Tổng quan hoạt động mua hàng và công nợ" : "Overview of procurement and debt operations"}</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="stat-card">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Package className="h-4 w-4" />
              {isVi ? "Tổng giá trị nhập tháng này" : "Total receipt value this month"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {isLoading ? "..." : formatCurrency(monthlyStats?.totalValue || 0)}
            </div>
            <p className="text-sm text-muted-foreground">
              {monthlyStats?.totalPOs || 0} {isVi ? "PO trong tháng" : "POs this month"}
            </p>
          </CardContent>
        </Card>

        <Card className="stat-card">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Wallet className="h-4 w-4" />
              {isVi ? "Tổng công nợ" : "Total debt"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">
              {isLoading ? "..." : formatCurrency(debtStats?.totalDebt || 0)}
            </div>
            <p className="text-sm text-muted-foreground">
              {debtStats?.bySupplier?.length || 0} {isVi ? "nhà cung cấp" : "suppliers"}
            </p>
          </CardContent>
        </Card>

        <Card className="stat-card">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <TrendingUp className="h-4 w-4" />
              {isVi ? "UNC chưa thanh toán" : "Unpaid UNC"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {isLoading ? "..." : formatCurrency(paymentStats?.uncTotal || 0)}
            </div>
            <p className="text-sm text-muted-foreground">{isVi ? "Chuyển khoản" : "Bank transfer"}</p>
          </CardContent>
        </Card>

        <Card className="stat-card">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Wallet className="h-4 w-4" />
              {isVi ? "Tiền mặt chưa thanh toán" : "Unpaid cash"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {isLoading ? "..." : formatCurrency(paymentStats?.cashTotal || 0)}
            </div>
            <p className="text-sm text-muted-foreground">{isVi ? "Tiền mặt" : "Cash"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Monthly Receipts by Supplier */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">{isVi ? "Giá trị nhập theo NCC" : "Receipt value by supplier"}</CardTitle>
                <CardDescription>
                  {isVi ? "Tháng" : "Month"} {format(selectedMonth, "MM/yyyy", { locale: isVi ? vi : undefined })}
                </CardDescription>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" onClick={handlePrevMonth}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={handleNextMonth}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {supplierChartData.length > 0 ? (
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={supplierChartData} layout="vertical" margin={{ left: 8, right: 8 }}>
                  <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    width={180}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => truncateSupplierName(String(value), 22)}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent formatter={(value) => formatCurrency(value as number)} />}
                  />
                  <Bar dataKey="value" fill="hsl(35, 85%, 45%)" radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                {isVi ? "Không có dữ liệu trong tháng này" : "No data in this month"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Debt by Supplier */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{isVi ? "Công nợ theo NCC" : "Debt by supplier"}</CardTitle>
            <CardDescription>{isVi ? "Top 5 nhà cung cấp có công nợ cao nhất" : "Top 5 suppliers with highest debt"}</CardDescription>
          </CardHeader>
          <CardContent>
            {debtChartData.length > 0 ? (
              <ChartContainer config={chartConfig} className="h-[250px]">
                <BarChart data={debtChartData} layout="vertical" margin={{ left: 8, right: 8 }}>
                  <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    width={180}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => truncateSupplierName(String(value), 22)}
                  />
                  <ChartTooltip
                    content={<ChartTooltipContent formatter={(value) => formatCurrency(value as number)} />}
                  />
                  <Bar dataKey="debt" fill="hsl(0, 65%, 50%)" radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground">
                {isVi ? "Không có công nợ" : "No debt"}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Debt Breakdown Pie + Supplier Table */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{isVi ? "Phân loại công nợ" : "Debt breakdown"}</CardTitle>
            <CardDescription>{isVi ? "Theo phương thức thanh toán" : "By payment method"}</CardDescription>
          </CardHeader>
          <CardContent>
            {debtPieData.length > 0 ? (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={debtPieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={40}
                      outerRadius={70}
                      paddingAngle={5}
                      dataKey="value"
                      label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                    >
                      {debtPieData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground">
                {isVi ? "Không có công nợ" : "No debt"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Supplier Stats Table */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5" />
              {isVi ? "Thống kê theo NCC" : "Supplier statistics"}
            </CardTitle>
            <CardDescription>{isVi ? "Tổng hợp đơn hàng, nhập kho và công nợ" : "Summary of orders, receipts, and debt"}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[300px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Đơn hàng" : "Orders"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Giá trị" : "Value"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Phiếu nhập" : "Receipts"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Công nợ" : "Debt"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {supplierStats?.slice(0, 10).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.name}</TableCell>
                      <TableCell className="text-right">{s.totalOrders}</TableCell>
                      <TableCell className="text-right">{formatCurrency(s.totalValue)}</TableCell>
                      <TableCell className="text-right">{s.totalReceipts}</TableCell>
                      <TableCell className="text-right">
                        {s.unpaidAmount > 0 ? (
                          <Badge variant="destructive">{formatCurrency(s.unpaidAmount)}</Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(!supplierStats || supplierStats.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {isVi ? "Không có dữ liệu" : "No data"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
