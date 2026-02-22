import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { parseCostValues, toNumber } from "@/lib/sku-cost-template";

export default function SkuCostsDjango() {
  const [skus, setSkus] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("product_skus").select("*").order("updated_at", { ascending: false });
        const finished = (data || []).filter((s: any) => String(s.category || "").toLowerCase().includes("thành phẩm"));
        setSkus(finished);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const summary = useMemo(() => {
    const count = skus.length;
    const avgSellingPrice = count > 0
      ? skus.reduce((sum, s) => sum + toNumber(parseCostValues(s.cost_values).selling_price, 0), 0) / count
      : 0;
    return { count, avgSellingPrice };
  }, [skus]);

  const vnd = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n || 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Tổng SKU thành phẩm</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-24" /> : <div className="text-2xl font-semibold">{summary.count}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Giá bán trung bình</CardTitle></CardHeader>
          <CardContent>
            {loading ? <Skeleton className="h-8 w-32" /> : <div className="text-2xl font-semibold">{vnd(summary.avgSellingPrice)}</div>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Danh sách SKU thành phẩm hiện có</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Tên sản phẩm</TableHead>
                  <TableHead>Giá bán</TableHead>
                  <TableHead>Cập nhật</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skus.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.sku_code}</TableCell>
                    <TableCell>{s.product_name}</TableCell>
                    <TableCell>{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</TableCell>
                    <TableCell>{s.updated_at ? new Date(s.updated_at).toLocaleString("vi-VN") : "-"}</TableCell>
                  </TableRow>
                ))}
                {skus.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-muted-foreground">Chưa có SKU thành phẩm.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
