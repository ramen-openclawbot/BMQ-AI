import { useMemo, useState } from "react";
import { Check, Edit3, Loader2, Plus, ShieldCheck, XCircle } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  CanonicalMaterial,
  MaterialAlias,
  MaterialAuditLog,
  MaterialPriceHistory,
  MaterialUnitConversion,
  Q7Mapping,
  ResolutionRequest,
  SupplierProduct,
  useConfirmMaterialResolution,
  useCreateCanonicalMaterial,
  useMaterialMaster,
  useUpdateCanonicalMaterial,
} from "@/hooks/useMaterialMaster";
import ReconciliationQueue from "./ReconciliationQueue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
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
      {selected && !hasPositiveVersion && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Cần tải lại dữ liệu</AlertTitle><AlertDescription>Thông tin NVL vừa thay đổi ở nơi khác. Hãy tải lại trước khi sửa.</AlertDescription></Alert>}
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

function ResponsiveMaterialList({ materials, selected, onSelect, editable }: { materials: CanonicalMaterial[]; selected: CanonicalMaterial | null; onSelect: (m: CanonicalMaterial) => void; editable: boolean }) {
  return <Card data-bmq-material-master-no-raw-ids data-bmq-material-master-tap-to-edit><CardHeader><CardTitle>Tên và đơn vị chuẩn</CardTitle><CardDescription>{editable ? "Chạm vào NVL để sửa tên, đơn vị, nhóm hoặc quy cách." : "Chạm vào NVL để xem các liên kết đang sử dụng."}</CardDescription></CardHeader><CardContent><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>Mã NVL</TableHead><TableHead>Tên NVL chuẩn</TableHead><TableHead>Đơn vị chuẩn</TableHead><TableHead>Nhóm · Thương hiệu · Quy cách</TableHead><TableHead>Trạng thái</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>{materials.map((row) => <TableRow key={row.id} onClick={() => onSelect(row)} className={`${selected?.id === row.id ? "bg-emerald-50" : ""} cursor-pointer hover:bg-emerald-50/60`}><TableCell className="font-medium">{row.material_code}</TableCell><TableCell>{row.canonical_name}</TableCell><TableCell>{row.default_unit}</TableCell><TableCell>{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "—"}</TableCell><TableCell>{statusBadge(row.active)}</TableCell><TableCell><Button variant="outline" size="sm" onClick={(event) => { event.stopPropagation(); onSelect(row); }}><Edit3 className="mr-2 h-4 w-4" />{editable ? "Sửa" : "Xem"}</Button></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden" data-bmq-material-master-mobile-cards>{materials.map((row) => <button key={row.id} type="button" onClick={() => onSelect(row)} className="w-full rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors active:bg-emerald-50"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-words font-semibold text-slate-900">{row.canonical_name}</h3>{statusBadge(row.active)}</div><p className="mt-1 text-sm text-slate-600">{row.material_code} · {row.default_unit || "chưa có đơn vị"}</p><p className="mt-1 text-xs text-slate-500">{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "Chưa phân nhóm"}</p><p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700"><Edit3 className="h-4 w-4" />{editable ? "Chạm để sửa" : "Chạm để xem liên kết"}</p></button>)}</div>{materials.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Không có NVL chuẩn phù hợp.</div>}</CardContent></Card>;
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
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
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
  const supplierProducts = (data?.supplierProducts || []).filter((row) => !selected || row.material_id === selected.id);
  const prices = (data?.prices || []).filter((row) => !selected || row.material_id === selected.id);
  const conversions = (data?.conversions || []).filter((row) => !selected || row.material_id === selected.id);
  const q7Mappings = (data?.kitchenMappings || []).filter((row) => !selected || row.canonical_material_id === selected.id);
  const cogsMappings = (data?.skuMappings || []).filter((row) => !selected || row.canonical_material_id === selected.id);
  const auditLogs = (data?.auditLogs || []).filter((row) => !selected || row.material_id === selected.id);
  const queueRequests = useMemo(() => {
    const requests = data?.resolutionRequests || [];
    if (sourceFilter === "all") return requests;
    return requests.filter((row) => row.source_type === sourceFilter || row.source_table === sourceFilter || (sourceFilter === "kitchen_inventory" && row.source_table === "kitchen_inventory_items"));
  }, [data?.resolutionRequests, sourceFilter]);
  const openConfirmationQueue = (source: string) => {
    setSourceFilter(source);
    setActiveTab("queue");
  };
  const openMaterialEditor = (material: CanonicalMaterial) => {
    setSelectedId(material.id);
    if (canEdit) setDialog("edit");
  };

  if (!canView) {
    return <div className="p-6"><Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không có quyền truy cập</AlertTitle><AlertDescription>Trang này yêu cầu quyền xem module Quản trị NVL chuẩn.</AlertDescription></Alert></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50/80 p-3 text-slate-900 sm:p-4 md:p-6" data-bmq-material-master-admin data-bmq-material-master-rbac="material_master" data-bmq-material-master-light-ui>
      <div className="mx-auto max-w-7xl space-y-4 md:space-y-5">
        <section className="rounded-3xl border border-emerald-100 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Danh mục nguyên vật liệu</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Chạm vào một NVL để sửa tên và đơn vị chuẩn. Thay đổi sẽ dùng chung trong Giá vốn, phiếu xuất kho NVL Q7 và sản phẩm Nhà cung cấp.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Dialog open={dialog === "create"} onOpenChange={(open) => setDialog(open ? "create" : null)}>
                <DialogTrigger asChild><Button className="min-h-11 w-full sm:w-auto" disabled={!canMutate}><Plus className="mr-2 h-4 w-4" />Thêm NVL</Button></DialogTrigger>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Thêm NVL chuẩn</DialogTitle><DialogDescription>Tạo tên và đơn vị chuẩn mới để liên kết thống nhất giữa các nghiệp vụ.</DialogDescription></DialogHeader><MaterialMutationForm canMutate={canMutate} selected={null} onClose={() => setDialog(null)} /></DialogContent>
              </Dialog>
            </div>
          </div>
        </section>

        {!canEdit && <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>Chế độ chỉ xem</AlertTitle><AlertDescription>Anh có thể xem các liên kết nhưng cần quyền chỉnh sửa để đổi tên, đơn vị hoặc xác nhận liên kết.</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được danh mục NVL</AlertTitle><AlertDescription>Vui lòng tải lại trang. Nếu vẫn lỗi, báo quản trị hệ thống.</AlertDescription></Alert>}
        {data?.sectionErrors && Object.entries(data.sectionErrors).length > 0 && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Một số thông tin liên kết chưa tải được</AlertTitle><AlertDescription>{Object.entries(data.sectionErrors).map(([section, message]) => `${section}: ${message}`).join(" | ")}</AlertDescription></Alert>}
        {isLoading && <LoadingState />}

        {!isLoading && !error && <>
          <Card>
            <CardContent className="pt-6">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm theo mã, tên NVL, đơn vị hoặc nhóm..." />
                <Select value={selected?.id || "none"} onValueChange={(value) => { if (value === "none") setSelectedId(null); else { const material = materials.find((row) => row.id === value); if (material) openMaterialEditor(material); } }}>
                  <SelectTrigger className="min-w-0 md:w-[360px]"><SelectValue placeholder="Chọn NVL" /></SelectTrigger>
                  <SelectContent><SelectItem value="none">Tất cả NVL</SelectItem>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {selected && <p className="mt-2 break-words text-sm text-slate-600">Đang chọn: <span className="font-medium text-slate-900">{displayMaterial(selected)}</span></p>}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-sm md:grid-cols-5" data-bmq-material-master-business-tabs>
              <TabsTrigger className="col-span-2 min-h-11 whitespace-normal md:col-span-1" value="materials">Tên & đơn vị chuẩn</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="cogs">Liên kết Giá vốn</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="q7">Phiếu xuất kho Q7</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="suppliers">Sản phẩm Nhà cung cấp</TabsTrigger>
              <TabsTrigger className="min-h-11 whitespace-normal" value="queue">Cần xác nhận</TabsTrigger>
            </TabsList>

            <TabsContent value="materials" className="space-y-4">
              <ResponsiveMaterialList materials={filteredMaterials} selected={selected} onSelect={openMaterialEditor} editable={canEdit} />
              <Dialog open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)}>
                <DialogContent className="max-h-[90dvh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Sửa tên và đơn vị chuẩn</DialogTitle><DialogDescription>Thay đổi này sẽ được lưu lịch sử để kiểm tra khi cần.</DialogDescription></DialogHeader><MaterialMutationForm key={`edit-${selected?.id}-${selected?.version}`} canMutate={canMutate} selected={selected} onClose={() => setDialog(null)} /></DialogContent>
              </Dialog>
              {selected && !(selected.version && selected.version > 0) && <p className="text-sm text-rose-700">Dữ liệu vừa thay đổi. Vui lòng tải lại trước khi sửa.</p>}

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
              <ReadOnlyTable<Q7Mapping> title="Liên kết Giá vốn" description="Tên và đơn vị NVL đang được công thức Giá vốn sử dụng." rows={cogsMappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.product_name || row.sku_code || row.item_code || "Dòng Giá vốn"}</h3>{linkBadge(Boolean(row.canonical_material_id))}</div><p className="text-sm text-slate-600">Đơn vị: {row.unit || "—"} · NVL chuẩn: {byMaterialName(materials, row.canonical_material_id)}</p></div>} />
              <Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => openConfirmationQueue("product_skus")}>Đi tới Cần xác nhận</Button>
            </TabsContent>

            <TabsContent value="q7" className="space-y-3">
              <ReadOnlyTable<Q7Mapping> title="Phiếu xuất kho NVL Q7" description="Tên và đơn vị NVL dùng khi lập phiếu xuất kho bếp Q7." rows={q7Mappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.name || row.item_code || "NVL kho Q7"}</h3>{linkBadge(Boolean(row.canonical_material_id))}</div><p className="text-sm text-slate-600">Đơn vị: {row.unit || "—"} · NVL chuẩn: {byMaterialName(materials, row.canonical_material_id)}</p></div>} />
              <Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => openConfirmationQueue("kitchen_inventory")}>Đi tới Cần xác nhận</Button>
            </TabsContent>

            <TabsContent value="suppliers" className="space-y-3">
              <ReadOnlyTable<SupplierProduct> title="Sản phẩm Nhà cung cấp" description="Tên hàng và đơn vị mua của Nhà cung cấp đã liên kết với NVL chuẩn." rows={supplierProducts} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.supplier_product_name || row.supplier_product_code || "Sản phẩm chưa đặt tên"}</h3>{statusBadge(row.approved)}</div><p className="text-sm text-slate-600">Nhà cung cấp: {supplierById.get(row.supplier_id || "") || "Chưa rõ"} · Đơn vị mua: {row.purchase_unit || "—"} · Đơn vị chuẩn: {row.base_unit || "—"}</p></div>} />
              <Button variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => openConfirmationQueue("all")}>Đi tới Cần xác nhận</Button>
            </TabsContent>

            <TabsContent value="queue" className="space-y-4" data-bmq-material-master-resolution-queue>
              <Card><CardContent className="pt-6"><div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:items-center"><Label>Lọc theo nơi sử dụng</Label><Select value={sourceFilter} onValueChange={setSourceFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Tất cả</SelectItem><SelectItem value="product_skus">Giá vốn</SelectItem><SelectItem value="kitchen_inventory">Kho NVL Q7</SelectItem></SelectContent></Select></div></CardContent></Card>
              <QueueActions requests={queueRequests} materials={materials} canMutate={canMutate} />
              <ReconciliationQueue canMutate={canMutate} sourceFilter={sourceFilter} />
            </TabsContent>
          </Tabs>

        </>}
      </div>
    </div>
  );
}
