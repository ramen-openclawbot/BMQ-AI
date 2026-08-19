import { useMemo, useState } from "react";
import { Check, Edit3, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  CanonicalMaterial,
  CogsMaterialLink,
  MaterialPaymentRequestLink,
  MaterialSupplierSuggestion,
  Q7Mapping,
  ResolutionRequest,
  SupplierLite,
  SupplierProduct,
  useConfirmMaterialResolution,
  useConfirmMaterialSupplierProduct,
  useCreateCanonicalMaterial,
  useMaterialMaster,
  useMaterialPaymentRequestLinks,
  useMaterialSupplierSuggestions,
  useSyncMaterialSupplierPaymentRequests,
  useUpdateCanonicalMaterial,
} from "@/hooks/useMaterialMaster";
import ReconciliationQueue from "./ReconciliationQueue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

const emptyForm = {
  material_code: "",
  canonical_name: "",
  default_unit: "",
  category: "",
  brand: "",
  specification: "",
  activeChoice: "active",
  reason: "",
};

const emptyCreateFields = {
  material_code: "",
  canonical_name: "",
  default_unit: "",
  category: "",
  brand: "",
  specification: "",
};

const sectionErrorLabels: Record<string, string> = {
  materials: "Danh mục NVL",
  aliases: "Tên gọi khác",
  scopedAliases: "Tên gọi theo nguồn",
  supplierProducts: "Sản phẩm Nhà cung cấp",
  prices: "Giá mua",
  conversions: "Quy đổi đơn vị",
  resolutionRequests: "Cần xác nhận",
  auditLogs: "Lịch sử chỉnh sửa",
  suppliers: "Nhà cung cấp",
  kitchenMappings: "Phiếu xuất kho Q7",
  finishedSkus: "SKU thành phẩm",
  cogsLinks: "Sản phẩm sử dụng",
};

function displayMaterial(material?: CanonicalMaterial | null) {
  if (!material) return "Chưa chọn NVL";
  return `${material.canonical_name || "Chưa đặt tên"} · ${material.material_code || "chưa có mã"} · ${material.default_unit || "chưa có đơn vị"}`;
}

