import { materialErrorText } from "@/i18n/productionErrors";
import { useProductionCopy } from "@/i18n/useProductionCopy";
import { productionCopy, type ProductionCopy } from "@/i18n/production";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardList, Loader2, Search, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type QueueDecision = "auto_ready" | "review" | "blocked";

const EXACT_CANDIDATE_SOURCES = new Set([
  "material_code",
  "normalized_canonical_name",
  "approved_supplier_alias",
  "approved_source_alias",
  "approved_global_alias",
]);

type ResolutionRequestRow = {
  id: string;
  source_type: string;
  source_table: string;
  source_id: string | null;
  supplier_id: string | null;
  raw_name: string;
  raw_code: string | null;
  raw_unit: string | null;
  status: string;
  candidate_status: string | null;
  resolved_material_id: string | null;
  reviewed_at: string | null;
  reviewer_reason: string | null;
  safe_payload: Record<string, unknown> | null;
  material?: { canonical_name: string | null; material_code: string | null; default_unit: string | null } | null;
};

const hasExactTask3Evidence = (row: ResolutionRequestRow): boolean => {
  const payload = row.safe_payload || {};
  return (
    EXACT_CANDIDATE_SOURCES.has(String(payload.candidate_source || "")) &&
    payload.confidence === "exact" &&
    payload.field_name === "task3_reconciliation"
  );
};

const canOfferExactLink = (row: ResolutionRequestRow): boolean => {
  return row.status === "resolved_existing" && Boolean(row.resolved_material_id) && hasExactTask3Evidence(row);
};

const decisionForRow = (row: ResolutionRequestRow): QueueDecision => {
  if (canOfferExactLink(row)) return "auto_ready";
  if (row.candidate_status === "ambiguous" || row.status === "rejected") return "blocked";
  return "review";
};



const sourceLabel = (row: ResolutionRequestRow, c: ProductionCopy = productionCopy.vi) => row.source_table === "kitchen_inventory_items" ? c.m431 : row.source_table === "product_skus" ? c.m432 : c.m433;

const decisionClass: Record<QueueDecision, string> = {
  auto_ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
  review: "border-amber-200 bg-amber-50 text-amber-700",
  blocked: "border-rose-200 bg-rose-50 text-rose-700",
};

