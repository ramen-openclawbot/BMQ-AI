import { localProductionError } from "@/i18n/productionErrors";
import { productionErrorToast } from "@/i18n/ProductionErrorToast";
import { formatText } from "@/i18n/format";
import { useProductionCopy } from "@/i18n/useProductionCopy";
import { productionCopy, type ProductionCopy } from "@/i18n/production";
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



function displayMaterial(material?: CanonicalMaterial | null, c: ProductionCopy = productionCopy.vi) {
  if (!material) return c.m105;
  return `${material.canonical_name || c.m106} · ${material.material_code || c.m107} · ${material.default_unit || c.m108}`;
}

function truncateId(id?: string | null) {
  if (!id) return "";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function byMaterialName(materials: CanonicalMaterial[], id?: string | null, c: ProductionCopy = productionCopy.vi) {
  return materials.find((material) => material.id === id)?.canonical_name || c.m109;
}

function statusBadge(status?: string | boolean | null, c: ProductionCopy = productionCopy.vi) {
  const text = typeof status === "boolean" ? (status ? "active" : "inactive") : status || c.m110;
  const ok = text === "active" || text === "Đã duyệt" || text === "approved";
  const label = text === "active" ? c.m112 : text === "inactive" ? c.m113 : text === "approved" ? c.m114 : text;
  return <Badge variant="outline" className={ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{label}</Badge>;
}

function linkBadge(linked: boolean, c: ProductionCopy = productionCopy.vi) {
  return <Badge variant="outline" className={linked ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{linked ? c.m115 : c.m116}</Badge>;
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
  const c = useProductionCopy();
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
        if (!(selected.version && selected.version > 0)) throw localProductionError("m117");
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
      toast({ title: selected ? c.m118 : c.m119, description: c.m120 });
      onClose?.();
    } catch (error) {
      productionErrorToast("material-mutation", error);
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>{c.m123} {selected ? c.m124 : ""}</Label>
        <Input value={form.material_code} onChange={(event) => setField("material_code", event.target.value)} disabled={!canMutate || Boolean(selected)} placeholder="VD: NVL-DUONG" />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div><Label>{c.m125}</Label><Input value={form.canonical_name} onChange={(event) => setField("canonical_name", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>{c.m126}</Label><Input value={form.default_unit} onChange={(event) => setField("default_unit", event.target.value)} disabled={!canMutate} /></div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <div><Label>{c.m127}</Label><Input value={form.category} onChange={(event) => setField("category", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>{c.m128}</Label><Input value={form.brand} onChange={(event) => setField("brand", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>{c.m129}</Label><Input value={form.specification} onChange={(event) => setField("specification", event.target.value)} disabled={!canMutate} /></div>
      </div>
      {selected && <div className="grid gap-2"><Label>{c.m130}</Label><Select value={form.activeChoice} onValueChange={(value) => setField("activeChoice", value)} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">{c.m131}</SelectItem><SelectItem value="inactive">{c.m132}</SelectItem></SelectContent></Select></div>}
      {selected && !hasPositiveVersion && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m133}</AlertTitle><AlertDescription>{c.m134}</AlertDescription></Alert>}
      <div className="grid gap-2">
        <Label>{c.m135}</Label>
        <Textarea value={form.reason} onChange={(event) => setField("reason", event.target.value)} disabled={!canMutate} placeholder={c.m136} />
        {!validReason && <p className="text-xs text-amber-700">{c.m137}</p>}
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={!canMutate || !validReason || pending || Boolean(selected && !hasPositiveVersion)}>
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
          {selected ? c.m138 : c.m139}
        </Button>
      </DialogFooter>
    </div>
  );
}

const formatVnd = (value: number | null) => value == null ? "—" : new Intl.NumberFormat("vi-VN").format(value);

const materialSuggestionKey = (row: MaterialSupplierSuggestion) =>
  `${row.supplier_id}-${row.product_sku_id || row.product_name}-${row.purchase_unit}`;

const suggestionSourceLabel = (source: MaterialSupplierSuggestion["candidate_source"], c: ProductionCopy = productionCopy.vi) => {
  if (source === "confirmed_supplier_product") return c.m140;
  if (source === "supplier_delivery_note_scan") return c.m141;
  if (source === "cogs_product_sku_exact") return c.m142;
  if (source === "payment_history_sku_exact") return c.m143;
  if (source === "payment_history_name_contains") return c.m144;
  return c.m145;
};

function MaterialSupplierReview({ selected, suppliers, canMutate }: { selected: CanonicalMaterial | null; suppliers: SupplierLite[]; canMutate: boolean }) {
  const c = useProductionCopy();
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
  const supplierActionLabel = activeSuggestionConfirmed ? c.m147 : c.m148;
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
      toast({ title: activeSuggestionConfirmed ? c.m149 : c.m150, description: c.m151 });
      if (!activeSuggestion) setSelectedKey("");
      setManualSupplierId("");
      setReason(defaultReason);
    } catch (submitError) {
      productionErrorToast("material-supplier-confirm", submitError);
    }
  };

  if (!selected) return <Card data-bmq-material-supplier-review><CardContent className="p-6 text-sm text-slate-600">{c.m154}</CardContent></Card>;

  return <Card data-bmq-material-supplier-review>
    <CardHeader><CardTitle>{c.m155}</CardTitle><CardDescription>{c.m156}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m157}</AlertTitle><AlertDescription>{c.m158}</AlertDescription></Alert>}
      {isLoading && <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
      {!isLoading && !error && suggestions.length === 0 && <Alert><AlertTitle>{c.m159}</AlertTitle><AlertDescription>{c.m160}</AlertDescription></Alert>}
      {activeSuggestion && <div className="min-w-0 rounded-2xl border bg-emerald-50 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase text-emerald-700">{activeSuggestionConfirmed ? c.m161 : c.m162}</p><h3 className="break-words text-lg font-semibold">{activeSuggestion.supplier_display_name || c.m163}</h3><p className="break-words text-sm text-slate-700">{activeSuggestion.product_code ? `${activeSuggestion.product_code} · ` : ""}{activeSuggestion.product_name}</p><p className="text-sm text-slate-700">{c.m164} <span className="font-semibold">{activeSuggestion.purchase_unit || "—"}</span> {c.m165} <span className="font-semibold">{selected.default_unit || "—"}</span></p></div>
          <Badge className="w-fit bg-white text-emerald-800 hover:bg-white">{suggestionSourceLabel(activeSuggestion.candidate_source, c)}</Badge>
        </div>
        <p className="mt-2 text-sm text-slate-600">{c.m166} {activeSuggestion.evidence_count || 0} {c.m167} {activeSuggestion.payment_candidate_count || 0} {c.m168}</p>
        {activeSuggestion.source_reference && <p className="mt-1 break-words text-sm text-slate-600">{c.m169} {activeSuggestion.source_reference}</p>}
        {activeSuggestion.package_quantity && activeSuggestion.package_unit && <p className="mt-1 text-sm text-slate-700">{c.m170} {activeSuggestion.package_quantity} {activeSuggestion.package_unit} / {activeSuggestion.purchase_unit}</p>}
      </div>}
      {suggestions.length > 0 && <div className="grid gap-2"><Label>{c.m171}</Label><Select value={activeSuggestion ? materialSuggestionKey(activeSuggestion) : ""} onValueChange={chooseSuggestion} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0"><SelectValue placeholder={c.m172} /></SelectTrigger><SelectContent>{suggestions.map((row) => <SelectItem key={materialSuggestionKey(row)} value={materialSuggestionKey(row)}>{row.supplier_display_name || c.m173} · {row.product_name} · {row.purchase_unit || "—"}</SelectItem>)}</SelectContent></Select></div>}
      <div className="grid gap-3 rounded-2xl border bg-slate-50 p-4 md:grid-cols-3">
        <div className="grid gap-2"><Label>{c.m174}</Label><Select value={manualSupplierId || "none"} onValueChange={chooseManualSupplier} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0"><SelectValue placeholder={c.m175} /></SelectTrigger><SelectContent><SelectItem value="none">{c.m176}</SelectItem>{suppliers.map((supplier) => <SelectItem key={supplier.id} value={supplier.id}>{supplier.name || c.m177}</SelectItem>)}</SelectContent></Select></div>
        <div className="grid gap-2"><Label htmlFor="manual-supplier-product-name">{c.m178}</Label><Input id="manual-supplier-product-name" value={manualProductName} onChange={(event) => setManualProductName(event.target.value)} disabled={!canMutate || !manualSupplierId} /></div>
        <div className="grid gap-2"><Label htmlFor="manual-supplier-purchase-unit">{c.m179}</Label><Input id="manual-supplier-purchase-unit" value={manualPurchaseUnit} onChange={(event) => setManualPurchaseUnit(event.target.value)} disabled={!canMutate || !manualSupplierId} /></div>
      </div>
      {manualSupplierSuggestions.length > 0 && <div className="grid gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4"><Label>{c.m180}</Label><p className="text-sm text-slate-600">{c.m181}</p><Select onValueChange={chooseSuggestion} disabled={!canMutate}><SelectTrigger className="min-h-11 min-w-0 bg-white"><SelectValue placeholder={c.m182} /></SelectTrigger><SelectContent>{manualSupplierSuggestions.map((row) => <SelectItem key={materialSuggestionKey(row)} value={materialSuggestionKey(row)}>{row.product_name} · {row.purchase_unit || "—"} · {suggestionSourceLabel(row.candidate_source, c)}</SelectItem>)}</SelectContent></Select></div>}
      {activeSuggestion?.candidate_source === "supplier_delivery_note_scan" && <div className="grid gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 sm:grid-cols-2" data-bmq-supplier-scan-conversion>
        <div className="min-w-0"><p className="font-semibold text-sky-950">{c.m183}</p><p className="text-sm text-slate-600">{c.m184}</p></div>
        <div className="grid gap-2"><Label htmlFor="supplier-scan-base-quantity">{c.m185}{activeSuggestion.purchase_unit}{c.m186} {selected.default_unit}?</Label><Input id="supplier-scan-base-quantity" inputMode="decimal" value={confirmedBaseQuantity} onChange={(event) => setBaseQuantityOverride({ key: activeConversionKey, value: event.target.value })} placeholder={`VD: 25000 ${selected.default_unit}`} disabled={!canMutate} /><p className="text-xs text-slate-600">{c.m187} {selected.default_unit}{c.m188}</p></div>
      </div>}
      {canMutate && <div className="grid gap-2"><Label htmlFor="supplier-confirm-reason">{c.m189}</Label><Textarea id="supplier-confirm-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={c.m190} /></div>}
      {canMutate && <Button className="min-h-11 w-full sm:w-auto" onClick={submit} disabled={!canConfirm || confirmSupplier.isPending}>{confirmSupplier.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}{supplierActionLabel}</Button>}
      {confirmedSuggestion && <PaymentRequestBulkSync selected={selected} suggestion={confirmedSuggestion} canMutate={canMutate} />}
    </CardContent>
  </Card>;
}

function MaterialPaymentRequestLinks({ selected }: { selected: CanonicalMaterial | null; canMutate: boolean }) {
  const c = useProductionCopy();
  const { data: paymentLinks = [], isLoading, error: paymentLinksError } = useMaterialPaymentRequestLinks(selected?.id || null);
  const linkedRows = paymentLinks.filter((row) => row.link_state === "linked");
  const candidates = paymentLinks.filter((row) => row.link_state === "candidate");

  if (!selected) return <Card data-bmq-material-payment-request-links><CardContent className="p-6 text-sm text-slate-600">{c.m191}</CardContent></Card>;

  return <Card data-bmq-material-payment-request-links>
    <CardHeader><CardTitle>{c.m192}</CardTitle><CardDescription>{c.m193}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {paymentLinksError && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m194}</AlertTitle><AlertDescription>{c.m195}</AlertDescription></Alert>}
      {isLoading && <div className="space-y-2"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
      {!isLoading && !paymentLinksError && linkedRows.length === 0 && candidates.length === 0 && <Alert><AlertTitle>{c.m196}</AlertTitle><AlertDescription>{c.m197}</AlertDescription></Alert>}
      {linkedRows.length > 0 && <section className="space-y-2"><h3 className="font-semibold">{c.m198}</h3>{linkedRows.map((row) => <PaymentRequestLinkCard key={row.payment_request_item_id} row={row} />)}</section>}
      {candidates.length > 0 && <section className="space-y-3"><div><h3 className="font-semibold">{c.m199}</h3><p className="text-sm text-slate-600">{c.m200}</p></div>{candidates.map((row) => <PaymentRequestLinkCard key={row.payment_request_item_id} row={row} />)}</section>}
    </CardContent>
  </Card>;
}

function PaymentRequestBulkSync({ selected, suggestion, canMutate }: { selected: CanonicalMaterial; suggestion: MaterialSupplierSuggestion; canMutate: boolean }) {
  const c = useProductionCopy();
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
      toast({ title: c.m202, description: formatText(c.rowsUpdated, { count: linkedCount || 0 }) });
      setReason(defaultReason);
    } catch (syncError) {
      productionErrorToast("material-payment-sync", syncError);
    }
  };

  return <div className="space-y-3 rounded-2xl border bg-white p-4" data-bmq-payment-request-bulk-sync>
    <div className="min-w-0"><h3 className="font-semibold">{c.m205}</h3><p className="break-words text-sm text-slate-600">{c.m206} {suggestion.supplier_display_name || c.m207} · {suggestion.product_name} · {suggestion.purchase_unit || selected.default_unit || "—"}</p><p className="text-sm text-slate-600">{c.m208} {suggestion.payment_candidate_count || 0} {c.m209} {suggestion.evidence_count || 0} {c.m210}</p></div>
    {(paymentPreviewLoading || paymentPreviewFetching) && <div className="space-y-2"><Skeleton className="h-16" /><p className="text-sm text-slate-600">{c.m211}</p></div>}
    {paymentPreviewError && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m212}</AlertTitle><AlertDescription>{c.m213}</AlertDescription></Alert>}
    {canMutate && <div className="grid gap-2"><Label htmlFor="payment-bulk-sync-reason">{c.m214}</Label><Textarea id="payment-bulk-sync-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={c.m215} /></div>}
    {canMutate && <Button className="min-h-11 w-full sm:w-auto" onClick={submit} disabled={!canSync || syncPaymentRequests.isPending}>{syncPaymentRequests.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}{c.m216}</Button>}
  </div>;
}

function PaymentRequestLinkCard({ row }: { row: MaterialPaymentRequestLink }) {
  const c = useProductionCopy();
  return <div className="min-w-0 rounded-xl bg-slate-50 p-3 text-sm"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="break-words font-medium">{row.product_name || row.product_code || c.m217}</p><p className="break-words text-slate-600">{row.request_number || c.m218} · {row.vendor_display_name || c.m219}</p></div>{row.link_state === "linked" && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{c.m220}</Badge>}</div><p className="mt-2 break-words text-slate-600">{row.quantity ?? "—"} {row.unit || "—"} {c.m221} {formatVnd(row.unit_price)}{c.m222} {formatVnd(row.line_total)}đ</p><p className="mt-1 text-xs text-slate-500">{c.m224} {row.request_status || "—"}</p></div>;
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
  const c = useProductionCopy();
  const supplierStatusBadge = (row: CanonicalMaterial) => {
    const supplierProductCount = supplierProductCountByMaterialId.get(row.id) || 0;
    if (supplierProductCount > 0) {
      return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{c.m225}</Badge>;
    }
    if (row.default_unit?.trim()) {
      return <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">{c.m226}</Badge>;
    }
    return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{c.m227}</Badge>;
  };

  return <Card data-bmq-cogs-rooted-material-list data-bmq-material-master-no-raw-ids data-bmq-material-master-tap-to-edit><CardHeader><CardTitle>{c.m228}</CardTitle><CardDescription>{editable ? c.m229 : c.m230}</CardDescription></CardHeader><CardContent><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>{c.m231}</TableHead><TableHead>{c.m232}</TableHead><TableHead>{c.m233}</TableHead><TableHead>{c.m234}</TableHead><TableHead>{c.m235}</TableHead><TableHead>{c.m236}</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>{materials.map((row) => <TableRow key={row.id} onClick={() => onSelect(row)} className={`${selected?.id === row.id ? "bg-emerald-50" : ""} cursor-pointer hover:bg-emerald-50/60`}><TableCell className="font-medium">{row.material_code}</TableCell><TableCell>{row.canonical_name}</TableCell><TableCell>{row.default_unit}</TableCell><TableCell>{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "—"}</TableCell><TableCell>{statusBadge(row.active, c)}</TableCell><TableCell>{supplierStatusBadge(row)}</TableCell><TableCell><Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); onEdit(row); }}><Edit3 className="mr-2 h-4 w-4" />{editable ? c.m237 : "Xem"}</Button></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden" data-bmq-material-master-mobile-cards>{materials.map((row) => {
    const hasSupplierProduct = (supplierProductCountByMaterialId.get(row.id) || 0) > 0;
    const hasStandardUnit = Boolean(row.default_unit?.trim());
    return <button key={row.id} type="button" onClick={() => onSelect(row)} className="w-full rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors active:bg-emerald-50"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold text-slate-900">{row.canonical_name}</h3>{statusBadge(row.active, c)}</div><p className="mt-1 text-sm text-slate-600">{row.material_code} · {row.default_unit || c.m238}</p><p className="mt-1 text-xs text-slate-500">{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || c.m239}</p><div className="mt-3">{supplierStatusBadge(row)}</div><p className={`mt-3 flex items-center gap-1.5 text-sm font-medium ${hasSupplierProduct || hasStandardUnit ? "text-emerald-700" : "text-amber-700"}`}><Edit3 className="h-4 w-4" />{hasSupplierProduct || hasStandardUnit ? c.m240 : editable ? c.m241 : c.m242}</p></button>;
  })}</div>{materials.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">{c.m243}</div>}</CardContent></Card>;
}

function ReadOnlyTable<T>({ title, description, rows, render }: { title: string; description: string; rows: T[]; render: (row: T, idx: number) => JSX.Element }) {
  const c = useProductionCopy();
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="space-y-3">{rows.length === 0 ? <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">{c.m244}</div> : rows.map(render)}</CardContent></Card>;
}

function QueueActions({ requests, materials, canMutate }: { requests: ResolutionRequest[]; materials: CanonicalMaterial[]; canMutate: boolean }) {
  const c = useProductionCopy();
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
      toast({ title: c.m245, description: c.m246 });
      setReason("");
      setMaterialId("");
    } catch (error) {
      productionErrorToast("material-resolution", error);
    }
  };

  return <Card><CardHeader><CardTitle>{c.m249}</CardTitle><CardDescription>{c.m250}</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-4"><Select value={requestId} onValueChange={resetForRequest} disabled={!canMutate}><SelectTrigger><SelectValue placeholder={c.m251} /></SelectTrigger><SelectContent>{requests.slice(0, 80).map((request) => <SelectItem key={request.id} value={request.id}>{request.raw_name || request.raw_code || truncateId(request.id)} · {request.status}</SelectItem>)}</SelectContent></Select><Select value={materialId} onValueChange={setMaterialId} disabled={!canMutate || action !== "resolve_existing"}><SelectTrigger><SelectValue placeholder={c.m252} /></SelectTrigger><SelectContent>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material, c)}</SelectItem>)}</SelectContent></Select><Select value={action} onValueChange={(value) => changeAction(value as "resolve_existing" | "create_new" | "reject")} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="resolve_existing">{c.m253}</SelectItem><SelectItem value="create_new">{c.m254}</SelectItem><SelectItem value="reject">{c.m255}</SelectItem></SelectContent></Select><Textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canMutate} placeholder={c.m256} className="md:col-span-3" />{action === "create_new" && <div className="grid gap-2 md:col-span-4 md:grid-cols-3"><Input value={createFields.material_code} onChange={(event) => setCreateFields((current) => ({ ...current, material_code: event.target.value }))} placeholder={c.m257} disabled={!canMutate} /><Input value={createFields.canonical_name} onChange={(event) => setCreateFields((current) => ({ ...current, canonical_name: event.target.value }))} placeholder={c.m258} disabled={!canMutate} /><Input value={createFields.default_unit} onChange={(event) => setCreateFields((current) => ({ ...current, default_unit: event.target.value }))} placeholder={c.m259} disabled={!canMutate} /><Input value={createFields.category} onChange={(event) => setCreateFields((current) => ({ ...current, category: event.target.value }))} placeholder={c.m260} disabled={!canMutate} /><Input value={createFields.brand} onChange={(event) => setCreateFields((current) => ({ ...current, brand: event.target.value }))} placeholder={c.m261} disabled={!canMutate} /><Input value={createFields.specification} onChange={(event) => setCreateFields((current) => ({ ...current, specification: event.target.value }))} placeholder={c.m262} disabled={!canMutate} /></div>}<Button onClick={run} disabled={!valid || confirm.isPending}>{confirm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{c.m263}</Button></CardContent></Card>;
}

const jsonSummary = (value: Record<string, unknown> | null | undefined) => {
  if (!value) return "—";
  return Object.entries(value).slice(0, 4).map(([key, val]) => `${key}: ${typeof val === "string" && val.length > 24 ? `${val.slice(0, 24)}…` : String(val)}`).join(" · ") || "—";
};

export default function MaterialMasterAdmin() {
  const c = useProductionCopy();
  const sectionErrorLabels: Record<string, string> = {
  materials: c.m93,
  aliases: c.m94,
  scopedAliases: c.m95,
  supplierProducts: c.m96,
  prices: c.m97,
  conversions: c.m98,
  resolutionRequests: c.m99,
  auditLogs: c.m100,
  suppliers: c.m101,
  kitchenMappings: c.m102,
  finishedSkus: c.m103,
  cogsLinks: c.m104,
};
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
  const supplierById = useMemo(() => new Map((data?.suppliers || []).map((supplier) => [supplier.id, supplier.name || c.m264])), [data?.suppliers, c.m264]);
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
    return <div className="p-6"><Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m265}</AlertTitle><AlertDescription>{c.m266}</AlertDescription></Alert></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50/80 p-3 text-slate-900 sm:p-4 md:p-6" data-production-i18n="c-production-v1" data-bmq-material-master-admin data-bmq-material-master-rbac="material_master" data-bmq-material-master-light-ui>
      <div className="mx-auto max-w-7xl space-y-4 md:space-y-5">
        <section className="rounded-3xl border border-emerald-100 bg-white p-4 shadow-sm sm:p-5">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{c.m267}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{c.m268}</p>
          </div>
        </section>

        {!canEdit && <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>{c.m269}</AlertTitle><AlertDescription>{c.m270}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m271}</AlertTitle><AlertDescription>{c.m272}</AlertDescription></Alert>}
        {data?.sectionErrors && Object.keys(data.sectionErrors).length > 0 && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m273}</AlertTitle><AlertDescription>{Object.keys(data.sectionErrors).map((section) => `${sectionErrorLabels[section] || c.m274}: ${c.loadFailed}`).join(" | ")}</AlertDescription></Alert>}
        {isLoading && <LoadingState />}

        {!isLoading && !error && <>
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={c.m275} />
                <Select value={selected?.id || "none"} onValueChange={(value) => { if (value === "none") setSelectedId(null); else { const material = materials.find((row) => row.id === value); if (material) chooseMaterial(material); } }}>
                  <SelectTrigger className="min-w-0 md:w-[360px]"><SelectValue placeholder={c.m276} /></SelectTrigger>
                  <SelectContent><SelectItem value="none">{c.m277}</SelectItem>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material, c)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {selected && <p className="mt-2 break-words text-sm text-slate-600">{c.m278} <span className="font-medium text-slate-900">{displayMaterial(selected, c)}</span></p>}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-sm md:grid-cols-5" data-bmq-material-master-business-tabs>
              <TabsTrigger className="col-span-2 min-h-11 whitespace-normal md:col-span-1" value="materials">{c.m279}</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="cogs">{c.m280}</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="q7">{c.m281}</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="suppliers">{c.m282}</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="queue">{c.m283}</TabsTrigger>
            </TabsList>

            <TabsContent value="materials" className="space-y-4">
              <ResponsiveMaterialList materials={filteredMaterials} selected={selected} supplierProductCountByMaterialId={supplierProductCountByMaterialId} onSelect={chooseMaterial} onEdit={openMaterialEditor} editable={canEdit} />
              <Dialog open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)}>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{c.m284}</DialogTitle><DialogDescription>{c.m285}</DialogDescription></DialogHeader>{selected && <MaterialMutationForm key={`edit-${selected.id}-${selected.version}`} canMutate={canMutate} selected={selected} onClose={() => setDialog(null)} />}</DialogContent>
              </Dialog>
              {selected && !(selected.version && selected.version > 0) && <p className="text-sm text-rose-700">{c.m286}</p>}

              {selected && <div className="grid gap-3 md:grid-cols-3" data-bmq-material-master-supporting-details>
                <details className="rounded-2xl border bg-white p-4">
                  <summary className="cursor-pointer font-semibold">{c.m287}</summary>
                  <div className="mt-3 space-y-2">{aliases.length === 0 ? <p className="text-sm text-slate-500">{c.m288}</p> : aliases.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.alias_name || c.m289}</p><p className="text-xs text-slate-500">{c.m290} {row.source || row.source_type || "—"}</p></div>)}</div>
                </details>
                <details className="rounded-2xl border bg-white p-4">
                  <summary className="cursor-pointer font-semibold">{c.m291}</summary>
                  <div className="mt-3 space-y-3">
                    {prices.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.price ?? "—"} / {row.price_unit || "—"}</p><p className="text-xs text-slate-500">{c.m292} {row.effective_from || "—"}</p></div>)}
                    {conversions.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">1 {row.from_unit || "—"} = {row.factor ?? "—"} {row.to_unit || "—"}</p><p className="text-xs text-slate-500">{statusBadge(row.approved, c)}</p></div>)}
                    {prices.length === 0 && conversions.length === 0 && <p className="text-sm text-slate-500">{c.m293}</p>}
                  </div>
                </details>
                <details className="rounded-2xl border bg-white p-4" data-bmq-material-master-audit-timeline>
                  <summary className="cursor-pointer font-semibold">{c.m294}</summary>
                  <div className="mt-3 space-y-2">{auditLogs.length === 0 ? <p className="text-sm text-slate-500">{c.m295}</p> : auditLogs.map((row) => <div key={row.id} className="rounded-xl bg-slate-50 p-3"><p className="font-medium">{row.action || c.m296}</p><p className="text-xs text-slate-600">{row.reason || c.m297}</p><p className="mt-1 text-xs text-slate-400">{row.created_at || "—"}</p></div>)}</div>
                </details>
              </div>}
            </TabsContent>

            <TabsContent value="cogs" className="space-y-3">
              <ReadOnlyTable<CogsMaterialLink> title={c.m298} description={c.m299} rows={cogsMappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.product_skus?.product_name || row.product_skus?.sku_code || c.m300}</h3>{linkBadge(Boolean(row.canonical_material_id), c)}</div><p className="text-sm text-slate-600">{row.product_skus?.sku_code || c.m301} · {row.dosage_qty ?? "—"} {row.unit || c.m302}</p></div>} />
            </TabsContent>

            <TabsContent value="q7" className="space-y-3">
              <ReadOnlyTable<Q7Mapping> title={c.m303} description={c.m304} rows={q7Mappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.name || row.item_code || c.warehouseMaterialFallback}</h3>{linkBadge(Boolean(row.canonical_material_id), c)}</div><p className="text-sm text-slate-600">{c.m305} {row.unit || "—"} {c.m306} {byMaterialName(materials, row.canonical_material_id, c)}</p></div>} />
            </TabsContent>

            <TabsContent value="suppliers" className="space-y-3">
              {selected && canMutate && <Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => openMaterialEditor(selected)}><Edit3 className="mr-2 h-4 w-4" />{c.m307}</Button>}
              <MaterialSupplierReview key={selected?.id || "none"} selected={selected} suppliers={data?.suppliers || []} canMutate={canMutate} />
              <MaterialPaymentRequestLinks selected={selected} canMutate={canMutate} />
              <ReadOnlyTable<SupplierProduct> title={c.m308} description={c.m309} rows={supplierProducts} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.supplier_product_name || row.supplier_product_code || c.m310}</h3>{statusBadge(row.approved, c)}</div><p className="text-sm text-slate-600">{c.m311} {supplierById.get(row.supplier_id || "") || c.m312} {c.m313} {row.purchase_unit || "—"} {c.m314} {row.base_unit || "—"}</p></div>} />
            </TabsContent>

            <TabsContent value="queue" className="space-y-4" data-bmq-material-master-resolution-queue>
              <Card><CardContent className="pt-6"><div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:items-center"><Label>{c.m315}</Label><Select value={sourceFilter} onValueChange={setSourceFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{c.m316}</SelectItem><SelectItem value="product_skus">{c.m317}</SelectItem><SelectItem value="payment_request">{c.m318}</SelectItem><SelectItem value="kitchen_inventory">{c.label3}</SelectItem></SelectContent></Select></div></CardContent></Card>
              <QueueActions requests={queueRequests} materials={materials} canMutate={canMutate} />
              <ReconciliationQueue canMutate={canMutate} sourceFilter={sourceFilter} />
            </TabsContent>
          </Tabs>

        </>}
      </div>
    </div>
  );
}
