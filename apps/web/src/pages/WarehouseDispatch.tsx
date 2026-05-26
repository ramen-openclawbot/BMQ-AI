/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Truck, Plus, Loader2, PackageCheck, AlertTriangle, RefreshCw, Brain, Camera, FileSpreadsheet, PackageSearch, FilePlus2, CheckCircle2 } from "lucide-react";
import { format, subDays } from "date-fns";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type DispatchStatus = "pending" | "picked" | "dispatched" | "delivered";

interface PoInbox {
  id: string;
  po_number: string | null;
  from_name: string | null;
  delivery_date: string | null;
  matched_customer_id: string | null;
  total_amount?: number | null;
  customer_address?: string | null;
  production_items: Array<{
    product_name: string;
    qty: number;
    unit: string;
    sku?: string;
    unit_price?: number;
    line_total?: number;
    amount?: number;
  }> | null;
}

interface InventoryItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  sku_id?: string;
}

interface DispatchFormItem {
  product_name: string;
  sku?: string;
  ordered_qty: number;    // from sales PO
  available_qty: number;  // from inventory
  dispatch_qty: number;   // what we're dispatching
  produced_qty: number;   // usable/accepted bánh
  defect_qty: number;
  billable_qty: number;
  unit_price_vat_included: number;
  source_line_amount_vat_included: number;
  actual_revenue_amount: string;
  shortage_reason_code: string;
  shortage_note: string;
  shortage_sku: string;
  unit: string;
  inventory_item_id?: string;
}

interface DispatchItem {
  id: string;
  dispatch_id: string;
  sku_id?: string;
  product_name: string;
  quantity: number;
  unit: string;
}

interface Dispatch {
  id: string;
  dispatch_number: string;
  customer_id: string | null;
  production_order_id: string | null;
  status: DispatchStatus;
  dispatch_date: string | null;
  delivered_date: string | null;
  delivery_address: string | null;
  notes: string | null;
  created_at: string;
  items?: DispatchItem[];
  // joined
  source_po_number?: string;
  customer_name?: string;
}

type ProductionOrderForMaterials = {
  id: string;
  production_number: string;
  source_po_inbox_id: string | null;
  status: string;
  planned_start_date: string | null;
  planned_end_date: string | null;
  created_at: string;
  notes: string | null;
};

type ProductionOrderItemForMaterials = {
  id: string;
  production_order_id: string;
  sku_id: string | null;
  product_name: string;
  ordered_qty: number | null;
  planned_qty: number | null;
  actual_qty: number | null;
  unit: string | null;
  delivery_date: string | null;
};

type MaterialSkuRow = {
  id: string;
  sku_code: string | null;
  product_name: string;
  unit: string | null;
  sku_type?: string | null;
};

type SkuFormulaRow = {
  id: string;
  sku_id: string;
  ingredient_sku_id: string | null;
  ingredient_name: string;
  unit: string | null;
  unit_price: number | null;
  dosage_qty: number | null;
  wastage_percent: number | null;
  sort_order: number | null;
};

type KitchenItemRow = {
  id: string;
  product_sku_id: string | null;
  name: string;
  unit: string;
  standard_unit_cost: number | null;
  active: boolean;
};

type ProductionMaterialIssue = {
  id: string;
  issue_number: string;
  production_order_id: string;
  issue_date: string;
  status: string;
  total_amount: number;
  created_at: string;
};

type ProductionMaterialIssueItem = {
  id: string;
  material_issue_id: string;
  ingredient_name: string;
  planned_finished_qty: number;
  dosage_qty: number;
  wastage_percent: number;
  required_qty: number;
  unit: string;
  unit_cost: number;
  amount: number;
};

type MaterialPreviewRow = {
  key: string;
  production_item_name: string;
  finished_qty: number;
  ingredient_name: string;
  required_qty: number;
  unit: string;
  unit_cost: number;
  amount: number;
  source: string;
  status: "ready" | "missing_finished_sku" | "missing_formula" | "missing_kitchen_item";
};

const statusConfig: Record<DispatchStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:    { label: "Chờ xuất kho",   variant: "secondary" },
  picked:     { label: "Đang lấy hàng",  variant: "default" },
  dispatched: { label: "Đã xuất kho",    variant: "default" },
  delivered:  { label: "Đã giao",        variant: "default" },
};

const statusColors: Record<DispatchStatus, string> = {
  pending:    "bg-slate-100 text-slate-700",
  picked:     "bg-blue-100 text-blue-700",
  dispatched: "bg-amber-100 text-amber-700",
  delivered:  "bg-green-100 text-green-700",
};

const shortageReasons = [
  { value: "production_defect", label: "Lỗi sản xuất" },
  { value: "warehouse_shortage", label: "Thiếu kho" },
  { value: "customer_change", label: "Khách đổi số lượng" },
  { value: "other", label: "Khác" },
];

const moneyNumber = (value: string) => {
  const numeric = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
};

const amountStatusLabel: Record<string, string> = {
  temporary_po_amount: "Doanh thu tạm từ PO",
  confirmed_dispatch_amount: "Đã xác nhận số xuất",
  needs_sku_allocation: "Cần chọn SKU thiếu",
  month_end_audit_adjusted: "Đã chỉnh audit cuối tháng",
};

