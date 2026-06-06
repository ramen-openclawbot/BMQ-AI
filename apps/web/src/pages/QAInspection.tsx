import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle,
  CalendarDays,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  Factory,
  Image as ImageIcon,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { evaluateLabelScan, expectedLabelDates, formatDateKeyVi, ProductLabelSpec, ExtractedProductLabelData, BarcodeBoundingBox } from "@/lib/product-label-control";

const QA_PHOTO_BUCKET = "sku-images";

type QueryResult<T = unknown> = { data: T | null; error: { message?: string } | null };
type MutationPayload = Record<string, unknown>;

type SupabaseQueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select(columns?: string): SupabaseQueryBuilder<T>;
  insert(values: MutationPayload | MutationPayload[]): SupabaseQueryBuilder<T>;
  update(values: MutationPayload): SupabaseQueryBuilder<T>;
  eq(column: string, value: unknown): SupabaseQueryBuilder<T>;
  in(column: string, values: unknown[]): SupabaseQueryBuilder<T>;
  gte(column: string, value: unknown): SupabaseQueryBuilder<T>;
  lt(column: string, value: unknown): SupabaseQueryBuilder<T>;
  ilike(column: string, pattern: string): SupabaseQueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
  limit(count: number): SupabaseQueryBuilder<T>;
  single(): SupabaseQueryBuilder<T>;
  maybeSingle(): SupabaseQueryBuilder<T>;
};

type SupabaseLoose = {
  from<T = unknown>(table: string): SupabaseQueryBuilder<T>;
  rpc<T = unknown>(fn: string, args?: MutationPayload): PromiseLike<QueryResult<T>>;
  storage: {
    from(bucket: string): {
      upload(path: string, file: Blob | File, options?: Record<string, unknown>): PromiseLike<QueryResult<unknown>>;
      getPublicUrl(path: string): { data: { publicUrl: string } };
    };
  };
};

const db = supabase as unknown as SupabaseLoose;

type QaStatus = "pending" | "approved" | "rejected";
type ProductionStatus = "draft" | "planned" | "in_progress" | "completed" | "cancelled" | string;

interface QAInspection {
  id: string;
  inspection_number?: string | null;
  production_order_id: string | null;
  production_shift_id?: string | null;
  inspected_by?: string | null;
  inspected_at?: string | null;
  inspection_date?: string | null;
  status: QaStatus;
  notes?: string | null;
  rejection_reason?: string | null;
  product_photos?: string[] | null;
  created_at: string;
  production_order?: {
    production_number: string;
    status?: ProductionStatus | null;
    planned_start_date?: string | null;
    planned_end_date?: string | null;
  } | null;
}

interface QAInspectionItem {
  id: string;
  qa_inspection_id: string;
  sku_id?: string | null;
  product_name: string;
  unit: string;
  inspected_qty: number;
  approved_qty: number;
  rejected_qty: number;
}

interface ProductionOrderItem {
  id: string;
  sku_id?: string | null;
  product_name: string;
  planned_qty?: number | null;
  ordered_qty?: number | null;
  actual_qty?: number | null;
  unit: string;
  delivery_date?: string | null;
}

interface ProductionOrder {
  id: string;
  production_number: string;
  status: ProductionStatus;
  planned_start_date?: string | null;
  planned_end_date?: string | null;
  created_at?: string | null;
  notes?: string | null;
  production_order_items?: ProductionOrderItem[] | null;
}

interface QaFormItem {
  id?: string;
  sku_id?: string | null;
  product_name: string;
  unit: string;
  planned_qty: number;
  inspected_qty: number;
  approved_qty: number;
}

interface LabelCheckState {
  status: "pending" | "passed" | "failed";
  reason: string;
  image_url?: string | null;
  extracted_barcode_crop_image_url?: string | null;
  extracted_barcode_bbox?: BarcodeBoundingBox | null;
  extracted?: ExtractedProductLabelData | null;
}

const vnTodayIso = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const numberValue = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const safeDate = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const displayDateTime = (value?: string | null) => {
  const date = safeDate(value);
  return date ? format(date, "dd/MM/yyyy HH:mm") : "-";
};

const displayDate = (value?: string | null) => {
  const date = safeDate(value);
  return date ? format(date, "dd/MM/yyyy") : "-";
};

const displayDateKey = (value?: string | null) => {
  if (!value) return "-";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return displayDate(value);
  return `${match[3]}/${match[2]}/${match[1]}`;
};

const vnDateKey = (value?: string | null) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = safeDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const orderMatchesDate = (order: ProductionOrder, selectedDate: string) => {
  const orderDates = [order.planned_start_date, order.planned_end_date, order.created_at];
  if (orderDates.some((value) => vnDateKey(value) === selectedDate)) return true;
  return (order.production_order_items || []).some((item) => vnDateKey(item.delivery_date) === selectedDate);
};

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error || ""));

const slugPart = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "qa";

const cropImageByBox = async (file: File, box?: BarcodeBoundingBox | null) => {
  if (!box) return null;
  const imageUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = imageUrl;
    });
    const canvas = document.createElement("canvas");
    const sourceX = Math.max(0, Math.round(box.x * image.naturalWidth));
    const sourceY = Math.max(0, Math.round(box.y * image.naturalHeight));
    const sourceWidth = Math.min(image.naturalWidth - sourceX, Math.round(box.width * image.naturalWidth));
    const sourceHeight = Math.min(image.naturalHeight - sourceY, Math.round(box.height * image.naturalHeight));
    canvas.width = Math.max(1, sourceWidth);
    canvas.height = Math.max(1, sourceHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
};

