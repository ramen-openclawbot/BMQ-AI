import { useMemo, useState } from "react";
import { Check, Clipboard, Download, Edit3, Loader2, Plus, ShieldCheck, XCircle } from "lucide-react";
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
import ControllerDashboard from "./ControllerDashboard";
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
  return materials.find((material) => material.id === id)?.canonical_name || "Chưa mapping";
}

function statusBadge(status?: string | boolean | null) {
  const text = typeof status === "boolean" ? (status ? "active" : "inactive") : status || "Chưa rõ";
  const ok = text === "active" || text === "Đã duyệt" || text === "approved";
  return <Badge variant="outline" className={ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>{text}</Badge>;
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

function MaterialMutationForm({ canMutate, selected, onClose }: MutationFormProps) {
  const { toast } = useToast();
  const createMutation = useCreateCanonicalMaterial();
  const updateMutation = useUpdateCanonicalMaterial();
  const [form, setForm] = useState(() => selected ? {
    material_code: selected.material_code || "",
    canonical_name: selected.canonical_name || "",
    default_unit: selected.default_unit || "",
    category: selected.category || "",
    brand: selected.brand || "",
    specification: selected.specification || "",
    activeChoice: selected.active === false ? "inactive" : "active",
    reason: "",
  } : emptyForm);

  const setField = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const pending = createMutation.isPending || updateMutation.isPending;
  const validReason = form.reason.trim().length > 0;
  const hasPositiveVersion = Boolean(selected && selected.version && selected.version > 0);

  const submit = async () => {
    if (!canMutate || !validReason) return;
    try {
      if (selected) {
        if (!(selected.version && selected.version > 0)) throw new Error("Cần tải lại để có version hợp lệ trước khi cập nhật.");
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
      toast({ title: selected ? "Đã cập nhật NVL chuẩn" : "Đã tạo NVL chuẩn", description: "Controller RPC đã trả trạng thái hợp lệ và ghi audit với lý do." });
      onClose?.();
    } catch (error) {
      toast({ title: "Không thể ghi thay đổi", description: error instanceof Error ? error.message : "RPC/RLS đã từ chối thao tác.", variant: "destructive" });
    }
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label>Mã NVL {selected ? "(Mã NVL không đổi)" : ""}</Label>
        <Input value={form.material_code} onChange={(event) => setField("material_code", event.target.value)} disabled={!canMutate || Boolean(selected)} placeholder="VD: NVL-DUONG" />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div><Label>Tên canonical</Label><Input value={form.canonical_name} onChange={(event) => setField("canonical_name", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Đơn vị chuẩn</Label><Input value={form.default_unit} onChange={(event) => setField("default_unit", event.target.value)} disabled={!canMutate} /></div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <div><Label>Nhóm</Label><Input value={form.category} onChange={(event) => setField("category", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Brand</Label><Input value={form.brand} onChange={(event) => setField("brand", event.target.value)} disabled={!canMutate} /></div>
        <div><Label>Quy cách/specification</Label><Input value={form.specification} onChange={(event) => setField("specification", event.target.value)} disabled={!canMutate} /></div>
      </div>
      {selected && <div className="grid gap-2"><Label>Trạng thái</Label><Select value={form.activeChoice} onValueChange={(value) => setField("activeChoice", value)} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">active</SelectItem><SelectItem value="inactive">inactive</SelectItem></SelectContent></Select><p className="text-xs text-slate-500">UI status chỉ map sang active boolean. expected_version bắt buộc.</p></div>}
      {selected && !hasPositiveVersion && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Cần tải lại để có version hợp lệ</AlertTitle><AlertDescription>Không gửi version 0/null; hãy refresh dữ liệu trước khi cập nhật.</AlertDescription></Alert>}
      <div className="grid gap-2">
        <Label>Lý do tiếng Việt bắt buộc</Label>
        <Textarea value={form.reason} onChange={(event) => setField("reason", event.target.value)} disabled={!canMutate} placeholder="VD: Chuẩn hoá tên theo hồ sơ NCC đã duyệt..." />
        {!validReason && <p className="text-xs text-amber-700">Lý do bắt buộc cho mọi mutation.</p>}
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

function ResponsiveMaterialList({ materials, selected, onSelect }: { materials: CanonicalMaterial[]; selected: CanonicalMaterial | null; onSelect: (m: CanonicalMaterial) => void }) {
  return <Card data-bmq-material-master-no-raw-ids><CardHeader><CardTitle>Danh sách NVL</CardTitle><CardDescription>Tên, mã và đơn vị là nhãn chính. Sao chép ID chỉ ở chi tiết audit.</CardDescription></CardHeader><CardContent><div className="hidden overflow-x-auto md:block"><Table><TableHeader><TableRow><TableHead>Mã</TableHead><TableHead>Tên canonical</TableHead><TableHead>Đơn vị</TableHead><TableHead>Nhóm/brand/specification</TableHead><TableHead>Status/version</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>{materials.map((row) => <TableRow key={row.id} className={selected?.id === row.id ? "bg-emerald-50" : ""}><TableCell className="font-medium">{row.material_code}</TableCell><TableCell>{row.canonical_name}</TableCell><TableCell>{row.default_unit}</TableCell><TableCell>{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "—"}</TableCell><TableCell>{statusBadge(row.active)}<span className="ml-2 text-xs text-slate-500">v{row.version || "?"}</span></TableCell><TableCell><Button variant="outline" size="sm" onClick={() => onSelect(row)}>Chọn</Button></TableCell></TableRow>)}</TableBody></Table></div><div className="space-y-3 md:hidden" data-bmq-material-master-mobile-cards>{materials.map((row) => <button key={row.id} type="button" onClick={() => onSelect(row)} className="w-full rounded-2xl border bg-white p-4 text-left shadow-sm"><div className="flex items-center justify-between gap-2"><h3 className="font-semibold text-slate-900">{row.canonical_name}</h3>{statusBadge(row.active)}</div><p className="mt-1 text-sm text-slate-600">{row.material_code} · {row.default_unit || "chưa đơn vị"}</p><p className="mt-1 text-xs text-slate-500">{[row.category, row.brand, row.specification].filter(Boolean).join(" · ") || "Chưa phân nhóm"}</p></button>)}</div>{materials.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Không có NVL chuẩn phù hợp.</div>}</CardContent></Card>;
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
      toast({ title: "Đã gửi xử lý hàng đợi", description: "confirm_material_resolution trả trạng thái/ID hợp lệ; source workflow sẽ retry link khi cần." });
      setReason("");
      setMaterialId("");
    } catch (error) {
      toast({ title: "Không thể xử lý hàng đợi", description: error instanceof Error ? error.message : "RPC/RLS từ chối thao tác.", variant: "destructive" });
    }
  };

  return <Card><CardHeader><CardTitle>Thao tác thủ công an toàn</CardTitle><CardDescription>fuzzy candidates never preselected; không tự chọn/không auto-confirm; generic request chỉ gọi confirm_material_resolution.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-4"><Select value={requestId} onValueChange={resetForRequest} disabled={!canMutate}><SelectTrigger><SelectValue placeholder="Chọn request theo tên" /></SelectTrigger><SelectContent>{requests.slice(0, 80).map((request) => <SelectItem key={request.id} value={request.id}>{request.raw_name || request.raw_code || truncateId(request.id)} · {request.status}</SelectItem>)}</SelectContent></Select><Select value={materialId} onValueChange={setMaterialId} disabled={!canMutate || action !== "resolve_existing"}><SelectTrigger><SelectValue placeholder="Chọn NVL rõ ràng" /></SelectTrigger><SelectContent>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material)}</SelectItem>)}</SelectContent></Select><Select value={action} onValueChange={(value) => changeAction(value as "resolve_existing" | "create_new" | "reject")} disabled={!canMutate}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="resolve_existing">Xác nhận existing</SelectItem><SelectItem value="create_new">Xác nhận tạo mới</SelectItem><SelectItem value="reject">Từ chối</SelectItem></SelectContent></Select><Textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canMutate} placeholder="Lý do tiếng Việt bắt buộc" className="md:col-span-3" />{action === "create_new" && <div className="grid gap-2 md:col-span-4 md:grid-cols-3"><Input value={createFields.material_code} onChange={(event) => setCreateFields((current) => ({ ...current, material_code: event.target.value }))} placeholder="Mã NVL mới (optional)" disabled={!canMutate} /><Input value={createFields.canonical_name} onChange={(event) => setCreateFields((current) => ({ ...current, canonical_name: event.target.value }))} placeholder="Tên canonical mới" disabled={!canMutate} /><Input value={createFields.default_unit} onChange={(event) => setCreateFields((current) => ({ ...current, default_unit: event.target.value }))} placeholder="Đơn vị chuẩn" disabled={!canMutate} /><Input value={createFields.category} onChange={(event) => setCreateFields((current) => ({ ...current, category: event.target.value }))} placeholder="Category optional" disabled={!canMutate} /><Input value={createFields.brand} onChange={(event) => setCreateFields((current) => ({ ...current, brand: event.target.value }))} placeholder="Brand optional" disabled={!canMutate} /><Input value={createFields.specification} onChange={(event) => setCreateFields((current) => ({ ...current, specification: event.target.value }))} placeholder="Specification optional" disabled={!canMutate} /></div>}<Button onClick={run} disabled={!valid || confirm.isPending}>{confirm.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Gửi RPC</Button></CardContent></Card>;
}

const jsonSummary = (value: Record<string, unknown> | null | undefined) => {
  if (!value) return "—";
  return Object.entries(value).slice(0, 4).map(([key, val]) => `${key}: ${typeof val === "string" && val.length > 24 ? `${val.slice(0, 24)}…` : String(val)}`).join(" · ") || "—";
};

export default function MaterialMasterAdmin() {
  const { canAccessModule, canEditModule } = useAuth();
  const canView = canAccessModule("material_master");
  const canEdit = canEditModule("material_master");
  const [editMode, setEditMode] = useState(false);
  const canMutate = canEdit && editMode;
  const { data, isLoading, error } = useMaterialMaster();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [sourceFilter, setSourceFilter] = useState("all");
  const { toast } = useToast();

  const materials = useMemo(() => data?.materials || [], [data?.materials]);
  const selected = selectedId ? materials.find((material) => material.id === selectedId) || null : null;
  const supplierById = useMemo(() => new Map((data?.suppliers || []).map((supplier) => [supplier.id, supplier.name || "NCC chưa tên"])), [data?.suppliers]);
  const filteredMaterials = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return materials;
    return materials.filter((material) => [material.material_code, material.canonical_name, material.default_unit, material.category, material.brand, material.specification].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)));
  }, [materials, search]);
  const copyMaterialId = async () => {
    if (!selected?.id) return;
    await navigator.clipboard?.writeText(selected.id);
    toast({ title: "Đã sao chép ID chi tiết", description: truncateId(selected.id) });
  };

  const aliases = [...(data?.aliases || []), ...(data?.scopedAliases || [])].filter((row) => !selected || row.material_id === selected.id);
  const supplierProducts = (data?.supplierProducts || []).filter((row) => !selected || row.material_id === selected.id);
  const prices = (data?.prices || []).filter((row) => !selected || row.material_id === selected.id);
  const conversions = (data?.conversions || []).filter((row) => !selected || row.material_id === selected.id);
  const mappings = [...(data?.kitchenMappings || []), ...(data?.skuMappings || [])];
  const auditLogs = (data?.auditLogs || []).filter((row) => !selected || row.material_id === selected.id);
  const queueRequests = useMemo(() => {
    const requests = data?.resolutionRequests || [];
    if (sourceFilter === "all") return requests;
    return requests.filter((row) => row.source_type === sourceFilter || row.source_table === sourceFilter || (sourceFilter === "kitchen_inventory" && row.source_table === "kitchen_inventory_items"));
  }, [data?.resolutionRequests, sourceFilter]);

  if (!canView) {
    return <div className="p-6"><Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không có quyền truy cập</AlertTitle><AlertDescription>Trang này yêu cầu quyền xem module Quản trị NVL chuẩn.</AlertDescription></Alert></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50/80 p-4 text-slate-900 md:p-6" data-bmq-material-master-admin data-bmq-material-master-rbac="material_master" data-bmq-material-master-light-ui data-bmq-material-master-explicit-edit-mode>
      <div className="mx-auto max-w-7xl space-y-5">
        <section className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/70 to-amber-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div><p className="text-sm font-semibold text-emerald-700">BMQ Operations · Canonical NVL Master</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Quản trị NVL chuẩn</h1><p className="mt-2 max-w-3xl text-sm text-slate-600">Fail-closed RBAC, đọc qua RLS, ghi chỉ qua audited controller RPC. Không thao tác trực tiếp DML với bảng controller.</p></div>
            <div className="flex flex-wrap gap-2"><Button variant={editMode ? "default" : "outline"} onClick={() => setEditMode((value) => !value)} disabled={!canEdit}>{editMode ? <ShieldCheck className="mr-2 h-4 w-4" /> : <Edit3 className="mr-2 h-4 w-4" />}{editMode ? "Đang sửa" : "Bật chế độ sửa"}</Button><Button variant="outline" onClick={() => setEditMode(false)}>Thoát sửa</Button><Dialog open={dialog === "create"} onOpenChange={(open) => setDialog(open ? "create" : null)}><DialogTrigger asChild><Button disabled={!canMutate}><Plus className="mr-2 h-4 w-4" />Tạo NVL</Button></DialogTrigger><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Tạo NVL chuẩn</DialogTitle><DialogDescription>Mã NVL là immutable sau khi tạo; form gọi create_canonical_material qua audited RPC.</DialogDescription></DialogHeader><MaterialMutationForm canMutate={canMutate} selected={null} onClose={() => setDialog(null)} /></DialogContent></Dialog></div>
          </div>
        </section>

        {!canEdit && <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>Chế độ chỉ đọc</AlertTitle><AlertDescription>Bạn có quyền xem nhưng không có quyền sửa material_master. Các tab supplier/alias/price hiện chỉ đọc nếu Task2 chưa có mutation RPC riêng.</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Lỗi tải dữ liệu lõi</AlertTitle><AlertDescription>RLS/RPC trả lỗi cho danh sách NVL chuẩn; không hiển thị trang rỗng gây hiểu nhầm.</AlertDescription></Alert>}
        {data?.sectionErrors && Object.entries(data.sectionErrors).length > 0 && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Một số section không tải được</AlertTitle><AlertDescription>{Object.entries(data.sectionErrors).map(([section, message]) => `${section}: ${message}`).join(" | ")}</AlertDescription></Alert>}
        {isLoading && <LoadingState />}

        {!isLoading && !error && <>
          <Card><CardContent className="pt-6"><div className="grid gap-3 md:grid-cols-[1fr_auto_auto]"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm NVL theo mã, tên, đơn vị, nhóm..." /><Select value={selected?.id || "none"} onValueChange={(value) => setSelectedId(value === "none" ? null : value)}><SelectTrigger><SelectValue placeholder="Chọn NVL" /></SelectTrigger><SelectContent><SelectItem value="none">Tất cả NVL</SelectItem>{materials.map((material) => <SelectItem key={material.id} value={material.id}>{displayMaterial(material)}</SelectItem>)}</SelectContent></Select><Button variant="outline" onClick={copyMaterialId} disabled={!selected}><Clipboard className="mr-2 h-4 w-4" />Sao chép ID chi tiết</Button></div>{selected && <p className="mt-2 text-xs text-slate-500">Đang chọn: {displayMaterial(selected)} · audit ID {truncateId(selected.id)}</p>}</CardContent></Card>

          <Tabs defaultValue="materials" className="space-y-4">
            <TabsList className="flex h-auto flex-wrap justify-start rounded-2xl bg-white p-1 shadow-sm"><TabsTrigger value="materials">Danh sách NVL</TabsTrigger><TabsTrigger value="controller">Controller shadow</TabsTrigger><TabsTrigger value="suppliers">Sản phẩm NCC</TabsTrigger><TabsTrigger value="aliases">Bí danh</TabsTrigger><TabsTrigger value="prices">Giá</TabsTrigger><TabsTrigger value="conversions">Quy đổi đơn vị</TabsTrigger><TabsTrigger value="q7">Mapping Q7</TabsTrigger><TabsTrigger value="queue">Hàng đợi xử lý</TabsTrigger><TabsTrigger value="audit">Audit</TabsTrigger></TabsList>
            <TabsContent value="materials" className="space-y-4"><ResponsiveMaterialList materials={filteredMaterials} selected={selected} onSelect={(material) => setSelectedId(material.id)} /><Dialog open={dialog === "edit"} onOpenChange={(open) => setDialog(open ? "edit" : null)}><DialogTrigger asChild><Button disabled={!canMutate || !selected || !(selected.version && selected.version > 0)}><Edit3 className="mr-2 h-4 w-4" />Sửa NVL đang chọn</Button></DialogTrigger><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Sửa NVL chuẩn</DialogTitle><DialogDescription>update_canonical_material gửi expected_version/p_patch để chống ghi đè.</DialogDescription></DialogHeader><MaterialMutationForm canMutate={canMutate} selected={selected} onClose={() => setDialog(null)} /></DialogContent></Dialog>{selected && !(selected.version && selected.version > 0) && <p className="text-sm text-rose-700">Cần tải lại để có version hợp lệ trước khi sửa.</p>}</TabsContent>
            <TabsContent value="controller" className="space-y-4"><ControllerDashboard sourceFilter={sourceFilter} onSourceFilterChange={setSourceFilter} /></TabsContent>
            <TabsContent value="suppliers"><ReadOnlyTable<SupplierProduct> title="Sản phẩm NCC" description="Read-only: mutation dành cho supplier product/price/alias cần RPC riêng; UI không insert/update/delete trực tiếp." rows={supplierProducts} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.supplier_product_name || row.supplier_product_code || "Sản phẩm NCC chưa tên"}</h3>{statusBadge(row.approved)}</div><p className="text-sm text-slate-600">NCC: {supplierById.get(row.supplier_id || "") || "Chưa rõ"} · Đơn vị mua: {row.purchase_unit || "—"} · base: {row.base_unit || "—"}</p></div>} /></TabsContent>
            <TabsContent value="aliases"><ReadOnlyTable<MaterialAlias> title="Bí danh" description="Gồm global và scoped aliases, metadata/source hiển thị để operator kiểm tra." rows={aliases} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><h3 className="font-semibold">{row.alias_name || "Bí danh chưa tên"}</h3><p className="text-sm text-slate-600">Source/metadata: {row.source || row.source_type || jsonSummary(row.metadata) || "—"} · normalized: {row.normalized_alias || "—"}</p></div>} /></TabsContent>
            <TabsContent value="prices"><ReadOnlyTable<MaterialPriceHistory> title="Giá" description="Giá đọc qua RLS: price/price_unit/normalized_base_unit_price/effective period/supplier product." rows={prices} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><h3 className="font-semibold">{row.price ?? "—"} / {row.price_unit || "—"}</h3><p className="text-sm text-slate-600">Base normalized: {row.normalized_base_unit_price ?? "—"} · Hiệu lực: {row.effective_from || "—"} → {row.effective_to || "hiện tại"} · NCC product {truncateId(row.supplier_product_id)}</p></div>} /></TabsContent>
            <TabsContent value="conversions"><ReadOnlyTable<MaterialUnitConversion> title="Quy đổi đơn vị" description="from_unit/to_unit/factor/effective_from/effective_to/approved/active." rows={conversions} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><h3 className="font-semibold">{row.from_unit || "—"} → {row.to_unit || "—"} × {row.factor ?? "—"}</h3><p className="text-sm text-slate-600">Hiệu lực: {row.effective_from || "—"} → {row.effective_to || "hiện tại"} · {statusBadge(row.approved)} {statusBadge(row.active)}</p></div>} /></TabsContent>
            <TabsContent value="q7"><ReadOnlyTable<Q7Mapping> title="Mapping Q7" description="Hiển thị mapping approved/missing; tên NVL và đơn vị là nhãn chính, ID chỉ để copy/audit." rows={mappings} render={(row, idx) => <div key={`${row.id}-${idx}`} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.name || row.product_name || row.item_code || row.sku_code || "Dòng Q7"}</h3>{statusBadge(Boolean(row.canonical_material_id))}</div><p className="text-sm text-slate-600">Đơn vị: {row.unit || "—"} · NVL: {byMaterialName(materials, row.canonical_material_id)}</p></div>} /></TabsContent>
            <TabsContent value="queue" className="space-y-4" data-bmq-material-master-resolution-queue><QueueActions requests={queueRequests} materials={materials} canMutate={canMutate} /><ReconciliationQueue canMutate={canMutate} sourceFilter={sourceFilter} /></TabsContent>
            <TabsContent value="audit" data-bmq-material-master-audit-timeline><ReadOnlyTable<MaterialAuditLog> title="Audit timeline" description="Append-only timeline từ controller; old/new/safe summary không dùng ID làm nhãn chính." rows={auditLogs} render={(row) => <div key={row.id} className="rounded-2xl border bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.action || "Sự kiện audit"}</h3><span className="text-xs text-slate-500">{row.created_at || "chưa thời gian"}</span></div><p className="mt-1 text-sm text-slate-600">Lý do: {row.reason || "—"}</p><p className="mt-1 text-xs text-slate-500">Old: {jsonSummary(row.old_values)} · New: {jsonSummary(row.new_values)} · Safe: {jsonSummary(row.safe_payload)}</p><p className="mt-1 text-xs text-slate-400">audit ID {truncateId(row.id)}</p></div>} /></TabsContent>
          </Tabs>
        </>}
      </div>
    </div>
  );
}
