/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle,
  ClipboardCheck,
  Clock,
  Factory,
  FilePlus2,
  Loader2,
  Monitor,
  Package,
  ImageIcon,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { isFinishedSku } from "@/lib/skuType";

interface ProductionItem {
  product_name: string;
  qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  date: string;
  sku?: string | null;
  sku_code?: string | null;
}

interface CustomerPoInbox {
  id: string;
  po_number: string;
  from_name: string;
  delivery_date: string;
  production_items: ProductionItem[];
  total_amount: number;
  match_status: string;
}

interface ResolvedProductionItem extends ProductionItem {
  matched_sku: ProductSkuImageRow;
}

interface VisibleCustomerPoInbox extends Omit<CustomerPoInbox, "production_items"> {
  production_items: ResolvedProductionItem[];
}

interface ProductionOrder {
  id: string;
  production_number: string;
  source_po_inbox_id: string;
  customer_id: string | null;
  customer_name?: string;
  po_number?: string;
  status: "draft" | "planned" | "in_progress" | "completed" | "cancelled";
  planned_start_date: string | null;
  planned_end_date: string | null;
  completed_at: string | null;
  notes: string | null;
  created_at: string;
  items_count?: number;
  revenue_draft_id?: string | null;
  sales_po_doc_id?: string | null;
}

interface ProductionOrderItem {
  id: string;
  production_order_id: string;
  product_name: string;
  planned_qty: number;
  completed_qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  line_complete: boolean;
  delivery_date: string;
  actual_qty?: number | null;
  notes: string | null;
  created_at: string;
}

interface CreateProductionOrderInput {
  po_id: string;
  po_number: string;
  from_name: string;
  items: Array<{
    product_name: string;
    original_qty: number;
    planned_qty: number;
    unit: string;
    unit_price: number;
    line_total: number;
    date: string;
  }>;
  planned_start_date: string;
  planned_end_date: string;
  notes: string;
}

interface AggregatedPlanItem {
  key: string;
  product_name: string;
  qty: number;
  unit: string;
  image_url?: string | null;
  channelCount: number;
  poCount: number;
  earliestDate: string | null;
  sourceNames: string[];
}

const productGradientClassNames = [
  "from-amber-500/30 via-orange-500/20 to-stone-950",
  "from-yellow-400/25 via-amber-500/20 to-red-950",
  "from-orange-400/24 via-yellow-500/16 to-stone-950",
  "from-amber-300/18 via-orange-500/18 to-zinc-950",
];

type ProductSkuImageRow = {
  id: string;
  sku_code: string | null;
  product_name: string;
  category?: string | null;
  sku_type?: "raw_material" | "finished_good" | null;
  unit: string | null;
  image_url?: string | null;
};

type ProductionLocationSkuSetting = {
  sku_id: string;
  is_enabled: boolean;
};

const PRODUCTION_LOCATION_CODE = "q7";
const PRODUCTION_LOCATION_MODULE_KEY = "production_q7";

const normalizeSkuText = (value: string | null | undefined) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeProductionProductName = (value: string | null | undefined) =>
  normalizeSkuText(value)
    .replace(/\bbmq\b/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|grams|kg|ml|l|lit|litre|hop|cai|goi|thung)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isStrictProductionSkuMatch = (itemName: string, skuName: string) => {
  const item = normalizeProductionProductName(itemName);
  const sku = normalizeProductionProductName(skuName);
  return !!item && !!sku && item === sku;
};

const resolveSkuMatch = (item: ProductionItem, skus: ProductSkuImageRow[]) => {
  const itemSkuCode = normalizeSkuText(item.sku_code || item.sku);
  if (itemSkuCode) {
    const byCode = skus.find((sku) => normalizeSkuText(sku.sku_code) === itemSkuCode);
    if (byCode) return byCode;
  }

  return skus.find((sku) => isStrictProductionSkuMatch(item.product_name, sku.product_name)) || null;
};

const resolveSkuImageUrl = (productName: string, skus: ProductSkuImageRow[]) =>
  skus.find((sku) => isStrictProductionSkuMatch(productName, sku.product_name))?.image_url || null;

