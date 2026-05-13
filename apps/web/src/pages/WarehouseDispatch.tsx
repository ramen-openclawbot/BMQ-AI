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
import { Truck, Plus, Loader2, PackageCheck, AlertTriangle, RefreshCw } from "lucide-react";
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
  }, [deliveryAddress, finishedInventory, salesPOs]);

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
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Truck className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Xuất kho</h1>
            <p className="text-sm text-muted-foreground">Tạo phiếu xuất kho từ đơn hàng bán → giao khách</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-2" /> Tạo phiếu xuất kho
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(["pending", "picked", "dispatched", "delivered"] as DispatchStatus[]).map((s) => (
          <Card key={s} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setActiveTab(s)}>
            <CardHeader className="pb-1 pt-4 px-4">
              <CardTitle className="text-xs text-muted-foreground font-normal">{statusConfig[s].label}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <span className="text-2xl font-bold">{stats[s]}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs + Table */}
      <Card>
        <CardHeader className="pb-0">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <TabsList>
              <TabsTrigger value="all">Tất cả ({dispatches.length})</TabsTrigger>
              <TabsTrigger value="pending">Chờ xuất ({stats.pending})</TabsTrigger>
              <TabsTrigger value="picked">Đang lấy ({stats.picked})</TabsTrigger>
              <TabsTrigger value="dispatched">Đã xuất ({stats.dispatched})</TabsTrigger>
              <TabsTrigger value="delivered">Đã giao ({stats.delivered})</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-4">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Truck className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p>Không có phiếu xuất kho nào</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã phiếu XK</TableHead>
                  <TableHead>Khách hàng</TableHead>
                  <TableHead>Ngày xuất</TableHead>
                  <TableHead>Ngày giao</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Ghi chú</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((d: any) => (
                  <TableRow key={d.id} className="cursor-pointer hover:bg-muted/30" onClick={() => openDetail(d)}>
                    <TableCell className="font-mono font-medium">{d.dispatch_number}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{d.customer_id ?? "—"}</TableCell>
                    <TableCell>{d.dispatch_date ? format(new Date(d.dispatch_date), "dd/MM/yyyy") : "—"}</TableCell>
                    <TableCell>{d.delivered_date ? format(new Date(d.delivered_date), "dd/MM/yyyy") : "—"}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[d.status as DispatchStatus]}`}>
                        {statusConfig[d.status as DispatchStatus]?.label ?? d.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{d.notes ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); openDetail(d); }}>Chi tiết</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
