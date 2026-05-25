/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle,
  ClipboardCheck,
  Factory,
  FilePlus2,
  Loader2,
  MailCheck,
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
  items?: ProductionOrderItem[];
  revenue_draft_id?: string | null;
  sales_po_doc_id?: string | null;
}

interface ProductionOrderItem {
  id: string;
  production_order_id: string;
  product_name: string;
  ordered_qty?: number | null;
  planned_qty: number;
  unit: string;
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

const formatDateInputFromParts = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

const vietnamDateInputValue = (offsetDays = 0) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
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

  const utcDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offsetDays));
  return formatDateInputFromParts(utcDate.getUTCFullYear(), utcDate.getUTCMonth() + 1, utcDate.getUTCDate());
};

const vietnamTodayInputValue = () => vietnamDateInputValue();
const vietnamProductionTargetInputValue = () => vietnamDateInputValue(1);

const vietnamDayUtcStartIso = (offsetDays = 0) => {
  const [year, month, day] = vietnamDateInputValue(offsetDays).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 7 * 60 * 60 * 1000).toISOString();
};

const formatDateOnly = (value: string | null | undefined) => {
  if (!value) return "-";
  const isoDate = normalizeDateForDb(value);
  if (!isoDate) return "-";
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
};

const normalizeDateForDb = (value: string | null | undefined) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateInputFromParts(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
};

const getProductionOrderDisplayStatus = (order: ProductionOrder, productionDateIso: string): ProductionOrder["status"] => {
  if (order.status === "completed" || order.status === "cancelled") return order.status;

  const hasTodayItems = (order.items || []).some((item) => normalizeDateForDb(item.delivery_date) === productionDateIso);
  if (hasTodayItems) return "in_progress";

  return "draft";
};

