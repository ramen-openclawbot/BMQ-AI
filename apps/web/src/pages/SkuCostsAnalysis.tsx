import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { useSkuCostsDjango } from "@/hooks/useSkuCostsDjango";
import { useDjangoRecentCosts } from "@/hooks/useDjangoRecentCosts";
import { useDjangoCostTrend } from "@/hooks/useDjangoCostTrend";

const tabItems = [
  { key: "sku", label: "SKU Cost" },
  { key: "trends", label: "Xu hướng chi phí" },
  { key: "overhead", label: "Phân bổ chi phí chung" },
];

const COLORS = ["#16a34a", "#f59e0b", "#ef4444"];

export default function SkuCostsAnalysis() {
  const [tab, setTab] = useState("sku");
  const { data, isLoading } = useSkuCostsDjango();
  const { data: recentCosts } = useDjangoRecentCosts();
  const firstProductId = data?.[0]?.product_id;
  const { data: trend } = useDjangoCostTrend(firstProductId);

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
      <div className="flex flex-wrap gap-2">
        {tabItems.map((t) => (
          <Button key={t.key} variant={tab === t.key ? "default" : "outline"} onClick={() => setTab(t.key)}>
            {t.label}
          </Button>
        ))}
      </div>

      {tab === "sku" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Bộ lọc</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Input placeholder="Tìm kiếm SKU hoặc sản phẩm" />
              <Select>
                <SelectTrigger><SelectValue placeholder="Danh mục" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả</SelectItem>
                </SelectContent>
              </Select>
              <Select>
                <SelectTrigger><SelectValue placeholder="Sắp xếp" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">Mới nhất</SelectItem>
                  <SelectItem value="old">Cũ nhất</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>SKU Cost</CardTitle>
            </CardHeader>
            <CardContent>
              {!data || data.length === 0 ? (
                <div className="text-sm text-muted-foreground">Chưa có dữ liệu.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU Code</TableHead>
                      <TableHead>Sản phẩm</TableHead>
                      <TableHead>Nguyên liệu</TableHead>
                      <TableHead>Nhân công</TableHead>
                      <TableHead>Chi phí chung</TableHead>
                      <TableHead>Tổng</TableHead>
                      <TableHead>Giá bán</TableHead>
                      <TableHead>Biên LN</TableHead>
                      <TableHead>%</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono text-xs">{c.sku_code}</TableCell>
                        <TableCell>{c.product_name}</TableCell>
                        <TableCell>{c.ingredient_cost?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.labor_cost?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.overhead_cost?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell className="font-semibold">{c.total_cost_per_unit?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.selling_price?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.margin?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.margin_percentage?.toFixed?.(2)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "trends" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Bộ lọc</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Select>
                <SelectTrigger><SelectValue placeholder="Danh mục" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả</SelectItem>
                </SelectContent>
              </Select>
              <Select>
                <SelectTrigger><SelectValue placeholder="Chu kỳ" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="3m">3 tháng</SelectItem>
                  <SelectItem value="6m">6 tháng</SelectItem>
                  <SelectItem value="12m">12 tháng</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Cost Trend Over Time</CardTitle>
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
                  <div className="text-sm text-muted-foreground">Chưa có dữ liệu.</div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cost Components</CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                {breakdown.length ? (
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
                ) : (
                  <div className="text-sm text-muted-foreground">Chưa có dữ liệu.</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Biggest Cost Changes</CardTitle>
            </CardHeader>
            <CardContent>
              {!recentCosts || recentCosts.length === 0 ? (
                <div className="text-sm text-muted-foreground">Chưa có dữ liệu.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sản phẩm</TableHead>
                      <TableHead>Giá thành</TableHead>
                      <TableHead>Biên LN</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentCosts.map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.product_name}</TableCell>
                        <TableCell>{c.total_cost_per_unit?.toLocaleString("vi-VN")}</TableCell>
                        <TableCell>{c.margin_percentage?.toFixed?.(2)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {tab === "overhead" && (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Phân bổ chi phí chung</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Chưa có dữ liệu phân bổ theo danh mục/tháng. Ramen sẽ nối API khi backend sẵn sàng.
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
