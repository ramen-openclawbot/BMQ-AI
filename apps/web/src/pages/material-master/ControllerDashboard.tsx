import { AlertTriangle, CheckCircle2, Clock3, ShieldCheck, SlidersHorizontal, XCircle } from "lucide-react";
import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MaterialMasterRolloutDashboardRow, useMaterialMasterRolloutDashboard } from "@/hooks/useMaterialMaster";

type ControllerDashboardProps = {
  sourceFilter: string;
  onSourceFilterChange: (source: string) => void;
};

const ALL_SOURCES = "all";

const numberValue = (value: number | null | undefined) => Number(value || 0);

const formatTime = (value: string | null | undefined) => {
  if (!value) return "—";
  return value.replace("T", " ").replace(/\.\d+Z?$/, "");
};

const formatBlockers = (blockers: MaterialMasterRolloutDashboardRow["blockers"]) => {
  if (!blockers) return "Không có blocker được báo cáo.";
  if (Array.isArray(blockers)) return blockers.length ? blockers.join(" · ") : "Không có blocker được báo cáo.";
  if (typeof blockers === "string") return blockers.trim() || "Không có blocker được báo cáo.";
  const entries = Object.entries(blockers).filter(([, value]) => value !== null && value !== undefined && value !== false && value !== 0);
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "Không có blocker được báo cáo.";
};

function sourceDisplayName(source: string | null | undefined) {
  if (source === "kitchen_inventory") return "Q7 / kho bếp";
  if (source === "product_skus") return "SKU bán hàng";
  if (source === "supplier_products") return "Sản phẩm NCC";
  return source || "Nguồn chưa rõ";
}

function statusBadge(row: MaterialMasterRolloutDashboardRow) {
  if (row.ready_for_enforcement) {
    return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">Sẵn sàng enforcement</Badge>;
  }
  return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">Shadow / còn blocker</Badge>;
}

export default function ControllerDashboard({ sourceFilter, onSourceFilterChange }: ControllerDashboardProps) {
  const { data: rows = [], isLoading, error } = useMaterialMasterRolloutDashboard();

  const sourceOptions = useMemo(() => {
    const keys = new Set(rows.map((row) => row.source_type).filter(Boolean) as string[]);
    keys.add("kitchen_inventory");
    return Array.from(keys).sort((left, right) => sourceDisplayName(left).localeCompare(sourceDisplayName(right), "vi"));
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (sourceFilter === ALL_SOURCES) return rows;
    return rows.filter((row) => row.source_type === sourceFilter);
  }, [rows, sourceFilter]);

  const totals = useMemo(() => filteredRows.reduce(
    (acc, row) => ({
      total: acc.total + numberValue(row.queue_total_count),
      pending: acc.pending + numberValue(row.queue_pending_count),
      resolved: acc.resolved + numberValue(row.queue_resolved_count),
      blocked: acc.blocked + numberValue(row.queue_blocked_count),
      readySources: acc.readySources + (row.ready_for_enforcement ? 1 : 0),
    }),
    { total: 0, pending: 0, resolved: 0, blocked: 0, readySources: 0 }
  ), [filteredRows]);

  return (
    <div className="space-y-5" data-bmq-material-master-controller-shadow-dashboard>
      <Card className="border-emerald-100 bg-gradient-to-br from-white via-emerald-50/60 to-amber-50">
        <CardHeader>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <CardDescription>Canonical NVL Controller · shadow rollout</CardDescription>
              <CardTitle className="mt-1 text-2xl">Dashboard giám sát controller</CardTitle>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                Read-only dashboard gọi RPC get_material_master_rollout_dashboard; không DML trực tiếp vào bảng config/controller. Dùng bộ lọc nguồn để drill hàng đợi an toàn bên tab Hàng đợi xử lý.
              </p>
            </div>
            <ShieldCheck className="h-10 w-10 shrink-0 text-emerald-600" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">Tổng queue</p><p className="mt-1 text-2xl font-semibold">{totals.total}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">Pending</p><p className="mt-1 text-2xl font-semibold text-amber-700">{totals.pending}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">Resolved</p><p className="mt-1 text-2xl font-semibold text-emerald-700">{totals.resolved}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">Blocked</p><p className="mt-1 text-2xl font-semibold text-rose-700">{totals.blocked}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">Nguồn ready</p><p className="mt-1 text-2xl font-semibold">{totals.readySources}/{filteredRows.length}</p></div>
          </div>
        </CardContent>
      </Card>

      <Alert className="border-amber-200 bg-amber-50">
        <AlertTriangle className="h-4 w-4 text-amber-700" />
        <AlertTitle className="text-amber-800">Cảnh báo vận hành: fuzzy/AI chỉ là gợi ý</AlertTitle>
        <AlertDescription className="text-amber-700">
          chỉ exact alias/code/name đã duyệt mới auto-resolve. Hàng đợi confirmation luôn xử lý thủ công qua confirm_material_resolution, không preselect ứng viên ambiguous/fuzzy và luôn yêu cầu lý do rõ ràng.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5" /> Bộ lọc nguồn shadow</CardTitle>
              <CardDescription>Chọn nguồn ở đây để xem dashboard và drill/filter queue bằng local UI state; không ghi config.</CardDescription>
            </div>
            <Select value={sourceFilter} onValueChange={onSourceFilterChange}>
              <SelectTrigger className="w-full md:w-64" data-bmq-material-master-source-filter>
                <SelectValue placeholder="Lọc nguồn" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SOURCES}>Tất cả nguồn</SelectItem>
                <SelectItem value="kitchen_inventory">{sourceDisplayName("kitchen_inventory")}</SelectItem>
                {sourceOptions.filter((source) => source !== "kitchen_inventory").map((source) => <SelectItem key={source} value={source}>{sourceDisplayName(source)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>}
          {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>Không tải được dashboard</AlertTitle><AlertDescription>RPC get_material_master_rollout_dashboard bị RLS/quyền chặn hoặc chưa triển khai.</AlertDescription></Alert>}
          {!isLoading && !error && filteredRows.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">Không có nguồn phù hợp bộ lọc.</div>}
          {!isLoading && !error && filteredRows.map((row) => (
            <div key={row.source_type || "unknown"} className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-900">{sourceDisplayName(row.source_type)}</h3>
                    {statusBadge(row)}
                    <Badge variant="outline">mode: {row.mode || "shadow"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">Source key: {row.source_type || "—"}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500"><Clock3 className="h-4 w-4" /> {formatTime(row.oldest_queue_created_at)} → {formatTime(row.latest_queue_created_at)}</div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Queue</p><p className="text-xl font-semibold">{numberValue(row.queue_total_count)}</p></div>
                <div className="rounded-xl bg-amber-50 p-3"><p className="text-xs text-amber-700">Pending</p><p className="text-xl font-semibold text-amber-800">{numberValue(row.queue_pending_count)}</p></div>
                <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-700">Resolved</p><p className="text-xl font-semibold text-emerald-800">{numberValue(row.queue_resolved_count)}</p></div>
                <div className="rounded-xl bg-rose-50 p-3"><p className="text-xs text-rose-700">Blocked</p><p className="text-xl font-semibold text-rose-800">{numberValue(row.queue_blocked_count)}</p></div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                {row.ready_for_enforcement ? <CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-600" /> : <AlertTriangle className="mr-2 inline h-4 w-4 text-amber-600" />}
                Blockers: {formatBlockers(row.blockers)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