export default function ProductionPlanning() {
  const { language } = useLanguage();
  const { canEditModule } = useAuth();
  const isVi = language === "vi";
  const canEditLocation = canEditModule(PRODUCTION_LOCATION_MODULE_KEY);
  const queryClient = useQueryClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tvModeOpen, setTvModeOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"plan" | "settings">("plan");
  const [selectedPoForCreation, setSelectedPoForCreation] = useState<CustomerPoInbox | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const productionPoDateIso = useMemo(() => vietnamProductionTargetInputValue(), []);
  const tvProductionDateIso = useMemo(() => vietnamTodayInputValue(), []);
  const planDayStartIso = useMemo(() => vietnamDayUtcStartIso(), []);
  const nextDayStartIso = useMemo(() => vietnamDayUtcStartIso(1), []);

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
    planned_start_date: productionPoDateIso,
    planned_end_date: productionPoDateIso,
    notes: "",
  });

  const { data: pendingPos = [], isLoading: loadingPos } = useQuery({
    queryKey: ["pending-pos", productionPoDateIso, planDayStartIso],
    queryFn: async () => {
      try {
        const { data: allPos, error: posError } = await (supabase as any)
          .from("customer_po_inbox")
          .select("*")
          .in("match_status", ["approved", "pending_approval"])
          .or(`delivery_date.eq.${productionPoDateIso},and(delivery_date.is.null,created_at.gte.${planDayStartIso})`)
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

        const orderIds = (orders || []).map((order: any) => order.id);
        const itemsByOrderId = new Map<string, ProductionOrderItem[]>();

        if (orderIds.length > 0) {
          const { data: items, error: itemsError } = await (supabase as any)
            .from("production_order_items")
            .select("*")
            .in("production_order_id", orderIds)
            .order("created_at");

          if (itemsError) {
            console.error("Error fetching order items:", itemsError);
          }

          ((items || []) as ProductionOrderItem[]).forEach((item) => {
            const orderItems = itemsByOrderId.get(item.production_order_id) || [];
            orderItems.push(item);
            itemsByOrderId.set(item.production_order_id, orderItems);
          });
        }

        return (orders || []).map((order: any) => {
          const items = itemsByOrderId.get(order.id) || [];
          return { ...order, items, items_count: items.length };
        }) as ProductionOrder[];
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

  const checkPoMutation = useMutation({
    mutationFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error(isVi ? "Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại." : "Session expired. Please sign in again.");
      }

      const fromEpoch = Math.floor(new Date(planDayStartIso).getTime() / 1000);
      const toEpoch = Math.floor(new Date(nextDayStartIso).getTime() / 1000);
      const query = `in:anywhere deliveredto:po@bmq.vn after:${fromEpoch} before:${toEpoch}`;

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-gmail-sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ mode: "import", maxResults: 100, query, includeOnlyCrm: true }),
      });

      const rawText = await response.text();
      let result: any = {};
      try {
        result = rawText ? JSON.parse(rawText) : {};
      } catch {
        result = { raw: rawText };
      }

      if (!response.ok) {
        throw new Error(result?.error || result?.message || result?.raw || rawText || "Không thể kiểm tra PO");
      }

      return { ...result, query };
    },
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
      await queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      toast.success(isVi ? `Đã kiểm tra PO: nhập ${result?.synced || 0} email mới.` : `PO check done: imported ${result?.synced || 0} new emails.`);
    },
    onError: (error: any) => {
      console.error("Error checking PO email:", error);
      toast.error(error?.message || (isVi ? "Không thể kiểm tra PO" : "Failed to check POs"));
    },
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
          .filter((item): item is ResolvedProductionItem => {
            if (!item) return false;
            if (po.delivery_date) return normalizeDateForDb(po.delivery_date) === productionPoDateIso;
            const itemDate = normalizeDateForDb((item as any).service_date || item.date);
            return itemDate === productionPoDateIso;
          }),
      }))
      .filter((po) => po.production_items.length > 0);
  }, [pendingPos, productionPoDateIso, resolveEnabledProductionItem]);

  const createProductionOrderMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      try {
        const productionDateIso = normalizeDateForDb(input.planned_start_date) || vietnamTodayInputValue();
        const dateStr = productionDateIso.replace(/-/g, "");

        const { count, error: countError } = await (supabase as any)
          .from("production_orders")
          .select("id", { count: "exact", head: true })
          .like("production_number", `SX-${dateStr}-%`);

        if (countError) throw countError;

        const sequence = (count || 0) + 1;
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
          ordered_qty: item.original_qty,
          planned_qty: item.planned_qty,
          unit: item.unit,
          delivery_date: normalizeDateForDb(item.date),
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
        planned_start_date: productionPoDateIso,
        planned_end_date: productionPoDateIso,
        notes: "",
      });
    },
    onError: (error: any) => {
      console.error("Mutation error:", error);
      toast.error(isVi ? "Không thể tạo lệnh sản xuất. Vui lòng thử lại." : "Failed to create production order. Please try again.");
    },
  });

  const formatDate = (dateString: string | null) => formatDateOnly(dateString);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft":
        return <Badge className="bg-emerald-500 text-white hover:bg-emerald-500"><CheckCircle className="mr-1 h-3 w-3" />{isVi ? "Đã xác nhận" : "Confirmed"}</Badge>;
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

  const tvProductionItems = useMemo<AggregatedPlanItem[]>(() => {
    const activeStatuses = new Set<ProductionOrder["status"]>(["draft", "planned", "in_progress"]);
    const map = new Map<string, AggregatedPlanItem>();

    productionOrders
      .filter((order) => activeStatuses.has(order.status))
      .forEach((order) => {
        (order.items || []).forEach((item) => {
          if (normalizeDateForDb(item.delivery_date) !== tvProductionDateIso) return;

          const imageUrl = resolveSkuImageUrl(item.product_name, skuImageRows);
          const key = `${item.product_name}__${item.unit || ""}`;
          const current = map.get(key) || {
            key,
            product_name: item.product_name,
            qty: 0,
            unit: item.unit,
            image_url: imageUrl,
            channelCount: 0,
            poCount: 0,
            earliestDate: item.delivery_date || null,
            sourceNames: [],
          };

          current.qty += Number(item.planned_qty || item.ordered_qty || 0);
          current.poCount += 1;
          if (order.production_number && !current.sourceNames.includes(order.production_number)) {
            current.sourceNames.push(order.production_number);
          }
          if (!current.image_url && imageUrl) current.image_url = imageUrl;
          if (item.delivery_date && (!current.earliestDate || item.delivery_date < current.earliestDate)) {
            current.earliestDate = item.delivery_date;
          }
          map.set(key, current);
        });
      });

    return Array.from(map.values())
      .map((item) => ({ ...item, channelCount: item.sourceNames.length }))
      .sort((a, b) => b.qty - a.qty);
  }, [productionOrders, skuImageRows, tvProductionDateIso]);

  const tvProductionQty = useMemo(
    () => tvProductionItems.reduce((sum, item) => sum + item.qty, 0),
    [tvProductionItems]
  );

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return {
      pendingPos: visiblePendingPos.length,
      plannedSkuCount: aggregatedPlanItems.length,
      plannedQty: aggregatedPlanItems.reduce((sum, item) => sum + item.qty, 0),
      inProgressOrders: productionOrders.filter((o) => getProductionOrderDisplayStatus(o, tvProductionDateIso) === "in_progress").length,
      completedToday: productionOrders.filter((o) => {
        if (o.status !== "completed" || !o.completed_at) return false;
        const completedDate = new Date(o.completed_at);
        completedDate.setHours(0, 0, 0, 0);
        return completedDate.getTime() === today.getTime();
      }).length,
    };
  }, [aggregatedPlanItems, productionOrders, tvProductionDateIso, visiblePendingPos.length]);

  const handleCreateClick = (po: CustomerPoInbox) => {
    if (!canEditLocation) {
      toast.error(isVi ? "Bạn cần quyền Sửa của Xưởng Q7 để xác nhận sản xuất" : "Edit permission for Q7 Workshop is required to confirm production");
      return;
    }
    const allowedItems = (po.production_items || [])
      .map(resolveEnabledProductionItem)
      .filter((item): item is ResolvedProductionItem => {
        if (!item) return false;
        if (po.delivery_date) return normalizeDateForDb(po.delivery_date) === productionPoDateIso;
        const itemDate = normalizeDateForDb((item as any).service_date || item.date);
        return itemDate === productionPoDateIso;
      });
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
      date: po.delivery_date || (item as any).service_date || item.date,
    }));
    setSelectedPoForCreation(po);
    setFormData({
      items,
      planned_start_date: productionPoDateIso,
      planned_end_date: productionPoDateIso,
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

  const handleOpenTvMode = useCallback(() => {
    setTvModeOpen(true);

    if (typeof document === "undefined") return;

    const fullscreenTarget = document.documentElement;
    if (!document.fullscreenElement && fullscreenTarget.requestFullscreen) {
      void fullscreenTarget.requestFullscreen().catch(() => {
        toast.info(isVi ? "Trình duyệt chặn fullscreen, vui lòng bấm F11 nếu cần." : "Fullscreen was blocked by the browser. Press F11 if needed.");
      });
    }
  }, [isVi]);

  const handleTvModeOpenChange = useCallback((open: boolean) => {
    setTvModeOpen(open);

    if (!open && typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);

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
              className={`h-12 rounded-2xl border-white/10 text-base ${activeTab === "settings" ? "bg-amber-400 text-[#1b1004] hover:bg-amber-300 hover:text-[#1b1004]" : "bg-white/[0.06] text-white hover:bg-white/[0.1] hover:text-white"}`}
              onClick={() => setActiveTab("settings")}
            >
              {isVi ? "Thiết lập SX" : "Production setup"}
            </Button>
            {activeTab === "plan" && (
              <>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-12 rounded-2xl border-white/10 bg-white/[0.06] text-base text-white hover:bg-white/[0.1] hover:text-white"
                  disabled={checkPoMutation.isPending}
                  onClick={() => checkPoMutation.mutate()}
                >
                  {checkPoMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <MailCheck className="mr-2 h-5 w-5" />}
                  {isVi ? "Kiểm tra PO" : "Check POs"}
                </Button>
                <Button variant="outline" size="lg" className="h-12 rounded-2xl border-white/10 bg-white/[0.06] text-base text-white hover:bg-white/[0.1] hover:text-white" onClick={handleOpenTvMode}>
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
            <CardDescription>{isVi ? "SKU ngày giao ngày mai" : "Tomorrow delivery SKUs"}</CardDescription>
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
              <h2 className="text-2xl font-black tracking-tight text-white">{isVi ? "PO cần xác nhận cho ngày giao ngày mai" : "POs to confirm for tomorrow delivery"}</h2>
              <p className="font-semibold text-white/45">
                {isVi ? "Buổi sáng bấm Kiểm tra PO, xác nhận để lập lệnh SX cho ngày giao kế tiếp." : "Morning PO check confirms tomorrow-delivery production orders."}
              </p>
            </div>
            <Badge variant="outline" className="w-fit rounded-full border-white/10 bg-white/[0.045] px-3 py-1 text-sm text-white/70">
              {formatDateOnly(productionPoDateIso)}
            </Badge>
          </div>

          {loadingPos ? (
            <div className="flex min-h-[320px] items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04]">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : pendingPosEmpty ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-3xl border border-white/10 bg-white/[0.04] text-center">
              <Package className="mb-3 h-14 w-14 text-muted-foreground" />
              <h3 className="text-xl font-bold">{isVi ? "Chưa có PO chờ sản xuất cho ngày giao này" : "No POs awaiting production for this delivery date"}</h3>
              <p className="mt-1 max-w-md text-muted-foreground">
                {isVi ? "Khi parser ghi nhận PO đã duyệt, sản phẩm sẽ hiện ở đây." : "Parsed and approved POs will appear here."}
              </p>
            </div>
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
              {aggregatedPlanItems.map((item, index) => (
                <article
                  key={item.key}
                  className="group flex min-h-[96px] items-center gap-3 rounded-[24px] border border-white/10 bg-[#14100d]/95 p-3 shadow-[0_14px_42px_rgba(0,0,0,0.28)] transition hover:border-amber-300/30 hover:bg-white/[0.045] md:min-h-[104px]"
                >
                  <ProductVisual
                    imageUrl={item.image_url}
                    productName={item.product_name}
                    className="h-[72px] w-[72px] shrink-0 rounded-[18px]"
                    gradientClassName={productGradientClassNames[index % productGradientClassNames.length]}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="line-clamp-2 text-[14px] font-black leading-tight text-white md:text-[15px]">{item.product_name}</h3>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[10px] font-extrabold text-amber-100 ring-1 ring-amber-300/15">
                            {item.poCount} PO
                          </span>
                          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-bold text-white/50">
                            {formatDate(item.earliestDate)}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[30px] font-black leading-none tracking-[-0.04em] text-amber-200 md:text-[34px]">{item.qty.toLocaleString("vi-VN")}</div>
                        <div className="mt-1 text-[10px] font-extrabold uppercase text-white/42">{item.unit}</div>
                      </div>
                    </div>
                    {item.sourceNames.length > 0 && (
                      <p className="mt-2 truncate text-[10px] font-bold text-white/35">
                        {item.sourceNames.slice(0, 2).join(" · ")}{item.channelCount > 2 ? ` · +${item.channelCount - 2}` : ""}
                      </p>
                    )}
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
              <Button className="h-14 w-full rounded-2xl bg-amber-400 text-base font-black text-zinc-950 hover:bg-amber-300" onClick={handleOpenTvMode}>
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
                        {getStatusBadge(getProductionOrderDisplayStatus(order, tvProductionDateIso))}
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

      {tvModeOpen && (
        <div className="fixed inset-0 z-50 h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_18%_-12%,rgba(245,158,11,0.22),transparent_34%),linear-gradient(180deg,#140f0c_0%,#0b0908_42%,#050403_100%)] text-white">
          <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:gap-4 md:p-6">
            <div className="flex shrink-0 flex-col gap-3 border-b border-white/10 pb-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <h2 className="text-3xl font-black leading-none md:text-5xl">
                  {isVi ? "Đang sản xuất hôm nay" : "Production in progress today"}
                </h2>
                <p className="mt-1 text-sm text-zinc-300 md:text-lg">
                  {isVi ? `Màn hình cho xưởng, quản lý và đối tác xem nhanh · Ngày SX ${formatDateOnly(tvProductionDateIso)}` : `Display for workshop, managers and partners · Production date ${formatDateOnly(tvProductionDateIso)}`}
                </p>
              </div>
              <div className="flex shrink-0 items-stretch gap-2 md:gap-3">
                <div className="rounded-2xl bg-amber-300 px-4 py-2 text-right text-zinc-950 md:rounded-3xl md:px-5 md:py-3">
                  <div className="text-xs font-black uppercase md:text-sm">{isVi ? "Tổng" : "Total"}</div>
                  <div className="text-4xl font-black leading-none md:text-5xl">{tvProductionQty.toLocaleString("vi-VN")}</div>
                </div>
                <Button
                  variant="outline"
                  className="h-auto rounded-2xl border-white/15 bg-white/[0.06] px-4 font-black text-white hover:bg-white/[0.12] hover:text-white md:rounded-3xl"
                  onClick={() => handleTvModeOpenChange(false)}
                >
                  {isVi ? "Đóng" : "Close"}
                </Button>
              </div>
            </div>

            {tvProductionItems.length === 0 ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-[2rem] border border-dashed border-white/15 bg-white/[0.04] text-center">
                <Factory className="mb-3 h-16 w-16 text-white/25" />
                <h3 className="text-3xl font-black text-white/80">
                  {isVi ? "Chưa có lệnh đang sản xuất" : "No active production orders"}
                </h3>
                <p className="mt-2 max-w-xl text-lg font-semibold text-white/40">
                  {isVi ? "TV hiển thị lệnh SX của hôm nay, thường đã được xác nhận từ hôm qua." : "TV shows today's production orders, usually confirmed yesterday."}
                </p>
              </div>
            ) : (
            <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-3 gap-3 md:grid-cols-3 md:grid-rows-2 md:gap-4">
              {tvProductionItems.slice(0, 6).map((item, idx) => (
                <div key={item.key} className="relative min-h-0 overflow-hidden rounded-3xl border border-white/10 bg-[#231913] md:rounded-[2rem]">
                  {item.image_url ? (
                    <img
                      src={item.image_url}
                      alt={item.product_name}
                      className="absolute inset-0 h-full w-full scale-105 object-cover object-center opacity-80 blur-[1px]"
                      loading="lazy"
                    />
                  ) : (
                    <div className={`absolute inset-0 bg-gradient-to-br ${productGradientClassNames[idx % productGradientClassNames.length]}`} />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/38 to-black/18" />
                  <div className="relative z-10 flex h-full min-h-0 flex-col justify-end p-4 text-white md:p-5">
                    <h3 className="line-clamp-2 text-2xl font-black leading-tight drop-shadow-[0_3px_10px_rgba(0,0,0,0.85)] md:text-4xl">{item.product_name}</h3>
                    <div className="mt-3 flex shrink-0 items-end justify-between gap-3">
                      <div className="text-5xl font-black leading-none text-amber-300 drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)] md:text-7xl">{item.qty.toLocaleString("vi-VN")}</div>
                      <div className="pb-1 text-lg font-black uppercase text-white drop-shadow-[0_3px_10px_rgba(0,0,0,0.85)] md:text-2xl">{item.unit}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
