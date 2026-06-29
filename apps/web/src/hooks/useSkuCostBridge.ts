 
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { parseCostValues, toNumber } from "@/lib/sku-cost-template";

export type FormulaRow = {
  sku_id: string;
  ingredient_sku_id: string | null;
  ingredient_name: string;
  material_code?: string | null;
  unit_price: number | null;
  dosage_qty: number | null;
  wastage_percent: number | null;
  unit?: string | null;
};

export type ActualCostPurchase = {
  sku_id: string | null;
  product_name?: string | null;
  product_code?: string | null;
  unit?: string | null;
  unit_price: number | null;
  quantity?: number | null;
  line_total?: number | null;
  created_at: string;
  source: "payment_request" | "purchase_order";
  payment_status?: string | null;
  status?: string | null;
  paid_at?: string | null;
  request_number?: string | null;
  confirmed_standard_cost_code?: string | null;
  suggested_standard_cost_code?: string | null;
  standard_cost_code?: string | null;
  canonical_cost_item_name?: string | null;
  unit_conversion_note?: string | null;
};

const sb = supabase as any;
const PAGE_SIZE = 1000;

async function fetchAllRows(baseQueryFactory: () => any) {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await baseQueryFactory().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

const normalize = (v: string) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const isFinishedSku = (category: string) => {
  const c = normalize(category);
  return c.includes("thanh pham") || c.includes("finished");
};

const isLevel2FormulaRow = (name: string) => String(name || "").includes(" > ");

export function useSkuCostBridge() {
  return useQuery({
    queryKey: ["sku-cost-bridge"],
    queryFn: async () => {
      const { data: skus } = await sb.from("product_skus").select("id,sku_code,product_name,category,unit,updated_at,cost_values,finished_output_qty,finished_output_unit,image_url,image_path,image_updated_at").order("updated_at", { ascending: false });

      const skuRows = (skus || []).filter((s: any) => isFinishedSku(String(s.category || "")));
      const skuIds = skuRows.map((s: any) => s.id);

      const [formulaRes, prRows, poRows, invRes] = await Promise.all([
        skuIds.length
          ? sb
              .from("sku_formulations")
              .select("sku_id, ingredient_sku_id, ingredient_name, material_code, unit_price, dosage_qty, wastage_percent, unit")
              .in("sku_id", skuIds)
          : Promise.resolve({ data: [] }),
        fetchAllRows(() =>
          sb
            .from("payment_request_items")
            .select("sku_id, product_name, product_code, unit, quantity, unit_price, line_total, created_at, unit_conversion_note, confirmed_standard_cost_code, suggested_standard_cost_code, standard_cost_code_type, canonical_cost_item_name, payment_requests(request_number,payment_status,status,paid_at,approved_at,updated_at)")
            .order("created_at", { ascending: true })
        ),
        fetchAllRows(() =>
          sb
            .from("purchase_order_items")
            .select("sku_id, product_name, quantity, unit, unit_price, line_total, created_at, purchase_orders(order_date)")
            .order("created_at", { ascending: true })
        ),
        sb
          .from("inventory_batches")
          .select("sku_id, quantity, received_date")
          .not("sku_id", "is", null)
          .order("received_date", { ascending: true })
          .limit(500),
      ]);

      const formulas = (formulaRes.data || []) as FormulaRow[];
      const purchases: ActualCostPurchase[] = [
        ...(prRows as Array<any>).map((x) => ({
          sku_id: x.sku_id,
          product_name: x.product_name || null,
          product_code: x.product_code || null,
          unit: x.unit || null,
          unit_price: x.unit_price,
          quantity: x.quantity,
          line_total: x.line_total,
          created_at: x.payment_requests?.paid_at || x.payment_requests?.approved_at || x.payment_requests?.updated_at || x.created_at,
          source: "payment_request" as const,
          payment_status: x.payment_requests?.payment_status || null,
          status: x.payment_requests?.status || null,
          paid_at: x.payment_requests?.paid_at || null,
          request_number: x.payment_requests?.request_number || null,
          confirmed_standard_cost_code: x.confirmed_standard_cost_code || null,
          suggested_standard_cost_code: x.suggested_standard_cost_code || null,
          standard_cost_code: x.confirmed_standard_cost_code || x.suggested_standard_cost_code || null,
          canonical_cost_item_name: x.canonical_cost_item_name || null,
          unit_conversion_note: x.unit_conversion_note || null,
        })),
        ...(poRows as Array<any>).map((x) => ({
          sku_id: x.sku_id,
          product_name: x.product_name || null,
          product_code: null,
          unit: x.unit || null,
          unit_price: x.unit_price,
          quantity: x.quantity,
          line_total: x.line_total,
          created_at: x.purchase_orders?.order_date || x.created_at,
          source: "purchase_order" as const,
          payment_status: null,
          status: null,
        })),
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
          image_url: sku.image_url || null,
          image_path: sku.image_path || null,
          image_updated_at: sku.image_updated_at || null,
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

      return { items, formulas, purchases };
    },
  });
}