const buildAuditNotes = (formNotes: string, checklist: Record<"quality" | "sensory" | "packaging", boolean>) => {
  const lines = [
    "[QA_CHECKLIST]",
    `Chất lượng: ${checklist.quality ? "PASS" : "FAIL"}`,
    `Cảm quan: ${checklist.sensory ? "PASS" : "FAIL"}`,
    `Bao bì: ${checklist.packaging ? "PASS" : "FAIL"}`,
    "[/QA_CHECKLIST]",
  ];
  if (formNotes.trim()) lines.push("", formNotes.trim());
  return lines.join("\n");
};

const checklistFromNotes = (notes?: string | null) => ({
  quality: /Chất lượng:\s*PASS/i.test(notes || ""),
  sensory: /Cảm quan:\s*PASS/i.test(notes || ""),
  packaging: /Bao bì:\s*PASS/i.test(notes || ""),
});

export default function QAInspection() {
  const { language } = useLanguage();
  const { profile, user } = useAuth();
  const isVi = language === "vi";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const labelFileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedDate, setSelectedDate] = useState(vnTodayIso());
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [inspectedBy, setInspectedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [checklist, setChecklist] = useState({ quality: true, sensory: true, packaging: true });
  const [qaFiles, setQaFiles] = useState<File[]>([]);
  const [formItems, setFormItems] = useState<QaFormItem[]>([]);
  const [qaDialogOpen, setQaDialogOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState<QAInspection | null>(null);
  const [selectedItems, setSelectedItems] = useState<QAInspectionItem[]>([]);
  const [labelChecks, setLabelChecks] = useState<Record<string, LabelCheckState>>({});
  const [pendingLabelIndex, setPendingLabelIndex] = useState<number | null>(null);
  const [scanningLabel, setScanningLabel] = useState(false);

  const loggedInInspectorName = useMemo(() => {
    const fullName = profile?.full_name?.trim();
    if (fullName) return fullName;
    const metadataName = String(user?.user_metadata?.full_name || user?.user_metadata?.name || "").trim();
    if (metadataName) return metadataName;
    return user?.email?.split("@")[0] || "";
  }, [profile?.full_name, user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name]);

  useEffect(() => {
    if (!inspectedBy.trim() && loggedInInspectorName) {
      setInspectedBy(loggedInInspectorName);
    }
  }, [inspectedBy, loggedInInspectorName]);

  const copy = {
    title: isVi ? "QA & nhập kho thành phẩm Q7" : "Q7 QA & finished goods receiving",
    subtitle: isVi
      ? "Gắn QA với lệnh sản xuất, chụp ảnh bằng chứng, xác nhận chất lượng/cảm quan/bao bì rồi nhập kho thành phẩm."
      : "Tie QA to production orders, capture photo evidence, check quality/sensory/packaging, then receive finished goods.",
    orderQueue: isVi ? "Lệnh SX chờ QA" : "Production orders waiting for QA",
    qaPass: isVi ? "QA pass & nhập kho" : "QA pass & receive stock",
    uploadPhotos: isVi ? "Upload nhiều ảnh QA" : "Upload QA photos",
    auditToday: isVi ? "Audit QA theo ngày" : "Daily QA audit",
    noOrders: isVi ? "Chưa có lệnh sản xuất phù hợp để QA." : "No suitable production orders found for QA.",
    noAudits: isVi ? "Chưa có phiếu QA trong ngày này." : "No QA records for this day.",
  };

  const { data: productionOrders = [], isLoading: ordersLoading, refetch: refetchOrders } = useQuery<ProductionOrder[]>({
    queryKey: ["qa_production_orders_q7"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ProductionOrder[]>("production_orders")
        .select(
          `
          id,production_number,status,planned_start_date,planned_end_date,created_at,notes,
          production_order_items(id,sku_id,product_name,planned_qty,ordered_qty,actual_qty,unit,delivery_date)
        `
        )
        .in("status", ["draft", "planned", "in_progress", "completed"])
        .order("planned_start_date", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(60);

      if (error) throw error;
      return data || [];
    },
  });

  const { data: labelSpecs = [] } = useQuery<ProductLabelSpec[]>({
    queryKey: ["qa_product_label_specs"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ProductLabelSpec[]>("product_label_specs")
        .select("id,sku_id,sku_code,product_name,barcode_value,partner_product_code,label_template_image_url,barcode_crop_image_url,barcode_crop_bbox,barcode_crop_confidence,shelf_life_days,net_weight_value,net_weight_unit,traceability_sheet_url,is_label_scan_required");
      if (error) throw error;
      return data || [];
    },
  });

  const labelSpecBySku = useMemo(() => new Map(labelSpecs.map((spec) => [spec.sku_id, spec])), [labelSpecs]);

  const { data: inspections = [], isLoading: inspectionsLoading } = useQuery<QAInspection[]>({
    queryKey: ["qa_inspections_by_day", selectedDate],
    queryFn: async () => {
      const start = `${selectedDate}T00:00:00+07:00`;
      const endDate = new Date(`${selectedDate}T00:00:00+07:00`);
      endDate.setDate(endDate.getDate() + 1);
      const end = endDate.toISOString();

      const { data, error } = await db
        .from<QAInspection[]>("qa_inspections")
        .select(
          `
          *,
          production_order:production_orders(production_number,status,planned_start_date,planned_end_date)
        `
        )
        .gte("inspected_at", start)
        .lt("inspected_at", end)
        .order("inspected_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  const productionOrderIds = useMemo(() => productionOrders.map((order) => order.id), [productionOrders]);

  const { data: orderQaInspections = [] } = useQuery<QAInspection[]>({
    queryKey: ["qa_inspections_for_order_status", productionOrderIds.join(",")],
    queryFn: async () => {
      if (productionOrderIds.length === 0) return [];
      const { data, error } = await db
        .from<QAInspection[]>("qa_inspections")
        .select("id,production_order_id,status,inspected_at")
        .in("production_order_id", productionOrderIds)
        .eq("status", "approved");
      if (error) throw error;
      return data || [];
    },
  });

  const filteredProductionOrders = useMemo(
    () => productionOrders.filter((order) => orderMatchesDate(order, selectedDate)),
    [productionOrders, selectedDate]
  );

  const selectedOrder = useMemo(
    () => productionOrders.find((order) => order.id === selectedOrderId) || null,
    [productionOrders, selectedOrderId]
  );

  const orderHasQa = useMemo(() => {
    const approvedOrderIds = new Set(
      orderQaInspections.map((inspection) => inspection.production_order_id).filter(Boolean)
    );
    return (orderId: string) => approvedOrderIds.has(orderId);
  }, [orderQaInspections]);

  const stats = useMemo(() => {
    const passed = inspections.filter((inspection) => inspection.status === "approved").length;
    const photos = inspections.reduce((sum, inspection) => sum + (inspection.product_photos?.length || 0), 0);
    const items = formItems.reduce((sum, item) => sum + numberValue(item.approved_qty), 0);
    return { passed, photos, items };
  }, [formItems, inspections]);

  const allLabelChecksPassed = useMemo(() => {
    return formItems.every((item, index) => {
      const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;
      if (spec?.is_label_scan_required === false) return true;
      const key = item.id || String(index);
      return labelChecks[key]?.status === "passed";
    });
  }, [formItems, labelChecks, labelSpecBySku]);

  const handleSelectOrder = (orderId: string) => {
    setSelectedOrderId(orderId);
    setInspectedBy(loggedInInspectorName);
    setNotes("");
    setChecklist({ quality: true, sensory: true, packaging: true });
    setQaFiles([]);
    const order = productionOrders.find((entry) => entry.id === orderId);
    const items = (order?.production_order_items || []).map((item) => {
      const plannedQty = numberValue(item.planned_qty || item.ordered_qty || item.actual_qty);
      return {
        id: item.id,
        sku_id: item.sku_id,
        product_name: item.product_name,
        unit: item.unit || "cái",
        planned_qty: plannedQty,
        inspected_qty: plannedQty,
        approved_qty: plannedQty,
      };
    });
    setFormItems(items);
    setLabelChecks({});
    setQaDialogOpen(true);
  };

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    setQaFiles((current) => [...current, ...files].slice(0, 12));
    event.target.value = "";
  };

  const openLabelScanner = (index: number) => {
    setPendingLabelIndex(index);
    labelFileInputRef.current?.click();
  };

  const handleLabelFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || pendingLabelIndex == null) return;
    const item = formItems[pendingLabelIndex];
    if (!item) return;
    const itemKey = item.id || String(pendingLabelIndex);
    const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;
    setScanningLabel(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `qa-labels/${selectedDate}/${slugPart(item.product_name)}-${Date.now()}.${ext}`;
      const { error: uploadError } = await (db).storage.from(QA_PHOTO_BUCKET).upload(path, file, {
        upsert: false,
        contentType: file.type || "image/jpeg",
      });
      if (uploadError) throw uploadError;
      const imageUrl = (db).storage.from(QA_PHOTO_BUCKET).getPublicUrl(path).data?.publicUrl;
      const { data, error } = await (supabase as unknown as { functions: { invoke<T>(name: string, options: { body: unknown }): Promise<{ data: T | null; error: Error | null }> } }).functions.invoke<{ data: ExtractedProductLabelData }>("scan-product-label", {
        body: { image_url: imageUrl, sku_code: spec?.sku_code, product_name: item.product_name, barcode_value: spec?.barcode_value, partner_product_code: spec?.partner_product_code, detect_barcode_bbox: true },
      });
      if (error) throw error;
      const extracted = data?.data || null;
      let extractedBarcodeCropUrl: string | null = null;
      const extractedBarcodeBlob = await cropImageByBox(file, extracted?.barcode_bbox || null);
      if (extractedBarcodeBlob) {
        const cropPath = `qa-labels/${selectedDate}/${slugPart(item.product_name)}-${Date.now()}-barcode-crop.jpg`;
        const { error: cropUploadError } = await (db).storage.from(QA_PHOTO_BUCKET).upload(cropPath, extractedBarcodeBlob, {
          upsert: false,
          contentType: "image/jpeg",
        });
        if (!cropUploadError) {
          extractedBarcodeCropUrl = (db).storage.from(QA_PHOTO_BUCKET).getPublicUrl(cropPath).data?.publicUrl || null;
        }
      }
      if (extracted) extracted.barcode_crop_image_url = extractedBarcodeCropUrl;
      const result = evaluateLabelScan({ spec, productionDateKey: selectedDate, extracted });
      setLabelChecks((current) => ({
        ...current,
        [itemKey]: { status: result.passed ? "passed" : "failed", reason: result.reason, image_url: imageUrl, extracted_barcode_crop_image_url: extractedBarcodeCropUrl, extracted_barcode_bbox: extracted?.barcode_bbox || null, extracted },
      }));
    } catch (error) {
      setLabelChecks((current) => ({
        ...current,
        [itemKey]: { status: "failed", reason: getErrorMessage(error), image_url: null, extracted: null },
      }));
    } finally {
      setScanningLabel(false);
      setPendingLabelIndex(null);
    }
  };

  const updateFormItem = (index: number, key: "inspected_qty" | "approved_qty", value: string) => {
    const qty = Math.max(0, numberValue(value));
    setFormItems((current) => current.map((item, idx) => (idx === index ? { ...item, [key]: qty } : item)));
  };

  const generateInspectionNumber = async () => {
    const refDate = vnTodayIso();
    try {
      const { data, error } = await db.rpc<string>("generate_doc_number", { prefix: "QA", ref_date: refDate });
      if (!error && data) return String(data);
    } catch (error) {
      console.warn("generate_doc_number unavailable", error);
    }
    const datePart = format(new Date(), "yyyyMMdd");
    const { data } = await db
      .from<Array<{ inspection_number: string | null }>>("qa_inspections")
      .select("inspection_number")
      .ilike("inspection_number", `QA-${datePart}-%`);
    const next = String((data?.length || 0) + 1).padStart(3, "0");
    return `QA-${datePart}-${next}`;
  };

  const uploadQaPhotos = async (inspectionNumber: string) => {
    const urls: string[] = [];
    for (const [index, file] of qaFiles.entries()) {
      const ext = file.name.split(".").pop()?.toLowerCase() || file.type.split("/").pop() || "jpg";
      const path = `qa-inspections/${format(new Date(), "yyyyMMdd")}/${slugPart(inspectionNumber)}/${Date.now()}-${index}.${ext}`;
      const { error } = await (db).storage.from(QA_PHOTO_BUCKET).upload(path, file, {
        upsert: false,
        contentType: file.type || "image/jpeg",
      });
      if (error) throw error;
      const publicUrl = (db).storage.from(QA_PHOTO_BUCKET).getPublicUrl(path).data?.publicUrl;
      if (publicUrl) urls.push(publicUrl);
    }
    return urls;
  };

  const qaPassMutation = useMutation({
    mutationFn: async () => {
      if (!selectedOrder) throw new Error(isVi ? "Chọn lệnh sản xuất trước." : "Select a production order first.");
      if (!inspectedBy.trim()) throw new Error(isVi ? "Nhập người QA trước." : "Enter inspector name first.");
      if (!checklist.quality || !checklist.sensory || !checklist.packaging) {
        throw new Error(isVi ? "Cần pass đủ chất lượng, cảm quan và bao bì." : "Quality, sensory, and packaging must all pass.");
      }
      if (qaFiles.length === 0) throw new Error(isVi ? "Cần upload ít nhất 1 ảnh QA." : "Upload at least one QA photo.");
      if (formItems.length === 0) throw new Error(isVi ? "Lệnh SX chưa có dòng sản phẩm để QA." : "The order has no items to inspect.");
      const requiredLabelFailures = formItems.filter((item, index) => {
        const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;
        if (spec?.is_label_scan_required === false) return false;
        const key = item.id || String(index);
        return labelChecks[key]?.status !== "passed";
      });
      if (requiredLabelFailures.length > 0) {
        throw new Error(isVi ? "Không cho nhập kho: cần quét và pass tem nhãn cho mọi SKU." : "Receiving blocked: every SKU label must be scanned and passed.");
      }

      const inspectionNumber = await generateInspectionNumber();
      const photoUrls = await uploadQaPhotos(inspectionNumber);
      const nowIso = new Date().toISOString();
      const auditNotes = buildAuditNotes(notes, checklist);

      const { data: inspection, error: inspectionError } = await db
        .from<QAInspection>("qa_inspections")
        .insert({
          inspection_number: inspectionNumber,
          production_order_id: selectedOrder.id,
          status: "approved",
          inspected_by: inspectedBy.trim(),
          inspected_at: nowIso,
          product_photos: photoUrls,
          notes: auditNotes,
        })
        .select()
        .single();
      if (inspectionError) throw inspectionError;

      const itemsToInsert = formItems.map((item) => ({
        qa_inspection_id: inspection.id,
        sku_id: item.sku_id || null,
        product_name: item.product_name,
        unit: item.unit || "cái",
        inspected_qty: item.inspected_qty,
        approved_qty: item.approved_qty,
        rejected_qty: Math.max(0, item.inspected_qty - item.approved_qty),
        notes: "QA pass từ lệnh sản xuất Q7",
      }));
      const { error: itemsError } = await (db).from("qa_inspection_items").insert(itemsToInsert);
      if (itemsError) throw itemsError;

      const labelRows = formItems.map((item, index) => {
        const key = item.id || String(index);
        const check = labelChecks[key];
        const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;
        const dates = expectedLabelDates(selectedDate, spec?.shelf_life_days || 1);
        return {
          qa_inspection_id: inspection.id,
          production_order_id: selectedOrder.id,
          production_order_item_id: item.id || null,
          sku_id: item.sku_id || null,
          product_label_spec_id: spec?.id || null,
          expected_barcode: spec?.barcode_value || null,
          expected_partner_product_code: spec?.partner_product_code || null,
          expected_manufacturing_date: dates.expectedNsx,
          expected_expiry_date: dates.expectedHsd,
          extracted_barcode: check?.extracted?.barcode || null,
          extracted_partner_product_code: check?.extracted?.partner_product_code || check?.extracted?.product_code || null,
          extracted_manufacturing_date: check?.extracted?.manufacturing_date || null,
          extracted_expiry_date: check?.extracted?.expiry_date || null,
          extracted_product_code: check?.extracted?.product_code || null,
          extracted_product_name: check?.extracted?.product_name || null,
          extracted_net_weight_value: check?.extracted?.net_weight_value ?? null,
          extracted_net_weight_unit: check?.extracted?.net_weight_unit || null,
          raw_ocr_text: check?.extracted?.raw_text || null,
          image_url: check?.image_url || null,
          expected_barcode_crop_image_url: spec?.barcode_crop_image_url || null,
          extracted_barcode_crop_image_url: check?.extracted_barcode_crop_image_url || check?.extracted?.barcode_crop_image_url || null,
          extracted_barcode_bbox: check?.extracted_barcode_bbox || check?.extracted?.barcode_bbox || null,
          status: check?.status || "pending",
          failure_reason: check?.status === "passed" ? null : check?.reason || "Chưa quét tem nhãn",
          checked_by: user?.id || null,
        };
      });
      const { error: labelError } = await (db).from("qa_label_checks").insert(labelRows);
      if (labelError) throw labelError;

      for (const item of formItems) {
        if (item.approved_qty <= 0) continue;
        const { data: existingInventory } = await db
          .from<{ id: string; quantity: number | string | null }>("inventory_items")
          .select("id,quantity,product_name,unit")
          .eq("product_name", item.product_name)
          .maybeSingle();

        let inventoryItemId = existingInventory?.id;
        if (existingInventory) {
          const { error } = await (db)
            .from("inventory_items")
            .update({ quantity: numberValue(existingInventory.quantity) + item.approved_qty })
            .eq("id", existingInventory.id);
          if (error) throw error;
        } else {
          const { data: newInventory, error } = await db
            .from<{ id: string }>("inventory_items")
            .insert({
              product_name: item.product_name,
              unit: item.unit || "cái",
              quantity: item.approved_qty,
              warehouse_location: "Kho TP Q7",
            })
            .select("id")
            .single();
          if (error) throw error;
          inventoryItemId = newInventory.id;
        }

        if (inventoryItemId) {
          const { error } = await (db).from("inventory_movements").insert({
            inventory_item_id: inventoryItemId,
            movement_type: "production_output",
            quantity: item.approved_qty,
            unit: item.unit || "cái",
            reference_type: "qa_inspection",
            reference_id: inspection.id,
            movement_date: vnTodayIso(),
            notes: `QA PASS ${inspectionNumber} — nhập kho TP từ ${selectedOrder.production_number}`,
          });
          if (error) throw error;
        }

        if (item.id) {
          await (db).from("production_order_items").update({ actual_qty: item.approved_qty }).eq("id", item.id);
        }
      }

      return inspection;
    },
    onSuccess: () => {
      toast({
        title: isVi ? "QA pass" : "QA passed",
        description: isVi ? "Đã upload ảnh, lưu audit theo ngày và nhập kho thành phẩm." : "Photos uploaded, daily audit saved, and finished goods received.",
      });
      setSelectedOrderId("");
      setInspectedBy(loggedInInspectorName);
      setNotes("");
      setChecklist({ quality: true, sensory: true, packaging: true });
      setQaFiles([]);
      setLabelChecks({});
      setFormItems([]);
      setQaDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["qa_inspections_by_day"] });
      queryClient.invalidateQueries({ queryKey: ["qa_inspections_for_order_status"] });
      queryClient.invalidateQueries({ queryKey: ["qa_production_orders_q7"] });
      queryClient.invalidateQueries({ queryKey: ["inventory_items"] });
    },
    onError: (error: unknown) => {
      toast({ title: isVi ? "Không thể QA pass" : "Unable to pass QA", description: getErrorMessage(error), variant: "destructive" });
    },
  });

  const handleOpenDetail = async (inspection: QAInspection) => {
    setSelectedInspection(inspection);
    const { data } = await db.from<QAInspectionItem[]>("qa_inspection_items").select("*").eq("qa_inspection_id", inspection.id);
    setSelectedItems(data || []);
    setDetailOpen(true);
  };

  const selectedChecklist = checklistFromNotes(selectedInspection?.notes);

  return (
    <div className="-m-4 min-h-screen bg-background p-4 text-foreground md:-m-6 md:p-6" data-stitch-qa-finished-goods="q7-current-theme-vn-date">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="card-elevated rounded-[1.75rem] p-4 md:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-warm">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <div>
                <Badge className="mb-2 rounded-full bg-success/15 text-success hover:bg-success/15">
                  {isVi ? "Xưởng Q7 · bánh ngọt" : "Q7 workshop · sweet bakery"}
                </Badge>
                <h1 className="text-2xl font-black tracking-tight md:text-4xl">{copy.title}</h1>
                <p className="mt-1 max-w-3xl text-sm font-semibold text-muted-foreground md:text-base">{copy.subtitle}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="stat-card rounded-2xl p-3 before:bg-success">
                <p className="text-xs font-bold text-muted-foreground">{isVi ? "QA pass" : "Passed"}</p>
                <p className="text-2xl font-black text-success">{inspectionsLoading ? "…" : stats.passed}</p>
              </div>
              <div className="stat-card rounded-2xl p-3 before:bg-accent">
                <p className="text-xs font-bold text-muted-foreground">{isVi ? "Ảnh audit" : "Photos"}</p>
                <p className="text-2xl font-black text-primary">{inspectionsLoading ? "…" : stats.photos}</p>
              </div>
              <div className="stat-card rounded-2xl p-3 before:bg-warning">
                <p className="text-xs font-bold text-muted-foreground">{isVi ? "SL đang nhập" : "Receiving"}</p>
                <p className="text-2xl font-black text-warning-foreground">{stats.items.toLocaleString("vi-VN")}</p>
              </div>
            </div>
          </div>
        </header>

        <Card className="card-elevated rounded-[1.5rem]">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl font-black">
                  <CalendarDays className="h-5 w-5 text-primary" />
                  {copy.auditToday} · {selectedDate === vnTodayIso() ? (isVi ? "Hôm nay" : "Today") : displayDateKey(selectedDate)}
                </CardTitle>
                <CardDescription>{isVi ? "Mở lại từng phiếu để xem lệnh SX, checklist và ảnh QA." : "Open any record to review order, checklist, and QA photos."}</CardDescription>
              </div>
              <Input type="date" className="w-full rounded-2xl bg-background sm:w-48" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </div>
          </CardHeader>
          <CardContent>
            {inspectionsLoading ? (
              <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
            ) : inspections.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-border bg-muted/50 p-8 text-center font-semibold text-muted-foreground">{copy.noAudits}</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {inspections.map((inspection) => {
                  const inspectedAt = inspection.inspected_at || inspection.inspection_date || inspection.created_at;
                  return (
                    <button key={inspection.id} type="button" onClick={() => handleOpenDetail(inspection)} className="rounded-3xl border border-border bg-card/70 p-4 text-left transition hover:border-primary/45 hover:bg-accent/20">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-mono text-sm font-black text-foreground">{inspection.inspection_number || inspection.id.slice(0, 8)}</p>
                          <p className="mt-1 text-sm font-bold text-muted-foreground">{inspection.production_order?.production_number || "-"}</p>
                        </div>
                        <Badge className={inspection.status === "approved" ? "bg-success/15 text-success hover:bg-success/15" : inspection.status === "rejected" ? "bg-destructive/15 text-destructive hover:bg-destructive/15" : "bg-warning text-warning-foreground hover:bg-warning"}>
                          {inspection.status === "approved" ? "QA pass" : inspection.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-muted-foreground">
                        <span>{displayDateTime(inspectedAt)}</span>
                        <span>·</span>
                        <span>{inspection.product_photos?.length || 0} ảnh</span>
                        <span>·</span>
                        <span>{inspection.inspected_by || "-"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>


        <div className="grid gap-5">
          <section className="space-y-4">
            <Card className="card-elevated rounded-[1.5rem]">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl font-black">
                      <Factory className="h-5 w-5 text-primary" />
                      {copy.orderQueue}
                    </CardTitle>
                    <CardDescription data-qa-date-filter-both="audit-and-orders">{isVi ? "Danh sách lệnh SX cũng lọc theo ngày audit đang chọn; bấm vào lệnh để QA pass & nhập kho." : "Production orders also follow the selected audit date; click an order to QA pass & receive stock."}</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => refetchOrders()} disabled={ordersLoading}>
                    {ordersLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {ordersLoading ? (
                  <div className="flex min-h-36 items-center justify-center rounded-3xl bg-muted/50">
                    <Loader2 className="h-7 w-7 animate-spin text-primary" />
                  </div>
                ) : filteredProductionOrders.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-border bg-muted/50 p-6 text-center font-semibold text-muted-foreground">{isVi ? `Không có lệnh SX cho ngày ${displayDateKey(selectedDate)}.` : `No production orders for ${displayDateKey(selectedDate)}.`}</div>
                ) : (
                  <div className="space-y-3">
                    {filteredProductionOrders.slice(0, 14).map((order) => {
                      const selected = order.id === selectedOrderId;
                      const items = order.production_order_items || [];
                      const totalQty = items.reduce((sum, item) => sum + numberValue(item.planned_qty || item.ordered_qty || item.actual_qty), 0);
                      const alreadyPassed = orderHasQa(order.id);
                      return (
                        <button
                          key={order.id}
                          type="button"
                          onClick={() => handleSelectOrder(order.id)}
                          className={`w-full rounded-3xl border p-3 text-left transition ${selected ? "border-primary bg-primary/10 shadow-inner" : "border-border bg-card/70 hover:border-primary/45 hover:bg-accent/20"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-mono text-sm font-black text-foreground">{order.production_number}</p>
                                {alreadyPassed && <Badge className="bg-success/15 text-success hover:bg-success/15">QA pass</Badge>}
                                <Badge variant="outline" className="rounded-full text-[11px] uppercase">{order.status}</Badge>
                              </div>
                              <p className="mt-1 line-clamp-2 text-sm font-semibold text-muted-foreground">
                                {items.slice(0, 2).map((item) => item.product_name).join(" · ") || (isVi ? "Chưa có dòng sản phẩm" : "No item lines")}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-2xl font-black text-warning-foreground">{totalQty.toLocaleString("vi-VN")}</p>
                              <p className="text-[11px] font-bold text-muted-foreground">{items.length} SKU</p>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-muted-foreground">
                            <span className="rounded-full bg-muted px-2 py-1">SX {displayDateKey(order.planned_start_date || order.planned_end_date || order.created_at)}</span>
                            <span className="rounded-full bg-muted px-2 py-1">{isVi ? "Bấm để QA pass" : "Click to QA pass"}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>


        </div>

      </div>


      <Dialog open={qaDialogOpen} onOpenChange={setQaDialogOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto rounded-3xl border-border bg-card text-card-foreground" data-qa-pass-modal="production-order-click">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <PackageCheck className="h-5 w-5 text-success" />
              {copy.qaPass}
            </DialogTitle>
            <CardDescription>{selectedOrder ? selectedOrder.production_number : isVi ? "Chọn một lệnh SX bên dưới để QA." : "Select a production order to QA."}</CardDescription>
          </DialogHeader>
          <div className="space-y-4">
                <div>
                  <label className="text-sm font-bold text-foreground">{isVi ? "Người QA" : "Inspector"}</label>
                  <Input data-qa-inspector-autofill="logged-in-user" className="mt-1 h-11 rounded-2xl bg-background" placeholder={loggedInInspectorName || (isVi ? "Ví dụ: Vũ Phương Nhi" : "Inspector name")} value={inspectedBy} onChange={(event) => setInspectedBy(event.target.value)} />
                </div>


                <div className="rounded-3xl border border-dashed border-primary/35 bg-primary/10 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-foreground">{copy.uploadPhotos}</p>
                      <p className="text-xs font-semibold text-muted-foreground">{isVi ? "Chọn nhiều ảnh: số lượng chưa đóng gói, cảm quan, bao bì sau đóng gói." : "Select multiple photos for quantity, sensory, and packaging evidence."}</p>
                    </div>
                    <Button type="button" variant="outline" className="shrink-0 rounded-2xl bg-background" onClick={() => fileInputRef.current?.click()}>
                      <UploadCloud className="mr-2 h-4 w-4" />
                      {isVi ? "Chọn ảnh" : "Choose"}
                    </Button>
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFilesChange} />
                  <input ref={labelFileInputRef} type="file" accept="image/*" className="hidden" onChange={handleLabelFileChange} />
                  {qaFiles.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {qaFiles.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="relative rounded-2xl border border-border bg-card p-2">
                          <ImageIcon className="h-5 w-5 text-primary" />
                          <p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{file.name}</p>
                          <button type="button" className="absolute -right-1 -top-1 rounded-full bg-red-600 p-1 text-white" onClick={() => setQaFiles((current) => current.filter((_, idx) => idx !== index))}>
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-black text-foreground">{isVi ? "Sản phẩm nhập kho từ lệnh SX" : "Finished goods from order"}</p>
                    <Badge variant="outline">{formItems.length} dòng</Badge>
                  </div>
                  {formItems.length === 0 ? (
                    <div className="rounded-2xl bg-muted p-4 text-sm font-semibold text-muted-foreground">{isVi ? "Chọn lệnh SX để tự điền danh sách sản phẩm." : "Select an order to auto-fill items."}</div>
                  ) : (
                    <div className="space-y-2">
                      {formItems.map((item, index) => {
                        const labelKey = item.id || String(index);
                        const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;
                        const check = labelChecks[labelKey];
                        const expected = expectedLabelDates(selectedDate, spec?.shelf_life_days || 1);
                        const labelOk = check?.status === "passed";
                        return (
                        <div key={item.id || index} className="rounded-2xl border border-border bg-muted/50 p-3" data-label-control="per-sku-label-scan">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="line-clamp-2 text-sm font-black text-foreground">{item.product_name}</p>
                              <p className="text-xs font-bold text-muted-foreground">Plan {item.planned_qty.toLocaleString("vi-VN")} {item.unit}</p>
                            </div>
                            <Badge className="bg-warning text-warning-foreground hover:bg-warning">{item.unit}</Badge>
                          </div>
                          <div className="mt-3 rounded-2xl border border-dashed border-primary/30 bg-background p-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div>
                                <p className="text-xs font-black text-foreground">Tem nhãn SKU</p>
                                <p className="text-[11px] font-bold text-muted-foreground">Kỳ vọng NSX {formatDateKeyVi(expected.expectedNsx)} · HSD {formatDateKeyVi(expected.expectedHsd)}{spec?.net_weight_value ? ` · ${spec.net_weight_value}${spec.net_weight_unit || ""}` : ""}{spec?.barcode_value ? ` · Mã vạch ${spec.barcode_value}` : ""}{spec?.partner_product_code ? ` · Mã SP ${spec.partner_product_code}` : ""}</p>
                              </div>
                              <Button type="button" variant={labelOk ? "outline" : "default"} size="sm" className="rounded-xl" disabled={scanningLabel} onClick={() => openLabelScanner(index)}>
                                {scanningLabel && pendingLabelIndex === index ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Camera className="mr-2 h-4 w-4" />}
                                Quét tem
                              </Button>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Badge className={labelOk ? "bg-success/15 text-success hover:bg-success/15" : check?.status === "failed" ? "bg-destructive/15 text-destructive hover:bg-destructive/15" : "bg-warning text-warning-foreground hover:bg-warning"}>
                                {labelOk ? "Tem đạt" : check?.status === "failed" ? "Tem lỗi" : "Chưa quét"}
                              </Badge>
                              <span className="text-[11px] font-bold text-muted-foreground">{check?.reason || (spec ? "Phải quét trước khi nhập kho." : "SKU chưa có cấu hình tem nhãn.")}</span>
                            </div>
                            {(spec?.barcode_crop_image_url || check?.extracted_barcode_crop_image_url) && (
                              <div className="mt-3 grid gap-2 sm:grid-cols-2" data-qa-barcode-crop-compare="template-vs-scan">
                                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                                  <div className="flex h-24 items-center justify-center bg-muted/70">
                                    {spec?.barcode_crop_image_url ? <img src={spec.barcode_crop_image_url} alt="Ảnh barcode mẫu" className="h-full w-full object-contain" /> : <ImageIcon className="h-6 w-6 text-muted-foreground" />}
                                  </div>
                                  <p className="px-2 py-1 text-[11px] font-bold text-muted-foreground">Ảnh barcode mẫu</p>
                                </div>
                                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                                  <div className="flex h-24 items-center justify-center bg-muted/70">
                                    {check?.extracted_barcode_crop_image_url ? <img src={check.extracted_barcode_crop_image_url} alt="Ảnh barcode vừa quét" className="h-full w-full object-contain" /> : <ImageIcon className="h-6 w-6 text-muted-foreground" />}
                                  </div>
                                  <p className="px-2 py-1 text-[11px] font-bold text-muted-foreground">Ảnh barcode vừa quét</p>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[11px] font-bold text-muted-foreground">{isVi ? "SL kiểm" : "Inspected"}</label>
                              <Input type="number" className="mt-1 h-10 rounded-xl bg-background" value={item.inspected_qty} onChange={(event) => updateFormItem(index, "inspected_qty", event.target.value)} />
                            </div>
                            <div>
                              <label className="text-[11px] font-bold text-muted-foreground">{isVi ? "SL pass nhập kho" : "Passed qty"}</label>
                              <Input type="number" className="mt-1 h-10 rounded-xl bg-background" value={item.approved_qty} onChange={(event) => updateFormItem(index, "approved_qty", event.target.value)} />
                            </div>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-sm font-bold text-foreground">{isVi ? "Ghi chú audit" : "Audit notes"}</label>
                  <Textarea className="mt-1 rounded-2xl bg-background" rows={3} placeholder={isVi ? "Ví dụ: PO 687, giao đủ 687; bao bì mới OK..." : "Notes for audit"} value={notes} onChange={(event) => setNotes(event.target.value)} />
                </div>

                <Button className="h-12 w-full rounded-2xl bg-success text-base font-black text-success-foreground hover:bg-success/90" disabled={qaPassMutation.isPending || !selectedOrderId || !allLabelChecksPassed} onClick={() => qaPassMutation.mutate()}>
                  {qaPassMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
                  {copy.qaPass}
                </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-4xl overflow-y-auto rounded-3xl border-border bg-card text-card-foreground">
          <DialogHeader>
            <DialogTitle>{isVi ? "Chi tiết audit QA" : "QA audit details"}</DialogTitle>
          </DialogHeader>
          {selectedInspection && (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-3xl bg-muted/50 p-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-bold text-muted-foreground">Mã QA</p>
                  <p className="font-mono text-sm font-black">{selectedInspection.inspection_number || selectedInspection.id.slice(0, 8)}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-muted-foreground">Lệnh SX</p>
                  <p className="text-sm font-black">{selectedInspection.production_order?.production_number || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-muted-foreground">Người QA</p>
                  <p className="text-sm font-black">{selectedInspection.inspected_by || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-muted-foreground">Thời gian</p>
                  <p className="text-sm font-black">{displayDateTime(selectedInspection.inspected_at || selectedInspection.inspection_date || selectedInspection.created_at)}</p>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ["quality", "Chất lượng", CheckCircle2],
                  ["sensory", "Cảm quan", Sparkles],
                  ["packaging", "Bao bì", PackageCheck],
                ].map(([key, label, Icon]) => {
                  const ActiveIcon = Icon as typeof CheckCircle2;
                  const passed = selectedChecklist[key as "quality" | "sensory" | "packaging"] || selectedInspection.status === "approved";
                  return (
                    <div key={String(key)} className={`rounded-2xl border p-3 ${passed ? "border-success/25 bg-success/10 text-success" : "border-destructive/25 bg-destructive/10 text-destructive"}`}>
                      <ActiveIcon className="mb-2 h-5 w-5" />
                      <p className="text-sm font-black">{String(label)}</p>
                      <p className="text-xs font-bold">{passed ? "PASS" : "CHƯA PASS"}</p>
                    </div>
                  );
                })}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-black">Sản phẩm đã QA</h3>
                <div className="space-y-2">
                  {selectedItems.map((item) => (
                    <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-2xl border border-border bg-card/70 p-3">
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-sm font-black">{item.product_name}</p>
                        <p className="text-xs font-bold text-muted-foreground">Kiểm {numberValue(item.inspected_qty).toLocaleString("vi-VN")} · Từ chối {numberValue(item.rejected_qty).toLocaleString("vi-VN")} {item.unit}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-black text-success">{numberValue(item.approved_qty).toLocaleString("vi-VN")}</p>
                        <p className="text-xs font-bold text-muted-foreground">{item.unit} nhập kho</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {selectedInspection.product_photos && selectedInspection.product_photos.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-black">Ảnh QA</h3>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    {selectedInspection.product_photos.map((photo, index) => (
                      <a key={`${photo}-${index}`} href={photo} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-2xl border border-border bg-muted">
                        <img src={photo} alt={`QA ${index + 1}`} className="h-40 w-full object-cover transition group-hover:scale-105" />
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-1 text-xs font-bold text-white"><Eye className="mr-1 inline h-3 w-3" />Mở</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {selectedInspection.notes && (
                <div className="rounded-2xl bg-muted/50 p-3">
                  <p className="mb-1 text-sm font-black">Ghi chú audit</p>
                  <pre className="whitespace-pre-wrap text-sm font-medium text-muted-foreground">{selectedInspection.notes.replace(/\[QA_CHECKLIST\][\s\S]*?\[\/QA_CHECKLIST\]\n?/g, "").trim() || "-"}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
