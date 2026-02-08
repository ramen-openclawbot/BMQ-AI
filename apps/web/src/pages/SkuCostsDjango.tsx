import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { useSkuCostsDjango } from "@/hooks/useSkuCostsDjango";
import { useDjangoLowStock } from "@/hooks/useDjangoLowStock";
import { useDjangoRecentCosts } from "@/hooks/useDjangoRecentCosts";
import { useDjangoCostTrend } from "@/hooks/useDjangoCostTrend";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const COLORS = ["#16a34a", "#f59e0b", "#ef4444"];

export default function SkuCostsDjango() {
  const { data, isLoading, isError } = useSkuCostsDjango();
  const { data: lowStock } = useDjangoLowStock();
  const { data: recentCosts } = useDjangoRecentCosts();

  const firstProductId = data?.[0]?.product_id;
  const { data: trend } = useDjangoCostTrend(firstProductId);

  const totals = useMemo(() => {
    if (!data || data.length === 0) return { count: 0, avgCost: 0, avgMargin: 0 };
    const count = data.length;
    const avgCost = data.reduce((s, i) => s + i.total_cost_per_unit, 0) / count;
    const avgMargin = data.reduce((s, i) => s + i.margin_percentage, 0) / count;
    return { count, avgCost, avgMargin };
  }, [data]);

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

  const breakdown = useMemo(() => {
    if (!data || data.length === 0) return [];
    const sum = data.reduce(
      (acc, i) => {
        acc.ingredient += i.ingredient_cost;
        acc.labor += i.labor_cost;
        acc.overhead += i.overhead_cost;
        return acc;
      },
      { ingredient: 0, labor: 0, overhead: 0 }
    );
    return [
      { name: "Nguyên liệu", value: sum.ingredient },
      { name: "Nhân công", value: sum.labor },
      { name: "Chi phí chung", value: sum.overhead },
    ];
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Tổng số sản phẩm</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-semibold">{totals.count}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Giá thành trung bình</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-8 w-32" /> : <div className="text-2xl font-semibold">{formatCurrency(totals.avgCost)}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Biên lợi nhuận TB</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-8 w-20" /> : <div className="text-2xl font-semibold">{totals.avgMargin.toFixed(2)}%</div>}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Xu hướng chi phí (SKU đầu tiên)</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {trend ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend.labels.map((l: string, idx: number) => ({
                  label: l,
                  ingredient: trend.datasets[0]?.data[idx],
                  labor: trend.datasets[1]?.data[idx],
                  overhead: trend.datasets[2]?.data[idx],
                  total: trend.datasets[3]?.data[idx],
                }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="label" />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="total" stroke="#0f172a" />
                  <Line type="monotone" dataKey="ingredient" stroke="#22c55e" />
                  <Line type="monotone" dataKey="labor" stroke="#f59e0b" />
                  <Line type="monotone" dataKey="overhead" stroke="#ef4444" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-56 w-full" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cơ cấu chi phí</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={breakdown} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}>
                  {breakdown.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Chi phí tính gần đây</CardTitle>
        </CardHeader>
        <CardContent>
          {recentCosts ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Sản phẩm</TableHead>
                  <TableHead>Giá thành</TableHead>
                  <TableHead>Biên LN</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentCosts.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.sku_code}</TableCell>
                    <TableCell>{i.product_name}</TableCell>
                    <TableCell>{formatCurrency(i.total_cost_per_unit)}</TableCell>
                    <TableCell>{i.margin_percentage.toFixed(2)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cảnh báo tồn kho thấp</CardTitle>
        </CardHeader>
        <CardContent>
          {lowStock ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nguyên liệu</TableHead>
                  <TableHead>Tồn kho</TableHead>
                  <TableHead>Tối thiểu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lowStock.map((i: any) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.name}</TableCell>
                    <TableCell>{i.current_stock}</TableCell>
                    <TableCell>{i.minimum_stock}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