export default function WarehouseDispatch() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const dispatchPoId = params.get("dispatchPoId") || "";
  const dispatchRevenueDate = params.get("revenueDate") || "";
  const dispatchReason = params.get("reason") || "";
  const [activeTab, setActiveTab] = useState<DispatchStatus | "all">("all");
  const [activeWorkflow, setActiveWorkflow] = useState<"finished" | "materials">("finished");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Dispatch | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Form state
  const [selectedPoId, setSelectedPoId] = useState("");
  const [dispatchDate, setDispatchDate] = useState(dispatchRevenueDate || format(new Date(), "yyyy-MM-dd"));
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [notes, setNotes] = useState(dispatchReason === "short_delivery" ? "Xử lý giao thiếu từ ledger: xác nhận số xuất thực tế/billable theo vận hành." : "");
  const [formItems, setFormItems] = useState<DispatchFormItem[]>([]);
  const [autoOpenDispatchFromLedger, setAutoOpenDispatchFromLedger] = useState(Boolean(dispatchPoId));

  // ── Queries ──────────────────────────────────────────────────────────────

  // Dispatches list
  const { data: dispatches = [], isLoading } = useQuery({
    queryKey: ["warehouse_dispatches"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("warehouse_dispatches")
        .select("id,dispatch_number,dispatch_date,customer_name,notes,status,created_at,created_by")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data || [];
    },
  });

  // Dispatch items (all, filtered client-side)
  const { data: allDispatchItems = [] } = useQuery({
    queryKey: ["warehouse_dispatch_items"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("warehouse_dispatch_items")
        .select("id,dispatch_id,sku_id,sku_code,product_name,quantity,unit,notes")
        .limit(1000);
      if (error) throw error;
      return data || [];
    },
  });

  // Approved sales POs for dispatch — delivery_date trong 3 ngày trước ngày xuất kho
  // Ví dụ: ngày xuất = 04/04 → lấy PO có delivery_date từ 01/04 đến 03/04
  const { data: salesPOs = [] } = useQuery<PoInbox[]>({
    queryKey: ["po_inbox_for_dispatch", dispatchDate, dispatchPoId],
    queryFn: async () => {
      const dispatchDateObj = new Date(dispatchDate);
      const fromDate = format(subDays(dispatchDateObj, 3), "yyyy-MM-dd"); // -3 ngày
      const toDate   = format(subDays(dispatchDateObj, 1), "yyyy-MM-dd"); // -1 ngày (không lấy chính ngày xuất)

      let query = (supabase as any)
        .from("customer_po_inbox")
        .select(`
          id, po_number, from_name, delivery_date, matched_customer_id, production_items,
          total_amount,
          mini_crm_customers!matched_customer_id ( address )
        `)
        .eq("match_status", "approved")
        .not("production_items", "is", null);

      if (dispatchPoId) {
        query = query.eq("id", dispatchPoId);
      } else {
        query = query.gte("delivery_date", fromDate).lte("delivery_date", toDate);
      }

      const { data, error } = await query.order("delivery_date", { ascending: true });
      if (error) throw error;
      // Flatten joined customer address
      return (data || []).map((row: any) => ({
        ...row,
        customer_address: row.mini_crm_customers?.address ?? null,
      }));
    },
    enabled: createOpen || Boolean(dispatchPoId),
  });

  // Finished goods inventory (sku_type = 'finished_good')
  const { data: finishedInventory = [], isFetched: isInventoryFetched } = useQuery<InventoryItem[]>({
    queryKey: ["inventory_finished_goods"],
    queryFn: async () => {
      // Get inventory_items joined with product_skus to filter finished_good
      const { data: skus, error: skuErr } = await supabase
        .from("product_skus")
        .select("id, product_name, sku_code")
        .eq("sku_type", "finished_good" as any);
      if (skuErr) throw skuErr;

      const { data: items, error: itemErr } = await supabase
        .from("inventory_items")
        .select("id, name, quantity, unit");
      if (itemErr) throw itemErr;

      // Cross-reference by name (loose match)
      const skuNames = new Set((skus || []).map((s: any) => s.product_name.toLowerCase().trim()));
      return (items || []).filter((inv: any) =>
        skuNames.has(inv.name.toLowerCase().trim()) || inv.quantity > 0
      ).map((inv: any) => ({ ...inv }));
    },
    enabled: createOpen || Boolean(dispatchPoId),
  });

  const { data: materialOrders = [], isLoading: loadingMaterialOrders } = useQuery<ProductionOrderForMaterials[]>({
    queryKey: ["production_orders_for_material_issue"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_orders")
        .select("id,production_number,source_po_inbox_id,status,planned_start_date,planned_end_date,created_at,notes")
        .in("status", ["draft", "planned", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials",
  });

  const materialOrderIds = materialOrders.map((order) => order.id);

  const { data: materialOrderItems = [] } = useQuery<ProductionOrderItemForMaterials[]>({
    queryKey: ["production_order_items_for_material_issue", materialOrderIds.join(",")],
    queryFn: async () => {
      if (!materialOrderIds.length) return [];
      const { data, error } = await (supabase as any)
        .from("production_order_items")
        .select("id,production_order_id,sku_id,product_name,ordered_qty,planned_qty,actual_qty,unit,delivery_date")
        .in("production_order_id", materialOrderIds)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials" && materialOrderIds.length > 0,
  });

  const { data: materialSkus = [] } = useQuery<MaterialSkuRow[]>({
    queryKey: ["material_issue_product_skus"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("product_skus")
        .select("id,sku_code,product_name,unit,sku_type")
        .order("product_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials",
  });

  const { data: skuFormulations = [] } = useQuery<SkuFormulaRow[]>({
    queryKey: ["material_issue_sku_formulations"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("sku_formulations")
        .select("id,sku_id,ingredient_sku_id,ingredient_name,unit,unit_price,dosage_qty,wastage_percent,sort_order")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials",
  });

  const { data: kitchenItems = [] } = useQuery<KitchenItemRow[]>({
    queryKey: ["material_issue_kitchen_items"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("kitchen_inventory_items")
        .select("id,product_sku_id,name,unit,standard_unit_cost,active")
        .eq("active", true)
        .order("name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials",
  });

  const { data: materialIssues = [] } = useQuery<ProductionMaterialIssue[]>({
    queryKey: ["production_material_issues"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_material_issues")
        .select("id,issue_number,production_order_id,issue_date,status,total_amount,created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials",
  });

  const { data: materialIssueItems = [] } = useQuery<ProductionMaterialIssueItem[]>({
    queryKey: ["production_material_issue_items", materialIssues.map((issue) => issue.id).join(",")],
    queryFn: async () => {
      const issueIds = materialIssues.map((issue) => issue.id);
      if (!issueIds.length) return [];
      const { data, error } = await (supabase as any)
        .from("production_material_issue_items")
        .select("id,material_issue_id,ingredient_name,planned_finished_qty,dosage_qty,wastage_percent,required_qty,unit,unit_cost,amount")
        .in("material_issue_id", issueIds)
        .order("ingredient_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: activeWorkflow === "materials" && materialIssues.length > 0,
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSelectPO = useCallback((poId: string) => {
    setSelectedPoId(poId);
    const po = salesPOs.find((p) => p.id === poId);
    if (!po?.production_items?.length) {
      setFormItems([]);
      return;
    }

    // Map PO items → form items, cross-reference with inventory
    const poTotal = Number(po.total_amount || 0);
    const totalOrderedQty = po.production_items.reduce((sum, pi) => sum + Number(pi.qty || 0), 0);
    const mapped: DispatchFormItem[] = po.production_items.map((pi) => {
      const inv = finishedInventory.find(
        (i) => i.name.toLowerCase().includes(pi.product_name.toLowerCase().trim()) ||
               pi.product_name.toLowerCase().includes(i.name.toLowerCase().trim())
      );
      const orderedQty = Number(pi.qty || 0);
      const dispatchQty = Math.min(orderedQty, inv?.quantity ?? 0);
      const sourceLineAmount = Number(pi.line_total || pi.amount || 0) || (poTotal > 0 && totalOrderedQty > 0 ? poTotal * orderedQty / totalOrderedQty : 0);
      const unitPrice = Number(pi.unit_price || 0) || (orderedQty > 0 ? sourceLineAmount / orderedQty : 0);
      return {
        product_name: pi.product_name,
        sku: pi.sku,
        ordered_qty: orderedQty,
        available_qty: inv?.quantity ?? 0,
        dispatch_qty: dispatchQty,
        produced_qty: dispatchQty,
        defect_qty: Math.max(orderedQty - dispatchQty, 0),
        billable_qty: dispatchQty,
        unit_price_vat_included: unitPrice,
        source_line_amount_vat_included: sourceLineAmount,
        actual_revenue_amount: "",
        shortage_reason_code: "production_defect",
        shortage_note: "",
        // Shortage SKU must be chosen explicitly when there is a shortage.
        // Do not default to the PO SKU, otherwise a short dispatch can become
        // final revenue without the operator allocating which SKU was missing.
        shortage_sku: Math.max(orderedQty - dispatchQty, 0) > 0 ? "" : (pi.sku || ""),
        unit: pi.unit || inv?.unit || "kg",
        inventory_item_id: inv?.id,
      };
    });
    setFormItems(mapped);
    // Pre-fill delivery date from PO
    if (po.delivery_date) setDispatchDate(po.delivery_date);
    // Auto-fill delivery address from CRM customer profile (only if not already filled)
    if (po.customer_address) setDeliveryAddress(po.customer_address);
  }, [finishedInventory, salesPOs]);

  useEffect(() => {
    if (!autoOpenDispatchFromLedger || !dispatchPoId) return;
    setCreateOpen(true);
  }, [autoOpenDispatchFromLedger, dispatchPoId]);

  useEffect(() => {
    if (!autoOpenDispatchFromLedger || !dispatchPoId || !salesPOs.length || !isInventoryFetched) return;
    const po = salesPOs.find((p) => p.id === dispatchPoId);
    if (!po) return;
    setSelectedPoId(dispatchPoId);
    handleSelectPO(dispatchPoId);
    setAutoOpenDispatchFromLedger(false);
  }, [autoOpenDispatchFromLedger, dispatchPoId, handleSelectPO, isInventoryFetched, salesPOs]);

  const handleDispatchQtyChange = (idx: number, val: string) => {
    const qty = Math.max(0, parseFloat(val) || 0);
    setFormItems((prev) => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        dispatch_qty: qty,
        produced_qty: qty,
        defect_qty: Math.max(next[idx].ordered_qty - qty, 0),
        billable_qty: qty,
      };
      return next;
    });
  };

  const updateFormItem = (idx: number, patch: Partial<DispatchFormItem>) => {
    setFormItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const resetForm = () => {
    setSelectedPoId("");
    setDispatchDate(format(new Date(), "yyyy-MM-dd"));
    setDeliveryAddress("");
    setNotes("");
    setFormItems([]);
  };

  // ── Mutations ─────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPoId) throw new Error("Vui lòng chọn đơn hàng bán");
      if (!formItems.length) throw new Error("Không có sản phẩm nào để xuất");

      const { data: existingConfirmation, error: existingConfirmationErr } = await (supabase as any)
        .from("po_dispatch_revenue_confirmations")
        .select("id,status,amount_status,warehouse_dispatch_id")
        .eq("customer_po_inbox_id", selectedPoId)
        .neq("status", "cancelled")
        .maybeSingle();
      if (existingConfirmationErr) throw existingConfirmationErr;
      if (existingConfirmation?.id) {
        throw new Error("PO này đã có xác nhận số xuất/doanh thu. Vui lòng mở bản xác nhận hiện có hoặc revise thay vì tạo phiếu mới để tránh cộng trùng công nợ.");
      }

      const itemsToDispatch = formItems.filter((i) => i.dispatch_qty > 0);
      if (!itemsToDispatch.length) throw new Error("Số lượng xuất phải lớn hơn 0");

      // Check over-dispatch
      const over = itemsToDispatch.find((i) => i.dispatch_qty > i.available_qty);
      if (over) throw new Error(`Tồn kho không đủ: ${over.product_name} chỉ còn ${over.available_qty} ${over.unit}`);

      // Generate XK number
      const dateStr = format(new Date(), "yyyyMMdd");
      const { data: existing } = await (supabase as any)
        .from("warehouse_dispatches")
        .select("id")
        .ilike("dispatch_number", `XK-${dateStr}-%`);
      const seq = String((existing?.length ?? 0) + 1).padStart(3, "0");
      const dispatch_number = `XK-${dateStr}-${seq}`;

      const po = salesPOs.find((p) => p.id === selectedPoId);

      // Find linked production order if exists
      const { data: linkedPO } = await (supabase as any)
        .from("production_orders")
        .select("id")
        .eq("source_po_inbox_id", selectedPoId)
        .maybeSingle();

      // Create dispatch header
      const { data: dispatchData, error: dispatchErr } = await (supabase as any)
        .from("warehouse_dispatches")
        .insert({
          dispatch_number,
          customer_id: po?.matched_customer_id ?? null,
          production_order_id: linkedPO?.id ?? null,
          status: "pending",
          dispatch_date: dispatchDate,
          delivery_address: deliveryAddress || null,
          notes: notes || null,
        })
        .select()
        .single();
      if (dispatchErr) throw dispatchErr;

      try {
        // Insert items
        const { error: itemsErr } = await (supabase as any)
          .from("warehouse_dispatch_items")
          .insert(
            itemsToDispatch.map((i) => ({
              dispatch_id: dispatchData.id,
              product_name: i.product_name,
              quantity: i.dispatch_qty,
              unit: i.unit,
            }))
          );
        if (itemsErr) throw itemsErr;

        const confirmationLines = formItems.map((i, idx) => {
          const hasShortage = i.ordered_qty > i.billable_qty || i.ordered_qty > i.produced_qty || i.defect_qty > 0;
          const hasMissingSkuAllocation = hasShortage && !(i.shortage_sku || "").trim();
          const manualAmount = moneyNumber(i.actual_revenue_amount);
          const computedAmount = i.unit_price_vat_included > 0 ? i.billable_qty * i.unit_price_vat_included : 0;
          return {
            source_line_key: i.sku || i.product_name || `line_${idx + 1}`,
            sku: hasShortage ? ((i.shortage_sku || "").trim() || null) : (i.sku || null),
            product_name: i.product_name,
            ordered_qty: i.ordered_qty,
            produced_qty: i.produced_qty,
            defect_qty: i.defect_qty,
            dispatched_qty: i.dispatch_qty,
            billable_qty: i.billable_qty,
            unit_price_vat_included: i.unit_price_vat_included || null,
            source_line_amount_vat_included: i.source_line_amount_vat_included || null,
            temporary_revenue_amount_vat_included: i.source_line_amount_vat_included || null,
            confirmed_revenue_amount_vat_included: hasMissingSkuAllocation ? null : (manualAmount || computedAmount || null),
            shortage_reason_code: hasShortage ? i.shortage_reason_code || null : null,
            shortage_note: i.shortage_note || null,
          };
        });
        const payload = {
          po_number: po?.po_number ?? null,
          production_order_id: linkedPO?.id ?? null,
          revenue_date: po?.delivery_date || dispatchDate,
          dispatch_date: dispatchDate,
          po_total_vat_included: po?.total_amount ?? null,
          ordered_qty_total: formItems.reduce((sum, i) => sum + i.ordered_qty, 0),
          produced_qty_total: formItems.reduce((sum, i) => sum + i.produced_qty, 0),
          defect_qty_total: formItems.reduce((sum, i) => sum + i.defect_qty, 0),
          dispatched_qty_total: formItems.reduce((sum, i) => sum + i.dispatch_qty, 0),
          billable_qty_total: formItems.reduce((sum, i) => sum + i.billable_qty, 0),
          temporary_revenue_amount_vat_included: po?.total_amount ?? confirmationLines.reduce((sum, i) => sum + Number(i.temporary_revenue_amount_vat_included || 0), 0),
          lines: confirmationLines,
        };
        const { data: confirmation, error: confirmationErr } = await (supabase as any).rpc("upsert_po_dispatch_revenue_confirmation", {
          _customer_po_inbox_id: selectedPoId,
          _warehouse_dispatch_id: dispatchData.id,
          _payload: payload,
          _note: notes || null,
        });
        if (confirmationErr) throw confirmationErr;
        let finalConfirmation = confirmation;
        if (
          confirmation?.id
          && confirmation?.amount_status !== "needs_sku_allocation"
          && confirmation?.confirmed_revenue_amount_vat_included !== null
          && confirmation?.confirmed_revenue_amount_vat_included !== undefined
        ) {
          const { data: confirmed, error: confirmErr } = await (supabase as any).rpc("confirm_po_dispatch_revenue", {
            _confirmation_id: confirmation.id,
            _note: notes || "Xác nhận số xuất thực tế từ phiếu xuất kho",
          });
          if (confirmErr) throw confirmErr;
          finalConfirmation = confirmed || confirmation;
        }
        return finalConfirmation;
      } catch (error) {
        // Keep the dispatch + revenue-confirmation workflow effectively atomic
        // from the operator's perspective. If the confirmation/audit write fails,
        // remove the just-created dispatch rows instead of leaving partial ops data.
        await (supabase as any).from("warehouse_dispatch_items").delete().eq("dispatch_id", dispatchData.id);
        await (supabase as any).from("warehouse_dispatches").delete().eq("id", dispatchData.id);
        throw error;
      }
    },
    onSuccess: (confirmation: any) => {
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatches"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatch_items"] });
      toast({
        title: "Tạo phiếu xuất kho thành công",
        description: amountStatusLabel[confirmation?.amount_status] || "Doanh thu tạm từ PO",
      });
      setCreateOpen(false);
      resetForm();
    },
    onError: (e: any) => {
      toast({ title: "Lỗi tạo phiếu", description: e?.message, variant: "destructive" });
    },
  });

  const createMaterialIssueMutation = useMutation({
    mutationFn: async (productionOrderId: string) => {
      const order = materialOrders.find((item) => item.id === productionOrderId);
      const issueDate = order?.planned_start_date || format(new Date(), "yyyy-MM-dd");
      const { data, error } = await (supabase as any).rpc("create_production_material_issue", {
        p_production_order_id: productionOrderId,
        p_issue_date: issueDate,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ["production_material_issues"] });
      queryClient.invalidateQueries({ queryKey: ["production_material_issue_items"] });
      if (result?.status === "posted") {
        toast({
          title: "Đã tạo phiếu xuất NVL",
          description: `${result.issue_number} · ${result.item_count || 0} dòng định lượng`,
        });
        return;
      }
      toast({
        title: "Chưa thể post PXK NVL",
        description: "Thiếu mapping SKU/BOM/kho bếp. Bảng bên dưới vẫn đang hiển thị preview từ data thật để anh kiểm tra.",
        variant: "destructive",
      });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi tạo PXK NVL", description: e?.message, variant: "destructive" });
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ dispatchId, newStatus }: { dispatchId: string; newStatus: DispatchStatus }) => {
      const updateData: any = { status: newStatus };

      // "Xuất kho" → deduct inventory + record movement
      if (newStatus === "dispatched" && selected) {
        const items = allDispatchItems.filter((i: any) => i.dispatch_id === dispatchId);
        for (const item of items) {
          const { data: inv } = await (supabase as any)
            .from("inventory_items")
            .select("id, quantity")
            .ilike("name", `%${item.product_name}%`)
            .maybeSingle();

          if (inv) {
            await (supabase as any)
              .from("inventory_items")
              .update({ quantity: Math.max(0, inv.quantity - item.quantity) })
              .eq("id", inv.id);

            await (supabase as any)
              .from("inventory_movements")
              .insert({
                movement_type: "dispatch_out",
                inventory_item_id: inv.id,
                quantity: -item.quantity,
                unit: item.unit,
                reference_type: "dispatch",
                reference_id: dispatchId,
                movement_date: format(new Date(), "yyyy-MM-dd"),
                notes: `Xuất kho ${selected.dispatch_number}`,
              });
          }
        }
      }

      if (newStatus === "delivered") {
        updateData.delivered_date = format(new Date(), "yyyy-MM-dd");
      }

      const { error } = await (supabase as any)
        .from("warehouse_dispatches")
        .update(updateData)
        .eq("id", dispatchId);
      if (error) throw error;
    },
    onSuccess: (_, { newStatus }) => {
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatches"] });
      queryClient.invalidateQueries({ queryKey: ["inventory_finished_goods"] });
      const msgs: Record<string, string> = {
        picked: "Bắt đầu lấy hàng",
        dispatched: "Đã xuất kho — tồn kho thành phẩm đã được trừ",
        delivered: "Xác nhận giao hàng thành công",
      };
      toast({ title: msgs[newStatus] || "Cập nhật thành công" });
      setDetailOpen(false);
    },
    onError: (e: any) => {
      toast({ title: "Lỗi cập nhật", description: e?.message, variant: "destructive" });
    },
  });

  // ── Computed ──────────────────────────────────────────────────────────────

  const filtered = activeTab === "all" ? dispatches : dispatches.filter((d: any) => d.status === activeTab);

  const stats = {
    pending:    dispatches.filter((d: any) => d.status === "pending").length,
    picked:     dispatches.filter((d: any) => d.status === "picked").length,
    dispatched: dispatches.filter((d: any) => d.status === "dispatched").length,
    delivered:  dispatches.filter((d: any) => d.status === "delivered").length,
  };

  const selectedPO = salesPOs.find((p) => p.id === selectedPoId);
  const totalDispatchQty = formItems.reduce((s, i) => s + i.dispatch_qty, 0);
  const totalBillableQty = formItems.reduce((s, i) => s + i.billable_qty, 0);
  const selectedMaterialOrder = materialOrders[0] || null;
  const selectedMaterialIssue = selectedMaterialOrder
    ? materialIssues.find((issue) => issue.production_order_id === selectedMaterialOrder.id) || null
    : null;
  const selectedMaterialIssueItems = selectedMaterialIssue
    ? materialIssueItems.filter((item) => item.material_issue_id === selectedMaterialIssue.id)
    : [];

  const normalizeMaterialName = (value: string | null | undefined) => String(value || "").trim().toLowerCase();
  const materialPreviewRows: MaterialPreviewRow[] = selectedMaterialOrder
    ? materialOrderItems
        .filter((item) => item.production_order_id === selectedMaterialOrder.id)
        .flatMap((orderItem) => {
          const finishedSku = orderItem.sku_id
            ? materialSkus.find((sku) => sku.id === orderItem.sku_id)
            : materialSkus.filter((sku) => normalizeMaterialName(sku.product_name) === normalizeMaterialName(orderItem.product_name));
          const resolvedFinishedSku = Array.isArray(finishedSku) ? (finishedSku.length === 1 ? finishedSku[0] : null) : finishedSku;
          const finishedQty = Number(orderItem.planned_qty || orderItem.ordered_qty || 0);

          if (!resolvedFinishedSku) {
            return [{
              key: `${orderItem.id}:missing-sku`,
              production_item_name: orderItem.product_name,
              finished_qty: finishedQty,
              ingredient_name: "Chưa match SKU thành phẩm",
              required_qty: 0,
              unit: orderItem.unit || "",
              unit_cost: 0,
              amount: 0,
              source: "production_order_items → product_skus",
              status: "missing_finished_sku" as const,
            }];
          }

          const formulas = skuFormulations.filter((row) => row.sku_id === resolvedFinishedSku.id);
          if (!formulas.length) {
            return [{
              key: `${orderItem.id}:missing-formula`,
              production_item_name: orderItem.product_name,
              finished_qty: finishedQty,
              ingredient_name: "Chưa có định lượng/BOM",
              required_qty: 0,
              unit: resolvedFinishedSku.unit || orderItem.unit || "",
              unit_cost: 0,
              amount: 0,
              source: "sku_formulations",
              status: "missing_formula" as const,
            }];
          }

          return formulas.map((formula) => {
            const kitchenMatch = formula.ingredient_sku_id
              ? kitchenItems.find((item) => item.product_sku_id === formula.ingredient_sku_id)
              : kitchenItems.find((item) => normalizeMaterialName(item.name) === normalizeMaterialName(formula.ingredient_name));
            const requiredQty = finishedQty * Number(formula.dosage_qty || 0) * (1 + Number(formula.wastage_percent || 0) / 100);
            const unitCost = Number(formula.unit_price || kitchenMatch?.standard_unit_cost || 0);
            return {
              key: `${orderItem.id}:${formula.id}`,
              production_item_name: orderItem.product_name,
              finished_qty: finishedQty,
              ingredient_name: formula.ingredient_name,
              required_qty: requiredQty,
              unit: formula.unit || kitchenMatch?.unit || "",
              unit_cost: unitCost,
              amount: requiredQty * unitCost,
              source: kitchenMatch ? "BOM + kho bếp" : "BOM · thiếu mapping kho bếp",
              status: kitchenMatch ? "ready" as const : "missing_kitchen_item" as const,
            };
          });
        })
    : [];

  const materialReadyRows = selectedMaterialIssue ? selectedMaterialIssueItems : materialPreviewRows.filter((row) => row.status === "ready");
  const materialMissingRows = materialPreviewRows.filter((row) => row.status !== "ready");
  const materialStandardQty = (selectedMaterialIssue ? selectedMaterialIssueItems : materialPreviewRows)
    .reduce((sum, row: any) => sum + Number(row.required_qty || 0), 0);
  const materialStandardAmount = (selectedMaterialIssue ? selectedMaterialIssueItems : materialPreviewRows)
    .reduce((sum, row: any) => sum + Number(row.amount || 0), 0);

  const mappingRows = [
    { raw: "Chà bông cay loại 1", mapped: "Chà bông gà cay", confidence: 92, status: "Tin cậy" },
    { raw: "Rau leo Đà Lạt", mapped: "Dưa leo", confidence: 86, status: "Tin cậy" },
    { raw: "Sốt đặc biệt BMQ", mapped: "Cần anh xác nhận", confidence: 58, status: "Cần duyệt" },
  ];

  const openDetail = (d: any) => {
    setSelected({ ...d, items: allDispatchItems.filter((i: any) => i.dispatch_id === d.id) });
    setDetailOpen(true);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) return (
    <div className="flex items-center justify-center h-96">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="min-h-[calc(100vh-4rem)] space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_34%),linear-gradient(135deg,#120d0a,#1f160f_48%,#100b08)] p-4 text-white md:p-6">
      {/* Header */}
      <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#1b120e]/90 shadow-2xl shadow-black/30">
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:p-6">
          <div className="space-y-5">
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/25 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100">
              <Truck className="h-3.5 w-3.5" />
              Trang xuất kho mới · giữ nguyên header và sidebar
            </div>
            <div className="space-y-2">
              <h1 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Xuất kho</h1>
              <p className="max-w-3xl text-sm leading-6 text-white/65 md:text-base">
                Tách rõ phiếu xuất thành phẩm để tính công nợ/đối chiếu PO và phiếu xuất nguyên vật liệu để theo dõi tiêu hao theo định lượng SKU, tồn kiểm tay và mua hàng.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                onClick={() => setActiveWorkflow("finished")}
                className={activeWorkflow === "finished"
                  ? "rounded-2xl bg-amber-500 px-4 py-6 font-bold text-stone-950 hover:bg-amber-400"
                  : "rounded-2xl border border-white/10 bg-white/5 px-4 py-6 font-bold text-white hover:bg-white/10"}
              >
                <PackageCheck className="mr-2 h-5 w-5" /> Thành phẩm
              </Button>
              <Button
                type="button"
                onClick={() => setActiveWorkflow("materials")}
                className={activeWorkflow === "materials"
                  ? "rounded-2xl bg-amber-500 px-4 py-6 font-bold text-stone-950 hover:bg-amber-400"
                  : "rounded-2xl border border-white/10 bg-white/5 px-4 py-6 font-bold text-white hover:bg-white/10"}
              >
                <PackageSearch className="mr-2 h-5 w-5" /> Nguyên vật liệu
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <p className="text-xs text-white/55">Phiếu TP</p>
              <p className="mt-2 text-3xl font-bold">{dispatches.length}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <p className="text-xs text-white/55">Chờ xuất</p>
              <p className="mt-2 text-3xl font-bold text-amber-200">{stats.pending}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <p className="text-xs text-white/55">Đã xuất</p>
              <p className="mt-2 text-3xl font-bold text-emerald-200">{stats.dispatched}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <p className="text-xs text-white/55">Mapping chờ duyệt</p>
              <p className="mt-2 text-3xl font-bold text-sky-200">18</p>
            </div>
          </div>
        </div>
      </div>

      {activeWorkflow === "finished" ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <Card className="border-white/10 bg-[#1b120e]/90 text-white shadow-xl shadow-black/20">
              <CardHeader className="gap-4 pb-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-2xl">
                    <PackageCheck className="h-6 w-6 text-amber-300" /> Phiếu xuất thành phẩm
                  </CardTitle>
                  <p className="mt-1 text-sm text-white/55">PO bán hàng → số xuất thực tế → số tính công nợ.</p>
                </div>
                <Button onClick={() => setCreateOpen(true)} className="rounded-xl bg-amber-500 font-bold text-stone-950 hover:bg-amber-400">
                  <Plus className="mr-2 h-4 w-4" /> Tạo phiếu thành phẩm
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {(["pending", "picked", "dispatched", "delivered"] as DispatchStatus[]).map((s) => (
                    <button
                      type="button"
                      key={s}
                      className={`rounded-2xl border p-4 text-left transition ${activeTab === s ? "border-amber-300/60 bg-amber-500/15" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.07]"}`}
                      onClick={() => setActiveTab(s)}
                    >
                      <p className="text-xs text-white/55">{statusConfig[s].label}</p>
                      <p className="mt-2 text-2xl font-bold">{stats[s]}</p>
                    </button>
                  ))}
                </div>

                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
                  <TabsList className="flex h-auto flex-wrap justify-start gap-2 bg-white/5 p-1">
                    <TabsTrigger value="all">Tất cả ({dispatches.length})</TabsTrigger>
                    <TabsTrigger value="pending">Chờ xuất ({stats.pending})</TabsTrigger>
                    <TabsTrigger value="picked">Đang lấy ({stats.picked})</TabsTrigger>
                    <TabsTrigger value="dispatched">Đã xuất ({stats.dispatched})</TabsTrigger>
                    <TabsTrigger value="delivered">Đã giao ({stats.delivered})</TabsTrigger>
                  </TabsList>
                </Tabs>

                {filtered.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/15 py-12 text-center text-white/50">
                    <Truck className="mx-auto mb-3 h-10 w-10 opacity-40" />
                    <p>Không có phiếu xuất thành phẩm nào</p>
                  </div>
                ) : (
                  <div className="space-y-3 md:hidden">
                    {filtered.map((d: any) => (
                      <button key={d.id} type="button" onClick={() => openDetail(d)} className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-mono text-sm font-bold text-amber-100">{d.dispatch_number}</p>
                            <p className="mt-1 text-sm text-white/60">{d.customer_name ?? d.customer_id ?? "Chưa có khách hàng"}</p>
                          </div>
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[d.status as DispatchStatus]}`}>
                            {statusConfig[d.status as DispatchStatus]?.label ?? d.status}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-white/55">
                          <span>Ngày xuất: {d.dispatch_date ? format(new Date(d.dispatch_date), "dd/MM/yyyy") : "—"}</span>
                          <span>Ngày giao: {d.delivered_date ? format(new Date(d.delivered_date), "dd/MM/yyyy") : "—"}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {filtered.length > 0 && (
                  <div className="hidden overflow-hidden rounded-2xl border border-white/10 md:block">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 bg-white/[0.04] hover:bg-white/[0.04]">
                          <TableHead className="text-white/55">Mã phiếu XK</TableHead>
                          <TableHead className="text-white/55">Khách hàng</TableHead>
                          <TableHead className="text-white/55">Ngày xuất</TableHead>
                          <TableHead className="text-white/55">Ngày giao</TableHead>
                          <TableHead className="text-white/55">Trạng thái</TableHead>
                          <TableHead className="text-white/55">Ghi chú</TableHead>
                          <TableHead className="text-right text-white/55">Thao tác</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filtered.map((d: any) => (
                          <TableRow key={d.id} className="cursor-pointer border-white/10 hover:bg-white/[0.04]" onClick={() => openDetail(d)}>
                            <TableCell className="font-mono font-medium text-amber-100">{d.dispatch_number}</TableCell>
                            <TableCell className="text-sm text-white/65">{d.customer_name ?? d.customer_id ?? "—"}</TableCell>
                            <TableCell>{d.dispatch_date ? format(new Date(d.dispatch_date), "dd/MM/yyyy") : "—"}</TableCell>
                            <TableCell>{d.delivered_date ? format(new Date(d.delivered_date), "dd/MM/yyyy") : "—"}</TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[d.status as DispatchStatus]}`}>
                                {statusConfig[d.status as DispatchStatus]?.label ?? d.status}
                              </span>
                            </TableCell>
                            <TableCell className="max-w-[200px] truncate text-sm text-white/55">{d.notes ?? "—"}</TableCell>
                            <TableCell className="text-right">
                              <Button variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white" onClick={(e) => { e.stopPropagation(); openDetail(d); }}>Chi tiết</Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-5">
            <Card className="border-white/10 bg-[#1b120e]/90 text-white shadow-xl shadow-black/20">
              <CardHeader>
                <CardTitle className="text-xl">Nguyên tắc công nợ</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-white/65">
                <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-emerald-50">Công nợ lấy theo <b>số tính tiền đã xác nhận</b>, không lấy mù theo PO nếu có thiếu/lỗi.</div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">PO → Phiếu xuất thành phẩm → Xác nhận doanh thu/công nợ → Đối chiếu cuối tháng.</div>
                <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-amber-50">Nếu thiếu hàng, bắt buộc chọn SKU thiếu và lý do để tránh cộng trùng công nợ.</div>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-[#1b120e]/90 text-white shadow-xl shadow-black/20">
              <CardHeader>
                <CardTitle className="text-xl">Phiếu đang nhập</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><p className="text-white/55">Tổng xuất</p><b className="text-2xl">{totalDispatchQty.toLocaleString("vi-VN")}</b></div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"><p className="text-white/55">Tính công nợ</p><b className="text-2xl">{totalBillableQty.toLocaleString("vi-VN")}</b></div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="border-white/10 bg-[#1b120e]/90 text-white shadow-xl shadow-black/20">
            <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-2xl">
                  <PackageSearch className="h-6 w-6 text-amber-300" /> Phiếu xuất nguyên vật liệu
                </CardTitle>
                <p className="mt-1 text-sm text-white/55">
                  Tự lấy lệnh sản xuất mới nhất đã xác nhận, nhân BOM/định lượng thật để tạo PXK NVL.
                </p>
              </div>
              <Badge variant="outline" className={selectedMaterialIssue ? "border-emerald-300/35 bg-emerald-500/10 text-emerald-100" : "border-amber-300/35 bg-amber-500/10 text-amber-100"}>
                {selectedMaterialIssue ? `Đã có ${selectedMaterialIssue.issue_number}` : "Preview data thật"}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-5">
              {loadingMaterialOrders ? (
                <div className="flex min-h-[220px] items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
                  <Loader2 className="h-8 w-8 animate-spin text-white/45" />
                </div>
              ) : !selectedMaterialOrder ? (
                <div className="rounded-2xl border border-dashed border-white/15 py-12 text-center text-white/50">
                  <PackageSearch className="mx-auto mb-3 h-10 w-10 opacity-40" />
                  <p>Chưa có lệnh sản xuất đã xác nhận để tạo PXK NVL.</p>
                </div>
              ) : (
                <>
                  <div className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 md:col-span-2">
                      <p className="text-xs text-white/55">Lệnh SX mới nhất</p>
                      <p className="mt-2 font-mono text-xl font-bold text-amber-100">{selectedMaterialOrder.production_number}</p>
                      <p className="mt-1 text-sm text-white/55">
                        Ngày SX: {selectedMaterialOrder.planned_start_date ? format(new Date(selectedMaterialOrder.planned_start_date), "dd/MM/yyyy") : "—"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <p className="text-xs text-white/55">Dòng NVL</p>
                      <p className="mt-2 text-3xl font-bold text-emerald-200">{materialReadyRows.length}</p>
                      <p className="text-xs text-white/45">{materialMissingRows.length} dòng cần mapping</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <p className="text-xs text-white/55">Giá trị chuẩn</p>
                      <p className="mt-2 text-2xl font-bold text-sky-200">{Math.round(materialStandardAmount).toLocaleString("vi-VN")}đ</p>
                      <p className="text-xs text-white/45">{materialStandardQty.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} đơn vị NVL</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={() => selectedMaterialOrder && createMaterialIssueMutation.mutate(selectedMaterialOrder.id)}
                      disabled={createMaterialIssueMutation.isPending || !selectedMaterialOrder || Boolean(selectedMaterialIssue)}
                      className="rounded-xl bg-amber-500 font-bold text-stone-950 hover:bg-amber-400"
                    >
                      {createMaterialIssueMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FilePlus2 className="mr-2 h-4 w-4" />}
                      {selectedMaterialIssue ? "Đã tạo PXK NVL" : "Tạo PXK NVL từ lệnh mới nhất"}
                    </Button>
                    <Button variant="outline" className="rounded-xl border-white/10 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                      <FileSpreadsheet className="mr-2 h-4 w-4" /> Xuất Excel mapping
                    </Button>
                    <Button variant="outline" className="rounded-xl border-white/10 bg-white/5 text-white hover:bg-white/10 hover:text-white">
                      <Camera className="mr-2 h-4 w-4" /> Nhập tồn kiểm tay
                    </Button>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 bg-white/[0.04] hover:bg-white/[0.04]">
                          <TableHead className="text-white/55">NVL/BOM</TableHead>
                          <TableHead className="text-white/55">SKU thành phẩm</TableHead>
                          <TableHead className="text-right text-white/55">Sản lượng</TableHead>
                          <TableHead className="text-right text-white/55">Cần dùng</TableHead>
                          <TableHead className="text-right text-white/55">Đơn giá</TableHead>
                          <TableHead className="text-right text-white/55">Thành tiền</TableHead>
                          <TableHead className="text-white/55">Trạng thái</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(selectedMaterialIssue ? selectedMaterialIssueItems : materialPreviewRows).slice(0, 120).map((row: any) => {
                          const status = row.status || "ready";
                          return (
                            <TableRow key={row.id || row.key} className="border-white/10 hover:bg-white/[0.04]">
                              <TableCell className="font-medium text-amber-100">{row.ingredient_name}</TableCell>
                              <TableCell className="max-w-[240px] text-sm text-white/60">{row.production_item_name || "Đã post vào PXK"}</TableCell>
                              <TableCell className="text-right">{Number(row.planned_finished_qty || row.finished_qty || 0).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}</TableCell>
                              <TableCell className="text-right">{Number(row.required_qty || 0).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} {row.unit}</TableCell>
                              <TableCell className="text-right">{Number(row.unit_cost || 0).toLocaleString("vi-VN")}</TableCell>
                              <TableCell className="text-right">{Math.round(Number(row.amount || 0)).toLocaleString("vi-VN")}</TableCell>
                              <TableCell>
                                {status === "ready" ? (
                                  <Badge variant="outline" className="border-emerald-300/30 bg-emerald-500/10 text-emerald-100"><CheckCircle2 className="mr-1 h-3 w-3" />Sẵn sàng</Badge>
                                ) : (
                                  <Badge variant="outline" className="border-amber-300/30 bg-amber-500/10 text-amber-100">
                                    {status === "missing_finished_sku" ? "Thiếu SKU TP" : status === "missing_formula" ? "Thiếu BOM" : "Thiếu map kho bếp"}
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {materialMissingRows.length > 0 && !selectedMaterialIssue && (
                    <div className="rounded-2xl border border-amber-300/20 bg-amber-500/10 p-4 text-sm text-amber-50">
                      Đã tính preview từ data thật nhưng chưa post/trừ kho vì còn {materialMissingRows.length} dòng thiếu mapping SKU/BOM/kho bếp. Cần hoàn tất mapping trước khi hệ thống ghi ledger NVL để tránh trừ kho sai.
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card className="border-white/10 bg-[#1b120e]/90 text-white shadow-xl shadow-black/20">
              <CardHeader>
                <CardTitle className="text-xl">Lệnh SX gần nhất</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {materialOrders.slice(0, 5).map((order) => {
                  const linkedIssue = materialIssues.find((issue) => issue.production_order_id === order.id);
                  return (
                    <div key={order.id} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-mono font-bold text-amber-100">{order.production_number}</p>
                          <p className="text-xs text-white/55">{order.planned_start_date ? format(new Date(order.planned_start_date), "dd/MM/yyyy") : "Chưa có ngày SX"}</p>
                        </div>
                        <Badge variant="outline" className={linkedIssue ? "border-emerald-300/30 bg-emerald-500/10 text-emerald-100" : "border-white/15 bg-white/[0.04] text-white/65"}>
                          {linkedIssue ? linkedIssue.issue_number : "Chưa có PXK"}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card className="border-sky-300/20 bg-[#111827]/90 text-white shadow-xl shadow-black/20">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl"><Brain className="h-5 w-5 text-sky-200" /> AI mapping hóa đơn</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {mappingRows.map((row) => (
                  <div key={row.raw} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">“{row.raw}”</p>
                        <p className="text-sm text-white/55">→ {row.mapped}</p>
                      </div>
                      <Badge variant="outline" className={row.confidence >= 80 ? "border-emerald-300/30 bg-emerald-500/10 text-emerald-100" : "border-amber-300/30 bg-amber-500/10 text-amber-100"}>{row.confidence}%</Badge>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                      <div className={row.confidence >= 80 ? "h-full rounded-full bg-emerald-400" : "h-full rounded-full bg-amber-400"} style={{ width: `${row.confidence}%` }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ── Create Dialog ────────────────────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-6xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" /> {dispatchReason === "short_delivery" ? "Xử lý giao thiếu từ ledger" : "Tạo phiếu xuất kho"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {/* Select Sales PO */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Đơn hàng bán (Sales PO) <span className="text-destructive">*</span>
              </label>
              <p className="text-xs text-muted-foreground">
                {dispatchPoId
                  ? "Mở từ ledger cho case PO đặt nhưng thực tế giao không đủ. Nhập số xuất/số đạt/số tính tiền; nếu thiếu phải chọn SKU thiếu để tránh cộng trùng công nợ."
                  : "Hiển thị PO có ngày giao trong 3 ngày trước ngày xuất kho"}
                {!dispatchPoId && dispatchDate && (
                  <> ({format(subDays(new Date(dispatchDate), 3), "dd/MM")} — {format(subDays(new Date(dispatchDate), 1), "dd/MM")})</>
                )}
              </p>
              <Select value={selectedPoId} onValueChange={handleSelectPO}>
                <SelectTrigger>
                  <SelectValue placeholder="Chọn đơn hàng cần xuất kho..." />
                </SelectTrigger>
                <SelectContent>
                  {salesPOs.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      Không có đơn hàng nào trong khoảng{" "}
                      {dispatchDate && `${format(subDays(new Date(dispatchDate), 3), "dd/MM")} – ${format(subDays(new Date(dispatchDate), 1), "dd/MM")}`}
                    </div>
                  )}
                  {salesPOs.map((po) => (
                    <SelectItem key={po.id} value={po.id}>
                      <span className="font-medium">{po.po_number ?? po.id.slice(0, 8)}</span>
                      <span className="ml-2 text-muted-foreground text-xs">— {po.from_name}</span>
                      {po.delivery_date && (
                        <span className="ml-2 text-muted-foreground text-xs">| Giao: {format(new Date(po.delivery_date), "dd/MM")}</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPO && (
                <p className="text-xs text-muted-foreground">
                  Khách: <strong>{selectedPO.from_name}</strong>
                  {selectedPO.delivery_date && ` · Ngày giao: ${format(new Date(selectedPO.delivery_date), "dd/MM/yyyy")}`}
                </p>
              )}
            </div>

            {/* Items from PO × Inventory */}
            {formItems.length > 0 && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-sm font-medium">Sản phẩm xuất kho</label>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">Doanh thu tạm từ PO</Badge>
                    {formItems.some((i) => i.ordered_qty > i.billable_qty || i.ordered_qty > i.produced_qty || i.defect_qty > 0) ? (
                      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                        {formItems.some((i) => (i.ordered_qty > i.billable_qty || i.ordered_qty > i.produced_qty || i.defect_qty > 0) && !i.shortage_sku)
                          ? "Cần chọn SKU thiếu"
                          : "Đã xác nhận số xuất"}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Đã xác nhận số xuất</Badge>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead className="text-right">Đặt (PO)</TableHead>
                        <TableHead className="text-right">Tồn kho</TableHead>
                        <TableHead className="text-right w-28">Số lượng XK</TableHead>
                        <TableHead className="text-right w-28">Số bánh đạt</TableHead>
                        <TableHead className="text-right w-28">Số lỗi/thiếu</TableHead>
                        <TableHead className="text-right w-28">Số tính tiền</TableHead>
                        <TableHead className="w-32">SKU thiếu</TableHead>
                        <TableHead className="w-36">Lý do</TableHead>
                        <TableHead className="w-40">Ghi chú</TableHead>
                        <TableHead className="w-36">Thành tiền thực tế</TableHead>
                        <TableHead>ĐVT</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {formItems.map((item, idx) => {
                        const overStock = item.dispatch_qty > item.available_qty;
                        const shortage = item.ordered_qty > item.billable_qty || item.ordered_qty > item.produced_qty || item.defect_qty > 0;
                        return (
                          <TableRow key={idx} className={overStock ? "bg-red-50" : ""}>
                            <TableCell className="font-medium text-sm">{item.product_name}</TableCell>
                            <TableCell className="text-right text-muted-foreground text-sm">{item.ordered_qty}</TableCell>
                            <TableCell className="text-right text-sm">
                              <span className={item.available_qty === 0 ? "text-destructive font-medium" : "text-green-700 font-medium"}>
                                {item.available_qty}
                              </span>
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                max={item.available_qty}
                                value={item.dispatch_qty}
                                onChange={(e) => handleDispatchQtyChange(idx, e.target.value)}
                                className={`w-24 text-right h-8 ${overStock ? "border-destructive" : ""}`}
                              />
                              {overStock && <p className="text-[10px] text-destructive mt-0.5">Vượt tồn kho</p>}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                value={item.produced_qty}
                                onChange={(e) => {
                                  const producedQty = Math.max(0, parseFloat(e.target.value) || 0);
                                  updateFormItem(idx, {
                                    produced_qty: producedQty,
                                    defect_qty: Math.max(item.ordered_qty - producedQty, 0),
                                    billable_qty: Math.min(item.billable_qty, producedQty),
                                    shortage_sku: producedQty < item.ordered_qty ? "" : item.shortage_sku,
                                  });
                                }}
                                className="w-24 text-right h-8"
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                value={item.defect_qty}
                                onChange={(e) => updateFormItem(idx, { defect_qty: Math.max(0, parseFloat(e.target.value) || 0) })}
                                className="w-24 text-right h-8"
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                value={item.billable_qty}
                                onChange={(e) => updateFormItem(idx, { billable_qty: Math.max(0, parseFloat(e.target.value) || 0) })}
                                className="w-24 text-right h-8"
                              />
                            </TableCell>
                            <TableCell>
                              {shortage ? (
                                <Input
                                  value={item.shortage_sku}
                                  onChange={(e) => updateFormItem(idx, { shortage_sku: e.target.value })}
                                  placeholder="SKU thiếu"
                                  className="h-8"
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {shortage ? (
                                <Select value={item.shortage_reason_code} onValueChange={(value) => updateFormItem(idx, { shortage_reason_code: value })}>
                                  <SelectTrigger className="h-8">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {shortageReasons.map((reason) => (
                                      <SelectItem key={reason.value} value={reason.value}>{reason.label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {shortage ? (
                                <Input
                                  value={item.shortage_note}
                                  onChange={(e) => updateFormItem(idx, { shortage_note: e.target.value })}
                                  placeholder="Ghi chú"
                                  className="h-8"
                                />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Input
                                inputMode="decimal"
                                value={item.actual_revenue_amount}
                                onChange={(e) => updateFormItem(idx, { actual_revenue_amount: e.target.value })}
                                placeholder="Tùy chọn"
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">{item.unit}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {formItems.some((i) => i.available_qty === 0) && (
                  <div className="flex items-center gap-2 text-amber-700 text-xs bg-amber-50 rounded px-3 py-2">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    Một số sản phẩm chưa có trong kho — cần QA duyệt nhập kho thành phẩm trước.
                  </div>
                )}
                <p className="text-xs text-muted-foreground text-right">
                  Tổng xuất: <strong>{totalDispatchQty.toLocaleString("vi-VN")}</strong> đơn vị
                </p>
              </div>
            )}

            {selectedPoId && formItems.length === 0 && (
              <div className="text-center py-4 text-muted-foreground text-sm">
                <RefreshCw className="h-4 w-4 mx-auto mb-2 animate-pulse" />
                Đang tải sản phẩm từ đơn hàng...
              </div>
            )}

            {/* Dates */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Ngày xuất kho</label>
                <Input type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} />
              </div>
            </div>

            {/* Address + Notes */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Địa chỉ giao hàng</label>
                {deliveryAddress && selectedPoId && (
                  <span className="text-xs text-muted-foreground">Tự động điền từ hồ sơ khách hàng</span>
                )}
              </div>
              <Input
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="Địa chỉ giao (tự động điền nếu CRM có địa chỉ)..."
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Ghi chú</label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ghi chú thêm..." rows={2} />
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Hủy</Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !selectedPoId || formItems.every((i) => i.dispatch_qty === 0)}
              >
                {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Truck className="h-4 w-4 mr-2" />}
                Tạo phiếu xuất kho
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Detail / Status Dialog ───────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" />
              {selected?.dispatch_number}
            </DialogTitle>
          </DialogHeader>

          {selected && (
            <div className="space-y-4">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Trạng thái</p>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium mt-1 ${statusColors[selected.status]}`}>
                    {statusConfig[selected.status]?.label}
                  </span>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Ngày xuất kho</p>
                  <p className="font-medium">{selected.dispatch_date ? format(new Date(selected.dispatch_date), "dd/MM/yyyy") : "—"}</p>
                </div>
                {selected.delivered_date && (
                  <div className="rounded-lg border px-3 py-2">
                    <p className="text-xs text-muted-foreground">Ngày giao</p>
                    <p className="font-medium">{format(new Date(selected.delivered_date), "dd/MM/yyyy")}</p>
                  </div>
                )}
                {selected.delivery_address && (
                  <div className="rounded-lg border px-3 py-2 col-span-2">
                    <p className="text-xs text-muted-foreground">Địa chỉ giao</p>
                    <p className="font-medium">{selected.delivery_address}</p>
                  </div>
                )}
                {selected.notes && (
                  <div className="rounded-lg border px-3 py-2 col-span-2">
                    <p className="text-xs text-muted-foreground">Ghi chú</p>
                    <p>{selected.notes}</p>
                  </div>
                )}
              </div>

              {/* Items */}
              <div>
                <p className="text-sm font-medium mb-2">Danh sách sản phẩm</p>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead className="text-right">Số lượng</TableHead>
                        <TableHead>ĐVT</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.items?.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>{item.product_name}</TableCell>
                          <TableCell className="text-right font-medium">{item.quantity}</TableCell>
                          <TableCell className="text-muted-foreground">{item.unit}</TableCell>
                        </TableRow>
                      ))}
                      {!selected.items?.length && (
                        <TableRow>
                          <TableCell colSpan={3} className="text-center text-muted-foreground py-4">Không có sản phẩm</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Action buttons based on status */}
              <div className="flex gap-3 justify-end pt-2 border-t">
                <Button variant="outline" onClick={() => setDetailOpen(false)}>Đóng</Button>
                {selected.status === "pending" && (
                  <Button onClick={() => updateStatusMutation.mutate({ dispatchId: selected.id, newStatus: "picked" })}
                    disabled={updateStatusMutation.isPending}>
                    {updateStatusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Bắt đầu lấy hàng
                  </Button>
                )}
                {selected.status === "picked" && (
                  <Button
                    onClick={() => updateStatusMutation.mutate({ dispatchId: selected.id, newStatus: "dispatched" })}
                    disabled={updateStatusMutation.isPending}
                    className="bg-amber-600 hover:bg-amber-700"
                  >
                    {updateStatusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <PackageCheck className="h-4 w-4 mr-2" />}
                    Xuất kho (trừ tồn kho)
                  </Button>
                )}
                {selected.status === "dispatched" && (
                  <Button onClick={() => updateStatusMutation.mutate({ dispatchId: selected.id, newStatus: "delivered" })}
                    disabled={updateStatusMutation.isPending}
                    className="bg-green-600 hover:bg-green-700">
                    {updateStatusMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Xác nhận đã giao
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
