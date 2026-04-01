import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseCostValues, toNumber } from "@/lib/sku-cost-template";

type FormulaRow = {
  sku_id: string;
  ingredient_sku_id: string | null;
  ingredient_name: string;
  unit_price: number | null;
  dosage_qty: number | null;
  wastage_percent: number | null;
  unit?: string | null;
};

const sb = supabase as any;

const normalize = (v: string) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const isFinishedSku = (category: string) => {
  const c = normalize(category);
  return c.includes("thanh pham") || c.includes("finished");
};

const ym = (d: string) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "N/A";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
};

const isLevel2FormulaRow = (name: string) => String(name || "").includes(" > ");

export function useSkuCostBridge() {
  return useQuery({
    queryKey: ["sku-cost-bridge"],
    queryFn: async () => {
      const { data: skus } = await sb.from("product_skus").select("id,sku_code,product_name,category,unit,updated_at,cost_values,finished_output_qty,finished_output_unit").order("updated_at", { ascending: false });

      const skuRows = (skus || []).filter((s: any) => isFinishedSku(String(s.category || "")));
      const skuIds = skuRows.map((s: any) => s.id);

      const [formulaRes, prRes, poRes, invRes, snapRes] = await Promise.all([
        skuIds.length
          ? sb
              .from("sku_formulations")
              .select("sku_id, ingredient_sku_id, ingredient_name, unit_price, dosage_qty, wastage_percent, unit")
              .in("sku_id", skuIds)
          : Promise.resolve({ data: [] }),
        sb
          .from("payment_request_items")
          .select("sku_id, unit_price, created_at")
          .not("sku_id", "is", null)
          .order("created_at", { ascending: true })
          .limit(500),
        sb
          .from("purchase_order_items")
          .select("sku_id, unit_price, created_at, purchase_orders(order_date)")
          .not("sku_id", "is", null)
          .order("created_at", { ascending: true })
          .limit(500),
        sb
          .from("inventory_batches")
          .select("sku_id, quantity, received_date")
          .not("sku_id", "is", null)
          .order("received_date", { ascending: true })
          .limit(500),
        sb
          .from("sku_cost_snapshots")
          .select("snapshot_date, ingredient_cost, packaging_cost, labor_cost, delivery_cost, other_production_cost, sga_cost, total_cost_per_unit")
          .order("snapshot_date", { ascending: true })
          .limit(200),
      ]);

      const formulas = (formulaRes.data || []) as FormulaRow[];
      const purchases = [
        ...((prRes.data || []) as Array<{ sku_id: string; unit_price: number; created_at: string }>),
        ...((poRes.data || []) as Array<any>).map((x) => ({ sku_id: x.sku_id, unit_price: x.unit_price, created_at: x.purchase_orders?.order_date || x.created_at })),
      ].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
      const inventories = (invRes.data || []) as Array<{ sku_id: string; quantity: number; received_date: string }>;

      const inventoryBySku = new Map<string, number>();
      inventories.forEach((i) => {
        inventoryBySku.set(i.sku_id, (inventoryBySku.get(i.sku_id) || 0) + toNumber(i.quantity, 0));
      });

      const items = skuRows.map((sku: any) => {
        const costValues = parseCostValues(sku.cost_values);
        const lines = formulas.filter((f) => f.sku_id === sku.id && !isLevel2FormulaRow(f.ingredient_name));

        // Đồng bộ với màn Edit/Detail: dùng unit_price * dosage_qty từ công thức đã lưu
        const materialBatchCost = lines.reduce((sum, l) => {
          const unitPrice = toNumber(l.unit_price, 0);
          const usage = toNumber(l.dosage_qty, 0);
          const wastage = toNumber(l.wastage_percent, 0) / 100;
          return sum + unitPrice * usage * (1 + wastage);
        }, 0);

        const outputQty = Math.max(1, toNumber(sku.finished_output_qty, 100));
        const ingredientBase = materialBatchCost / outputQty;
        const provisionPct = toNumber(costValues.material_provision_percent, 0);
        const ingredientCost = ingredientBase * (1 + provisionPct / 100);

        const packagingCost = toNumber(costValues.packaging_cost, 0);
        const laborCost = toNumber(costValues.labor_cost, 0);
        const deliveryCost = toNumber(costValues.delivery_cost, 0);
        const otherProductionCost = toNumber(costValues.other_production_cost, 0);
        const sgaCost = toNumber(costValues.sga_cost, 0);
        const extraCost = 0;

        const totalCost = ingredientCost + packagingCost + laborCost + deliveryCost + otherProductionCost + sgaCost + extraCost;
        const selling = toNumber(costValues.selling_price, 0);
        const margin = selling - totalCost;
        const marginPct = selling > 0 ? (margin / selling) * 100 : 0;

        const ingredientStock = lines.reduce((sum, l) => sum + (l.ingredient_sku_id ? (inventoryBySku.get(l.ingredient_sku_id) || 0) : 0), 0);

        return {
          id: sku.id,
          sku_code: sku.sku_code,
          product_name: sku.product_name,
          category: sku.category || "",
          unit: sku.unit || sku.finished_output_unit || "",
          updated_at: sku.updated_at,
          ingredient_cost: ingredientCost,
          packaging_cost: packagingCost,
          labor_cost: laborCost,
          delivery_cost: deliveryCost,
          other_production_cost: otherProductionCost,
          sga_cost: sgaCost,
          extra_cost: extraCost,
          total_cost_per_unit: totalCost,
          selling_price: selling,
          margin,
          margin_percentage: marginPct,
          finished_output_qty: outputQty,
          finished_output_unit: sku.finished_output_unit || sku.unit || "cái",
          estimated_ingredient_stock: ingredientStock,
        };
      });

      const snapshots = (snapRes.data || []) as Array<any>;
      let trendRows: Array<{ label: string; ingredient: number; labor: number; overhead: number; total: number }> = [];

      if (snapshots.length) {
        const dayMap = new Map<string, { ingredient: number; labor: number; overhead: number; total: number; count: number }>();
        snapshots.forEach((s) => {
          const key = String(s.snapshot_date || "");
          const row = dayMap.get(key) || { ingredient: 0, labor: 0, overhead: 0, total: 0, count: 0 };
          row.ingredient += toNumber(s.ingredient_cost, 0);
          row.labor += toNumber(s.labor_cost, 0);
          row.overhead += toNumber(s.packaging_cost, 0) + toNumber(s.delivery_cost, 0) + toNumber(s.other_production_cost, 0) + toNumber(s.sga_cost, 0);
          row.total += toNumber(s.total_cost_per_unit, 0);
          row.count += 1;
          dayMap.set(key, row);
        });

        trendRows = Array.from(dayMap.entries())
          .sort((a, b) => +new Date(a[0]) - +new Date(b[0]))
          .map(([k, v]) => ({
            label: k,
            ingredient: v.count ? v.ingredient / v.count : 0,
            labor: v.count ? v.labor / v.count : 0,
            overhead: v.count ? v.overhead / v.count : 0,
            total: v.count ? v.total / v.count : 0,
          }));
      } else {
        const monthMap = new Map<string, { ingredient: number; sample: number }>();
        purchases.forEach((p) => {
          const k = ym(p.created_at);
          const m = monthMap.get(k) || { ingredient: 0, sample: 0 };
          m.ingredient += toNumber(p.unit_price, 0);
          m.sample += 1;
          monthMap.set(k, m);
        });

        const sortedMonths = Array.from(monthMap.keys()).sort();
        const avgFixed = items.length
          ? items.reduce((s, i) => s + i.packaging_cost + i.labor_cost + i.delivery_cost + i.other_production_cost + i.sga_cost + i.extra_cost, 0) / items.length
          : 0;

        trendRows = sortedMonths.map((k) => {
          const m = monthMap.get(k)!;
          const ingredient = m.sample ? m.ingredient / m.sample : 0;
          const total = ingredient + avgFixed;
          return { label: k, ingredient, labor: 0, overhead: avgFixed, total };
        });
      }

      return { items, trendRows };
    },
  });
}
