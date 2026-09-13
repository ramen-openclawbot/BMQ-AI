import { productionErrorToast } from "@/i18n/ProductionErrorToast";
import { formatText } from "@/i18n/format";
import { useProductionCopy } from "@/i18n/useProductionCopy";
import { productionCopy, type ProductionCopy } from "@/i18n/production";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, ShieldCheck, SlidersHorizontal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  MaterialMasterEnforcementMode,
  MaterialMasterRolloutDashboardRow,
  useMaterialMasterRolloutDashboard,
  useSetMaterialMasterEnforcementMode,
} from "@/hooks/useMaterialMaster";

type ControllerDashboardProps = {
  sourceFilter: string;
  onSourceFilterChange: (source: string) => void;
  canEdit: boolean;
};

type ModeChangeDraft = {
  row: MaterialMasterRolloutDashboardRow;
  newMode: MaterialMasterEnforcementMode;
  title: string;
  destructive?: boolean;
  emergency?: boolean;
};

const ALL_SOURCES = "all";
const FIXED_EXACT_CONTROLLER_SOURCES = new Set(["sku_cogs", "scan_sku_cost_sheet", "kitchen_inventory"]);

const numberValue = (value: number | null | undefined) => Number(value || 0);

const normalizeMode = (mode: string | null | undefined): MaterialMasterEnforcementMode => {
  if (mode === "enforced" || mode === "disabled") return mode;
  return "shadow";
};

const modeIs = (mode: string | null | undefined, expected: MaterialMasterEnforcementMode) => normalizeMode(mode) === expected;

const formatTime = (value: string | null | undefined) => {
  if (!value) return "—";
  return value.replace("T", " ").replace(/\.\d+Z?$/, "");
};

const hasNoBlockers = (blockers: MaterialMasterRolloutDashboardRow["blockers"]) => {
  if (!blockers) return true;
  if (Array.isArray(blockers)) return blockers.length === 0;
  if (typeof blockers === "string") return blockers.trim().length === 0;
  return Object.values(blockers).every((value) => value === null || value === undefined || value === false || value === 0 || value === "");
};

const formatBlockers = (blockers: MaterialMasterRolloutDashboardRow["blockers"], c: ProductionCopy = productionCopy.vi) => {
  if (hasNoBlockers(blockers)) return c.m387;
  if (Array.isArray(blockers)) return blockers.join(" · ");
  if (typeof blockers === "string") return blockers.trim() || c.m388;
  const entries = Object.entries(blockers).filter(([, value]) => value !== null && value !== undefined && value !== false && value !== 0 && value !== "");
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : c.m389;
};

function sourceDisplayName(source: string | null | undefined, c: ProductionCopy = productionCopy.vi) {
  if (source === "kitchen_inventory") return c.m390;
  if (source === "product_skus") return c.m391;
  if (source === "supplier_products") return c.m392;
  return source || c.m393;
}

function statusBadge(row: MaterialMasterRolloutDashboardRow, c: ProductionCopy = productionCopy.vi) {
  if (row.ready_for_enforcement) {
    return <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">{c.m394}</Badge>;
  }
  return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">{c.m395}</Badge>;
}

function canPromoteToEnforced(row: MaterialMasterRolloutDashboardRow) {
  return row.ready_for_enforcement === true && numberValue(row.queue_pending_count) === 0 && hasNoBlockers(row.blockers);
}

function readinessSnapshot(row: MaterialMasterRolloutDashboardRow, newMode: MaterialMasterEnforcementMode): Record<string, unknown> {
  return {
    source_type: row.source_type,
    mode: normalizeMode(row.mode),
    queue_total_count: numberValue(row.queue_total_count),
    queue_pending_count: numberValue(row.queue_pending_count),
    queue_resolved_count: numberValue(row.queue_resolved_count),
    queue_blocked_count: numberValue(row.queue_blocked_count),
    ready_for_enforcement: row.ready_for_enforcement === true,
    blockers: row.blockers || [],
    oldest_queue_created_at: row.oldest_queue_created_at,
    latest_queue_created_at: row.latest_queue_created_at,
    mode_updated_at: row.mode_updated_at,
    reason_code: newMode === "disabled" ? "emergency_disable" : "owner_mode_change",
  };
}

