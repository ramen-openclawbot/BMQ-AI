import { ChangeEvent, useMemo, useRef, useState } from "react";
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
      upload(path: string, file: File, options?: Record<string, unknown>): PromiseLike<QueryResult<unknown>>;
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

const todayIso = () => format(new Date(), "yyyy-MM-dd");

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

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error || ""));

const slugPart = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "qa";

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
  const isVi = language === "vi";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [inspectedBy, setInspectedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [checklist, setChecklist] = useState({ quality: true, sensory: true, packaging: true });
  const [qaFiles, setQaFiles] = useState<File[]>([]);
  const [formItems, setFormItems] = useState<QaFormItem[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedInspection, setSelectedInspection] = useState<QAInspection | null>(null);
  const [selectedItems, setSelectedItems] = useState<QAInspectionItem[]>([]);

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

  const selectedOrder = useMemo(
    () => productionOrders.find((order) => order.id === selectedOrderId) || null,
    [productionOrders, selectedOrderId]
  );

  const orderHasQa = useMemo(() => {
    const approvedOrderIds = new Set(
      inspections.filter((inspection) => inspection.status === "approved").map((inspection) => inspection.production_order_id).filter(Boolean)
    );
    return (orderId: string) => approvedOrderIds.has(orderId);
  }, [inspections]);

  const stats = useMemo(() => {
    const passed = inspections.filter((inspection) => inspection.status === "approved").length;
    const photos = inspections.reduce((sum, inspection) => sum + (inspection.product_photos?.length || 0), 0);
    const items = formItems.reduce((sum, item) => sum + numberValue(item.approved_qty), 0);
    return { passed, photos, items };
  }, [formItems, inspections]);

  const handleSelectOrder = (orderId: string) => {
    setSelectedOrderId(orderId);
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
  };

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    setQaFiles((current) => [...current, ...files].slice(0, 12));
    event.target.value = "";
  };

  const updateFormItem = (index: number, key: "inspected_qty" | "approved_qty", value: string) => {
    const qty = Math.max(0, numberValue(value));
    setFormItems((current) => current.map((item, idx) => (idx === index ? { ...item, [key]: qty } : item)));
  };

  const generateInspectionNumber = async () => {
    const refDate = todayIso();
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
            movement_date: todayIso(),
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
      setInspectedBy("");
      setNotes("");
      setChecklist({ quality: true, sensory: true, packaging: true });
      setQaFiles([]);
      setFormItems([]);
      queryClient.invalidateQueries({ queryKey: ["qa_inspections_by_day"] });
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
    <div className="-m-4 min-h-screen bg-[#f7f2ec] p-4 text-stone-950 md:-m-6 md:p-6" data-stitch-qa-finished-goods="q7-sweet-bakery-flow">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-[1.75rem] border border-amber-200 bg-gradient-to-br from-white via-amber-50 to-orange-50 p-4 shadow-sm md:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-600 text-white shadow-lg shadow-amber-600/20">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <div>
                <Badge className="mb-2 rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                  {isVi ? "Xưởng Q7 · bánh ngọt" : "Q7 workshop · sweet bakery"}
                </Badge>
                <h1 className="text-2xl font-black tracking-tight md:text-4xl">{copy.title}</h1>
                <p className="mt-1 max-w-3xl text-sm font-semibold text-stone-600 md:text-base">{copy.subtitle}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-2xl border border-amber-200 bg-white/80 p-3">
                <p className="text-xs font-bold text-stone-500">{isVi ? "QA pass" : "Passed"}</p>
                <p className="text-2xl font-black text-emerald-700">{inspectionsLoading ? "…" : stats.passed}</p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-white/80 p-3">
                <p className="text-xs font-bold text-stone-500">{isVi ? "Ảnh audit" : "Photos"}</p>
                <p className="text-2xl font-black text-blue-700">{inspectionsLoading ? "…" : stats.photos}</p>
              </div>
              <div className="rounded-2xl border border-amber-200 bg-white/80 p-3">
                <p className="text-xs font-bold text-stone-500">{isVi ? "SL đang nhập" : "Receiving"}</p>
                <p className="text-2xl font-black text-amber-700">{stats.items.toLocaleString("vi-VN")}</p>
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
          <section className="space-y-4">
            <Card className="rounded-[1.5rem] border-amber-200 bg-white shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl font-black">
                      <Factory className="h-5 w-5 text-amber-700" />
                      {copy.orderQueue}
                    </CardTitle>
                    <CardDescription>{isVi ? "Bao gồm cả lệnh đã xác nhận đang lưu trạng thái nháp/kế hoạch để staff vẫn thấy được." : "Includes confirmed orders stored as draft/planned so staff can see them."}</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => refetchOrders()} disabled={ordersLoading}>
                    {ordersLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {ordersLoading ? (
                  <div className="flex min-h-36 items-center justify-center rounded-3xl bg-amber-50">
                    <Loader2 className="h-7 w-7 animate-spin text-amber-700" />
                  </div>
                ) : productionOrders.length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-amber-300 bg-amber-50 p-6 text-center font-semibold text-stone-600">{copy.noOrders}</div>
                ) : (
                  <div className="space-y-3">
                    {productionOrders.slice(0, 14).map((order) => {
                      const selected = order.id === selectedOrderId;
                      const items = order.production_order_items || [];
                      const totalQty = items.reduce((sum, item) => sum + numberValue(item.planned_qty || item.ordered_qty || item.actual_qty), 0);
                      const alreadyPassed = orderHasQa(order.id);
                      return (
                        <button
                          key={order.id}
                          type="button"
                          onClick={() => handleSelectOrder(order.id)}
                          className={`w-full rounded-3xl border p-3 text-left transition ${selected ? "border-amber-600 bg-amber-50 shadow-inner" : "border-stone-200 bg-white hover:border-amber-300 hover:bg-amber-50/60"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-mono text-sm font-black text-stone-900">{order.production_number}</p>
                                {alreadyPassed && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">QA pass</Badge>}
                                <Badge variant="outline" className="rounded-full text-[11px] uppercase">{order.status}</Badge>
                              </div>
                              <p className="mt-1 line-clamp-2 text-sm font-semibold text-stone-600">
                                {items.slice(0, 2).map((item) => item.product_name).join(" · ") || (isVi ? "Chưa có dòng sản phẩm" : "No item lines")}
                              </p>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className="text-2xl font-black text-amber-700">{totalQty.toLocaleString("vi-VN")}</p>
                              <p className="text-[11px] font-bold text-stone-500">{items.length} SKU</p>
                            </div>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-stone-500">
                            <span className="rounded-full bg-stone-100 px-2 py-1">SX {displayDate(order.planned_start_date || order.planned_end_date || order.created_at)}</span>
                            <span className="rounded-full bg-stone-100 px-2 py-1">{isVi ? "Tự điền dòng QA từ lệnh SX" : "Auto-fill QA lines from order"}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            <Card className="rounded-[1.5rem] border-emerald-200 bg-white shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl font-black">
                  <PackageCheck className="h-5 w-5 text-emerald-700" />
                  {copy.qaPass}
                </CardTitle>
                <CardDescription>{selectedOrder ? selectedOrder.production_number : isVi ? "Chọn một lệnh SX bên trái để QA." : "Select a production order first."}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-bold text-stone-700">{isVi ? "Người QA" : "Inspector"}</label>
                  <Input className="mt-1 h-11 rounded-2xl" placeholder={isVi ? "Ví dụ: Vũ Phương Nhi" : "Inspector name"} value={inspectedBy} onChange={(event) => setInspectedBy(event.target.value)} />
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  {[
                    ["quality", isVi ? "Chất lượng" : "Quality", CheckCircle2],
                    ["sensory", isVi ? "Cảm quan" : "Sensory", Sparkles],
                    ["packaging", isVi ? "Bao bì" : "Packaging", PackageCheck],
                  ].map(([key, label, Icon]) => {
                    const typedKey = key as "quality" | "sensory" | "packaging";
                    const ActiveIcon = Icon as typeof CheckCircle2;
                    return (
                      <button
                        key={typedKey}
                        type="button"
                        onClick={() => setChecklist((current) => ({ ...current, [typedKey]: !current[typedKey] }))}
                        className={`rounded-2xl border p-3 text-left transition ${checklist[typedKey] ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}
                      >
                        <ActiveIcon className="mb-2 h-5 w-5" />
                        <p className="text-sm font-black">{label}</p>
                        <p className="text-xs font-bold">{checklist[typedKey] ? "PASS" : "CHƯA PASS"}</p>
                      </button>
                    );
                  })}
                </div>

                <div className="rounded-3xl border border-dashed border-blue-300 bg-blue-50 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-blue-950">{copy.uploadPhotos}</p>
                      <p className="text-xs font-semibold text-blue-700">{isVi ? "Chọn nhiều ảnh: số lượng chưa đóng gói, cảm quan, bao bì sau đóng gói." : "Select multiple photos for quantity, sensory, and packaging evidence."}</p>
                    </div>
                    <Button type="button" variant="outline" className="shrink-0 rounded-2xl bg-white" onClick={() => fileInputRef.current?.click()}>
                      <UploadCloud className="mr-2 h-4 w-4" />
                      {isVi ? "Chọn ảnh" : "Choose"}
                    </Button>
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFilesChange} />
                  {qaFiles.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {qaFiles.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="relative rounded-2xl border border-blue-200 bg-white p-2">
                          <ImageIcon className="h-5 w-5 text-blue-700" />
                          <p className="mt-1 truncate text-[11px] font-bold text-stone-600">{file.name}</p>
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
                    <p className="text-sm font-black text-stone-700">{isVi ? "Sản phẩm nhập kho từ lệnh SX" : "Finished goods from order"}</p>
                    <Badge variant="outline">{formItems.length} dòng</Badge>
                  </div>
                  {formItems.length === 0 ? (
                    <div className="rounded-2xl bg-stone-100 p-4 text-sm font-semibold text-stone-500">{isVi ? "Chọn lệnh SX để tự điền danh sách sản phẩm." : "Select an order to auto-fill items."}</div>
                  ) : (
                    <div className="space-y-2">
                      {formItems.map((item, index) => (
                        <div key={item.id || index} className="rounded-2xl border border-stone-200 bg-stone-50 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="line-clamp-2 text-sm font-black text-stone-900">{item.product_name}</p>
                              <p className="text-xs font-bold text-stone-500">Plan {item.planned_qty.toLocaleString("vi-VN")} {item.unit}</p>
                            </div>
                            <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">{item.unit}</Badge>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[11px] font-bold text-stone-500">{isVi ? "SL kiểm" : "Inspected"}</label>
                              <Input type="number" className="mt-1 h-10 rounded-xl" value={item.inspected_qty} onChange={(event) => updateFormItem(index, "inspected_qty", event.target.value)} />
                            </div>
                            <div>
                              <label className="text-[11px] font-bold text-stone-500">{isVi ? "SL pass nhập kho" : "Passed qty"}</label>
                              <Input type="number" className="mt-1 h-10 rounded-xl" value={item.approved_qty} onChange={(event) => updateFormItem(index, "approved_qty", event.target.value)} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-sm font-bold text-stone-700">{isVi ? "Ghi chú audit" : "Audit notes"}</label>
                  <Textarea className="mt-1 rounded-2xl" rows={3} placeholder={isVi ? "Ví dụ: PO 687, giao đủ 687; bao bì mới OK..." : "Notes for audit"} value={notes} onChange={(event) => setNotes(event.target.value)} />
                </div>

                <Button className="h-12 w-full rounded-2xl bg-emerald-700 text-base font-black hover:bg-emerald-800" disabled={qaPassMutation.isPending || !selectedOrderId} onClick={() => qaPassMutation.mutate()}>
                  {qaPassMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
                  {copy.qaPass}
                </Button>
              </CardContent>
            </Card>
          </aside>
        </div>

        <Card className="rounded-[1.5rem] border-stone-200 bg-white shadow-sm">
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-xl font-black">
                  <CalendarDays className="h-5 w-5 text-blue-700" />
                  {copy.auditToday}
                </CardTitle>
                <CardDescription>{isVi ? "Mở lại từng phiếu để xem lệnh SX, checklist và ảnh QA." : "Open any record to review order, checklist, and QA photos."}</CardDescription>
              </div>
              <Input type="date" className="w-full rounded-2xl sm:w-48" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </div>
          </CardHeader>
          <CardContent>
            {inspectionsLoading ? (
              <div className="flex min-h-32 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-blue-700" /></div>
            ) : inspections.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-stone-300 bg-stone-50 p-8 text-center font-semibold text-stone-500">{copy.noAudits}</div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {inspections.map((inspection) => {
                  const inspectedAt = inspection.inspected_at || inspection.inspection_date || inspection.created_at;
                  return (
                    <button key={inspection.id} type="button" onClick={() => handleOpenDetail(inspection)} className="rounded-3xl border border-stone-200 bg-stone-50 p-4 text-left transition hover:border-blue-300 hover:bg-blue-50">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-mono text-sm font-black text-stone-900">{inspection.inspection_number || inspection.id.slice(0, 8)}</p>
                          <p className="mt-1 text-sm font-bold text-stone-600">{inspection.production_order?.production_number || "-"}</p>
                        </div>
                        <Badge className={inspection.status === "approved" ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : inspection.status === "rejected" ? "bg-red-100 text-red-800 hover:bg-red-100" : "bg-amber-100 text-amber-800 hover:bg-amber-100"}>
                          {inspection.status === "approved" ? "QA pass" : inspection.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-stone-500">
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
      </div>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-4xl overflow-y-auto rounded-3xl">
          <DialogHeader>
            <DialogTitle>{isVi ? "Chi tiết audit QA" : "QA audit details"}</DialogTitle>
          </DialogHeader>
          {selectedInspection && (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-3xl bg-stone-50 p-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-bold text-stone-500">Mã QA</p>
                  <p className="font-mono text-sm font-black">{selectedInspection.inspection_number || selectedInspection.id.slice(0, 8)}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-stone-500">Lệnh SX</p>
                  <p className="text-sm font-black">{selectedInspection.production_order?.production_number || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-stone-500">Người QA</p>
                  <p className="text-sm font-black">{selectedInspection.inspected_by || "-"}</p>
                </div>
                <div>
                  <p className="text-xs font-bold text-stone-500">Thời gian</p>
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
                    <div key={String(key)} className={`rounded-2xl border p-3 ${passed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
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
                    <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-2xl border border-stone-200 bg-white p-3">
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-sm font-black">{item.product_name}</p>
                        <p className="text-xs font-bold text-stone-500">Kiểm {numberValue(item.inspected_qty).toLocaleString("vi-VN")} · Từ chối {numberValue(item.rejected_qty).toLocaleString("vi-VN")} {item.unit}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xl font-black text-emerald-700">{numberValue(item.approved_qty).toLocaleString("vi-VN")}</p>
                        <p className="text-xs font-bold text-stone-500">{item.unit} nhập kho</p>
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
                      <a key={`${photo}-${index}`} href={photo} target="_blank" rel="noreferrer" className="group relative overflow-hidden rounded-2xl border border-stone-200 bg-stone-100">
                        <img src={photo} alt={`QA ${index + 1}`} className="h-40 w-full object-cover transition group-hover:scale-105" />
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2 py-1 text-xs font-bold text-white"><Eye className="mr-1 inline h-3 w-3" />Mở</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {selectedInspection.notes && (
                <div className="rounded-2xl bg-stone-50 p-3">
                  <p className="mb-1 text-sm font-black">Ghi chú audit</p>
                  <pre className="whitespace-pre-wrap text-sm font-medium text-stone-700">{selectedInspection.notes.replace(/\[QA_CHECKLIST\][\s\S]*?\[\/QA_CHECKLIST\]\n?/g, "").trim() || "-"}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
