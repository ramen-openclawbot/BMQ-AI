import { useProductionCopy } from "@/i18n/useProductionCopy";
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { formatDateKeyVi, expectedLabelDates, ProductLabelSpec } from "@/lib/product-label-control";
import { CheckCircle2, Loader2, PackageSearch, Save, ShieldCheck } from "lucide-react";

type QueryResult<T = unknown> = { data: T | null; error: { message?: string } | null };
type SupabaseQueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select(columns?: string): SupabaseQueryBuilder<T>;
  upsert(values: unknown, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
};
type SupabaseLoose = {
  from<T = unknown>(table: string): SupabaseQueryBuilder<T>;
};
const db = supabase as unknown as SupabaseLoose;

interface ProductSku {
  id: string;
  sku_code: string | null;
  product_name: string | null;
  unit: string | null;
  image_url?: string | null;
  category: string | null;
  sku_type: string | null;
}

type LabelDraft = Pick<ProductLabelSpec, "shelf_life_days" | "net_weight_value" | "net_weight_unit" | "traceability_sheet_url" | "is_label_scan_required">;

const defaultDraft: LabelDraft = {
  shelf_life_days: 3,
  net_weight_value: null,
  net_weight_unit: "g",
  traceability_sheet_url: "",
  is_label_scan_required: true,
};

const isFinishedSku = (sku: ProductSku) => {
  const text = `${sku.sku_type || ""} ${sku.category || ""}`.toLowerCase();
  return text.includes("finished") || text.includes("thành phẩm") || text.includes("finished_good");
};

