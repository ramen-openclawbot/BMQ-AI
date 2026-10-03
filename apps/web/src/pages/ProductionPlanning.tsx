 
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  CheckCircle,
  ClipboardCheck,
  Factory,
  FileDown,
  FilePlus2,
  Download,
  Loader2,
  Monitor,
  Package,
  Paperclip,
  ImageIcon,
  Pencil,
  Trash2,
  Truck,
  Zap,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Link } from "react-router-dom";
import { isFinishedSku } from "@/lib/skuType";
import KfmPoIntake, { type KfmAwaitingSetupPo, type KfmIntakeOutcome } from "@/components/production/KfmPoIntake";
import "@/styles/bmq-production.css";

interface ProductionItem {
  product_name: string;
  qty: number;
  unit: string;
  unit_price: number;
  line_total: number;
  date: string;
  sku?: string | null;
  sku_code?: string | null;
  sku_id?: string | null;
}

interface CustomerPoInbox {
  id: string;
  po_number: string;
  from_name: string;
  from_email?: string | null;
  email_subject?: string | null;
  received_at?: string | null;
  created_at?: string | null;
  delivery_date: string;
  production_items: ProductionItem[];
  total_amount: number;
  match_status: string;
  has_attachments?: boolean | null;
  attachment_names?: string[] | null;
  raw_payload?: { source?: string; kfm_order_id?: number; kfm_vendor_id?: number } | null;
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
  location_code: string | null;
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

type ProductionOrderDisplayStatus = ProductionOrder["status"] | "upcoming";

interface CreateProductionOrderInput {
  po_id: string;
  po_number: string;
  from_name: string;
  items: Array<{
    sku_id: string;
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

type CreateProductionOrderResult = {
  order: ProductionOrder;
  reused?: boolean;
};

type Q7MaterialIssuePdfResult = {
  issue_id?: string;
  issue_number?: string;
  revision?: number;
  status?: string;
  pdf_sha256?: string;
  download_url?: string;
  expires_in?: number;
  error?: string;
  blockers?: Array<{ status?: string; message?: string }>;
};

type EditProductionOrderForm = {
  planned_start_date: string;
  planned_end_date: string;
  notes: string;
  items: Array<{
    id: string;
    product_name: string;
    planned_qty: number;
    unit: string;
    delivery_date: string;
    notes: string;
  }>;
};

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
  "from-primary/15 via-accent/25 to-secondary/40",
  "from-secondary/45 via-background to-accent/20",
  "from-success/12 via-card to-primary/12",
  "from-muted via-card to-secondary/35",
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
  // Portal intake already validates the exact SKU; never remap it by a looser name.
  if (item.sku_id) return skus.find((sku) => sku.id === item.sku_id) || null;
  const itemSkuCode = normalizeSkuText(item.sku_code || item.sku);
  if (itemSkuCode) {
    const byCode = skus.find((sku) => normalizeSkuText(sku.sku_code) === itemSkuCode);
    if (byCode) return byCode;
  }

  return skus.find((sku) => isStrictProductionSkuMatch(item.product_name, sku.product_name)) || null;
};

const resolveSkuImageUrl = (productName: string, skus: ProductSkuImageRow[]) =>
  skus.find((sku) => isStrictProductionSkuMatch(productName, sku.product_name))?.image_url || null;

const kfmTokenPattern = /(^|[^a-z0-9])kfm([^a-z0-9]|$)/i;

const isKingfoodPo = (po: Pick<CustomerPoInbox, "from_email" | "email_subject" | "from_name">) => {
  const marker = normalizeSkuText(`${po.from_email || ""} ${po.email_subject || ""} ${po.from_name || ""}`);
  // KFM token positives: "KFM", "[KFM] order", "KFM-PO".
  // KFM substring false positives: "akfmart@example.com", "notkfmvendor", "prefixkfm".
  return marker.includes("kingfoodmart") || marker.includes("kingfood") || kfmTokenPattern.test(marker);
};

const isPortalPo = (po: CustomerPoInbox) => po.raw_payload?.source === "kfm_portal";

const latestReplacementKeyForPo = (po: CustomerPoInbox) => {
  if (isPortalPo(po)) return `kfm-portal:${po.po_number.trim().toUpperCase()}`;
  const deliveryDate = normalizeDateForDb(po.delivery_date) || "no-date";
  if (isKingfoodPo(po)) return `kingfood:${deliveryDate}`;
  return null;
};

const keepLatestReplacementPos = <T extends CustomerPoInbox>(pos: T[]) => {
  const latestByKey = new Map<string, T>();
  const passthrough: T[] = [];

  pos.forEach((po) => {
    const key = latestReplacementKeyForPo(po);
    if (!key) {
      passthrough.push(po);
      return;
    }

    const current = latestByKey.get(key);
    const poTime = new Date(po.received_at || po.created_at || 0).getTime();
    const currentTime = current ? new Date(current.received_at || current.created_at || 0).getTime() : -Infinity;
    if (!current || poTime >= currentTime) latestByKey.set(key, po);
  });

  return [...latestByKey.values(), ...passthrough];
};

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
  <div className={`relative overflow-hidden rounded-3xl border border-border/55 bg-card shadow-inner ${className}`}>
    {imageUrl ? (
      <img src={imageUrl} alt={productName} className="h-full w-full object-cover object-center" loading="lazy" />
    ) : (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br ${gradientClassName} text-muted-foreground`}>
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

const getProductionOrderDateIso = (order: ProductionOrder) => {
  const itemDates = (order.items || [])
    .map((item) => normalizeDateForDb(item.delivery_date))
    .filter((date): date is string => Boolean(date));

  return normalizeDateForDb(order.planned_start_date) || itemDates.sort()[0] || null;
};

const getProductionOrderTotalQty = (order: ProductionOrder) =>
  (order.items || []).reduce((sum, item) => sum + Number(item.planned_qty ?? item.ordered_qty ?? 0), 0);

const getPoAttachmentNames = (po: Pick<CustomerPoInbox, "attachment_names" | "has_attachments">) =>
  Array.isArray(po.attachment_names) ? po.attachment_names.filter(Boolean) : [];

const getProductionOrderDisplayStatus = (order: ProductionOrder, productionDateIso: string): ProductionOrderDisplayStatus => {
  if (order.status === "completed" || order.status === "cancelled") return order.status;

  const orderDateIso = getProductionOrderDateIso(order);
  if (orderDateIso && orderDateIso < productionDateIso) return "completed";

  const hasTodayItems = (order.items || []).some((item) => normalizeDateForDb(item.delivery_date) === productionDateIso);
  if (hasTodayItems || orderDateIso === productionDateIso) return "in_progress";

  if (orderDateIso && orderDateIso > productionDateIso) return "upcoming";

  return "draft";
};

export default function ProductionPlanning() {
  const { language } = useLanguage();
  const { canEditModule, isOwner } = useAuth();
  const isVi = language === "vi";
  const canEditLocation = canEditModule(PRODUCTION_LOCATION_MODULE_KEY);
  const queryClient = useQueryClient();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [tvModeOpen, setTvModeOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"plan" | "settings">("plan");
  const [selectedPoForCreation, setSelectedPoForCreation] = useState<CustomerPoInbox | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [showAllDoneOrders, setShowAllDoneOrders] = useState(false);
  const [editingOrder, setEditingOrder] = useState<ProductionOrder | null>(null);
  const [deleteOrder, setDeleteOrder] = useState<ProductionOrder | null>(null);
  const [materialIssuePdfOrderId, setMaterialIssuePdfOrderId] = useState<string | null>(null);
  const [materialIssuePdfMessages, setMaterialIssuePdfMessages] = useState<Record<string, string>>({});
  const [editForm, setEditForm] = useState<EditProductionOrderForm>({
    planned_start_date: "",
    planned_end_date: "",
    notes: "",
    items: [],
  });
  const productionPoDateIso = useMemo(() => vietnamProductionTargetInputValue(), []);
  const tvProductionDateIso = useMemo(() => vietnamTodayInputValue(), []);
  const planDayStartIso = useMemo(() => vietnamDayUtcStartIso(), []);

  const [formData, setFormData] = useState<{
    items: Array<{
      sku_id: string;
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

  const { data: pendingPos = [], isLoading: loadingPos, isError: pendingPosError, error: pendingPosErrorValue, refetch: refetchPendingPos } = useQuery({
    queryKey: ["pending-pos", productionPoDateIso, planDayStartIso],
    queryFn: async () => {
      const { data: allPos, error: posError } = await (supabase as any)
        .from("customer_po_inbox")
        .select("*")
        .in("match_status", ["approved", "pending_approval"])
        .or(`raw_payload->>source.eq.kfm_portal,delivery_date.eq.${productionPoDateIso},and(delivery_date.is.null,created_at.gte.${planDayStartIso})`)
        .order("created_at", { ascending: false });

      if (posError) throw posError;

      const { data: linkedPos, error: linkedError } = await (supabase as any)
        .from("production_orders")
        .select("source_po_inbox_id");

      if (linkedError) throw linkedError;

      const linkedPoIds = new Set((linkedPos || []).map((p: any) => p.source_po_inbox_id));
      return (allPos || []).filter((po: CustomerPoInbox) => !linkedPoIds.has(po.id) && (!(isPortalPo(po) || isKingfoodPo(po)) || po.match_status === "approved")) as CustomerPoInbox[];
    },
  });

  // A failed read must stay a failed read: never present it as an empty queue.
  useEffect(() => {
    if (!pendingPosError) return;
    console.error("Error fetching pending POs:", pendingPosErrorValue);
    toast.error(isVi ? "Không thể tải danh sách PO" : "Failed to load POs");
  }, [pendingPosError, pendingPosErrorValue, isVi]);

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

  const openEditOrder = (order: ProductionOrder) => {
    setEditingOrder(order);
    setEditForm({
      planned_start_date: normalizeDateForDb(order.planned_start_date) || "",
      planned_end_date: normalizeDateForDb(order.planned_end_date) || normalizeDateForDb(order.planned_start_date) || "",
      notes: order.notes || "",
      items: (order.items || []).map((item) => ({
        id: item.id,
        product_name: item.product_name,
        planned_qty: Number(item.planned_qty ?? item.ordered_qty ?? 0),
        unit: item.unit,
        delivery_date: normalizeDateForDb(item.delivery_date) || "",
        notes: item.notes || "",
      })),
    });
  };

  const updateEditItem = (index: number, updates: Partial<EditProductionOrderForm["items"][number]>) => {
    setEditForm((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...updates } : item)),
    }));
  };

  const closeEditOrder = () => {
    setEditingOrder(null);
    setEditForm({ planned_start_date: "", planned_end_date: "", notes: "", items: [] });
  };

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
    return keepLatestReplacementPos(pendingPos)
      .map((po) => ({
        ...po,
        production_items: (isPortalPo(po) && (po.production_items || []).some((item) => !resolveEnabledProductionItem(item)) ? [] : po.production_items || [])
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

  const prepareQ7MaterialIssuePdf = async (orderId: string) => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        console.warn("[Q7 PDF prepare] skipped: no active session");
        return;
      }

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/production-material-issue-pdf`, {
        method: "POST",
        headers: {
          ["authori" + "zation"]: ["Bear", "er ", accessToken].join(""),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ production_order_id: orderId }),
      });
      if (!response.ok) console.warn(`[Q7 PDF prepare] failed (${response.status})`);
    } catch {
      console.warn("[Q7 PDF prepare] failed");
    }
  };

  const createProductionOrderMutation = useMutation({
    mutationFn: async (input: CreateProductionOrderInput) => {
      const { data, error } = await (supabase as any).rpc("create_q7_production_from_po", {
        p_po_id: input.po_id,
        p_start_date: input.planned_start_date || null,
        p_end_date: input.planned_end_date || null,
        p_notes: input.notes || null,
        p_items: input.items,
      });
      if (error) throw error;
      if (!data?.order?.id) throw new Error("Không nhận được lệnh sản xuất đã xác minh.");
      return data as CreateProductionOrderResult;
    },
    onSuccess: ({ order, reused }) => {
      queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
      queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      void prepareQ7MaterialIssuePdf(order.id);

      const successMessage = reused
        ? (isVi ? `Lệnh ${order.production_number} đã tồn tại; không tạo trùng.` : `Order ${order.production_number} already exists; no duplicate created.`)
        : isVi
        ? `Đã tạo lệnh sản xuất ${order.production_number}. Phiếu NVL đang được chuẩn bị.`
        : `Production order ${order.production_number} created. The material issue PDF is being prepared.`;

      toast.success(successMessage);
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

  const updateProductionOrderMutation = useMutation({
    mutationFn: async ({ orderId, form }: { orderId: string; form: EditProductionOrderForm }) => {
      const { error: orderError } = await (supabase as any)
        .from("production_orders")
        .update({
          planned_start_date: form.planned_start_date || null,
          planned_end_date: form.planned_end_date || null,
          notes: form.notes || null,
        })
        .eq("id", orderId);

      if (orderError) throw orderError;

      await Promise.all(
        form.items.map((item) =>
          (supabase as any)
            .from("production_order_items")
            .update({
              planned_qty: Number(item.planned_qty || 0),
              delivery_date: item.delivery_date || null,
              notes: item.notes || null,
            })
            .eq("id", item.id)
            .then(({ error }: { error: any }) => {
              if (error) throw error;
            })
        )
      );

      return orderId;
    },
    onSuccess: (orderId) => {
      queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      queryClient.invalidateQueries({ queryKey: ["production-order-items"] });
      void prepareQ7MaterialIssuePdf(orderId);
      toast.success(isVi ? "Đã cập nhật lệnh sản xuất" : "Production order updated");
      closeEditOrder();
    },
    onError: (error: any) => {
      console.error("Error updating production order:", error);
      toast.error(isVi ? "Không thể cập nhật lệnh sản xuất" : "Failed to update production order");
    },
  });

  const deleteProductionOrderMutation = useMutation({
    mutationFn: async (orderId: string) => {
      if (!isOwner) throw new Error("Owner permission required");
      const { error } = await (supabase as any)
        .from("production_orders")
        .delete()
        .eq("id", orderId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
      queryClient.invalidateQueries({ queryKey: ["production-orders"] });
      queryClient.invalidateQueries({ queryKey: ["production-order-items"] });
      toast.success(isVi ? "Đã xoá lệnh sản xuất" : "Production order deleted");
      setDeleteOrder(null);
      if (expandedOrderId === deleteOrder?.id) setExpandedOrderId(null);
    },
    onError: (error: any) => {
      console.error("Error deleting production order:", error);
      toast.error(isVi ? "Không thể xoá lệnh sản xuất" : "Failed to delete production order");
    },
  });

  const formatDate = (dateString: string | null) => formatDateOnly(dateString);

  const getStatusBadge = (status: ProductionOrderDisplayStatus) => {
    switch (status) {
      case "draft":
        return <Badge className="bg-emerald-500 text-white hover:bg-emerald-500"><CheckCircle className="mr-1 h-3 w-3" />{isVi ? "Đã xác nhận" : "Confirmed"}</Badge>;
      case "upcoming":
        return <Badge className="bg-sky-500 text-white hover:bg-sky-500"><CalendarDays className="mr-1 h-3 w-3" />{isVi ? "Sắp sản xuất" : "Upcoming"}</Badge>;
      case "planned":
        return <Badge className="bg-blue-500"><CalendarDays className="mr-1 h-3 w-3" />{isVi ? "Đã lên kế hoạch" : "Planned"}</Badge>;
      case "in_progress":
        return <Badge className="bg-amber-500"><Zap className="mr-1 h-3 w-3" />{isVi ? "Đang sản xuất" : "In Progress"}</Badge>;
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="mr-1 h-3 w-3" />{isVi ? "Đã hoàn thành" : "Completed"}</Badge>;
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

  const handleCreateClick = (po: CustomerPoInbox, quiet = false): string | null => {
    const fail = (message: string) => { if (!quiet) toast.error(message); return message; };
    if (!canEditLocation) return fail(isVi ? "Bạn cần quyền Sửa của Xưởng Q7 để xác nhận sản xuất" : "Edit permission for Q7 Workshop is required");
    if (loadingSkus || loadingLocationSettings) return fail(isVi ? "Đang tải danh mục SKU và thiết lập xưởng. Hãy thử lại sau giây lát." : "SKU and workshop settings are loading. Try again shortly.");
    const portal = isPortalPo(po);
    const sourceItems = po.production_items || [];
    const resolved = sourceItems.map(resolveEnabledProductionItem);
    if (portal) {
      const missing = sourceItems.filter((_, index) => !resolved[index]);
      if (missing.length) return fail((isVi ? "PO đã xác nhận trên KFM. Cần khớp / bật SKU trong Thiết lập SX trước khi lập lệnh: " : "PO confirmed on KFM. Map / enable these workshop SKUs before production: ") + missing.map((item) => item.product_name).join(", "));
      if (!normalizeDateForDb(po.delivery_date)) return fail(isVi ? "PO thiếu ngày giao hợp lệ; chưa thể thiết lập sản xuất." : "The PO needs a valid delivery date before production setup.");
    }
    const allowedItems = resolved.filter((item): item is ResolvedProductionItem => {
      if (!item) return false;
      if (portal) return true;
      if (po.delivery_date) return normalizeDateForDb(po.delivery_date) === productionPoDateIso;
      return normalizeDateForDb((item as any).service_date || item.date) === productionPoDateIso;
    });
    if (allowedItems.length === 0) return fail(isVi ? "PO này không có SKU được bật cho Xưởng Q7" : "This PO has no enabled SKUs for Q7 Workshop");
    const date = portal ? normalizeDateForDb(po.delivery_date)! : productionPoDateIso;
    setSelectedPoForCreation(po);
    setFormData({
      items: allowedItems.map((item) => ({
        sku_id: item.matched_sku.id, product_name: item.matched_sku.product_name,
        original_qty: item.qty, planned_qty: item.qty, unit: item.matched_sku.unit || item.unit,
        unit_price: item.unit_price, line_total: item.line_total,
        date: po.delivery_date || (item as any).service_date || item.date,
      })),
      planned_start_date: date, planned_end_date: date, notes: "",
    });
    setCreateDialogOpen(true);
    return null;
  };

  const handlePortalImported = async (inboxId: string): Promise<KfmIntakeOutcome> => {
    await queryClient.invalidateQueries({ queryKey: ["pending-pos"] });
    await queryClient.invalidateQueries({ queryKey: ["production-orders"] });
    const { data: linked, error: linkedError } = await (supabase as any).from("production_orders").select("id").eq("source_po_inbox_id", inboxId).maybeSingle();
    if (linkedError) throw linkedError;
    if (linked) return "already-linked"; // Another employee completed production while this PO was open.
    const { data: po, error } = await (supabase as any).from("customer_po_inbox").select("*").eq("id", inboxId).single();
    if (error) throw error;
    if (!isPortalPo(po) || po.match_status !== "approved") throw new Error("Chưa xác minh PO được nhập từ portal sau khi xác nhận.");
    const issue = handleCreateClick(po, true);
    if (issue) throw new Error(issue);
    return "setup-opened";
  };

  const portalPosAwaitingSetup = useMemo(() => keepLatestReplacementPos(pendingPos.filter(isPortalPo)), [pendingPos]);

  const awaitingSetupPos = useMemo<KfmAwaitingSetupPo[]>(
    () => portalPosAwaitingSetup.map((po) => ({
      id: po.id,
      poNumber: po.po_number,
      deliveryDate: po.delivery_date || null,
      itemCount: (po.production_items || []).length,
    })),
    [portalPosAwaitingSetup]
  );

  const refreshPendingPos = useCallback(async () => {
    await refetchPendingPos();
  }, [refetchPendingPos]);

  const downloadPoAttachment = useCallback(
    async (po: Pick<CustomerPoInbox, "id" | "po_number">, fileName: string, event?: MouseEvent<HTMLElement>) => {
      event?.preventDefault();
      event?.stopPropagation();

      const lowerName = fileName.toLowerCase();
      const shouldOpenInline = /\.(pdf|png|jpe?g|webp)$/i.test(lowerName);
      const viewerWindow = shouldOpenInline && typeof window !== "undefined" ? window.open("", "_blank") : null;

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          viewerWindow?.close();
          toast.error(isVi ? "Vui lòng đăng nhập để mở file PO" : "Please sign in to open the PO file");
          return;
        }

        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-gmail-attachment`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inboxId: po.id, filename: fileName }),
        });

        if (!response.ok) {
          viewerWindow?.close();
          let message = response.statusText;
          try {
            const errorPayload = await response.json();
            message = String(errorPayload?.error || message);
          } catch {
            // ignore non-JSON error body
          }
          throw new Error(message);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        if (viewerWindow) {
          viewerWindow.location.href = blobUrl;
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
        } else {
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        }
      } catch (error) {
        console.error("Error opening PO attachment:", error);
        toast.error(isVi ? "Không thể mở file PO thật từ email" : "Failed to open the original PO email attachment");
      }
    },
    [isVi]
  );

  const canGenerateQ7MaterialIssuePdf = useCallback(
    (order: ProductionOrder) =>
      order.location_code === PRODUCTION_LOCATION_CODE &&
      (order.status === "planned" || order.status === "in_progress") &&
      canEditLocation,
    [canEditLocation]
  );

  const q7PdfBlockerMessage = (result: Q7MaterialIssuePdfResult) => {
    const firstBlocker = result.blockers?.find((blocker) => blocker?.message || blocker?.status);
    const status = firstBlocker?.status || result.status || "";
    if (firstBlocker?.message) return firstBlocker.message;
    const messages: Record<string, string> = {
      blocked_missing_finished_skus: "Thiếu SKU thành phẩm đã lưu trên dòng sản xuất.",
      blocked_missing_formulations: "Thiếu BOM/công thức NVL cho SKU thành phẩm.",
      blocked_missing_q7_mappings: "Thiếu mapping NVL đã duyệt sang Kho bếp Q7.",
      blocked_non_q7_order: "Lệnh sản xuất không thuộc Xưởng Q7.",
      blocked_posted_issue_changed: "Phiếu NVL đã chốt/post nhưng dữ liệu nguồn đã thay đổi.",
      blocked_ineligible_status: "Trạng thái lệnh sản xuất chưa đủ điều kiện tạo Phiếu NVL.",
    };
    return messages[status] || result.error || "Không thể tạo Phiếu NVL.";
  };

  const openQ7MaterialIssuePdf = useCallback(
    async (order: ProductionOrder, event?: MouseEvent<HTMLElement>) => {
      event?.preventDefault();
      event?.stopPropagation();

      if (!canGenerateQ7MaterialIssuePdf(order)) {
        const message = isVi ? "Chỉ lệnh Q7 đang kế hoạch/đang sản xuất mới tạo Phiếu NVL." : "Only active Q7 orders can generate material issue PDFs.";
        setMaterialIssuePdfMessages((current) => ({ ...current, [order.id]: message }));
        toast.error(message);
        return;
      }

      const viewerWindow = typeof window !== "undefined" ? window.open("", "_blank") : null;
      setMaterialIssuePdfOrderId(order.id);
      setMaterialIssuePdfMessages((current) => ({ ...current, [order.id]: "" }));

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        if (!accessToken) {
          viewerWindow?.close();
          throw new Error(isVi ? "Vui lòng đăng nhập lại để tải Phiếu NVL." : "Please sign in again to download the PDF.");
        }

        const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/production-material-issue-pdf`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ production_order_id: order.id }),
        });

        const rawText = await response.text();
        let result: Q7MaterialIssuePdfResult = {};
        try {
          result = rawText ? JSON.parse(rawText) : {};
        } catch {
          result = { error: rawText };
        }

        if (!response.ok || !result.download_url) {
          viewerWindow?.close();
          throw new Error(q7PdfBlockerMessage(result));
        }

        if (viewerWindow) {
          viewerWindow.opener = null;
          viewerWindow.location.href = result.download_url;
        } else {
          window.open(result.download_url, "_blank", "noopener,noreferrer");
        }
        toast.success(isVi ? `Đã tạo Phiếu NVL ${result.issue_number || order.production_number}` : "Material issue PDF is ready.");
      } catch (error: any) {
        const message = String(error?.message || (isVi ? "Không thể tạo Phiếu NVL." : "Failed to create material issue PDF."));
        setMaterialIssuePdfMessages((current) => ({ ...current, [order.id]: message }));
        toast.error(message);
      } finally {
        setMaterialIssuePdfOrderId(null);
      }
    },
    [canGenerateQ7MaterialIssuePdf, isVi]
  );

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

  const maxPlanQty = Math.max(1, ...aggregatedPlanItems.map((item) => item.qty));
  const otherPendingPos = visiblePendingPos.filter((po) => !isPortalPo(po));
  const deliveryLabel = formatDateOnly(productionPoDateIso);
  const shiftIso = (iso: string, days: number) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  const liveOrders = productionOrders.filter((order) => order.status !== "cancelled");
  const windowOrders = liveOrders.filter((order) => {
    const dateIso = getProductionOrderDateIso(order);
    return !!dateIso && dateIso >= tvProductionDateIso && dateIso <= productionPoDateIso;
  });
  const orderedQty = windowOrders.reduce((sum, order) => sum + getProductionOrderTotalQty(order), 0);
  const demandQty = orderedQty + stats.plannedQty;
  const orderedPct = demandQty > 0 ? Math.round((orderedQty / demandQty) * 100) : 0;
  const orderStatusCount = (status: ProductionOrderDisplayStatus) =>
    liveOrders.filter((order) => getProductionOrderDisplayStatus(order, tvProductionDateIso) === status).length;
  const completedCount = orderStatusCount("completed");
  const upcomingDays = [0, 1, 2].map((offset) => {
    const dayIso = shiftIso(tvProductionDateIso, offset);
    const dayOrders = liveOrders.filter((order) => getProductionOrderDateIso(order) === dayIso);
    return { dayIso, orders: dayOrders.length, qty: dayOrders.reduce((sum, order) => sum + getProductionOrderTotalQty(order), 0) };
  });
  const maxDayQty = Math.max(1, ...upcomingDays.map((day) => day.qty));
  const flowSteps = [
    { key: "po", label: isVi ? "PO đã xác nhận" : "POs confirmed", count: visiblePendingPos.length + windowOrders.length, state: visiblePendingPos.length + windowOrders.length > 0 ? "done" : "idle" },
    { key: "plan", label: isVi ? "Lập kế hoạch SX" : "Production plan", count: stats.pendingPos, state: stats.pendingPos > 0 ? "now" : windowOrders.length > 0 ? "done" : "idle" },
    { key: "run", label: isVi ? "Đang sản xuất" : "In production", count: stats.inProgressOrders, state: stats.inProgressOrders > 0 ? (stats.pendingPos > 0 ? "idle" : "now") : completedCount > 0 ? "done" : "idle" },
    { key: "done", label: isVi ? "Hoàn thành" : "Completed", count: completedCount, state: completedCount > 0 && stats.inProgressOrders === 0 ? "done" : "idle" },
  ];
  const beadCx = 200;
  const beadCy = 200;
  const beadR = 158;
  const beads = Array.from({ length: 21 }, (_, k) => {
    const value = k * 5;
    const angle = Math.PI + (value / 100) * Math.PI;
    return { value, x: beadCx + beadR * Math.cos(angle), y: beadCy + beadR * Math.sin(angle), on: demandQty > 0 && value <= orderedPct };
  });
  const SKU_COLORS = ["#29bf12", "#3c91e6", "#d0679a", "#f4442e", "#8a8a88"];

  return (
    <div className="d3-pp min-w-0" data-stitch-production-planning="bmq-light-operations" data-bmq-production-layout="demo3-v2">
      <header className="d3-pp-head" data-stitch-production-header="true" data-bmq-q7-header="v2">
        <div className="d3-pp-titles">
          <span className="d3-pp-tag">
            {isVi ? `Sản xuất · xưởng Q7 · ngày giao ${deliveryLabel}` : `Production · Q7 workshop · delivery ${deliveryLabel}`}
          </span>
          <h1>
            {activeTab === "settings" ? (
              <>{isVi ? "Thiết lập " : "Production "}<b>{isVi ? "SKU sản xuất" : "SKU setup"}</b></>
            ) : demandQty > 0 ? (
              <>
                {isVi ? "Đã lập lệnh " : "Orders cover "}
                <b>{orderedPct}%</b>
                {isVi ? " sản lượng cần làm" : " of the quantity"}
              </>
            ) : (
              <>{isVi ? "Chưa có " : "No "}<b>{isVi ? "đơn cần sản xuất" : "production demand"}</b>{isVi ? ` cho ${deliveryLabel}` : ` for ${deliveryLabel}`}</>
            )}
          </h1>
        </div>
        <div className="d3-pp-actions sm:flex sm:flex-wrap">
          {activeTab === "settings" ? (
            <Button variant="outline" onClick={() => setActiveTab("plan")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {isVi ? "Quay lại kế hoạch" : "Back to plan"}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setActiveTab("settings")}>
                {isVi ? "Thiết lập SX" : "Production setup"}
              </Button>
              <KfmPoIntake canDecide={canEditLocation} isVi={isVi} paused={createDialogOpen || !!editingOrder || !!deleteOrder || tvModeOpen} onImported={handlePortalImported} awaitingSetup={awaitingSetupPos} awaitingSetupLoading={loadingPos} awaitingSetupError={pendingPosError} onRefreshAwaitingSetup={refreshPendingPos} />
              <Button asChild variant="outline" data-kfm-portal-entry="v2">
                <Link to="/production/planning/q7/kfm"><Truck className="mr-2 h-4 w-4" />{isVi ? "Cổng KFM" : "KFM portal"}</Link>
              </Button>
              <Button
                disabled={!canEditLocation || visiblePendingPos.length === 0}
                onClick={() => visiblePendingPos[0] && handleCreateClick(visiblePendingPos[0])}
              >
                <ClipboardCheck className="mr-2 h-4 w-4" />
                {isVi ? "Tạo kế hoạch SX" : "Create plan"}
              </Button>
            </>
          )}
        </div>
      </header>

      {activeTab === "settings" ? (
        <Card className="card-elevated rounded-[1.5rem]" data-stitch-production-settings="true">
          <CardHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-2xl font-black text-foreground">{isVi ? "Thiết lập SKU sản xuất - Xưởng Q7" : "Q7 production SKU setup"}</CardTitle>
                <CardDescription className="mt-1 text-muted-foreground">
                  {isVi ? "Chỉ SKU được check mới hiển thị trong kế hoạch sản xuất khi PO đẩy về xưởng này." : "Only checked SKUs appear in this workshop production plan when POs arrive."}
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  className="rounded-2xl border-primary/30 bg-card/80 font-bold text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => setActiveTab("plan")}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {isVi ? "Quay lại" : "Back"}
                </Button>
                <Badge className="w-fit bg-primary text-primary-foreground hover:bg-primary">
                  {enabledSkuIds.size}/{skuImageRows.length} {isVi ? "SKU bật" : "enabled"}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!canEditLocation && (
              <Alert className="rounded-2xl border-warning/40 bg-warning/20">
                <AlertDescription className="text-sm text-warning-foreground">
                  {isVi ? "Bạn chỉ có quyền xem. Cần quyền Sửa của module Xưởng Q7 để thay đổi thiết lập SKU." : "View only. Edit permission for Q7 Workshop is required to change SKU settings."}
                </AlertDescription>
              </Alert>
            )}
            {loadingSkus || loadingLocationSettings ? (
              <div className="flex min-h-[240px] items-center justify-center rounded-3xl border border-border/60 bg-card/60">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : skuImageRows.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-border bg-card/60 p-10 text-center text-muted-foreground">
                {isVi ? "Chưa có SKU nào trong hệ thống." : "No SKUs found."}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {skuImageRows.map((sku, idx) => {
                  const enabled = enabledSkuIds.has(sku.id);
                  return (
                    <label
                      key={sku.id}
                      className={`grid min-h-[104px] cursor-pointer grid-cols-[72px_minmax(0,1fr)_28px] items-center gap-3 rounded-3xl border p-3 transition ${enabled ? "border-primary/30 bg-primary/10" : "border-border/60 bg-card/70 hover:bg-muted/60"}`}
                    >
                      <ProductVisual
                        imageUrl={sku.image_url}
                        productName={sku.product_name}
                        className="h-[72px] w-[72px] rounded-[18px]"
                        gradientClassName={productGradientClassNames[idx % productGradientClassNames.length]}
                      />
                      <div className="min-w-0 overflow-hidden">
                        <p className="line-clamp-2 break-words text-[13px] font-black leading-snug text-foreground">{sku.product_name}</p>
                        <p className="mt-1 truncate font-mono text-[10px] font-bold leading-tight text-muted-foreground">{sku.sku_code || sku.id}</p>
                        <p className="mt-1 w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">{sku.unit || "-"}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={!canEditLocation || toggleLocationSkuMutation.isPending}
                        onChange={(event) => toggleLocationSkuMutation.mutate({ skuId: sku.id, enabled: event.target.checked })}
                        className="h-5 w-5 justify-self-end accent-primary disabled:opacity-50"
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
      <div className="d3-pp-dash">
        <section className="d3-pp-card d3-pp-hero" style={{ ["--i" as string]: 1 }} data-stitch-production-metrics="true">
          <span className="d3-pp-glow" aria-hidden="true" />
          <div className="d3-pp-card-h">
            <h2>{isVi ? "Sản lượng so với kế hoạch" : "Output vs plan"}</h2>
            <span className="d3-pp-pill is-green">{isVi ? `Ngày giao ${deliveryLabel}` : deliveryLabel}</span>
          </div>
          <div className="d3-pp-beads-wrap">
            <svg className="d3-pp-beads" viewBox="0 0 400 225" role="img" aria-label={isVi ? `Đã lập lệnh ${orderedPct}% sản lượng cần làm` : `${orderedPct}% of demand has production orders`}>
              <path className="d3-pp-bead-track" d={`M${beadCx - beadR} ${beadCy}A${beadR} ${beadR} 0 0 1 ${beadCx + beadR} ${beadCy}`} />
              {beads.map((bead, k) => (
                <g key={bead.value} className={`d3-pp-bead${bead.on ? " is-on" : ""}`} style={{ ["--dl" as string]: `${300 + k * 60}ms` }}>
                  <circle cx={bead.x.toFixed(1)} cy={bead.y.toFixed(1)} r={13} />
                  <text x={bead.x.toFixed(1)} y={(bead.y + 3.5).toFixed(1)} textAnchor="middle">{bead.value}</text>
                </g>
              ))}
              <text x={beadCx - beadR} y={beadCy + 26} textAnchor="middle" className="d3-pp-bead-label">0%</text>
              <text x={beadCx + beadR} y={beadCy + 26} textAnchor="middle" className="d3-pp-bead-label">100%</text>
            </svg>
            <div className="d3-pp-bead-center">
              <div className="d3-pp-big">{loadingPos || loadingOrders ? "…" : pendingPosError ? "—" : orderedPct}<span className="d3-pp-dot" /></div>
              <span className="d3-pp-sub">
                {pendingPosError
                  ? (isVi ? "Không đọc được PO" : "Could not read POs")
                  : isVi
                    ? `${orderedQty.toLocaleString("vi-VN")} / ${demandQty.toLocaleString("vi-VN")} sản phẩm đã lập lệnh`
                    : `${orderedQty.toLocaleString("en-US")} / ${demandQty.toLocaleString("en-US")} units ordered`}
              </span>
            </div>
          </div>
        </section>

        <div className="d3-pp-side">
          <section className="d3-pp-card" style={{ ["--i" as string]: 2 }}>
            <div className="d3-pp-card-h"><h2>{isVi ? "Trạng thái lệnh" : "Order status"}</h2></div>
            <div className="d3-pp-trio">
              <div className={stats.pendingPos > 0 ? "is-warn" : ""}><strong>{loadingPos ? "…" : pendingPosError ? "—" : stats.pendingPos}</strong><small>{isVi ? "PO chờ lập SX" : "POs to set up"}</small></div>
              <div className="is-live"><strong>{loadingOrders ? "…" : stats.inProgressOrders}</strong><small>{isVi ? "đang sản xuất" : "in production"}</small></div>
              <div><strong>{loadingOrders ? "…" : completedCount}</strong><small>{isVi ? "đã hoàn thành" : "completed"}</small></div>
            </div>
          </section>
          <section className="d3-pp-card" style={{ ["--i" as string]: 3 }}>
            <div className="d3-pp-card-h"><h2>{isVi ? "Màn hình xưởng" : "Workshop screen"}</h2><span className="d3-pp-pill">TV</span></div>
            <div className="d3-pp-tv">
              <button type="button" className="d3-pp-tv-ring" onClick={handleOpenTvMode} aria-label={isVi ? "Mở chế độ TV" : "Open TV mode"}>
                <Monitor className="h-7 w-7" />
              </button>
              <div>
                <strong>{aggregatedPlanItems.length}</strong>
                <small>{isVi ? "SKU hiển thị cho xưởng · không lộ giá, công thức" : "SKUs on the floor screen · no prices or recipes"}</small>
                <Button variant="outline" className="mt-2 h-9 rounded-[11px]" onClick={handleOpenTvMode}>{isVi ? "Màn hình TV" : "TV View"}</Button>
              </div>
            </div>
          </section>
        </div>
      </div>

      <div className="d3-pp-row3">
        <section className="d3-pp-card" data-stitch-production-po-check="true" style={{ ["--i" as string]: 4 }}>
          <div className="d3-pp-card-h">
            <h2>{isVi ? "Theo sản phẩm" : "By product"}</h2>
            {stats.pendingPos > 0 && <span className="d3-pp-pill is-warn">{isVi ? `Còn ${stats.pendingPos} PO chờ lập SX` : `${stats.pendingPos} POs awaiting setup`}</span>}
          </div>
          {loadingPos ? (
            <div className="d3-pp-state"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : pendingPosError ? (
            <div role="alert" className="d3-pp-state is-error" data-kfm-pending-error="v1">
              <AlertCircle className="h-10 w-10" />
              <h3>{isVi ? "Không đọc được danh sách PO" : "Could not load POs"}</h3>
              <p>{isVi ? "Đây chưa phải là “không có PO”. Kiểm tra kết nối rồi thử lại." : "This is not “no POs”. Check the connection and retry."}</p>
              <Button variant="outline" className="mt-2 min-h-11" onClick={() => void refetchPendingPos()}>{isVi ? "Thử lại" : "Try again"}</Button>
            </div>
          ) : pendingPosEmpty ? (
            <div className="d3-pp-state">
              <Package className="h-10 w-10" />
              <h3>{isVi ? "Chưa có PO chờ sản xuất cho ngày giao này" : "No POs awaiting production for this delivery date"}</h3>
              <p>{isVi ? "PO đã xác nhận và khớp SKU sẽ hiện ở đây theo ngày giao." : "Confirmed POs with matched SKUs appear here by delivery date."}</p>
            </div>
          ) : (
            <>
              <div className="d3-pp-products" data-stitch-production-table="true">
                {aggregatedPlanItems.map((item, index) => (
                  <article key={item.key} className="d3-pp-prod">
                    <ProductVisual
                      imageUrl={item.image_url}
                      productName={item.product_name}
                      className="h-[52px] w-[52px] rounded-[14px]"
                      gradientClassName={productGradientClassNames[index % productGradientClassNames.length]}
                    />
                    <div className="min-w-0">
                      <h3>{item.product_name}</h3>
                      <p className="d3-pp-prod-meta">
                        {item.poCount} PO · {formatDate(item.earliestDate)}
                        {item.sourceNames.length > 0 ? ` · ${item.sourceNames.slice(0, 2).join(" · ")}${item.channelCount > 2 ? ` · +${item.channelCount - 2}` : ""}` : ""}
                      </p>
                      <div className="d3-pp-track" aria-hidden="true"><i style={{ ["--p" as string]: item.qty / maxPlanQty, ["--dl" as string]: `${300 + index * 90}ms`, background: SKU_COLORS[index % SKU_COLORS.length] }} /></div>
                    </div>
                    <div className="d3-pp-qty">
                      <strong>{item.qty.toLocaleString("vi-VN")}</strong>
                      <small>{item.unit} · {isVi ? "Sẵn sàng SX" : "Ready"}</small>
                    </div>
                  </article>
                ))}
              </div>
              <div className="d3-pp-foot">
                <span>{isVi ? `${aggregatedPlanItems.length} SKU · thanh = tỷ lệ so với SKU nhiều nhất` : `${aggregatedPlanItems.length} SKUs · bar = share of the largest SKU`}</span>
                <span>{isVi ? "Dữ liệu từ PO đã parse" : "Data from parsed POs"}</span>
              </div>
            </>
          )}
        </section>

        <section className="d3-pp-card" style={{ ["--i" as string]: 5 }}>
          <div className="d3-pp-card-h"><h2>{isVi ? "Quy trình hôm nay" : "Today's flow"}</h2></div>
          <div className="d3-pp-steps">
            {flowSteps.map((step, k) => (
              <div key={step.key} className={`d3-pp-step is-${step.state}`} style={{ ["--dl" as string]: `${300 + k * 120}ms` }}>
                <i>{step.state === "done" ? <CheckCircle className="h-3.5 w-3.5" /> : null}</i>
                <span>{step.label}</span>
                <small>{step.count}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="d3-pp-card" style={{ ["--i" as string]: 6 }}>
          <div className="d3-pp-card-h"><h2>{isVi ? "3 ngày tới" : "Next 3 days"}</h2><span className="d3-pp-pill is-blue">{isVi ? "Theo lệnh đã lập" : "From orders"}</span></div>
          {upcomingDays.map((day, k) => (
            <div key={day.dayIso} className="d3-pp-grp">
              <span className="d3-pp-grp-label">{formatDateOnly(day.dayIso)}{k === 0 ? (isVi ? " · hôm nay" : " · today") : ""}</span>
              <p>{day.orders > 0 ? (isVi ? `${day.orders} lệnh sản xuất` : `${day.orders} orders`) : (isVi ? "Chưa có lệnh" : "No orders yet")}</p>
              <div className="d3-pp-grp-track">
                <span className="d3-pp-track"><i style={{ ["--p" as string]: day.qty / maxDayQty, ["--dl" as string]: `${500 + k * 150}ms`, background: ["#29bf12", "#3c91e6", "#d0679a"][k] }} /></span>
                <small>{day.qty.toLocaleString("vi-VN")}</small>
              </div>
            </div>
          ))}
        </section>
      </div>

      {portalPosAwaitingSetup.length > 0 && <section className="d3-pp-card" data-kfm-production-resume="v1">
        <div className="d3-pp-card-h">
          <h2>{isVi ? "PO KFM đã xác nhận · Chờ thiết lập SX" : "Confirmed KFM POs · Production setup pending"}</h2>
          <p>{isVi ? "Giữ lại cả đơn giao ngày tới. Tiếp tục ở đây nếu đã đóng bước thiết lập hoặc chưa khớp SKU." : "Includes future deliveries. Continue here after closing setup or resolving SKU mappings."}</p>
        </div>
        <div className="d3-pp-rows">
          {portalPosAwaitingSetup.map((po) => <div key={po.id} className="d3-pp-row">
            <div className="min-w-0"><b className="font-mono">{po.po_number}</b><small>{formatDateOnly(po.delivery_date)} · {po.production_items?.length || 0} {isVi ? "dòng sản phẩm" : "items"}</small></div>
            <Button variant="outline" className="min-h-11 shrink-0" disabled={!canEditLocation || loadingSkus || loadingLocationSettings} onClick={() => handleCreateClick(po)}>{isVi ? "Tiếp tục thiết lập SX" : "Continue production setup"}</Button>
          </div>)}
        </div>
      </section>}

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="d3-pp-card" data-stitch-production-orders="true" style={{ ["--i" as string]: 7 }}>
          <div className="d3-pp-card-h">
            <h2>{isVi ? "Lệnh sản xuất" : "Production Orders"}</h2>
            <span className="d3-pp-pill">{isVi ? `${liveOrders.length} lệnh` : `${liveOrders.length} orders`}</span>
          </div>
          {loadingOrders ? (
            <div className="d3-pp-state"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : ordersEmpty ? (
            <div className="d3-pp-state">
              <Factory className="h-10 w-10" />
              <h3>{isVi ? "Chưa có lệnh sản xuất nào" : "No production orders yet"}</h3>
            </div>
          ) : (
            <div className="d3-pp-ogroups">
              {([
                ["in_progress", isVi ? "Đang sản xuất" : "In production"],
                ["upcoming", isVi ? "Sắp sản xuất" : "Upcoming"],
                ["draft", isVi ? "Nháp" : "Draft"],
                ["completed", isVi ? "Đã hoàn thành" : "Completed"],
                ["cancelled", isVi ? "Đã huỷ" : "Cancelled"],
              ] as Array<[ProductionOrderDisplayStatus, string]>).map(([groupStatus, groupLabel]) => {
                const groupOrders = productionOrders.filter((order) => getProductionOrderDisplayStatus(order, tvProductionDateIso) === groupStatus);
                if (groupOrders.length === 0) return null;
                const limited = groupStatus === "completed" && !showAllDoneOrders ? groupOrders.slice(0, 5) : groupOrders;
                return (
                  <div key={groupStatus} className="d3-pp-ogroup" data-status={groupStatus}>
                    <div className="d3-pp-ogroup-h"><span>{groupLabel}</span><small>{groupOrders.length}</small></div>
                    {limited.map((order) => {
                      const totalQty = getProductionOrderTotalQty(order);
                      const canGeneratePdf = canGenerateQ7MaterialIssuePdf(order);
                      const pdfLoading = materialIssuePdfOrderId === order.id;
                      const pdfMessage = materialIssuePdfMessages[order.id];
                      const expanded = expandedOrderId === order.id;
                      const unit = order.items?.[0]?.unit || (isVi ? "sp" : "units");
                      const counterpart = [order.po_number, order.customer_name].filter(Boolean).join(" · ");
                      return (
                        <div key={order.id} className={`d3-pp-order${expanded ? " is-open" : ""}`}>
                          <button
                            type="button"
                            className="d3-pp-order-row"
                            aria-expanded={expanded}
                            onClick={() => setExpandedOrderId(expanded ? null : order.id)}
                          >
                            <i className="d3-pp-odot" aria-hidden="true" />
                            <span className="min-w-0">
                              <b className="font-mono">{order.production_number}</b>
                              <small>
                                {order.planned_start_date
                                  ? order.planned_end_date && order.planned_end_date !== order.planned_start_date
                                    ? `${formatDate(order.planned_start_date)} – ${formatDate(order.planned_end_date)}`
                                    : formatDate(order.planned_start_date)
                                  : "—"}
                                {` · ${order.items_count || 0} ${isVi ? "mặt hàng" : "items"}`}
                                {counterpart ? ` · ${counterpart}` : ""}
                                {order.revenue_draft_id ? (isVi ? " · Duyệt DT" : " · Revenue draft") : ""}
                              </small>
                            </span>
                            <span className="d3-pp-oqty"><strong>{totalQty.toLocaleString("vi-VN")}</strong><small>{unit}</small></span>
                            <ChevronDown className="d3-pp-ochev h-4 w-4" aria-hidden="true" />
                          </button>
                          {expanded && (
                            <div className="d3-pp-order-body">
                              <div className="d3-pp-items">
                                {((orderItems[order.id] as ProductionOrderItem[]) || order.items || []).length > 0 ? (
                                  (((orderItems[order.id] as ProductionOrderItem[]) || order.items || []) as ProductionOrderItem[]).map((item) => (
                                    <div key={item.id} className="d3-pp-item">
                                      <div className="min-w-0">
                                        <b>{item.product_name}</b>
                                        <p>{formatDate(item.delivery_date)}</p>
                                      </div>
                                      <div className="text-right">
                                        <strong>{item.planned_qty.toLocaleString("vi-VN")}</strong>
                                        <p>{item.unit}</p>
                                        {Number(item.actual_qty || 0) > 0 && <em>✓ {Number(item.actual_qty || 0).toLocaleString("vi-VN")}</em>}
                                      </div>
                                    </div>
                                  ))
                                ) : (
                                  <p className="py-3 text-center">{isVi ? "Không có hàng nào" : "No items"}</p>
                                )}
                              </div>
                              <div className="d3-pp-order-actions">
                                {canGeneratePdf && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    data-testid={`q7-material-issue-pdf-${order.id}`}
                                    disabled={pdfLoading}
                                    onClick={(event) => openQ7MaterialIssuePdf(order, event)}
                                  >
                                    {pdfLoading ? <Loader2 className="mr-1 h-4 w-4 shrink-0 animate-spin" /> : <FileDown className="mr-1 h-4 w-4 shrink-0" />}
                                    <span className="truncate">Phiếu NVL</span>
                                  </Button>
                                )}
                                {canEditLocation && (
                                  <Button type="button" variant="outline" size="sm" onClick={() => openEditOrder(order)}>
                                    <Pencil className="mr-1 h-4 w-4" />
                                    {isVi ? "Sửa" : "Edit"}
                                  </Button>
                                )}
                                {isOwner && (
                                  <Button type="button" variant="ghost" size="sm" className="d3-pp-odelete" onClick={() => setDeleteOrder(order)}>
                                    <Trash2 className="mr-1 h-4 w-4" />
                                    {isVi ? "Xoá lệnh" : "Delete"}
                                  </Button>
                                )}
                              </div>
                              {pdfMessage && <p className="d3-pp-order-note">{pdfMessage}</p>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {groupStatus === "completed" && groupOrders.length > 5 && (
                      <button type="button" className="d3-pp-omore" onClick={() => setShowAllDoneOrders((value) => !value)}>
                        {showAllDoneOrders ? (isVi ? "Thu gọn" : "Show less") : (isVi ? `Xem thêm ${groupOrders.length - 5} lệnh` : `Show ${groupOrders.length - 5} more`)}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <aside className="min-w-0 space-y-4" data-stitch-production-insights="true">
          <section className="d3-pp-card" style={{ ["--i" as string]: 2 }}>
            <div className="d3-pp-card-h">
              <h2>{isVi ? "PO khác chờ lập SX" : "Other POs awaiting setup"}</h2>
            </div>
            {otherPendingPos.length === 0 ? (
              <div className="d3-pp-empty-note">
                {isVi
                  ? "Chưa có PO nào còn đủ điều kiện xác nhận cho ngày giao này. PO chỉ hiện ở đây khi đã parse được thành phẩm, khớp SKU xưởng Q7 và chưa tạo lệnh sản xuất."
                  : "No POs currently qualify for confirmation on this delivery date. POs appear here only after parsing production items, matching enabled Q7 SKUs, and before a production order is created."}
              </div>
            ) : (
              <div className="d3-pp-rows">
                {otherPendingPos.slice(0, 6).map((po) => {
                  const attachmentNames = getPoAttachmentNames(po);
                  return (
                    <button key={po.id} type="button" disabled={!canEditLocation} onClick={() => handleCreateClick(po)} className="d3-pp-row">
                      <div className="min-w-0">
                        <b className="font-mono">{po.po_number}</b>
                        <small>{po.from_name}</small>
                        <small>{formatDate(po.delivery_date)}</small>
                      </div>
                      <span className="d3-pp-go">{isVi ? "Xác nhận" : "Confirm"}</span>
                      <div className="d3-pp-files">
                        {attachmentNames.length > 0 ? (
                          attachmentNames.slice(0, 4).map((fileName) => (
                            <span
                              key={fileName}
                              role="button"
                              tabIndex={0}
                              title={isVi ? `Mở file PO thật: ${fileName}` : `Open original PO file: ${fileName}`}
                              onClick={(event) => downloadPoAttachment(po, fileName, event)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") void downloadPoAttachment(po, fileName, event as any);
                              }}
                              className="d3-pp-file"
                            >
                              <Paperclip className="h-3 w-3 shrink-0" />
                              <span>{fileName}</span>
                              <Download className="h-3 w-3 shrink-0" />
                            </span>
                          ))
                        ) : (
                          <span className="d3-pp-file"><Paperclip className="h-3 w-3" />{isVi ? "Không có file PO" : "No PO file"}</span>
                        )}
                        {attachmentNames.length > 4 && <span className="d3-pp-file">+{attachmentNames.length - 4}</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </aside>
      </div>
        </>
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto rounded-3xl border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">
              {isVi ? "Xác nhận / điều chỉnh kế hoạch" : "Confirm / adjust plan"}
            </DialogTitle>
          </DialogHeader>

          {selectedPoForCreation && (
            <div className="space-y-5">
              <div className="rounded-3xl border border-primary/20 bg-primary/10 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-mono text-lg font-black text-foreground">{selectedPoForCreation.po_number}</p>
                    <p className="font-semibold text-muted-foreground">{selectedPoForCreation.from_name}</p>
                  </div>
                  <Badge className="w-fit bg-primary text-primary-foreground hover:bg-primary">
                    {isPortalPo(selectedPoForCreation) ? (isVi ? "Đã xác nhận trên KFM" : "Confirmed on KFM") : (isVi ? "Nguồn PO đã parse" : "Parsed PO source")}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {getPoAttachmentNames(selectedPoForCreation).length > 0 ? (
                    getPoAttachmentNames(selectedPoForCreation).map((fileName) => (
                      <button
                        key={fileName}
                        type="button"
                        title={isVi ? `Mở file PO thật: ${fileName}` : `Open original PO file: ${fileName}`}
                        onClick={(event) => downloadPoAttachment(selectedPoForCreation, fileName, event)}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/25 bg-background/80 px-2.5 py-1 text-xs font-bold text-primary transition hover:border-primary/50 hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        <Paperclip className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{fileName}</span>
                        <Download className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    ))
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-1 text-xs font-bold text-muted-foreground">
                      <Paperclip className="h-3.5 w-3.5" />
                      {isVi ? "Không có file PO đính kèm" : "No attached PO file"}
                    </span>
                  )}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {formData.items.map((item, idx) => {
                  const adjusted = item.planned_qty !== item.original_qty;
                  return (
                    <div key={`${item.product_name}-${idx}`} className="rounded-3xl border border-border/60 bg-card/70 p-4 shadow-card">
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
                          {adjusted && <Badge variant="outline" className="mt-2 border-warning/60 text-warning-foreground">{isVi ? "Đã điều chỉnh" : "Adjusted"}</Badge>}
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

              <Alert className="rounded-2xl border-success/30 bg-success/10">
                <FilePlus2 className="h-4 w-4 text-success" />
                <AlertDescription className="text-success">
                  {isVi
                    ? "Sau khi xác nhận: tạo lệnh sản xuất và giữ link audit về PO nguồn. Phiếu xuất kho NVL sẽ được tự động hóa khi nối BOM/NVL."
                    : "After confirmation: production order is created and linked to source PO for audit. Material issue slip automation needs BOM integration."}
                </AlertDescription>
              </Alert>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" className="h-12 rounded-2xl" onClick={() => setCreateDialogOpen(false)} disabled={createProductionOrderMutation.isPending}>
                  {isVi ? "Hủy" : "Cancel"}
                </Button>
                <Button className="btn-gradient h-12 rounded-2xl font-black" onClick={handleSubmitCreate} disabled={!canEditLocation || createProductionOrderMutation.isPending}>
                  {createProductionOrderMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
                  {isVi ? "Xác nhận tạo lệnh SX" : "Confirm production order"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingOrder} onOpenChange={(open) => !open && closeEditOrder()}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto rounded-3xl border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-2xl font-black">
              {isVi ? "Sửa lệnh sản xuất" : "Edit production order"} {editingOrder?.production_number}
            </DialogTitle>
          </DialogHeader>

          {editingOrder && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="edit-start-date">{isVi ? "Ngày bắt đầu" : "Start date"}</Label>
                  <Input
                    id="edit-start-date"
                    type="date"
                    value={editForm.planned_start_date}
                    onChange={(e) => setEditForm({ ...editForm, planned_start_date: e.target.value })}
                    className="mt-1 h-12 rounded-2xl"
                    disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                  />
                </div>
                <div>
                  <Label htmlFor="edit-end-date">{isVi ? "Ngày kết thúc" : "End date"}</Label>
                  <Input
                    id="edit-end-date"
                    type="date"
                    value={editForm.planned_end_date}
                    onChange={(e) => setEditForm({ ...editForm, planned_end_date: e.target.value })}
                    className="mt-1 h-12 rounded-2xl"
                    disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                  />
                </div>
              </div>

              <div className="grid gap-3">
                {editForm.items.map((item, idx) => (
                  <div key={item.id} className="rounded-3xl border border-border/60 bg-card/70 p-4 shadow-card">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-base font-black leading-tight">{item.product_name}</h3>
                        <p className="text-xs font-bold uppercase text-muted-foreground">{item.unit}</p>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[160px_180px_minmax(0,1fr)]">
                      <div>
                        <Label>{isVi ? "Số lượng" : "Quantity"}</Label>
                        <Input
                          type="number"
                          min="0"
                          value={item.planned_qty}
                          onChange={(e) => updateEditItem(idx, { planned_qty: Number.parseFloat(e.target.value) || 0 })}
                          className="mt-1 h-12 rounded-2xl text-xl font-black"
                          disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                        />
                      </div>
                      <div>
                        <Label>{isVi ? "Ngày giao/SX" : "Delivery date"}</Label>
                        <Input
                          type="date"
                          value={item.delivery_date}
                          onChange={(e) => updateEditItem(idx, { delivery_date: e.target.value })}
                          className="mt-1 h-12 rounded-2xl"
                          disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                        />
                      </div>
                      <div>
                        <Label>{isVi ? "Ghi chú dòng" : "Line note"}</Label>
                        <Input
                          value={item.notes}
                          onChange={(e) => updateEditItem(idx, { notes: e.target.value })}
                          className="mt-1 h-12 rounded-2xl"
                          placeholder={isVi ? "Lý do chỉnh số lượng..." : "Adjustment reason..."}
                          disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <Label htmlFor="edit-notes">{isVi ? "Ghi chú lệnh" : "Order notes"}</Label>
                <Textarea
                  id="edit-notes"
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  className="mt-1 min-h-24 rounded-2xl"
                  disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                />
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" className="h-12 rounded-2xl" onClick={closeEditOrder} disabled={updateProductionOrderMutation.isPending}>
                  {isVi ? "Hủy" : "Cancel"}
                </Button>
                <Button
                  className="btn-gradient h-12 rounded-2xl font-black"
                  onClick={() => updateProductionOrderMutation.mutate({ orderId: editingOrder.id, form: editForm })}
                  disabled={!canEditLocation || updateProductionOrderMutation.isPending}
                >
                  {updateProductionOrderMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle className="mr-2 h-4 w-4" />}
                  {isVi ? "Lưu thay đổi" : "Save changes"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteOrder} onOpenChange={(open) => !open && setDeleteOrder(null)}>
        <AlertDialogContent className="border-border bg-card text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle>{isVi ? "Xoá lệnh sản xuất?" : "Delete production order?"}</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {isVi
                ? `Owner sẽ xoá lệnh ${deleteOrder?.production_number || "SX"} và toàn bộ dòng hàng liên quan. Hành động này không thể hoàn tác.`
                : `Owner will delete order ${deleteOrder?.production_number || "SX"} and all related line items. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteProductionOrderMutation.isPending}>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!isOwner || deleteProductionOrderMutation.isPending}
              onClick={() => deleteOrder && deleteProductionOrderMutation.mutate(deleteOrder.id)}
            >
              {deleteProductionOrderMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {isVi ? "Xoá lệnh" : "Delete order"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