const ProductVisual = ({
  imageUrl,
  productName,
  className = "",
  gradientClassName,
  children,
}: {
  imageUrl?: string | null;
  productName: string;
  className?: string;
  gradientClassName: string;
  children?: ReactNode;
}) => (
  <div className={`relative overflow-hidden rounded-3xl border border-white/10 bg-[#231913] shadow-inner ${className}`}>
    {imageUrl ? (
      <img src={imageUrl} alt={productName} className="h-full w-full object-cover object-center" loading="lazy" />
    ) : (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br ${gradientClassName} text-amber-100/45`}>
        <ImageIcon className="h-6 w-6" />
        <span className="text-[10px] font-extrabold uppercase tracking-wide">Chưa có ảnh</span>
      </div>
    )}
    {children}
  </div>
);

const vietnamDateParts = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

const vietnamTodayInputValue = () => {
  const parts = vietnamDateParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const todayInputValue = vietnamTodayInputValue;

const vietnamDayUtcStartIso = () => {
  const vietnamNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  vietnamNow.setHours(0, 0, 0, 0);
  return new Date(vietnamNow.getTime() - 7 * 60 * 60 * 1000).toISOString();
};

export default function ProductionPlanning() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const isVi = language === "vi";
  const locale = isVi ? vi : undefined;
  const canEditLocation = canEditModule(PRODUCTION_LOCATION_MODULE_KEY);
  const queryClient = useQueryClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tvModeOpen, setTvModeOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"plan" | "settings">("plan");
  const [selectedPoForCreation, setSelectedPoForCreation] = useState<CustomerPoInbox | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    items: Array<{
      product_name: string;
      original_qty: number;
      planned_qty: number;
      unit: string;
      unit_price: number;
      line_total: number;
      date: string;
    }>;
    planned_start_date: string;
    planned_end_date: string;
    notes: string;
  }>({
    items: [],
    planned_start_date: todayInputValue(),
    planned_end_date: todayInputValue(),
    notes: "",
  });

  const planDateIso = useMemo(() => vietnamTodayInputValue(), []);
  const planDayStartIso = useMemo(() => vietnamDayUtcStartIso(), []);

  const { data: pendingPos = [], isLoading: loadingPos } = useQuery({
    queryKey: ["pending-pos", planDateIso, planDayStartIso],
    queryFn: async () => {
      try {
        const { data: allPos, error: posError } = await (supabase as any)
          .from("customer_po_inbox")
          .select("*")
          .in("match_status", ["approved", "pending_approval"])
          .or(`delivery_date.eq.${planDateIso},created_at.gte.${planDayStartIso}`)
          .order("created_at", { ascending: false });

        if (posError) throw posError;

        const { data: linkedPos, error: linkedError } = await (supabase as any)
          .from("production_orders")
          .select("source_po_inbox_id");

        if (linkedError) throw linkedError;

        const linkedPoIds = new Set((linkedPos || []).map((p: any) => p.source_po_inbox_id));
        return (allPos || []).filter((po: any) => !linkedPoIds.has(po.id)) as CustomerPoInbox[];
      } catch (error) {
        console.error("Error fetching pending POs:", error);
        toast.error(isVi ? "Không thể tải danh sách PO" : "Failed to load POs");
        return [];
      }
    },
  });

  const { data: skuImageRows = [], isLoading: loadingSkus } = useQuery({
    queryKey: ["production-sku-images"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("product_skus")
        .select("id,sku_code,product_name,category,sku_type,unit,image_url")
        .order("product_name", { ascending: true });

      if (error) {
        console.error("Error fetching SKU images:", error);
        return [] as ProductSkuImageRow[];
      }

      return ((data || []) as ProductSkuImageRow[]).filter((sku) => isFinishedSku(sku));
    },
    staleTime: 30000,
  });

  const { data: locationSkuSettings = [], isLoading: loadingLocationSettings } = useQuery({
    queryKey: ["production-location-sku-settings", PRODUCTION_LOCATION_CODE],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_location_sku_settings")
        .select("sku_id,is_enabled")
        .eq("location_code", PRODUCTION_LOCATION_CODE);

      if (error) {
        console.error("Error fetching production location SKU settings:", error);
        toast.error(isVi ? "Không thể tải thiết lập SKU xưởng" : "Failed to load workshop SKU settings");
        return [] as ProductionLocationSkuSetting[];
      }

      return (data || []) as ProductionLocationSkuSetting[];
    },
  });

  const toggleLocationSkuMutation = useMutation({
    mutationFn: async ({ skuId, enabled }: { skuId: string; enabled: boolean }) => {
      const { error } = await (supabase as any)
        .from("production_location_sku_settings")
        .upsert(
          {
            location_code: PRODUCTION_LOCATION_CODE,
            sku_id: skuId,
            is_enabled: enabled,
          },
          { onConflict: "location_code,sku_id" }
        );

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["production-location-sku-settings", PRODUCTION_LOCATION_CODE] });
    },
    onError: (error: any) => {
      console.error("Error updating production location SKU setting:", error);
      toast.error(isVi ? "Không thể cập nhật thiết lập SKU" : "Failed to update SKU setting");
    },
  });

  const { data: productionOrders = [], isLoading: loadingOrders } = useQuery({
    queryKey: ["production-orders"],
    queryFn: async () => {
      try {
        const { data: orders, error: ordersError } = await (supabase as any)
          .from("production_orders")
          .select("*")
          .order("created_at", { ascending: false });

        if (ordersError) throw ordersError;

        const ordersWithItems = await Promise.all(
          (orders || []).map(async (order: any) => {
            const { data: items, error: itemsError } = await (supabase as any)
              .from("production_order_items")
              .select("*")
              .eq("production_order_id", order.id);

            if (itemsError) console.error("Error fetching order items:", itemsError);
            return { ...order, items_count: (items || []).length };
          })
        );

        return ordersWithItems as ProductionOrder[];
      } catch (error) {
        console.error("Error fetching production orders:", error);
        toast.error(isVi ? "Không thể tải danh sách lệnh sản xuất" : "Failed to load production orders");
        return [];
      }
    },
  });

  const { data: orderItems = {} } = useQuery({
    queryKey: ["production-order-items", expandedOrderId],
    queryFn: async () => {
      if (!expandedOrderId) return {};

      try {
        const { data: items, error } = await (supabase as any)
          .from("production_order_items")
          .select("*")
          .eq("production_order_id", expandedOrderId)
          .order("created_at");

        if (error) throw error;
        return { [expandedOrderId]: items || [] };
      } catch (error) {
        console.error("Error fetching order items:", error);
        return {};
      }
    },
    enabled: !!expandedOrderId,
  });

  const enabledSkuIds = useMemo(() => {
    return new Set(locationSkuSettings.filter((row) => row.is_enabled).map((row) => row.sku_id));
  }, [locationSkuSettings]);

  const resolveEnabledProductionItem = useCallback(
    (item: ProductionItem): ResolvedProductionItem | null => {
      const matchedSku = resolveSkuMatch(item, skuImageRows);
      if (!matchedSku || !enabledSkuIds.has(matchedSku.id)) return null;
      return { ...item, matched_sku: matchedSku };
    },
    [enabledSkuIds, skuImageRows]
  );

  const visiblePendingPos = useMemo<VisibleCustomerPoInbox[]>(() => {
    return pendingPos
      .map((po) => ({
        ...po,
        production_items: (po.production_items || [])
          .map(resolveEnabledProductionItem)
          .filter((item): item is ResolvedProductionItem => !!item),
      }))
      .filter((po) => po.production_items.length > 0);
  }, [pendingPos, resolveEnabledProductionItem]);

  const createProductionOrderMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      try {
        const now = new Date();
        const dateStr = format(now, "yyyyMMdd");

        const { data: todayOrders, error: countError } = await (supabase as any)
          .from("production_orders")
          .select("id", { count: "exact", head: true })
          .gte("created_at", format(now, "yyyy-MM-dd'T'00:00:00"))
          .lte("created_at", format(now, "yyyy-MM-dd'T'23:59:59"));

        if (countError) throw countError;

        const sequence = ((todayOrders || []).length || 0) + 1;
        const productionNumber = `SX-${dateStr}-${String(sequence).padStart(3, "0")}`;

        const { data: newOrder, error: orderError } = await (supabase as any)
          .from("production_orders")
          .insert({
            production_number: productionNumber,
            source_po_inbox_id: input.po_id,
            status: "draft",
            planned_start_date: input.planned_start_date || null,
            planned_end_date: input.planned_end_date || null,
            notes: input.notes || null,
          })
          .select()
          .single();

        if (orderError) throw orderError;

        const itemsToInsert = input.items.map((item) => ({
          production_order_id: newOrder.id,
          product_name: item.product_name,
          planned_qty: item.planned_qty,
          completed_qty: 0,
          unit: item.unit,
          unit_price: item.unit_price,
          line_total: item.line_total,
          line_complete: false,
          delivery_date: item.date,
          notes: item.planned_qty !== item.original_qty ? "Đã điều chỉnh số lượng trước khi xác nhận" : null,
        }));

        const { error: itemsError } = await (supabase as any)
          .from("production_order_items")
          .insert(itemsToInsert);

        if (itemsError) {
          await (supabase as any).from("production_orders").delete().eq("id", newOrder.id);
          throw itemsError;
        }

        return newOrder;
      } catch (error) {
        console.error("Error creating production order:", error);
        throw error;
      }
    },
    onSuccess: (order) => {
      queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
      queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      toast.success(
        isVi
          ? `Đã tạo lệnh sản xuất ${order.production_number}. Cần liên kết BOM/NVL để tự sinh phiếu xuất kho.`
          : `Production order ${order.production_number} created. BOM/material issue integration is still required.`
      );
      setCreateDialogOpen(false);
      setSelectedPoForCreation(null);
      setFormData({
        items: [],
        planned_start_date: todayInputValue(),
        planned_end_date: todayInputValue(),
        notes: "",
      });
    },
    onError: (error: any) => {
      console.error("Mutation error:", error);
      toast.error(isVi ? "Không thể tạo lệnh sản xuất. Vui lòng thử lại." : "Failed to create production order. Please try again.");
    },
  });

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "-";
    try {
      const date = new Date(dateString);
      if (Number.isNaN(date.getTime())) return "-";
      return format(date, "dd/MM/yyyy", { locale });
    } catch {
      return "-";
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge variant="secondary"><Clock className="mr-1 h-3 w-3" />{isVi ? "Nháp" : "Draft"}</Badge>;
      case "planned":
        return <Badge className="bg-blue-500"><CalendarDays className="mr-1 h-3 w-3" />{isVi ? "Đã lên kế hoạch" : "Planned"}</Badge>;
      case "in_progress":
        return <Badge className="bg-amber-500"><Zap className="mr-1 h-3 w-3" />{isVi ? "Đang sản xuất" : "In Progress"}</Badge>;
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="mr-1 h-3 w-3" />{isVi ? "Hoàn thành" : "Completed"}</Badge>;
      case "cancelled":
        return <Badge variant="destructive"><AlertCircle className="mr-1 h-3 w-3" />{isVi ? "Hủy" : "Cancelled"}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const aggregatedPlanItems = useMemo<AggregatedPlanItem[]>(() => {
    const map = new Map<string, AggregatedPlanItem>();

    visiblePendingPos.forEach((po) => {
      (po.production_items || []).forEach((item) => {
        const matchedSku = item.matched_sku;
        const displayUnit = matchedSku.unit || item.unit;
        const key = matchedSku.id;
        const current = map.get(key) || {
          key,
          product_name: matchedSku.product_name,
          qty: 0,
          unit: displayUnit,
          image_url: matchedSku.image_url || null,
          channelCount: 0,
          poCount: 0,
          earliestDate: po.delivery_date || null,
          sourceNames: [],
        };

        current.qty += Number(item.qty || 0);
        current.poCount += 1;
        if (po.from_name && !current.sourceNames.includes(po.from_name)) current.sourceNames.push(po.from_name);
        if (po.delivery_date && (!current.earliestDate || new Date(po.delivery_date) < new Date(current.earliestDate))) {
          current.earliestDate = po.delivery_date;
        }
        map.set(key, current);
      });
    });

    return Array.from(map.values())
      .map((item) => ({ ...item, channelCount: item.sourceNames.length }))
      .sort((a, b) => b.qty - a.qty);
  }, [visiblePendingPos]);

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return {
      pendingPos: visiblePendingPos.length,
      plannedSkuCount: aggregatedPlanItems.length,
      plannedQty: aggregatedPlanItems.reduce((sum, item) => sum + item.qty, 0),
      inProgressOrders: productionOrders.filter((o) => o.status === "in_progress").length,
      completedToday: productionOrders.filter((o) => {
        if (o.status !== "completed" || !o.completed_at) return false;
        const completedDate = new Date(o.completed_at);
        completedDate.setHours(0, 0, 0, 0);
        return completedDate.getTime() === today.getTime();
      }).length,
    };
  }, [aggregatedPlanItems, visiblePendingPos.length, productionOrders]);

  const handleCreateClick = (po: CustomerPoInbox) => {
    if (!canEditLocation) {
      toast.error(isVi ? "Bạn cần quyền Sửa của Xưởng Q7 để xác nhận sản xuất" : "Edit permission for Q7 Workshop is required to confirm production");
      return;
    }
    const allowedItems = (po.production_items || [])
      .map(resolveEnabledProductionItem)
      .filter((item): item is ResolvedProductionItem => !!item);
    if (allowedItems.length === 0) {
      toast.error(isVi ? "PO này không có SKU được bật cho Xưởng Q7" : "This PO has no enabled SKUs for Q7 Workshop");
      return;
    }
    const items = allowedItems.map((item) => ({
      product_name: item.matched_sku.product_name,
      original_qty: item.qty,
      planned_qty: item.qty,
      unit: item.matched_sku.unit || item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
      date: item.date,
    }));
    setSelectedPoForCreation(po);
    setFormData({
      items,
      planned_start_date: todayInputValue(),
      planned_end_date: todayInputValue(),
      notes: "",
    });
    setCreateDialogOpen(true);
  };

  const handleSubmitCreate = async () => {
    if (!selectedPoForCreation) return;
    if (!canEditLocation) {
      toast.error(isVi ? "Bạn cần quyền Sửa của Xưởng Q7 để xác nhận sản xuất" : "Edit permission for Q7 Workshop is required to confirm production");
      return;
    }

    if (!formData.planned_start_date) {
      toast.error(isVi ? "Vui lòng chọn ngày bắt đầu" : "Please select start date");
      return;
    }
    if (!formData.planned_end_date) {
      toast.error(isVi ? "Vui lòng chọn ngày kết thúc" : "Please select end date");
      return;
    }

    await createProductionOrderMutation.mutateAsync({
      po_id: selectedPoForCreation.id,
      po_number: selectedPoForCreation.po_number,
      from_name: selectedPoForCreation.from_name,
      items: formData.items,
      planned_start_date: formData.planned_start_date,
      planned_end_date: formData.planned_end_date,
      notes: formData.notes,
    });
  };

  const changePlannedQty = (idx: number, nextQty: number) => {
    const newItems = [...formData.items];
    const safeQty = Math.max(0, Number.isFinite(nextQty) ? nextQty : 0);
    newItems[idx].planned_qty = safeQty;
    newItems[idx].line_total = safeQty * newItems[idx].unit_price;
    setFormData({ ...formData, items: newItems });
  };

  const pendingPosEmpty = !loadingPos && visiblePendingPos.length === 0;
  const ordersEmpty = !loadingOrders && productionOrders.length === 0;

  return (
    <div className="-m-4 min-h-screen space-y-5 bg-[radial-gradient(circle_at_18%_-12%,rgba(245,158,11,0.18),transparent_34%),linear-gradient(180deg,#140f0c_0%,#0b0908_42%,#070605_100%)] p-4 text-white md:-m-6 md:p-6">
      <div className="rounded-[2rem] border border-white/10 bg-white/[0.055] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-xl md:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-2">
            <Badge className="w-fit bg-amber-100 text-amber-900 hover:bg-amber-100">
              {isVi ? "Tự động từ PO đã parse" : "Auto from parsed POs"}
            </Badge>
            <div>
              <h1 className="font-display text-3xl font-bold tracking-tight text-white md:text-4xl">
                {isVi ? "Kế hoạch sản xuất - Xưởng Q7" : "Q7 Workshop Production Plan"}
              </h1>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              variant="outline"
              size="lg"
              className={`h-12 rounded-2xl border-white/10 text-base ${activeTab === "plan" ? "bg-amber-400 text-[#1b1004] hover:bg-amber-300 hover:text-[#1b1004]" : "bg-white/[0.06] text-white hover:bg-white/[0.1] hover:text-white"}`}
              onClick={() => setActiveTab("plan")}
            >
              {isVi ? "Kế hoạch" : "Plan"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className={`h-12 rounded-2xl border-white/10 text-base ${activeTab === "settings" ? "bg-amber-400 text-[#1b1004] hover:bg-amber-300 hover:text-[#1b1004]" : "bg-white/[0.06] text-white hover:bg-white/[0.1] hover:text-white"}`}
              onClick={() => setActiveTab("settings")}
            >
              {isVi ? "Thiết lập SX" : "Production setup"}
            </Button>
            {activeTab === "plan" && (
              <>
                <Button variant="outline" size="lg" className="h-12 rounded-2xl border-white/10 bg-white/[0.06] text-base text-white hover:bg-white/[0.1] hover:text-white" onClick={() => setTvModeOpen(true)}>
                  <Monitor className="mr-2 h-5 w-5" />
                  {isVi ? "Màn hình TV" : "TV View"}
                </Button>
                <Button
                  size="lg"
                  className="h-12 rounded-2xl bg-amber-400 text-base font-black text-[#1b1004] shadow-[0_12px_28px_rgba(245,158,11,0.22)] hover:bg-amber-300"
                  disabled={!canEditLocation || visiblePendingPos.length === 0}
                  onClick={() => visiblePendingPos[0] && handleCreateClick(visiblePendingPos[0])}
                >
                  <ClipboardCheck className="mr-2 h-5 w-5" />
                  {isVi ? "Xác nhận" : "Confirm"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {activeTab === "settings" ? (
        <Card className="rounded-[1.75rem] border-white/10 bg-[#14100d]/94 text-white shadow-sm">
          <CardHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-2xl font-black">{isVi ? "Thiết lập SKU sản xuất - Xưởng Q7" : "Q7 production SKU setup"}</CardTitle>
                <CardDescription className="mt-1 text-white/45">
                  {isVi ? "Chỉ SKU được check mới hiển thị trong kế hoạch sản xuất khi PO đẩy về xưởng này." : "Only checked SKUs appear in this workshop production plan when POs arrive."}
                </CardDescription>
              </div>
              <Badge className="w-fit bg-amber-400 text-[#1b1004] hover:bg-amber-400">
                {enabledSkuIds.size}/{skuImageRows.length} {isVi ? "SKU bật" : "enabled"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!canEditLocation && (
              <Alert className="rounded-2xl border-amber-300/20 bg-amber-300/10">
                <AlertDescription className="text-sm text-amber-100/80">
                  {isVi ? "Bạn chỉ có quyền xem. Cần quyền Sửa của module Xưởng Q7 để thay đổi thiết lập SKU." : "View only. Edit permission for Q7 Workshop is required to change SKU settings."}
                </AlertDescription>
              </Alert>
            )}
            {loadingSkus || loadingLocationSettings ? (
              <div className="flex min-h-[240px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]">
                <Loader2 className="h-8 w-8 animate-spin text-white/45" />
              </div>
            ) : skuImageRows.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/15 bg-white/[0.04] p-10 text-center text-white/45">
                {isVi ? "Chưa có SKU nào trong hệ thống." : "No SKUs found."}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {skuImageRows.map((sku, idx) => {
                  const enabled = enabledSkuIds.has(sku.id);
                  return (
                    <label
                      key={sku.id}
                      className={`grid min-h-[104px] cursor-pointer grid-cols-[72px_minmax(0,1fr)_28px] items-center gap-3 rounded-3xl border p-3 transition ${enabled ? "border-amber-300/30 bg-amber-300/[0.08]" : "border-white/10 bg-white/[0.04] hover:bg-white/[0.06]"}`}
                    >
                      <ProductVisual
                        imageUrl={sku.image_url}
                        productName={sku.product_name}
                        className="h-[72px] w-[72px] rounded-[18px]"
                        gradientClassName={productGradientClassNames[idx % productGradientClassNames.length]}
                      />
                      <div className="min-w-0 overflow-hidden">
                        <p className="line-clamp-2 break-words text-[13px] font-black leading-snug text-white">{sku.product_name}</p>
                        <p className="mt-1 truncate font-mono text-[10px] font-bold leading-tight text-white/35">{sku.sku_code || sku.id}</p>
                        <p className="mt-1 w-fit rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase text-white/45">{sku.unit || "-"}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={!canEditLocation || toggleLocationSkuMutation.isPending}
                        onChange={(event) => toggleLocationSkuMutation.mutate({ skuId: sku.id, enabled: event.target.checked })}
                        className="h-5 w-5 justify-self-end accent-amber-400 disabled:opacity-50"
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="rounded-3xl border-amber-300/20 bg-amber-300/10 text-white shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardDescription className="text-sm font-medium text-amber-100/70">{isVi ? "Tổng cần sản xuất" : "Planned quantity"}</CardDescription>
            <CardTitle className="text-4xl font-black tracking-tight text-amber-100">
              {loadingPos ? <Loader2 className="h-7 w-7 animate-spin" /> : stats.plannedQty.toLocaleString("vi-VN")}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-3xl border-white/10 bg-[#14100d]/90 text-white shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardDescription>{isVi ? "SKU hôm nay" : "Today's SKUs"}</CardDescription>
            <CardTitle className="text-4xl font-black">{stats.plannedSkuCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-3xl border-white/10 bg-[#14100d]/90 text-white shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardDescription>{isVi ? "PO có SKU bật" : "POs with enabled SKUs"}</CardDescription>
            <CardTitle className="text-4xl font-black text-orange-600">{loadingPos ? "..." : stats.pendingPos}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="rounded-3xl border-white/10 bg-[#14100d]/90 text-white shadow-sm">
          <CardHeader className="space-y-1 p-4">
            <CardDescription>{isVi ? "Đang sản xuất" : "In progress"}</CardDescription>
            <CardTitle className="text-4xl font-black text-emerald-600">{stats.inProgressOrders}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <section className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-black tracking-tight text-white">{isVi ? "Sản phẩm cần làm" : "Products to make"}</h2>
              <p className="font-semibold text-white/45">
                {isVi ? "Tổng hợp theo sản phẩm từ toàn bộ PO đã parse tự động." : "Aggregated by product across parsed POs."}
              </p>
            </div>
            <Badge variant="outline" className="w-fit rounded-full border-white/10 bg-white/[0.045] px-3 py-1 text-sm text-white/70">
              {format(new Date(`${planDateIso}T00:00:00`), "dd/MM/yyyy")}
            </Badge>
          </div>

          {loadingPos ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : pendingPosEmpty ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04] text-center">
              <Package className="mb-3 h-14 w-14 text-muted-foreground" />
              <h3 className="text-xl font-bold">{isVi ? "Chưa có PO chờ sản xuất" : "No POs awaiting production"}</h3>
              <p className="mt-1 max-w-md text-muted-foreground">
                {isVi ? "Khi parser ghi nhận PO đã duyệt, sản phẩm sẽ hiện ở đây." : "Parsed and approved POs will appear here."}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {aggregatedPlanItems.map((item, index) => (
                <article
                  key={item.key}
                  className="group rounded-[1.75rem] border border-white/10 bg-[#14100d]/94 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.28)] transition hover:-translate-y-0.5 hover:border-amber-300/30"
                >
                  <ProductVisual
                    imageUrl={item.image_url}
                    productName={item.product_name}
                    className="mb-4 h-28"
                    gradientClassName={productGradientClassNames[index % productGradientClassNames.length]}
                  >
                    <div className="absolute right-3 top-3 rounded-full bg-black/58 px-3 py-1 text-xs font-bold text-amber-100 backdrop-blur">
                      {item.poCount} PO
                    </div>
                  </ProductVisual>
                  <div className="space-y-3">
                    <h3 className="min-h-[3.25rem] text-xl font-black leading-tight text-white">{item.product_name}</h3>
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <div className="text-5xl font-black leading-none tracking-tight text-amber-200">{item.qty.toLocaleString("vi-VN")}</div>
                        <div className="text-base font-bold uppercase text-white/42">{item.unit}</div>
                      </div>
                      <div className="text-right text-sm text-white/45">
                        <div>{isVi ? "Giao" : "Delivery"}</div>
                        <div className="font-bold text-white">{formatDate(item.earliestDate)}</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {item.sourceNames.slice(0, 2).map((source) => (
                        <span key={source} className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-bold text-amber-100 ring-1 ring-amber-300/15">
                          {source}
                        </span>
                      ))}
                      {item.channelCount > 2 && (
                        <span className="rounded-full bg-white/[0.06] px-3 py-1 text-xs font-bold text-white/50">+{item.channelCount - 2}</span>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Card className="rounded-[1.75rem] border-white/10 bg-[#14100d]/94 text-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl font-black">
                <ClipboardCheck className="h-6 w-6 text-emerald-600" />
                {isVi ? "Xác nhận sản xuất" : "Confirm production"}
              </CardTitle>
              <CardDescription className="text-base">
                {isVi
                  ? "Chọn từng PO để xác nhận. Có thể chỉnh số lượng trong bước xác nhận trước khi tạo lệnh."
                  : "Confirm each PO. Quantities can be adjusted before creating the order."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Alert className="rounded-2xl border-amber-300/20 bg-amber-300/10">
                <AlertDescription className="text-sm leading-6 text-amber-100/78">
                  {isVi
                    ? "Backend hiện tạo lệnh sản xuất từ PO. Bước tự sinh phiếu xuất kho NVL theo BOM cần nối tiếp với bảng giá vốn/NVL ở phase sau."
                    : "Current backend creates production orders from POs. Material issue slips from BOM need the next integration phase."}
                </AlertDescription>
              </Alert>
              <div className="grid gap-2">
                {visiblePendingPos.slice(0, 6).map((po) => (
                  <button
                    key={po.id}
                    type="button"
                    disabled={!canEditLocation}
                    onClick={() => handleCreateClick(po)}
                    className="flex min-h-20 w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-left transition hover:border-amber-300/30 hover:bg-amber-300/[0.06] disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm font-black">{po.po_number}</div>
                      <div className="truncate text-sm text-muted-foreground">{po.from_name}</div>
                      <div className="text-xs text-muted-foreground">{formatDate(po.delivery_date)}</div>
                    </div>
                    <div className="shrink-0 rounded-xl bg-amber-400 px-3 py-2 text-sm font-black text-[#1b1004]">
                      {isVi ? "Xác nhận" : "Confirm"}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-[1.75rem] border-white/10 bg-[#0b0908] text-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-2xl font-black">
                <Monitor className="h-6 w-6 text-amber-300" />
                {isVi ? "Màn hình đang sản xuất" : "Production TV"}
              </CardTitle>
              <CardDescription className="text-zinc-300">
                {isVi ? "Chỉ hiển thị sản phẩm và số lượng; không lộ công thức, giá vốn, tiền." : "Shows products and quantities only."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="h-14 w-full rounded-2xl bg-amber-400 text-base font-black text-zinc-950 hover:bg-amber-300" onClick={() => setTvModeOpen(true)}>
                {isVi ? "Mở chế độ TV" : "Open TV mode"}
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Card className="rounded-[1.75rem] border-white/10 bg-[#14100d]/94 text-white shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-2xl font-black">
            <Factory className="h-6 w-6" />
            {isVi ? "Lệnh sản xuất" : "Production Orders"}
          </CardTitle>
          <CardDescription>{isVi ? "Theo dõi lệnh đã tạo và trạng thái sản xuất." : "Track created orders and production status."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingOrders ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : ordersEmpty ? (
            <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed py-12 text-center">
              <Factory className="mb-2 h-12 w-12 text-muted-foreground" />
              <p className="font-semibold text-muted-foreground">{isVi ? "Chưa có lệnh sản xuất nào" : "No production orders yet"}</p>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {productionOrders.map((order) => (
                <div key={order.id} className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-lg font-black">{order.production_number}</span>
                        {getStatusBadge(order.status)}
                        {order.revenue_draft_id && <Badge variant="outline" className="text-blue-600">Duyệt DT</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {order.po_number || "-"} · {order.customer_name || "-"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {order.planned_start_date ? `${formatDate(order.planned_start_date)} - ${formatDate(order.planned_end_date)}` : "-"}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="h-12 rounded-2xl"
                      onClick={() => setExpandedOrderId(expandedOrderId === order.id ? null : order.id)}
                    >
                      {isVi ? "Xem hàng" : "Items"} · {order.items_count || 0}
                    </Button>
                  </div>
                  {expandedOrderId === order.id && (
                    <div className="mt-4 grid gap-2 border-t pt-4">
                      {((orderItems[expandedOrderId] as ProductionOrderItem[]) || []).length > 0 ? (
                        ((orderItems[expandedOrderId] as ProductionOrderItem[]) || []).map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl bg-[#211915]/80 p-3">
                            <div>
                              <p className="font-bold leading-tight">{item.product_name}</p>
                              <p className="text-sm text-muted-foreground">{formatDate(item.delivery_date)}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-2xl font-black">{item.planned_qty.toLocaleString("vi-VN")}</p>
                              <p className="text-xs font-bold uppercase text-muted-foreground">{item.unit}</p>
                              {Number(item.actual_qty || 0) > 0 && (
                                <p className="text-xs font-semibold text-emerald-600">✓ {Number(item.actual_qty || 0).toLocaleString("vi-VN")}</p>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="py-3 text-center text-sm text-muted-foreground">{isVi ? "Không có hàng nào" : "No items"}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
        </>
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto rounded-3xl border-white/10 bg-[#14100d] text-white">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">
              {isVi ? "Xác nhận / điều chỉnh kế hoạch" : "Confirm / adjust plan"}
            </DialogTitle>
          </DialogHeader>

          {selectedPoForCreation && (
            <div className="space-y-5">
              <div className="rounded-3xl border border-amber-300/20 bg-amber-300/10 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-mono text-lg font-black">{selectedPoForCreation.po_number}</p>
                    <p className="font-semibold text-white/45">{selectedPoForCreation.from_name}</p>
                  </div>
                  <Badge className="w-fit bg-amber-400 text-[#1b1004] hover:bg-amber-400">
                    {isVi ? "Nguồn PO đã parse" : "Parsed PO source"}
                  </Badge>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {formData.items.map((item, idx) => {
                  const adjusted = item.planned_qty !== item.original_qty;
                  return (
                    <div key={`${item.product_name}-${idx}`} className="rounded-3xl border border-white/10 bg-[#14100d]/94 p-4">
                      <div className="mb-4 flex gap-3">
                        <ProductVisual
                          imageUrl={resolveSkuImageUrl(item.product_name, skuImageRows)}
                          productName={item.product_name}
                          className="h-20 w-24 shrink-0 rounded-2xl"
                          gradientClassName={productGradientClassNames[idx % productGradientClassNames.length]}
                        />
                        <div className="min-w-0">
                          <h3 className="text-lg font-black leading-tight">{item.product_name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {isVi ? "Khách đặt" : "Ordered"}: {item.original_qty.toLocaleString("vi-VN")} {item.unit}
                          </p>
                          {adjusted && <Badge variant="outline" className="mt-2 border-orange-300 text-orange-700">{isVi ? "Đã điều chỉnh" : "Adjusted"}</Badge>}
                        </div>
                      </div>

                      <div className="grid grid-cols-[56px_1fr_56px] items-center gap-2">
                        <Button variant="outline" size="icon" className="h-14 w-14 rounded-2xl text-2xl" disabled={!canEditLocation} onClick={() => changePlannedQty(idx, item.planned_qty - 1)}>
                          −
                        </Button>
                        <Input
                          type="number"
                          min="0"
                          value={item.planned_qty}
                          onChange={(e) => changePlannedQty(idx, Number.parseInt(e.target.value, 10) || 0)}
                          className="h-14 rounded-2xl text-center text-2xl font-black"
                          disabled={!canEditLocation}
                        />
                        <Button variant="outline" size="icon" className="h-14 w-14 rounded-2xl text-2xl" disabled={!canEditLocation} onClick={() => changePlannedQty(idx, item.planned_qty + 1)}>
                          +
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="start-date">{isVi ? "Ngày bắt đầu" : "Start date"}</Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={formData.planned_start_date}
                    onChange={(e) => setFormData({ ...formData, planned_start_date: e.target.value })}
                    className="mt-1 h-12 rounded-2xl"
                  />
                </div>
                <div>
                  <Label htmlFor="end-date">{isVi ? "Ngày kết thúc" : "End date"}</Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={formData.planned_end_date}
                    onChange={(e) => setFormData({ ...formData, planned_end_date: e.target.value })}
                    className="mt-1 h-12 rounded-2xl"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="notes">
                  {isVi ? "Lý do điều chỉnh / ghi chú" : "Adjustment reason / notes"}
                </Label>
                <Textarea
                  id="notes"
                  placeholder={isVi ? "Ví dụ: thiếu NVL ca sáng, sản xuất bù ca chiều..." : "Example: material shortage in morning shift..."}
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  className="mt-1 min-h-24 rounded-2xl"
                  disabled={!canEditLocation}
                />
              </div>

              <Alert className="rounded-2xl border-emerald-300/20 bg-emerald-400/10">
                <FilePlus2 className="h-4 w-4 text-emerald-300" />
                <AlertDescription className="text-emerald-100/80">
                  {isVi
                    ? "Sau khi xác nhận: tạo lệnh sản xuất và giữ link audit về PO nguồn. Phiếu xuất kho NVL sẽ được tự động hóa khi nối BOM/NVL."
                    : "After confirmation: production order is created and linked to source PO for audit. Material issue slip automation needs BOM integration."}
                </AlertDescription>
              </Alert>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" className="h-12 rounded-2xl" onClick={() => setCreateDialogOpen(false)} disabled={createProductionOrderMutation.isPending}>
                  {isVi ? "Hủy" : "Cancel"}
                </Button>
                <Button className="h-12 rounded-2xl bg-amber-400 font-black text-[#1b1004] hover:bg-amber-300" onClick={handleSubmitCreate} disabled={!canEditLocation || createProductionOrderMutation.isPending}>
                  {createProductionOrderMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
                  {isVi ? "Xác nhận tạo lệnh SX" : "Confirm production order"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={tvModeOpen} onOpenChange={setTvModeOpen}>
        <DialogContent className="max-h-[92vh] max-w-6xl overflow-hidden rounded-[2rem] border-zinc-800 bg-zinc-950 p-0 text-white">
          <div className="space-y-6 p-6 md:p-8">
            <div className="flex flex-col gap-4 border-b border-white/10 pb-5 md:flex-row md:items-center md:justify-between">
              <div>
                <DialogTitle className="text-4xl font-black md:text-5xl">
                  {isVi ? "Đang sản xuất hôm nay" : "Production in progress"}
                </DialogTitle>
                <p className="mt-2 text-lg text-zinc-300">
                  {isVi ? "Màn hình cho xưởng, quản lý và đối tác xem nhanh." : "Display for workshop, managers and partners."}
                </p>
              </div>
              <div className="rounded-3xl bg-amber-300 px-6 py-4 text-right text-zinc-950">
                <div className="text-sm font-black uppercase">{isVi ? "Tổng" : "Total"}</div>
                <div className="text-5xl font-black">{stats.plannedQty.toLocaleString("vi-VN")}</div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {aggregatedPlanItems.slice(0, 6).map((item, idx) => (
                <div key={item.key} className="rounded-[2rem] border border-white/10 bg-white/[0.06] p-5">
                  <ProductVisual
                    imageUrl={item.image_url}
                    productName={item.product_name}
                    className="mb-5 h-28"
                    gradientClassName={productGradientClassNames[idx % productGradientClassNames.length]}
                  />
                  <h3 className="min-h-[4rem] text-3xl font-black leading-tight">{item.product_name}</h3>
                  <div className="mt-4 flex items-end justify-between gap-4">
                    <div className="text-6xl font-black leading-none text-amber-300">{item.qty.toLocaleString("vi-VN")}</div>
                    <div className="pb-2 text-xl font-bold uppercase text-zinc-300">{item.unit}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
