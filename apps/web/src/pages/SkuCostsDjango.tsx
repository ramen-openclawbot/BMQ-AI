import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  const stats = useMemo(() => {
    const count = skus.length;
    const sellingPrices = skus.map((s) => toNumber(parseCostValues(s.cost_values).selling_price, 0));
    const avgSelling = count ? sellingPrices.reduce((a, b) => a + b, 0) / count : 0;
    const maxSelling = count ? Math.max(...sellingPrices) : 0;
    const updatedAt = skus[0]?.updated_at;
    return { count, avgSelling, maxSelling, updatedAt };
  }, [skus]);

  const vnd = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n || 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">SKU thành phẩm</div><div className="text-xl font-semibold">{loading ? "..." : stats.count}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Giá bán TB</div><div className="text-xl font-semibold">{loading ? "..." : vnd(stats.avgSelling)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Giá bán cao nhất</div><div className="text-xl font-semibold">{loading ? "..." : vnd(stats.maxSelling)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Cập nhật gần nhất</div><div className="text-sm font-medium">{loading ? "..." : (stats.updatedAt ? new Date(stats.updatedAt).toLocaleString("vi-VN") : "-")}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">SKU mới cập nhật</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <div className="text-sm text-muted-foreground">Đang tải...</div>
          ) : skus.length === 0 ? (
            <div className="text-sm text-muted-foreground">Chưa có dữ liệu.</div>
          ) : (
            skus.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center justify-between border rounded px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{s.product_name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{s.sku_code}</div>
                </div>
                <div className="font-semibold">{vnd(toNumber(parseCostValues(s.cost_values).selling_price, 0))}</div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
