import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell } from "recharts";
import { useSkuCostBridge } from "@/hooks/useSkuCostBridge";

const tabItems = [
  { key: "sku", label: "SKU Cost" },
  { key: "trends", label: "Xu hướng chi phí" },
  { key: "overhead", label: "Phân bổ chi phí chung" },
];

const COLORS = ["#16a34a", "#0ea5e9", "#f59e0b", "#ef4444", "#8b5cf6"];
const money = (v: number) => new Intl.NumberFormat("vi-VN").format(Number(v || 0));

export default function SkuCostsAnalysis() {
  const [tab, setTab] = useState("sku");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useSkuCostBridge();

  const items = data?.items || [];
  const trendRows = data?.trendRows || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c: any) => `${c.sku_code} ${c.product_name}`.toLowerCase().includes(q));
  }, [items, search]);

  const breakdown = useMemo(() => {
    if (!filtered.length) return [];
    const sum = filtered.reduce(
      (acc: any, i: any) => {
        acc.ingredient += i.ingredient_cost;
        acc.packaging += i.packaging_cost;
        acc.labor += i.labor_cost;
        acc.overhead += i.delivery_cost + i.other_production_cost + i.sga_cost + i.extra_cost;
        return acc;
      },
      { ingredient: 0, packaging: 0, labor: 0, overhead: 0 }
    );
    return [
      { name: "Nguyên liệu", value: sum.ingredient },
      { name: "Bao bì", value: sum.packaging },
      { name: "Nhân công", value: sum.labor },
      { name: "Chi phí khác", value: sum.overhead },
    ];
  }, [filtered]);

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
            <CardHeader><CardTitle>Bộ lọc</CardTitle></CardHeader>
            <CardContent><Input placeholder="Tìm kiếm SKU hoặc sản phẩm" value={search} onChange={(e) => setSearch(e.target.value)} /></CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>SKU Cost (linked từ SKU Quản trị)</CardTitle></CardHeader>
            <CardContent>
              {!filtered.length ? (
                <div className="text-sm text-muted-foreground">{isLoading ? "Đang tải dữ liệu..." : "Chưa có dữ liệu."}</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Nguyên liệu</TableHead>
                      <TableHead>Bao bì</TableHead>
                      <TableHead>Nhân công</TableHead>
                      <TableHead>Delivery</TableHead>
                      <TableHead>Other Prod.</TableHead>
                      <TableHead>BH&QL</TableHead>
                      <TableHead>Tổng/cái</TableHead>
                      <TableHead>Thành phẩm</TableHead>
                      <TableHead>Giá bán</TableHead>
                      <TableHead>Biên LN</TableHead>
                      <TableHead>Stock NVL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((c: any) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono text-xs">{c.sku_code}<div className="text-muted-foreground">{c.product_name}</div></TableCell>
                        <TableCell>{money(c.ingredient_cost)}</TableCell>
                        <TableCell>{money(c.packaging_cost)}</TableCell>
                        <TableCell>{money(c.labor_cost)}</TableCell>
                        <TableCell>{money(c.delivery_cost)}</TableCell>
                        <TableCell>{money(c.other_production_cost)}</TableCell>
                        <TableCell>{money(c.sga_cost + c.extra_cost)}</TableCell>
                        <TableCell className="font-semibold">{money(c.total_cost_per_unit)}</TableCell>
                        <TableCell>{c.finished_output_qty} {c.finished_output_unit}</TableCell>
                        <TableCell>{money(c.selling_price)}</TableCell>
                        <TableCell>{c.margin_percentage?.toFixed?.(2)}%</TableCell>
                        <TableCell>{money(c.estimated_ingredient_stock)}</TableCell>
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader><CardTitle>Cost Trend theo dữ liệu mua hàng</CardTitle></CardHeader>
            <CardContent className="h-64">
              {trendRows.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendRows}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip />
                    <Line type="monotone" dataKey="total" stroke="#0f172a" />
                    <Line type="monotone" dataKey="ingredient" stroke="#22c55e" />
                    <Line type="monotone" dataKey="overhead" stroke="#ef4444" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-sm text-muted-foreground">Chưa có dữ liệu mua hàng để dựng trend.</div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Tỷ trọng nhóm chi phí</CardTitle></CardHeader>
            <CardContent className="h-64">
              {breakdown.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={breakdown} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90}>
                      {breakdown.map((_: any, idx: number) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
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
      )}

      {tab === "overhead" && (
        <Card>
          <CardHeader><CardTitle>Phân bổ chi phí chung</CardTitle></CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Delivery + Other Production + BH&QL đang được gom vào nhóm chi phí chung trong phân tích tổng quan.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