export default function ProductionProducts() {
  const c = useProductionCopy();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [draft, setDraft] = useState<LabelDraft>(defaultDraft);
  const [saveSuccessAt, setSaveSuccessAt] = useState<Date | null>(null);

  const { data: skus = [], isLoading: skusLoading } = useQuery<ProductSku[]>({
    queryKey: ["production-products-finished-skus"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ProductSku[]>("product_skus")
        .select("id,sku_code,product_name,unit,category,sku_type,image_url")
        .order("product_name", { ascending: true });
      if (error) throw error;
      return (data || []).filter(isFinishedSku);
    },
  });

  const { data: specs = [], isLoading: specsLoading } = useQuery<ProductLabelSpec[]>({
    queryKey: ["production-product-label-specs"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ProductLabelSpec[]>("product_label_specs")
        .select("id,sku_id,sku_code,product_name,shelf_life_days,net_weight_value,net_weight_unit,traceability_sheet_url,is_label_scan_required")
        .order("product_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const specBySku = useMemo(() => new Map(specs.map((spec) => [spec.sku_id, spec])), [specs]);

  const selectSku = (sku: ProductSku) => {
    const existing = specBySku.get(sku.id);
    setSelectedSkuId(sku.id);
    setSaveSuccessAt(null);
    setDraft({
      shelf_life_days: existing?.shelf_life_days || 3,
      net_weight_value: existing?.net_weight_value ?? null,
      net_weight_unit: existing?.net_weight_unit || "g",
      traceability_sheet_url: existing?.traceability_sheet_url || "",
      is_label_scan_required: existing?.is_label_scan_required ?? true,
    });
  };

  const handleSelectSkuId = (skuId: string) => {
    const sku = skus.find((item) => item.id === skuId);
    if (sku) selectSku(sku);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const sku = skus.find((item) => item.id === selectedSkuId);
      if (!sku) throw new Error(c.m323);
      const { error } = await db.from("product_label_specs").upsert(
        {
          sku_id: sku.id,
          sku_code: sku.sku_code,
          product_name: sku.product_name,
          shelf_life_days: Math.max(1, Number(draft.shelf_life_days || 1)),
          net_weight_value: draft.net_weight_value == null || Number.isNaN(Number(draft.net_weight_value)) ? null : Number(draft.net_weight_value),
          net_weight_unit: draft.net_weight_unit || "g",
          traceability_sheet_url: draft.traceability_sheet_url || null,
          is_label_scan_required: draft.is_label_scan_required ?? true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sku_id" }
      );
      if (error) throw error;
    },
    onSuccess: () => {
      setSaveSuccessAt(new Date());
      toast({ title: c.m324, description: c.m325 });
      queryClient.invalidateQueries({ queryKey: ["production-product-label-specs"] });
    },
    onError: (error) => toast({ title: c.m326, description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });

  const selectedSku = skus.find((sku) => sku.id === selectedSkuId) || null;
  const demoDates = expectedLabelDates("2026-06-06", Number(draft.shelf_life_days || 1));

  return (
    <div className="-m-4 min-h-screen bg-background p-4 text-foreground md:-m-6 md:p-6" data-production-i18n="c-production-v1" data-production-products-label-specs="mvp">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="card-elevated rounded-[1.75rem] p-4 md:p-6">
          <Badge className="mb-3 rounded-full bg-primary/10 text-primary hover:bg-primary/10">{c.m327}</Badge>
          <h1 className="text-2xl font-black tracking-tight md:text-4xl">{c.m328}</h1>
          <p className="mt-2 max-w-3xl text-sm font-semibold text-muted-foreground md:text-base">
            {c.m329}
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <Card className="card-elevated rounded-[1.5rem]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-black"><PackageSearch className="h-5 w-5 text-primary" /> {c.m330}</CardTitle>
              <CardDescription>{c.m331}</CardDescription>
            </CardHeader>
            <CardContent>
              {skusLoading || specsLoading ? (
                <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
              ) : (
                <div className="space-y-4" data-production-products-sku-dropdown="compact-select">
                  <div className="space-y-2">
                    <Label>{c.m332}</Label>
                    <Select value={selectedSkuId} onValueChange={handleSelectSkuId}>
                      <SelectTrigger className="h-12 rounded-2xl bg-background text-left font-bold">
                        <SelectValue placeholder={c.m333} />
                      </SelectTrigger>
                      <SelectContent className="max-h-80 rounded-2xl">
                        {skus.map((sku) => {
                          const spec = specBySku.get(sku.id);
                          return (
                            <SelectItem key={sku.id} value={sku.id} className="rounded-xl py-2">
                              {(sku.product_name || sku.sku_code || c.m334) + (sku.sku_code ? ` · ${sku.sku_code}` : "") + (spec ? c.m335 : c.m336)}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <p className="text-xs font-semibold text-muted-foreground">{c.m337}</p>
                  </div>

                  {selectedSku ? (
                    <div className="rounded-3xl border border-primary/20 bg-primary/5 p-4">
                      <div className="grid gap-3 sm:grid-cols-[96px_minmax(0,1fr)]">
                        <div className="h-24 w-full overflow-hidden rounded-2xl border border-border bg-muted shadow-inner sm:w-24" data-production-products-sku-image="selected-sku">
                          {selectedSku.image_url ? (
                            <img src={selectedSku.image_url} alt={selectedSku.product_name || selectedSku.sku_code || c.m338} className="h-full w-full object-cover object-center" loading="lazy" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/15 to-warning/20 px-2 text-center text-[11px] font-black text-muted-foreground">{c.m339}</div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="line-clamp-2 text-base font-black text-foreground">{selectedSku.product_name || selectedSku.sku_code}</p>
                              <p className="mt-1 truncate font-mono text-xs font-bold text-muted-foreground">{selectedSku.sku_code || "-"}</p>
                            </div>
                            {(() => {
                              const spec = specBySku.get(selectedSku.id);
                              return <Badge className={spec ? "bg-success/15 text-success hover:bg-success/15" : "bg-warning text-warning-foreground hover:bg-warning"}>{spec ? c.m340 : c.m341}</Badge>;
                            })()}
                          </div>
                          {(() => {
                            const spec = specBySku.get(selectedSku.id);
                            return spec ? <p className="mt-3 text-sm font-bold text-muted-foreground">{c.shelfLife} {spec.shelf_life_days} {c.m342} {spec.net_weight_value || "-"}{spec.net_weight_unit || ""}</p> : <p className="mt-3 text-sm font-bold text-muted-foreground">{c.m343}</p>;
                          })()}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-border bg-muted/40 p-4 text-sm font-bold text-muted-foreground">{c.m344}</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="card-elevated rounded-[1.5rem]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-black"><ShieldCheck className="h-5 w-5 text-success" /> {c.m345}</CardTitle>
              <CardDescription>{selectedSku ? selectedSku.product_name : c.m346}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{c.m347}</Label>
                  <Input type="number" className="mt-1 rounded-2xl" value={draft.shelf_life_days} onChange={(event) => setDraft((cur) => ({ ...cur, shelf_life_days: Number(event.target.value) }))} />
                </div>
                <div>
                  <Label>{c.m348}</Label>
                  <Input type="number" className="mt-1 rounded-2xl" value={draft.net_weight_value ?? ""} onChange={(event) => setDraft((cur) => ({ ...cur, net_weight_value: event.target.value === "" ? null : Number(event.target.value) }))} />
                </div>
              </div>
              <div>
                <Label>{c.m349}</Label>
                <Input className="mt-1 rounded-2xl" value={draft.net_weight_unit || ""} onChange={(event) => setDraft((cur) => ({ ...cur, net_weight_unit: event.target.value }))} />
              </div>
              <div>
                <Label>{c.m350}</Label>
                <Input className="mt-1 rounded-2xl" placeholder="https://docs.google.com/spreadsheets/..." value={draft.traceability_sheet_url || ""} onChange={(event) => setDraft((cur) => ({ ...cur, traceability_sheet_url: event.target.value }))} />
              </div>
              <div className="rounded-2xl bg-muted/60 p-3 text-sm font-semibold text-muted-foreground">
                {c.m351} {formatDateKeyVi(demoDates.expectedNsx)} · {c.expiry} {formatDateKeyVi(demoDates.expectedHsd)}.
              </div>
              <Button type="button" className="h-12 w-full rounded-2xl font-black" data-product-label-save-button="primary" disabled={!selectedSkuId || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Save className="mr-2 h-5 w-5" />}
                {c.m352}
              </Button>
              {saveSuccessAt ? (
                <div className="flex items-center gap-2 rounded-2xl border border-success/30 bg-success/10 p-3 text-sm font-black text-success" data-product-label-save-success="inline">
                  <CheckCircle2 className="h-5 w-5 shrink-0" />
                  <span>{c.m353}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
