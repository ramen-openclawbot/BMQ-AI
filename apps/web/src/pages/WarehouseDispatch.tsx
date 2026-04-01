import { useState } from "react";
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
  customer_address?: string | null;
  production_items: Array<{
    product_name: string;
    qty: number;
    unit: string;
    sku?: string;
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

export default function WarehouseDispatch() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<DispatchStatus | "all">("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selected, setSelected] = useState<Dispatch | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  // Form state
  const [selectedPoId, setSelectedPoId] = useState("");
  const [dispatchDate, setDispatchDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [formItems, setFormItems] = useState<DispatchFormItem[]>([]);

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
    queryKey: ["po_inbox_for_dispatch", dispatchDate],
    queryFn: async () => {
      const dispatchDateObj = new Date(dispatchDate);
      const fromDate = format(subDays(dispatchDateObj, 3), "yyyy-MM-dd"); // -3 ngày
      const toDate   = format(subDays(dispatchDateObj, 1), "yyyy-MM-dd"); // -1 ngày (không lấy chính ngày xuất)

      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select(`
          id, po_number, from_name, delivery_date, matched_customer_id, production_items,
          mini_crm_customers!matched_customer_id ( address )
        `)
        .eq("match_status", "approved")
        .not("production_items", "is", null)
        .gte("delivery_date", fromDate)
        .lte("delivery_date", toDate)
        .order("delivery_date", { ascending: true });
      if (error) throw error;
      // Flatten joined customer address
      return (data || []).map((row: any) => ({
        ...row,
        customer_address: row.mini_crm_customers?.address ?? null,
      }));
    },
    enabled: createOpen,
  });

  // Finished goods inventory (sku_type = 'finished_good')
  const { data: finishedInventory = [] } = useQuery<InventoryItem[]>({
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
    enabled: createOpen,
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSelectPO = (poId: string) => {
    setSelectedPoId(poId);
    const po = salesPOs.find((p) => p.id === poId);
    if (!po?.production_items?.length) {
      setFormItems([]);
      return;
    }

    // Map PO items → form items, cross-reference with inventory
    const mapped: DispatchFormItem[] = po.production_items.map((pi) => {
      const inv = finishedInventory.find(
        (i) => i.name.toLowerCase().includes(pi.product_name.toLowerCase().trim()) ||
               pi.product_name.toLowerCase().includes(i.name.toLowerCase().trim())
      );
      return {
        product_name: pi.product_name,
        sku: pi.sku,
        ordered_qty: pi.qty ?? 0,
        available_qty: inv?.quantity ?? 0,
        dispatch_qty: Math.min(pi.qty ?? 0, inv?.quantity ?? 0),
        unit: pi.unit || inv?.unit || "kg",
        inventory_item_id: inv?.id,
      };
    });
    setFormItems(mapped);
    // Pre-fill delivery date from PO
    if (po.delivery_date) setDispatchDate(po.delivery_date);
    // Auto-fill delivery address from CRM customer profile (only if not already filled)
    if (po.customer_address) setDeliveryAddress(po.customer_address);
  };

  const handleDispatchQtyChange = (idx: number, val: string) => {
    const qty = Math.max(0, parseFloat(val) || 0);
    setFormItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], dispatch_qty: qty };
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
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatches"] });
      queryClient.invalidateQueries({ queryKey: ["warehouse_dispatch_items"] });
      toast({ title: "Tạo phiếu xuất kho thành công" });
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
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5" /> Tạo phiếu xuất kho
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {/* Select Sales PO */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Đơn hàng bán (Sales PO) <span className="text-destructive">*</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Hiển thị PO có ngày giao trong 3 ngày trước ngày xuất kho
                {dispatchDate && (
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
                <label className="text-sm font-medium">Sản phẩm xuất kho</label>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead className="text-right">Đặt (PO)</TableHead>
                        <TableHead className="text-right">Tồn kho</TableHead>
                        <TableHead className="text-right w-28">Số lượng XK</TableHead>
                        <TableHead>ĐVT</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {formItems.map((item, idx) => {
                        const overStock = item.dispatch_qty > item.available_qty;
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