export default function ControllerDashboard({ sourceFilter, onSourceFilterChange, canEdit }: ControllerDashboardProps) {
  const c = useProductionCopy();
  const { data: rows = [], isLoading, error } = useMaterialMasterRolloutDashboard();
  const setMode = useSetMaterialMasterEnforcementMode();
  const { toast } = useToast();
  const [draft, setDraft] = useState<ModeChangeDraft | null>(null);
  const [reason, setReason] = useState("");
  const [emergencyAck, setEmergencyAck] = useState(false);

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

  const openModeDialog = (row: MaterialMasterRolloutDashboardRow, newMode: MaterialMasterEnforcementMode, title: string, options: Pick<ModeChangeDraft, "destructive" | "emergency"> = {}) => {
    if (!canEdit || !row.source_type) return;
    setReason("");
    setEmergencyAck(false);
    setDraft({ row, newMode, title, ...options });
  };

  const closeModeDialog = () => {
    if (setMode.isPending) return;
    setDraft(null);
    setReason("");
    setEmergencyAck(false);
  };

  const confirmModeChange = async () => {
    if (!draft || !reason.trim() || (draft.emergency && !emergencyAck)) return;
    try {
      await setMode.mutateAsync({
        source_type: draft.row.source_type || "",
        expected_mode: normalizeMode(draft.row.mode),
        new_mode: draft.newMode,
        reason,
        readiness_snapshot: readinessSnapshot(draft.row, draft.newMode),
      });
      toast({ title: c.m396, description: formatText(c.controllerUpdated, { source: sourceDisplayName(draft.row.source_type, c), old: normalizeMode(draft.row.mode), new: draft.newMode }) });
      closeModeDialog();
    } catch (error) {
      productionErrorToast("material-controller-mode", error);
    }
  };

  const confirmDisabled = !draft || !reason.trim() || setMode.isPending || Boolean(draft.emergency && !emergencyAck);

  return (
    <div className="space-y-5" data-bmq-material-master-controller-shadow-dashboard>
      <Card className="border-emerald-100 bg-gradient-to-br from-white via-emerald-50/60 to-amber-50">
        <CardHeader>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <CardDescription>{c.label7}</CardDescription>
              <CardTitle className="mt-1 text-2xl">{c.m399}</CardTitle>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                {c.m400}
              </p>
            </div>
            <ShieldCheck className="h-10 w-10 shrink-0 text-emerald-600" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">{c.m401}</p><p className="mt-1 text-2xl font-semibold">{totals.total}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">{c.label8}</p><p className="mt-1 text-2xl font-semibold text-amber-700">{totals.pending}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">{c.label9}</p><p className="mt-1 text-2xl font-semibold text-emerald-700">{totals.resolved}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">{c.label10}</p><p className="mt-1 text-2xl font-semibold text-rose-700">{totals.blocked}</p></div>
            <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-medium text-slate-500">{c.m402}</p><p className="mt-1 text-2xl font-semibold">{totals.readySources}/{filteredRows.length}</p></div>
          </div>
        </CardContent>
      </Card>

      <Alert className="border-amber-200 bg-amber-50">
        <AlertTriangle className="h-4 w-4 text-amber-700" />
        <AlertTitle className="text-amber-800">{c.m403}</AlertTitle>
        <AlertDescription className="text-amber-700">
          {c.m404}
        </AlertDescription>
      </Alert>

      {!canEdit && <Alert><ShieldCheck className="h-4 w-4" /><AlertTitle>{c.m405}</AlertTitle><AlertDescription>{c.m406}</AlertDescription></Alert>}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5" /> {c.m407}</CardTitle>
              <CardDescription>{c.m408}</CardDescription>
            </div>
            <Select value={sourceFilter} onValueChange={onSourceFilterChange}>
              <SelectTrigger className="w-full md:w-64" data-bmq-material-master-source-filter>
                <SelectValue placeholder={c.m409} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_SOURCES}>{c.m410}</SelectItem>
                <SelectItem value="kitchen_inventory">{sourceDisplayName("kitchen_inventory", c)}</SelectItem>
                {sourceOptions.filter((source) => source !== "kitchen_inventory").map((source) => <SelectItem key={source} value={source}>{sourceDisplayName(source, c)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <div className="grid gap-3 md:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>}
          {error && <Alert variant="destructive"><XCircle className="h-4 w-4" /><AlertTitle>{c.m411}</AlertTitle><AlertDescription>{c.m412}</AlertDescription></Alert>}
          {!isLoading && !error && filteredRows.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">{c.m413}</div>}
          {!isLoading && !error && filteredRows.map((row) => (
            <div key={row.source_type || "unknown"} className="rounded-2xl border bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-900">{sourceDisplayName(row.source_type, c)}</h3>
                    {statusBadge(row, c)}
                    <Badge variant="outline">{c.label11} {row.mode || "shadow"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{c.label12} {row.source_type || "—"}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500"><Clock3 className="h-4 w-4" /> {formatTime(row.oldest_queue_created_at)} → {formatTime(row.latest_queue_created_at)}</div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{c.label13}</p><p className="text-xl font-semibold">{numberValue(row.queue_total_count)}</p></div>
                <div className="rounded-xl bg-amber-50 p-3"><p className="text-xs text-amber-700">{c.label8}</p><p className="text-xl font-semibold text-amber-800">{numberValue(row.queue_pending_count)}</p></div>
                <div className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-emerald-700">{c.label9}</p><p className="text-xl font-semibold text-emerald-800">{numberValue(row.queue_resolved_count)}</p></div>
                <div className="rounded-xl bg-rose-50 p-3"><p className="text-xs text-rose-700">{c.label10}</p><p className="text-xl font-semibold text-rose-800">{numberValue(row.queue_blocked_count)}</p></div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                {row.ready_for_enforcement ? <CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-600" /> : <AlertTriangle className="mr-2 inline h-4 w-4 text-amber-600" />}
                {c.label14} {formatBlockers(row.blockers, c)}
              </div>
              {canEdit && row.source_type && FIXED_EXACT_CONTROLLER_SOURCES.has(row.source_type) && (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" data-bmq-material-master-fixed-enforcement>
                  {c.m414}
                </div>
              )}
              {canEdit && (!row.source_type || !FIXED_EXACT_CONTROLLER_SOURCES.has(row.source_type)) && (
                <div className="mt-4 flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3 sm:flex-row sm:flex-wrap" data-bmq-material-master-owner-mode-controls>
                  <Button type="button" className="w-full sm:w-auto" disabled={!canPromoteToEnforced(row) || modeIs(row.mode, "enforced") || !row.source_type} onClick={() => openModeDialog(row, "enforced", c.m415)}>{c.label15}</Button>
                  <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={!modeIs(row.mode, "enforced") || !row.source_type} onClick={() => openModeDialog(row, "shadow", "Rollback enforced → shadow")}>{c.label16}</Button>
                  <Button type="button" variant="destructive" className="w-full sm:w-auto" disabled={modeIs(row.mode, "disabled") || !row.source_type} onClick={() => openModeDialog(row, "disabled", c.m416, { destructive: true, emergency: true })}>{c.label17}</Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(draft)} onOpenChange={(open) => !open && closeModeDialog()}>
        <AlertDialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>{draft ? (draft.newMode === "enforced" ? c.m415 : draft.newMode === "disabled" ? c.m416 : c.rollbackTitle) : c.m417}</AlertDialogTitle>
            <AlertDialogDescription>
              {c.m418}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {draft && (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 rounded-xl border bg-slate-50 p-3 sm:grid-cols-2">
                <div><span className="font-medium">{c.m419}</span><p>{sourceDisplayName(draft.row.source_type, c)} · {draft.row.source_type}</p></div>
                <div><span className="font-medium">{c.m420}</span><p>{normalizeMode(draft.row.mode)}</p></div>
                <div><span className="font-medium">{c.m421}</span><p>{draft.newMode}</p></div>
                <div><span className="font-medium">{c.label8}</span><p>{numberValue(draft.row.queue_pending_count)}</p></div>
              </div>
              <div className="rounded-xl border bg-white p-3">
                <p className="font-medium">{c.label18}</p>
                <p className="mt-1 text-slate-600">{c.label19} {draft.row.ready_for_enforcement ? "true" : "false"}  {c.label20} {numberValue(draft.row.queue_total_count)}  {c.label21} {numberValue(draft.row.queue_resolved_count)}  {c.label22} {numberValue(draft.row.queue_blocked_count)}</p>
                <p className="mt-1 text-slate-600">{c.label14} {formatBlockers(draft.row.blockers, c)}</p>
              </div>
              {draft.emergency && (
                <label className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-800">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={emergencyAck} onChange={(event) => setEmergencyAck(event.target.checked)} />
                  <span>{c.m422}</span>
                </label>
              )}
              <div className="grid gap-2">
                <label className="font-medium" htmlFor="material-master-mode-reason">{c.m423}</label>
                <Textarea id="material-master-mode-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder={c.m424} />
                {!reason.trim() && <p className="text-xs text-amber-700">{c.m425}</p>}
              </div>
            </div>
          )}
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel disabled={setMode.isPending}>{c.m426}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmModeChange} disabled={confirmDisabled} className={draft?.destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
              {setMode.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {c.m427}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