function truncateId(id?: string | null) {
  if (!id) return "";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function byMaterialName(materials: CanonicalMaterial[], id?: string | null) {
  return materials.find((material) => material.id === id)?.canonical_name || "Chưa liên kết";
}

function statusBadge(status?: string | boolean | null) {
  const text = typeof status === "boolean" ? (status ? "active" : "inactive") : status || "Chưa rõ";
  const ok = text === "active" || text === "Đã duyệt" || text === "approved";
  const label = text === "active" ? "Đang dùng" : text === "inactive" ? "Ngưng dùng" : text === "approved" ? "Đã duyệt" : text;
  return <Badge variant="outline" className={ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{label}</Badge>;
}

function linkBadge(linked: boolean) {
  return <Badge variant="outline" className={linked ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{linked ? "Đã liên kết" : "Chưa liên kết"}</Badge>;
}

function LoadingState() {
  return <div className="grid gap-4 md:grid-cols-3"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
}

const trimmedOrNull = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

type MutationFormProps = {
  canMutate: boolean;
  selected: CanonicalMaterial | null;
  onClose?: () => void;
};

const materialFormValues = (selected: CanonicalMaterial | null) => selected ? {
  material_code: selected.material_code || "",
  canonical_name: selected.canonical_name || "",
  default_unit: selected.default_unit || "",
  category: selected.category || "",
  brand: selected.brand || "",
  specification: selected.specification || "",
  activeChoice: selected.active === false ? "inactive" : "active",
  reason: "",
} : { ...emptyForm };

function MaterialMutationForm({ canMutate, selected, onClose }: MutationFormProps) {
  const { toast } = useToast();
  const createMutation = useCreateCanonicalMaterial();
  const updateMutation = useUpdateCanonicalMaterial();
  const [form, setForm] = useState(() => materialFormValues(selected));


  const setField = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const pending = createMutation.isPending || updateMutation.isPending;
  const validReason = form.reason.trim().length > 0;
  const hasPositiveVersion = Boolean(selected && selected.version && selected.version > 0);

  const submit = async () => {
    if (!canMutate || !validReason) return;
    try {
      if (selected) {
        if (!(selected.version && selected.version > 0)) throw new Error("Thông tin NVL vừa thay đổi ở nơi khác. Vui lòng tải lại trước khi sửa.");
        const patch: Partial<Pick<CanonicalMaterial, "canonical_name" | "default_unit" | "active" | "category" | "brand" | "specification">> = {};
        if (form.canonical_name.trim() !== (selected.canonical_name || "")) patch.canonical_name = form.canonical_name.trim();
        if (form.default_unit.trim() !== (selected.default_unit || "")) patch.default_unit = form.default_unit.trim();
        if (trimmedOrNull(form.category) !== selected.category) patch.category = trimmedOrNull(form.category);
        if (trimmedOrNull(form.brand) !== selected.brand) patch.brand = trimmedOrNull(form.brand);
        if (trimmedOrNull(form.specification) !== selected.specification) patch.specification = trimmedOrNull(form.specification);
        const nextActive = form.activeChoice === "active";
        if (nextActive !== Boolean(selected.active)) patch.active = nextActive;
        await updateMutation.mutateAsync({
          material_id: selected.id,
          expectedVersion: selected.version,
          patch,
          reason: form.reason,
        });
      } else {
        await createMutation.mutateAsync({
          material_code: form.material_code,
          canonical_name: form.canonical_name,
          default_unit: form.default_unit,
          category: form.category,
          brand: form.brand,
          specification: form.specification,
          reason: form.reason,
        });
      }
      toast({ title: selected ? "Đã cập nhật NVL chuẩn" : "Đã tạo NVL chuẩn", description: "Tên, đơn vị và lý do thay đổi đã được lưu." });
      onClose?.();
    } catch (error) {
      toast({ title: "Không thể lưu thay đổi", description: error instanceof Error ? error.message : "Hệ thống đã từ chối thao tác không hợp lệ.", variant: "destructive" });
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>Mã NVL {selected ? "(Mã NVL không đổi)" : ""}</Label>
        <Input value={form.material_code} onChange={(event) => setField("material_code", event.target.value)} disabled={!canMutate || Boolean(selected)} placeholder="VD: NVL-DUONG" />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div><Label>Tên NVL chuẩn</Label><Input value={form.canonical_name} onChange={(event) => setField("canonical_name", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Đơn vị chuẩn</Label><Input value={form.default_unit} onChange={(event) => setField("default_unit", event.target.value)} disabled={!canMutate} /></div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <div><Label>Nhóm</Label><Input value={form.category} onChange={(event) => setField("category", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Thương hiệu</Label><Input value={form.brand} onChange={(event) => setField("brand", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Quy cách</Label><Input value={form.specification} onChange={(event) => setField("specification", event.target.value)} disabled={!canMutate} /></div>
      </div>
      {selected && <div className="grid gap-2"><Label>Trạng thái</Label><Select value={form.activeChoice} onValueChange={(value) => setField("activeChoice", value)} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Đang dùng</SelectItem><SelectItem value="inactive">Ngưng dùng</SelectItem></SelectContent></Select></div>}
      {selected && !hasPositiveVersion && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Phiên bản NVL chưa sẵn sàng</AlertTitle><AlertDescription>Đóng cửa sổ rồi mở lại NVL trước khi điều chỉnh.</AlertDescription></Alert>}
      <div className="grid gap-2">
        <Label>Lý do thay đổi</Label>
        <Textarea value={form.reason} onChange={(event) => setField("reason", event.target.value)} disabled={!canMutate} placeholder="VD: Chuẩn hoá tên theo hồ sơ NCC đã duyệt..." />
        {!validReason && <p className="text-xs text-amber-700">Vui lòng ghi lý do để lưu lịch sử chỉnh sửa.</p>}
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={!canMutate || !validReason || pending || Boolean(selected && !hasPositiveVersion)}>
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          {selected ? "Lưu cập nhật" : "Tạo NVL"}
        </Button>
      </DialogFooter>
    </div>
  );
}

const formatVnd = (value: number | null) => value == null ? "—" : new Intl.NumberFormat("vi-VN").format(value);

const materialSuggestionKey = (row: MaterialSupplierSuggestion) =>
  `${row.supplier_id}-${row.product_sku_id || row.product_name}-${row.purchase_unit}`;

const suggestionSourceLabel = (source: MaterialSupplierSuggestion["candidate_source"]) => {
  if (source === "confirmed_supplier_product") return "Đã xác nhận trước đó";
  if (source === "supplier_delivery_note_scan") return "Gợi ý từ phiếu xuất hàng NCC";
  if (source === "cogs_product_sku_exact") return "Khớp SKU trong Giá vốn";
  if (source === "payment_history_sku_exact") return "Khớp mã hàng Duyệt chi";
  if (source === "payment_history_name_contains") return "Tên Duyệt chi có chứa tên NVL";
  return "Khớp tên và đơn vị Duyệt chi";
};

function MaterialSupplierReview({ selected, suppliers, canMutate }: { selected: CanonicalMaterial | null; suppliers: SupplierLite[]; canMutate: boolean }) {
  const { toast } = useToast();
  const { data: suggestions = [], isLoading, error } = useMaterialSupplierSuggestions(selected?.id || null);
  const confirmSupplier = useConfirmMaterialSupplierProduct();
  const defaultReason = "Xác nhận sản phẩm Nhà cung cấp theo lựa chọn của người dùng.";
  const [selectedKey, setSelectedKey] = useState("");
  const [manualSupplierId, setManualSupplierId] = useState("");
  const [manualProductName, setManualProductName] = useState(selected?.canonical_name || "");
  const [manualPurchaseUnit, setManualPurchaseUnit] = useState(selected?.default_unit || "");
  const [baseQuantityOverride, setBaseQuantityOverride] = useState<{ key: string; value: string } | null>(null);
  const [pendingConfirmedSelection, setPendingConfirmedSelection] = useState<{ key: string; supplierProductId: string } | null>(null);
  const [reason, setReason] = useState(defaultReason);
  const confirmedSuggestions = suggestions
    .filter((row) => row.confirmed && row.supplier_product_id)
    .sort((left, right) => right.payment_candidate_count - left.payment_candidate_count);
  const activeSuggestion = selectedKey
    ? suggestions.find((row) => materialSuggestionKey(row) === selectedKey)
    : manualSupplierId ? undefined : confirmedSuggestions[0] || suggestions[0];
  const optimisticConfirmedSuggestion = activeSuggestion
    && pendingConfirmedSelection?.key === materialSuggestionKey(activeSuggestion)
    ? { ...activeSuggestion, confirmed: true, supplier_product_id: pendingConfirmedSelection.supplierProductId }
    : undefined;
  const confirmedSuggestion = optimisticConfirmedSuggestion || (activeSuggestion?.confirmed && activeSuggestion.supplier_product_id
    ? activeSuggestion
    : confirmedSuggestions[0]);
  const activeSuggestionConfirmed = Boolean(activeSuggestion && confirmedSuggestion && materialSuggestionKey(activeSuggestion) === materialSuggestionKey(confirmedSuggestion));
  const supplierActionLabel = activeSuggestionConfirmed ? "Chỉnh sửa" : "Xác nhận và lưu";
  const manualSupplierSuggestions = manualSupplierId
    ? suggestions.filter((row) => row.supplier_id === manualSupplierId && !row.confirmed)
    : [];
  const confirmationSupplierId = activeSuggestion?.supplier_id || manualSupplierId;
  const confirmationProductName = activeSuggestion?.product_name || manualProductName.trim();
  const confirmationPurchaseUnit = activeSuggestion?.purchase_unit || manualPurchaseUnit.trim();
  const activeConversionKey = activeSuggestion && selected ? `${selected.id}:${materialSuggestionKey(activeSuggestion)}` : "";
  const confirmedBaseQuantity = baseQuantityOverride?.key === activeConversionKey
    ? baseQuantityOverride.value
    : activeSuggestion?.candidate_source === "supplier_delivery_note_scan" && activeSuggestion.suggested_base_quantity
      ? String(activeSuggestion.suggested_base_quantity)
      : "";
  const parsedBaseQuantity = confirmedBaseQuantity.trim() ? Number(confirmedBaseQuantity) : null;
  const validBaseQuantity = parsedBaseQuantity == null || (Number.isFinite(parsedBaseQuantity) && parsedBaseQuantity > 0);
  const validReason = reason.trim().length > 0;
  const canConfirm = Boolean(canMutate && selected?.version && selected.version > 0 && confirmationSupplierId && confirmationProductName && confirmationPurchaseUnit && validReason && validBaseQuantity);

  const chooseSuggestion = (value: string) => {
    setSelectedKey(value);
    setManualSupplierId("");
    setPendingConfirmedSelection(null);
    setBaseQuantityOverride(null);
  };

  const chooseManualSupplier = (value: string) => {
    setManualSupplierId(value === "none" ? "" : value);
    setSelectedKey("");
    setManualProductName(selected?.canonical_name || "");
    setManualPurchaseUnit(selected?.default_unit || "");
    setPendingConfirmedSelection(null);
    setBaseQuantityOverride(null);
  };

  const submit = async () => {
    if (!selected?.version || !canConfirm) return;
    try {
      const confirmedResult = await confirmSupplier.mutateAsync({
        materialId: selected.id,
        expectedVersion: selected.version,
        supplierId: confirmationSupplierId,
        productSkuId: activeSuggestion?.product_sku_id || null,
        productName: confirmationProductName,
        purchaseUnit: confirmationPurchaseUnit,
        scanEvidenceId: activeSuggestion?.scan_evidence_id || null,
        confirmedBaseQuantity: parsedBaseQuantity,
        confirmedBaseUnit: parsedBaseQuantity ? selected.default_unit : null,
        reason,
      });
      if (activeSuggestion && typeof confirmedResult.supplier_product_id === "string") {
        setPendingConfirmedSelection({
          key: materialSuggestionKey(activeSuggestion),
          supplierProductId: confirmedResult.supplier_product_id,
        });
      }
      toast({ title: activeSuggestionConfirmed ? "Đã cập nhật NCC" : "Đã xác nhận NCC", description: "Lựa chọn đã được lưu và ghi lịch sử; gợi ý trước đó không tự liên kết." });
      if (!activeSuggestion) setSelectedKey("");
      setManualSupplierId("");
      setReason(defaultReason);
    } catch (submitError) {
      toast({ title: "Không thể xác nhận NCC", description: submitError instanceof Error ? submitError.message : "Hệ thống từ chối gợi ý đã chọn.", variant: "destructive" });
    }
  };

  if (!selected) return <Card data-bmq-material-supplier-review><CardContent className="p-6 text-sm text-slate-600">Chọn một NVL từ Giá vốn để xem Hệ thống gợi ý NCC.</CardContent></Card>;

  return <Card data-bmq-material-supplier-review>
    <CardHeader><CardTitle>Hệ thống gợi ý NCC</CardTitle><CardDescription>Gợi ý để tham khảo — chưa tự liên kết. Đơn vị Giá vốn lấy từ Giá vốn; đơn vị mua được ưu tiên gợi ý từ phiếu xuất hàng NCC đã scan và chỉ ghi sau khi anh xác nhận.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được gợi ý NCC</AlertTitle><AlertDescription>Anh vẫn có thể chọn Nhà cung cấp thủ công bên dưới; hệ thống chỉ ghi khi anh bấm xác nhận.</AlertDescription></Alert>}
      {isLoading && <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
      {!isLoading && !error && suggestions.length === 0 && <Alert><AlertTitle>Chưa có gợi ý NCC</AlertTitle><AlertDescription>Chọn Nhà cung cấp bên dưới, sau đó nhập tên hàng tại NCC và đơn vị mua để xác nhận.</AlertDescription></Alert>}
      {activeSuggestion && <div className="min-w-0 rounded-2xl border bg-emerald-50 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase text-emerald-700">{activeSuggestionConfirmed ? "NCC đã xác nhận" : "Gợi ý ưu tiên — chưa liên kết"}</p><h3 className="break-words text-lg font-semibold">{activeSuggestion.supplier_display_name || "NCC chưa đặt tên"}</h3><p className="break-words text-sm text-slate-700">{activeSuggestion.product_code ? `${activeSuggestion.product_code} · ` : ""}{activeSuggestion.product_name}</p><p className="text-sm text-slate-700">Đơn vị mua: <span className="font-semibold">{activeSuggestion.purchase_unit || "—"}</span> · Đơn vị Giá vốn: <span className="font-semibold">{selected.default_unit || "—"}</span></p></div>
          <Badge className="w-fit bg-white text-emerald-800 hover:bg-white">{suggestionSourceLabel(activeSuggestion.candidate_source)}</Badge>
        </div>
        <p className="mt-2 text-sm text-slate-600">Bằng chứng: {activeSuggestion.evidence_count || 0} dòng · Dự kiến đồng bộ Duyệt chi: {activeSuggestion.payment_candidate_count || 0} dòng</p>
        {activeSuggestion.source_reference && <p className="mt-1 break-words text-sm text-slate-600">Nguồn scan: {activeSuggestion.source_reference}</p>}
        {activeSuggestion.package_quantity && activeSuggestion.package_unit && <p className="mt-1 text-sm text-slate-700">Quy cách OCR: {activeSuggestion.package_quantity} {activeSuggestion.package_unit} / {activeSuggestion.purchase_unit}</p>}
      </div>}
      {suggestions.length > 0 && <div className="grid gap-2"><Label>Chọn NCC khác trong gợi ý</Label><Select value={activeSuggestion ? materialSuggestionKey(activeSuggestion) : ""} onValueChange={chooseSuggestion} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0"><SelectValue placeholder="Chọn NCC khác" /></SelectTrigger><SelectContent>{suggestions.map((row) => <SelectItem key={materialSuggestionKey(row)} value={materialSuggestionKey(row)}>{row.supplier_display_name || "NCC chưa đặt tên"} · {row.product_name} · {row.purchase_unit || "—"}</SelectItem>)}</SelectContent></Select></div>}
      <div className="grid gap-3 rounded-2xl border bg-slate-50 p-4 md:grid-cols-3">
        <div className="grid gap-2"><Label>Chọn nhà cung cấp</Label><Select value={manualSupplierId || "none"} onValueChange={chooseManualSupplier} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0"><SelectValue placeholder="Chọn nhà cung cấp" /></SelectTrigger><SelectContent><SelectItem value="none">Chưa chọn</SelectItem>{suppliers.map((supplier) => <SelectItem key={supplier.id} value={supplier.id}>{supplier.name || "NCC chưa đặt tên"}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label htmlFor="manual-supplier-product-name">Tên hàng tại NCC</Label><Input id="manual-supplier-product-name" value={manualProductName} onChange={(event) => setManualProductName(event.target.value)} disabled={!canMutate || !manualSupplierId} /></div>
        <div className="grid gap-2"><Label htmlFor="manual-supplier-purchase-unit">Đơn vị mua</Label><Input id="manual-supplier-purchase-unit" value={manualPurchaseUnit} onChange={(event) => setManualPurchaseUnit(event.target.value)} disabled={!canMutate || !manualSupplierId} /></div>
      </div>
      {manualSupplierSuggestions.length > 0 && <div className="grid gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4"><Label>Chọn tên hàng từ Duyệt chi hoặc phiếu NCC</Label><p className="text-sm text-slate-600">Ưu tiên đơn vị mua đọc từ phiếu xuất hàng NCC; dữ liệu Duyệt chi chỉ hỗ trợ đối chiếu. Chọn đúng tên hàng và đơn vị trước khi xác nhận.</p><Select onValueChange={chooseSuggestion} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0 bg-white"><SelectValue placeholder="Chọn tên hàng và đơn vị" /></SelectTrigger><SelectContent>{manualSupplierSuggestions.map((row) => <SelectItem key={materialSuggestionKey(row)} value={materialSuggestionKey(row)}>{row.product_name} · {row.purchase_unit || "—"} · {suggestionSourceLabel(row.candidate_source)}</SelectItem>)}</SelectContent></Select></div>}
      {activeSuggestion?.candidate_source === "supplier_delivery_note_scan" && <div className="grid gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 sm:grid-cols-2" data-bmq-supplier-scan-conversion>
        <div className="min-w-0"><p className="font-semibold text-sky-950">Xác nhận quy đổi mua hàng</p><p className="text-sm text-slate-600">OCR chỉ gợi ý. Kiểm tra phiếu NCC trước khi lưu; để trống nếu phiếu không ghi rõ quy cách.</p></div>
        <div className="grid gap-2"><Label htmlFor="supplier-scan-base-quantity">1 đơn vị mua ({activeSuggestion.purchase_unit}) = bao nhiêu {selected.default_unit}?</Label><Input id="supplier-scan-base-quantity" inputMode="decimal" value={confirmedBaseQuantity} onChange={(event) => setBaseQuantityOverride({ key: activeConversionKey, value: event.target.value })} placeholder={`VD: 25000 ${selected.default_unit}`} disabled={!canMutate} /><p className="text-xs text-slate-600">Đơn vị Giá vốn cố định: {selected.default_unit}. Không tự đổi Duyệt chi hoặc số tiền.</p></div>
      </div>}
      {canMutate && <div className="grid gap-2"><Label htmlFor="supplier-confirm-reason">Lý do xác nhận</Label><Textarea id="supplier-confirm-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="VD: Đã đối chiếu NCC gợi ý với Giá vốn và Duyệt chi..." /></div>}
      {canMutate && <Button className="min-h-11 w-full sm:w-auto" onClick={submit} disabled={!canConfirm || confirmSupplier.isPending}>{confirmSupplier.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}{supplierActionLabel}</Button>}
      {confirmedSuggestion && <PaymentRequestBulkSync selected={selected} suggestion={confirmedSuggestion} canMutate={canMutate} />}
    </CardContent>
  </Card>;
}

function MaterialPaymentRequestLinks({ selected }: { selected: CanonicalMaterial | null; canMutate: boolean }) {
  const { data: paymentLinks = [], isLoading, error: paymentLinksError } = useMaterialPaymentRequestLinks(selected?.id || null);
  const linkedRows = paymentLinks.filter((row) => row.link_state === "linked");
  const candidates = paymentLinks.filter((row) => row.link_state === "candidate");

  if (!selected) return <Card data-bmq-material-payment-request-links><CardContent className="p-6 text-sm text-slate-600">Chọn một NVL để xem Duyệt chi liên quan.</CardContent></Card>;

  return <Card data-bmq-material-payment-request-links>
    <CardHeader><CardTitle>Duyệt chi liên quan</CardTitle><CardDescription>Chỉ hiển thị dòng đã đồng bộ hoặc có bằng chứng chính xác theo Nhà cung cấp/SKU cũ. Không tự ghép tên gần giống.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {paymentLinksError && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được Duyệt chi liên quan</AlertTitle><AlertDescription>Vui lòng tải lại trang để xem danh sách.</AlertDescription></Alert>}
      {isLoading && <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
      {!isLoading && !paymentLinksError && linkedRows.length === 0 && candidates.length === 0 && <Alert><AlertTitle>Chưa có Duyệt chi khớp</AlertTitle><AlertDescription>Hãy xác nhận sản phẩm Nhà cung cấp trước, sau đó dùng nút đồng bộ một lần.</AlertDescription></Alert>}
      {linkedRows.length > 0 && <section className="space-y-2"><h3 className="font-semibold">Đã đồng bộ NVL</h3>{linkedRows.map((row) => <PaymentRequestLinkCard key={row.payment_request_item_id} row={row} />)}</section>}
      {candidates.length > 0 && <section className="space-y-3"><div><h3 className="font-semibold">Dự kiến đồng bộ</h3><p className="text-sm text-slate-600">Các dòng này chỉ được ghi bằng nút đồng bộ hàng loạt sau khi NCC đã được xác nhận.</p></div>{candidates.map((row) => <PaymentRequestLinkCard key={row.payment_request_item_id} row={row} />)}</section>}
    </CardContent>
  </Card>;
}

function PaymentRequestBulkSync({ selected, suggestion, canMutate }: { selected: CanonicalMaterial; suggestion: MaterialSupplierSuggestion; canMutate: boolean }) {
  const { toast } = useToast();
  const defaultReason = "Đồng bộ Duyệt chi theo sản phẩm Nhà cung cấp đã xác nhận.";
  const syncPaymentRequests = useSyncMaterialSupplierPaymentRequests();
  const {
    isLoading: paymentPreviewLoading,
    isFetching: paymentPreviewFetching,
    error: paymentPreviewError,
  } = useMaterialPaymentRequestLinks(selected.id);
  const [reason, setReason] = useState(defaultReason);
  const validReason = reason.trim().length > 0;
  const canSync = Boolean(
    canMutate
      && selected.version
      && selected.version > 0
      && suggestion.supplier_product_id
      && validReason
      && !paymentPreviewLoading
      && !paymentPreviewFetching
      && !paymentPreviewError,
  );

  const submit = async () => {
    if (!selected.version || !suggestion.supplier_product_id || !canSync) return;
    try {
      const result = await syncPaymentRequests.mutateAsync({ materialId: selected.id, expectedVersion: selected.version, supplierProductId: suggestion.supplier_product_id, reason });
      const linkedCount = typeof result.linked_count === "number" ? result.linked_count : suggestion.payment_candidate_count;
      toast({ title: "Đã đồng bộ Duyệt chi", description: `${linkedCount || 0} dòng đã được cập nhật NVL chuẩn.` });
      setReason(defaultReason);
    } catch (syncError) {
      toast({ title: "Không thể đồng bộ Duyệt chi", description: syncError instanceof Error ? syncError.message : "Hệ thống từ chối đồng bộ hàng loạt.", variant: "destructive" });
    }
  };

  return <div className="space-y-3 rounded-2xl border bg-white p-4" data-bmq-payment-request-bulk-sync>
    <div className="min-w-0"><h3 className="font-semibold">Xem trước đồng bộ Duyệt chi</h3><p className="break-words text-sm text-slate-600">NCC đã xác nhận: {suggestion.supplier_display_name || "NCC chưa đặt tên"} · {suggestion.product_name} · {suggestion.purchase_unit || selected.default_unit || "—"}</p><p className="text-sm text-slate-600">Dự kiến cập nhật chính xác: {suggestion.payment_candidate_count || 0} dòng; đã có bằng chứng: {suggestion.evidence_count || 0} dòng.</p></div>
    {(paymentPreviewLoading || paymentPreviewFetching) && <div className="space-y-2"><Skeleton className="h-16" /><p className="text-sm text-slate-600">Đang tải bản xem trước Duyệt chi…</p></div>}
    {paymentPreviewError && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được bản xem trước Duyệt chi</AlertTitle><AlertDescription>Nút đồng bộ đã được khóa. Vui lòng tải lại trang trước khi tiếp tục.</AlertDescription></Alert>}
    {canMutate && <div className="grid gap-2"><Label htmlFor="payment-bulk-sync-reason">Lý do đồng bộ</Label><Textarea id="payment-bulk-sync-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="VD: NCC đã xác nhận, đồng bộ các dòng Duyệt chi khớp chính xác..." /></div>}
    {canMutate && <Button className="min-h-11 w-full sm:w-auto" onClick={submit} disabled={!canSync || syncPaymentRequests.isPending}>{syncPaymentRequests.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Xác nhận và đồng bộ</Button>}
  </div>;
}

function PaymentRequestLinkCard({ row }: { row: MaterialPaymentRequestLink }) {
  return <div className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{row.product_name || row.product_code || "Dòng hàng chưa đặt tên"}</p><p className="break-words text-slate-600">{row.request_number || "Duyệt chi"} · {row.vendor_display_name || "Chưa rõ Nhà cung cấp"}</p></div>{row.link_state === "linked" && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Đã liên kết NVL</Badge>}</div><p className="mt-2 break-words text-slate-600">{row.quantity ?? "—"} {row.unit || "—"} · Đơn giá {formatVnd(row.unit_price)}đ · Thành tiền {formatVnd(row.line_total)}đ</p><p className="mt-1 text-xs text-slate-500">Trạng thái Duyệt chi: {row.request_status || "—"}</p></div>;
}

function ResponsiveMaterialList({
  materials,
  selected,
  supplierProductCountByMaterialId,
  onSelect,
  onEdit,
  editable,
}: {
  materials: CanonicalMaterial[];
  selected: CanonicalMaterial | null;
  supplierProductCountByMaterialId: Map<string, number>;
  onSelect: (m: CanonicalMaterial) => void;
  onEdit: (m: CanonicalMaterial) => void;
  editable: boolean;
}) {
  const supplierStatusBadge = (row: CanonicalMaterial) => {
    const supplierProductCount = supplierProductCountByMaterialId.get(row.id) || 0;
    if (supplierProductCount > 0) {
      return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Đã xác nhận NCC</Badge>;
    }
    if (row.default_unit?.trim()) {
      return <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">Đã chuẩn hoá đơn vị</Badge>;
    }
    return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">Thiếu đơn vị chuẩn</Badge>;
  };

  return <Card data-bmq-cogs-rooted-material-list data-bmq-material-master-no-raw-ids data-bmq-material-master-tap-to-edit><CardHeader><CardTitle>NVL từ Giá vốn</CardTitle><CardDescription>{editable ? "Chọn NVL để xem/gắn NCC; dùng nút Sửa để điều chỉnh thông tin chuẩn." : "Chạm vào NVL từ Giá vốn để xem các liên kết đang sử dụng."}</CardDescription></CardHeader><CardContent><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>Mã NVL</TableHead><TableHead>Tên NVL chuẩn</TableHead><TableHead>Đơn vị chuẩn</TableHead><TableHead>Nhóm · Thương hiệu · Quy cách</TableHead><TableHead>Trạng thái</TableHead><TableHead>Tiến độ</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>{materials.map((row) => <TableRow key={row.id} onClick={() => onSelect(row)} className={`${selected?.id === row.id ? "bg-emerald-50" : ""} cursor-pointer hover:bg-emerald-50/60`}><TableCell className="font-medium">{row.material_code}</TableCell><TableCell>{row.canonical_name}</TableCell><TableCell>{row.default_unit}</TableCell><TableCell>{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "—"}</TableCell><TableCell>{statusBadge(row.active)}</TableCell><TableCell>{supplierStatusBadge(row)}</TableCell><TableCell><Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); onEdit(row); }}><Edit3 className="mr-2 h-4 w-4" />{editable ? "Sửa" : "Xem"}</Button></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden" data-bmq-material-master-mobile-cards>{materials.map((row) => {
    const hasSupplierProduct = (supplierProductCountByMaterialId.get(row.id) || 0) > 0;
    const hasStandardUnit = Boolean(row.default_unit?.trim());
    return <button key={row.id} type="button" onClick={() => onSelect(row)} className="w-full rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors active:bg-emerald-50"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold text-slate-900">{row.canonical_name}</h3>{statusBadge(row.active)}</div><p className="mt-1 text-sm text-slate-600">{row.material_code} · {row.default_unit || "chưa có đơn vị"}</p><p className="mt-1 text-xs text-slate-500">{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "Chưa phân nhóm"}</p><div className="mt-3">{supplierStatusBadge(row)}</div><p className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${hasSupplierProduct || hasStandardUnit ? "text-emerald-700" : "text-amber-700"}`}><Edit3 className="h-4 w-4" />{hasSupplierProduct || hasStandardUnit ? "Chỉnh sửa" : editable ? "Chạm để bổ sung đơn vị" : "Chạm để xem liên kết"}</p></button>;
  })}</div>{materials.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Không có NVL chuẩn phù hợp.</div>}</CardContent></Card>;
}

function ReadOnlyTable<T>({ title, description, rows, render }: { title: string; description: string; rows: T[]; render: (row: T, idx: number) => JSX.Element }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="space-y-3">{rows.length === 0 ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Không có dữ liệu phù hợp.</div> : rows.map(render)}</CardContent></Card>;
}

function QueueActions({ requests, materials, canMutate }: { requests: ResolutionRequest[]; materials: CanonicalMaterial[]; canMutate: boolean }) {
  const confirm = useConfirmMaterialResolution();
  const { toast } = useToast();
  const [requestId, setRequestId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [action, setAction] = useState<"resolve_existing" | "create_new" | "reject">("resolve_existing");
  const [reason, setReason] = useState("");
  const [createFields, setCreateFields] = useState(emptyCreateFields);
  const selectedRequest = requests.find((request) => request.id === requestId);
  const createReady = createFields.canonical_name.trim() && createFields.default_unit.trim();
  const valid = Boolean(canMutate && requestId && reason.trim() && (action === "reject" || (action === "resolve_existing" && materialId) || (action === "create_new" && createReady)));

  const resetForRequest = (value: string) => {
    setRequestId(value);
    setMaterialId("");
    const next = requests.find((request) => request.id === value);
    setCreateFields({ ...emptyCreateFields, canonical_name: next?.raw_name || "", default_unit: next?.raw_unit || "", material_code: next?.raw_code || "" });
  };
  const changeAction = (value: "resolve_existing" | "create_new" | "reject") => {
    setAction(value);
    setMaterialId("");
    setCreateFields({ ...emptyCreateFields, canonical_name: selectedRequest?.raw_name || "", default_unit: selectedRequest?.raw_unit || "", material_code: selectedRequest?.raw_code || "" });
  };

  const run = async () => {
    if (!valid || !selectedRequest) return;
    try {
      if (action === "reject") await confirm.mutateAsync({ request_id: requestId, action: "reject", reason });
      if (action === "resolve_existing") await confirm.mutateAsync({ request_id: requestId, action: "resolve_existing", material_id: materialId, raw_alias: selectedRequest.raw_name, reason });
      if (action === "create_new") await confirm.mutateAsync({ request_id: requestId, action: "create_new", raw_alias: selectedRequest.raw_name, create_payload: createFields, reason });
      toast({ title: "Đã lưu xác nhận", description: "Tên và đơn vị chuẩn sẽ được dùng lại khi chứng từ được xử lý." });
      setReason("");
      setMaterialId("");
    } catch (error) {
      toast({ title: "Không thể lưu xác nhận", description: error instanceof Error ? error.message : "Hệ thống đã từ chối thao tác không hợp lệ.", variant: "destructive" });
    }
  };

  return <Card><CardHeader><CardTitle>Xác nhận tên và đơn vị</CardTitle><CardDescription>Hệ thống có thể gợi ý nhưng không tự chọn. Anh kiểm tra rồi xác nhận NVL chuẩn cần liên kết.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-4"><Select value={requestId} onValueChange={resetForRequest} disabled={!canMutate}><SelectTrigger><SelectValue placeholder="Chọn dòng cần xác nhận" /></SelectTrigger><SelectContent>{requests.slice(0, 80).map((request) => <SelectItem key={request.id} value={request.id}>{request.raw_name || request.raw_code || truncateId(request.id)} · {request.status}</SelectItem>)}</SelectContent></Select><Select value={materialId} onValueChange={setMaterialId} disabled={!canMutate || action !== "resolve_existing"}><SelectTrigger><SelectValue placeholder="Chọn NVL chuẩn" /></SelectTrigger><SelectContent>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material)}</SelectItem>)}</SelectContent></Select><Select value={action} onValueChange={(value) => changeAction(value as "resolve_existing" | "create_new" | "reject")} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="resolve_existing">Liên kết với NVL có sẵn</SelectItem><SelectItem value="create_new">Tạo NVL chuẩn mới</SelectItem><SelectItem value="reject">Không liên kết</SelectItem></SelectContent></Select><Textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canMutate} placeholder="Lý do xác nhận" className="md:col-span-3" />{action === "create_new" && <div className="grid gap-2 md:col-span-4 md:grid-cols-3"><Input value={createFields.material_code} onChange={(event) => setCreateFields((current) => ({ ...current, material_code: event.target.value }))} placeholder="Mã NVL mới (không bắt buộc)" disabled={!canMutate} /><Input value={createFields.canonical_name} onChange={(event) => setCreateFields((current) => ({ ...current, canonical_name: event.target.value }))} placeholder="Tên NVL chuẩn mới" disabled={!canMutate} /><Input value={createFields.default_unit} onChange={(event) => setCreateFields((current) => ({ ...current, default_unit: event.target.value }))} placeholder="Đơn vị chuẩn mới" disabled={!canMutate} /><Input value={createFields.category} onChange={(event) => setCreateFields((current) => ({ ...current, category: event.target.value }))} placeholder="Nhóm (không bắt buộc)" disabled={!canMutate} /><Input value={createFields.brand} onChange={(event) => setCreateFields((current) => ({ ...current, brand: event.target.value }))} placeholder="Thương hiệu (không bắt buộc)" disabled={!canMutate} /><Input value={createFields.specification} onChange={(event) => setCreateFields((current) => ({ ...current, specification: event.target.value }))} placeholder="Quy cách (không bắt buộc)" disabled={!canMutate} /></div>}<Button onClick={run} disabled={!valid || confirm.isPending}>{confirm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lưu xác nhận</Button></CardContent></Card>;
}

const jsonSummary = (value: Record<string, unknown> | null | undefined) => {
  if (!value) return "—";
  return Object.entries(value).slice(0, 4).map(([key, val]) => `${key}: ${typeof val === "string" && val.length > 24 ? `${val.slice(0, 24)}…` : String(val)}`).join(" · ") || "—";
};

export default function MaterialMasterAdmin() {
  const { canAccessModule, canEditModule } = useAuth();
  const canView = canAccessModule("material_master");
  const canEdit = canEditModule("material_master");
  const canMutate = canEdit;
  const { data, isLoading, error } = useMaterialMaster();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"edit" | null>(null);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [activeTab, setActiveTab] = useState("materials");

  const materials = useMemo(() => data?.materials || [], [data?.materials]);
  const selected = selectedId ? materials.find((material) => material.id === selectedId) || null : null;
  const supplierById = useMemo(() => new Map((data?.suppliers || []).map((supplier) => [supplier.id, supplier.name || "NCC chưa tên"])), [data?.suppliers]);
  const filteredMaterials = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return materials;
    return materials.filter((material) => [material.material_code, material.canonical_name, material.default_unit, material.category, material.brand, material.specification].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }, [materials, search]);
  const aliases = [...(data?.aliases || []), ...(data?.scopedAliases || [])].filter((row) => !selected || row.material_id === selected.id);
  const allSupplierProducts = useMemo(() => data?.supplierProducts || [], [data?.supplierProducts]);
  const supplierProductCountByMaterialId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of allSupplierProducts) {
      if (!row.material_id || row.active !== true || row.approved !== true) continue;
      counts.set(row.material_id, (counts.get(row.material_id) || 0) + 1);
    }
    return counts;
  }, [allSupplierProducts]);
  const supplierProducts = allSupplierProducts.filter((row) => {
    if (!selected) return true;
    return row.material_id === selected.id
      && row.active === true
      && row.approved === true;
  });
  const prices = (data?.prices || []).filter((row) => !selected || row.material_id === selected.id);
  const conversions = (data?.conversions || []).filter((row) => !selected || row.material_id === selected.id);
  const q7Mappings = (data?.kitchenMappings || []).filter((row) => !selected || row.canonical_material_id === selected.id);
  const cogsMappings = (data?.cogsLinks || []).filter((row) => !selected || row.canonical_material_id === selected.id);
  const auditLogs = (data?.auditLogs || []).filter((row) => !selected || row.material_id === selected.id);
  const queueRequests = useMemo(() => {
    const requests = data?.resolutionRequests || [];
    if (sourceFilter === "all") return requests;
    return requests.filter((row) => row.source_type === sourceFilter || row.source_table === sourceFilter || (sourceFilter === "kitchen_inventory" && row.source_table === "kitchen_inventory_items"));
  }, [data?.resolutionRequests, sourceFilter]);
  const chooseMaterial = (material: CanonicalMaterial) => {
    setSelectedId(material.id);
    setDialog(null);
    setActiveTab("suppliers");
  };
  const openMaterialEditor = (material: CanonicalMaterial) => {
    setSelectedId(material.id);
    setActiveTab("materials");
    if (canEdit) setDialog("edit");
  };

  if (!canView) {
    return <div className="p-6"><Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không có quyền truy cập</AlertTitle><AlertDescription>Trang này yêu cầu quyền xem module Quản trị NVL chuẩn.</AlertDescription></Alert></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50/80 p-3 text-slate-900 sm:p-4 md:p-6" data-bmq-material-master-admin data-bmq-material-master-rbac="material_master" data-bmq-material-master-light-ui>
      <div className="mx-auto max-w-7xl space-y-4 md:space-y-5">
        <section className="rounded-3xl border border-emerald-100 bg-white p-4 shadow-sm sm:p-5">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Danh mục nguyên vật liệu từ Giá vốn</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Giá vốn là nguồn gốc của danh mục NVL. Tại đây anh xác nhận sản phẩm Nhà cung cấp, sau đó đồng bộ các Duyệt chi khớp chính xác.</p>
          </div>
        </section>

        {!canEdit && <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>Chế độ chỉ xem</AlertTitle><AlertDescription>Anh có thể xem các liên kết nhưng cần quyền chỉnh sửa để đổi tên, đơn vị hoặc xác nhận liên kết.</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được danh mục NVL</AlertTitle><AlertDescription>Vui lòng tải lại trang. Nếu vẫn lỗi, báo quản trị hệ thống.</AlertDescription></Alert>}
        {data?.sectionErrors && Object.keys(data.sectionErrors).length > 0 && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Một số thông tin liên kết chưa tải được</AlertTitle><AlertDescription>{Object.keys(data.sectionErrors).map((section) => `${sectionErrorLabels[section] || "Thông tin liên kết"}: Không tải được dữ liệu`).join(" | ")}</AlertDescription></Alert>}
        {isLoading && <LoadingState />}

        {!isLoading && !error && <>
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm theo mã, tên NVL, đơn vị hoặc nhóm..." />
                <Select value={selected?.id || "none"} onValueChange={(value) => { if (value === "none") setSelectedId(null); else { const material = materials.find((row) => row.id === value); if (material) chooseMaterial(material); } }}>
                  <SelectTrigger className="min-w-0 md:w-[360px]"><SelectValue placeholder="Chọn NVL" /></SelectTrigger>
                  <SelectContent><SelectItem value="none">Tất cả NVL</SelectItem>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {selected && <p className="mt-2 break-words text-sm text-slate-600">Đang chọn: <span className="font-medium text-slate-900">{displayMaterial(selected)}</span></p>}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-sm md:grid-cols-5" data-bmq-material-master-business-tabs>
              <TabsTrigger className="col-span-2 min-h-11 whitespace-normal md:col-span-1" value="materials">NVL từ Giá vốn</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="cogs">Sản phẩm sử dụng</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="q7">Phiếu xuất kho Q7</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="suppliers">NCC & Duyệt chi</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="queue">Cần xác nhận</TabsTrigger>
            </TabsList>

            <TabsContent value="materials" className="space-y-4">
              <ResponsiveMaterialList materials={filteredMaterials} selected={selected} supplierProductCountByMaterialId={supplierProductCountByMaterialId} onSelect={chooseMaterial} onEdit={openMaterialEditor} editable={canEdit} />
              <Dialog open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)}>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Điều chỉnh NVL</DialogTitle><DialogDescription>Chỉ điều chỉnh thông tin chuẩn của NVL từ Giá vốn; liên kết NCC và Duyệt chi được xác nhận tại tab nghiệp vụ riêng.</DialogDescription></DialogHeader>{selected && <MaterialMutationForm key={`edit-${selected.id}-${selected.version}`} canMutate={canMutate} selected={selected} onClose={() => setDialog(null)} />}</DialogContent>
              </Dialog>
              {selected && !(selected.version && selected.version > 0) && <p className="text-sm text-rose-700">Phiên bản NVL chưa sẵn sàng để điều chỉnh.</p>}

              {selected && <div className="grid gap-3 md:grid-cols-3" data-bmq-material-master-supporting-details>
                <details className="rounded-2xl border bg-white p-4">
                  <summary className="cursor-pointer font-semibold">Tên gọi khác</summary>
                  <div className="mt-3 space-y-2">{aliases.length === 0 ? <p className="text-sm text-slate-500">Chưa có tên gọi khác.</p> : aliases.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.alias_name || "Chưa đặt tên"}</p><p className="text-xs text-slate-500">Nguồn: {row.source || row.source_type || "—"}</p></div>)}</div>
                </details>
                <details className="rounded-2xl border bg-white p-4">
                  <summary className="cursor-pointer font-semibold">Giá mua & quy đổi</summary>
                  <div className="mt-3 space-y-3">
                    {prices.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.price ?? "—"} / {row.price_unit || "—"}</p><p className="text-xs text-slate-500">Hiệu lực từ {row.effective_from || "—"}</p></div>)}
                    {conversions.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">1 {row.from_unit || "—"} = {row.factor ?? "—"} {row.to_unit || "—"}</p><p className="text-xs text-slate-500">{statusBadge(row.approved)}</p></div>)}
                    {prices.length === 0 && conversions.length === 0 && <p className="text-sm text-slate-500">Chưa có giá mua hoặc quy đổi đơn vị.</p>}
                  </div>
                </details>
                <details className="rounded-2xl border bg-white p-4" data-bmq-material-master-audit-timeline>
                  <summary className="cursor-pointer font-semibold">Lịch sử chỉnh sửa</summary>
                  <div className="mt-3 space-y-2">{auditLogs.length === 0 ? <p className="text-sm text-slate-500">Chưa có lịch sử.</p> : auditLogs.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.action || "Đã cập nhật"}</p><p className="text-xs text-slate-600">{row.reason || "Không có ghi chú"}</p><p className="mt-1 text-xs text-slate-400">{row.created_at || "—"}</p></div>)}</div>
                </details>
              </div>}
            </TabsContent>

            <TabsContent value="cogs" className="space-y-3">
              <ReadOnlyTable<CogsMaterialLink> title="Sản phẩm đang sử dụng NVL" description="Nguồn Giá vốn xác định NVL này đang được dùng trong những công thức SKU nào." rows={cogsMappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.product_skus?.product_name || row.product_skus?.sku_code || "Sản phẩm Giá vốn"}</h3>{linkBadge(Boolean(row.canonical_material_id))}</div><p className="text-sm text-slate-600">{row.product_skus?.sku_code || "chưa có mã SKU"} · {row.dosage_qty ?? "—"} {row.unit || "chưa có đơn vị"}</p></div>} />
            </TabsContent>

            <TabsContent value="q7" className="space-y-3">
              <ReadOnlyTable<Q7Mapping> title="Phiếu xuất kho NVL Q7" description="Tên và đơn vị NVL dùng khi lập phiếu xuất kho bếp Q7." rows={q7Mappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.name || row.item_code || "NVL kho Q7"}</h3>{linkBadge(Boolean(row.canonical_material_id))}</div><p className="text-sm text-slate-600">Đơn vị: {row.unit || "—"} · NVL chuẩn: {byMaterialName(materials, row.canonical_material_id)}</p></div>} />
            </TabsContent>

            <TabsContent value="suppliers" className="space-y-3">
              {selected && canMutate && <Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => openMaterialEditor(selected)}><Edit3 className="mr-2 h-4 w-4" />Điều chỉnh thông tin NVL</Button>}
              <MaterialSupplierReview key={selected?.id || "none"} selected={selected} suppliers={data?.suppliers || []} canMutate={canMutate} />
              <MaterialPaymentRequestLinks selected={selected} canMutate={canMutate} />
              <ReadOnlyTable<SupplierProduct> title="Sản phẩm Nhà cung cấp" description="Tên hàng và đơn vị mua của Nhà cung cấp đã liên kết với NVL chuẩn." rows={supplierProducts} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.supplier_product_name || row.supplier_product_code || "Sản phẩm chưa đặt tên"}</h3>{statusBadge(row.approved)}</div><p className="text-sm text-slate-600">Nhà cung cấp: {supplierById.get(row.supplier_id || "") || "Chưa rõ"} · Đơn vị mua: {row.purchase_unit || "—"} · Đơn vị chuẩn: {row.base_unit || "—"}</p></div>} />
            </TabsContent>

            <TabsContent value="queue" className="space-y-4" data-bmq-material-master-resolution-queue>
              <Card><CardContent className="pt-6"><div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:items-center"><Label>Lọc theo nơi sử dụng</Label><Select value={sourceFilter} onValueChange={setSourceFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Tất cả</SelectItem><SelectItem value="product_skus">Giá vốn</SelectItem><SelectItem value="payment_request">Duyệt chi</SelectItem><SelectItem value="kitchen_inventory">Kho NVL Q7</SelectItem></SelectContent></Select></div></CardContent></Card>
              <QueueActions requests={queueRequests} materials={materials} canMutate={canMutate} />
              <ReconciliationQueue canMutate={canMutate} sourceFilter={sourceFilter} />
            </TabsContent>
          </Tabs>

        </>}
      </div>
    </div>
  );
}