export default function ReconciliationQueue({ canMutate = false, sourceFilter = "all" }: { canMutate?: boolean; sourceFilter?: string }) {
  const c = useProductionCopy();
  const decisionLabel: Record<QueueDecision, string> = {
  auto_ready: c.m428,
  review: c.m429,
  blocked: c.m430,
};
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [decisionFilter, setDecisionFilter] = useState<QueueDecision | "all">("all");
  const [searchText, setSearchText] = useState("");

  const db = supabase as any;
  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ["material-master", "material_resolution_requests", "task3"],
    queryFn: async () => {
      const { data, error: queryError } = await db
        .from("material_resolution_requests")
        .select("id, source_type, source_table, source_id, supplier_id, raw_name, raw_code, raw_unit, status, candidate_status, resolved_material_id, reviewed_at, reviewer_reason, safe_payload")
        .in("source_table", ["kitchen_inventory_items", "product_skus"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (queryError) throw queryError;
      const requestRows = (data || []) as ResolutionRequestRow[];
      const materialIds = Array.from(new Set(requestRows.map((row) => row.resolved_material_id).filter(Boolean))) as string[];
      if (materialIds.length === 0) return requestRows;
      const { data: materials, error: materialError } = await db
        .from("sku_cogs_materials")
        .select("id, canonical_name, material_code, default_unit")
        .in("id", materialIds);
      if (materialError) throw materialError;
      const byId = new Map<string, ResolutionRequestRow["material"]>((materials || []).map((material: any) => [material.id, material]));
      return requestRows.map((row): ResolutionRequestRow => ({ ...row, material: row.resolved_material_id ? byId.get(row.resolved_material_id) || null : null }));
    },
  });

  const counts = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc[decisionForRow(row)] += 1;
        return acc;
      },
      { auto_ready: 0, review: 0, blocked: 0 } as Record<QueueDecision, number>
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    return rows.filter((row) => {
      const decision = decisionForRow(row);
      if (sourceFilter !== "all" && row.source_type !== sourceFilter && row.source_table !== sourceFilter && !(sourceFilter === "kitchen_inventory" && row.source_table === "kitchen_inventory_items")) return false;
      if (decisionFilter !== "all" && decision !== decisionFilter) return false;
      if (!needle) return true;
      return [row.raw_name, row.raw_code, row.raw_unit, row.material?.canonical_name, row.material?.material_code]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [decisionFilter, rows, searchText, sourceFilter]);

  const linkMutation = useMutation({
    mutationFn: async (row: ResolutionRequestRow) => {
      if (!row.source_id || !row.resolved_material_id) throw new Error(c.m434);
      const { data, error: rpcError } = await db.rpc("link_approved_material_resolution", {
        p_request_id: row.id,
        p_source_table: row.source_table,
        p_source_id: row.source_id,
        p_expected_material_id: row.resolved_material_id,
        p_reason: "Task3 reviewed exact reconciliation from queue",
      });
      if (rpcError) throw rpcError;
      return data;
    },
    onSuccess: () => {
      toast({ title: c.m435, description: c.m436 });
      queryClient.invalidateQueries({ queryKey: ["material-master", "material_resolution_requests", "task3"] });
    },
    onError: (mutationError: any) => {
      toast({ title: c.m437, description: mutationError?.message || c.m438, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-5 p-4 md:p-6" data-task3-reconciliation-queue>
      <div className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50 via-white to-amber-50 p-5 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-700">{c.m439}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{c.m440}</h1>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              {c.m441}
            </p>
          </div>
          <ShieldCheck className="h-10 w-10 text-emerald-600" />
        </div>
      </div>

      <Alert className="border-amber-200 bg-amber-50">
        <AlertTriangle className="h-4 w-4 text-amber-700" />
        <AlertTitle className="text-amber-800">{c.m442}</AlertTitle>
        <AlertDescription className="text-amber-700">
          {c.m443}
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 md:grid-cols-3">
        {(Object.keys(decisionLabel) as QueueDecision[]).map((key) => (
          <Card key={key} className="border-slate-200">
            <CardHeader className="pb-2">
              <CardDescription>{decisionLabel[key]}</CardDescription>
              <CardTitle className="text-2xl">{counts[key]}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><ClipboardList className="h-5 w-5" /> {c.m444}</CardTitle>
              <CardDescription>{c.m445}</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={c.m446} className="pl-9" />
              </div>
              <Select value={decisionFilter} onValueChange={(value) => setDecisionFilter(value as QueueDecision | "all")}>
                <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder={c.m447} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{c.m448}</SelectItem>
                  <SelectItem value="auto_ready">{c.m449}</SelectItem>
                  <SelectItem value="review">{c.m450}</SelectItem>
                  <SelectItem value="blocked">{c.m451}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> {c.m452}</div>}
          {error && <div className="text-sm text-rose-600">{c.m453}</div>}
          {!isLoading && filteredRows.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-slate-500">{c.m454}</div>}
          {filteredRows.map((row) => {
            const decision = decisionForRow(row);
            const exactEvidenceReady = canOfferExactLink(row);
            const evidence = String(row.safe_payload?.candidate_source || row.candidate_status || c.m455);
            return (
              <div key={row.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-slate-900">{row.raw_name}</h3>
                      <Badge variant="outline" className={decisionClass[decision]}>{decisionLabel[decision]}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{c.m456} {row.material?.canonical_name || c.m457} {row.material?.material_code ? `· ${row.material.material_code}` : ""}</p>
                    <p className="mt-1 text-xs text-slate-500">{c.m458} {sourceLabel(row, c)}</p>
                  </div>
                  {exactEvidenceReady && canMutate && (
                    <Button size="sm" onClick={() => linkMutation.mutate(row)} disabled={linkMutation.isPending}>
                      {linkMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                      {c.m459}
                    </Button>
                  )}
                </div>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <div className="rounded-xl bg-slate-50 p-3"><p className="font-medium text-slate-700">{c.m460}</p><p className="mt-1 text-slate-600">{evidence}</p></div>
                  <div className="rounded-xl bg-slate-50 p-3"><p className="font-medium text-slate-700">{c.m461}</p><p className="mt-1 text-slate-600">{row.raw_unit || c.m462}</p></div>
                  <div className="rounded-xl bg-slate-50 p-3"><p className="font-medium text-slate-700">{c.m463}</p><p className="mt-1 text-slate-600">{row.material?.default_unit || c.m464}</p></div>
                </div>
                {(row.candidate_status || row.reviewer_reason) && (
                  <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-sm text-amber-800">
                    {c.m465} {row.candidate_status || row.reviewer_reason}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
