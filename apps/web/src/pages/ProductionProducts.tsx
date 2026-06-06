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
import { Loader2, PackageSearch, Save, ShieldCheck } from "lucide-react";

type QueryResult<T = unknown> = { data: T | null; error: { message?: string } | null };
type SupabaseQueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select(columns?: string): SupabaseQueryBuilder<T>;
  upsert(values: unknown, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder<T>;
};
type SupabaseLoose = { from<T = unknown>(table: string): SupabaseQueryBuilder<T> };
const db = supabase as unknown as SupabaseLoose;

interface ProductSku {
  id: string;
  sku_code: string | null;
  product_name: string | null;
  unit: string | null;
  category: string | null;
  sku_type: string | null;
}

type LabelDraft = Pick<ProductLabelSpec, "shelf_life_days" | "net_weight_value" | "net_weight_unit" | "barcode_value" | "partner_product_code" | "traceability_sheet_url" | "is_label_scan_required">;

const defaultDraft: LabelDraft = {
  shelf_life_days: 3,
  net_weight_value: null,
  net_weight_unit: "g",
  barcode_value: "",
  partner_product_code: "",
  traceability_sheet_url: "",
  is_label_scan_required: true,
};

const isFinishedSku = (sku: ProductSku) => {
  const text = `${sku.sku_type || ""} ${sku.category || ""}`.toLowerCase();
  return text.includes("finished") || text.includes("thành phẩm") || text.includes("finished_good");
};

export default function ProductionProducts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedSkuId, setSelectedSkuId] = useState("");
  const [draft, setDraft] = useState<LabelDraft>(defaultDraft);

  const { data: skus = [], isLoading: skusLoading } = useQuery<ProductSku[]>({
    queryKey: ["production-products-finished-skus"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ProductSku[]>("product_skus")
        .select("id,sku_code,product_name,unit,category,sku_type")
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
        .select("id,sku_id,sku_code,product_name,barcode_value,partner_product_code,shelf_life_days,net_weight_value,net_weight_unit,traceability_sheet_url,is_label_scan_required")
        .order("product_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const specBySku = useMemo(() => new Map(specs.map((spec) => [spec.sku_id, spec])), [specs]);

  const selectSku = (sku: ProductSku) => {
    const existing = specBySku.get(sku.id);
    setSelectedSkuId(sku.id);
    setDraft({
      shelf_life_days: existing?.shelf_life_days || 3,
      net_weight_value: existing?.net_weight_value ?? null,
      net_weight_unit: existing?.net_weight_unit || "g",
      barcode_value: existing?.barcode_value || "",
      partner_product_code: existing?.partner_product_code || "",
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
      if (!sku) throw new Error("Chọn SKU thành phẩm trước.");
      const { error } = await db.from("product_label_specs").upsert(
        {
          sku_id: sku.id,
          sku_code: sku.sku_code,
          product_name: sku.product_name,
          shelf_life_days: Math.max(1, Number(draft.shelf_life_days || 1)),
          net_weight_value: draft.net_weight_value == null || Number.isNaN(Number(draft.net_weight_value)) ? null : Number(draft.net_weight_value),
          net_weight_unit: draft.net_weight_unit || "g",
          barcode_value: draft.barcode_value?.trim() || null,
          partner_product_code: draft.partner_product_code?.trim() || null,
          traceability_sheet_url: draft.traceability_sheet_url || null,
          is_label_scan_required: draft.is_label_scan_required ?? true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "sku_id" }
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Đã lưu cấu hình tem", description: "QA sẽ dùng thông số này để đối chiếu tem nhãn." });
      queryClient.invalidateQueries({ queryKey: ["production-product-label-specs"] });
    },
    onError: (error) => toast({ title: "Không thể lưu", description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });

  const selectedSku = skus.find((sku) => sku.id === selectedSkuId) || null;
  const demoDates = expectedLabelDates("2026-06-06", Number(draft.shelf_life_days || 1));

  return (
    <div className="-m-4 min-h-screen bg-background p-4 text-foreground md:-m-6 md:p-6" data-production-products-label-specs="mvp">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="card-elevated rounded-[1.75rem] p-4 md:p-6">
          <Badge className="mb-3 rounded-full bg-primary/10 text-primary hover:bg-primary/10">Quản lý sản phẩm · tem nhãn QA</Badge>
          <h1 className="text-2xl font-black tracking-tight md:text-4xl">Quản lý sản phẩm</h1>
          <p className="mt-2 max-w-3xl text-sm font-semibold text-muted-foreground md:text-base">
            Cấu hình HSD, khối lượng, mã vạch, mã SP đối tác và link sheet truy xuất theo SKU thành phẩm. QA phải quét/đối chiếu tem đạt trước khi nhập kho TP.
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <Card className="card-elevated rounded-[1.5rem]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-black"><PackageSearch className="h-5 w-5 text-primary" /> SKU thành phẩm</CardTitle>
              <CardDescription>Chọn SKU để khai báo thông số tem nhãn chuẩn.</CardDescription>
            </CardHeader>
            <CardContent>
              {skusLoading || specsLoading ? (
                <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
              ) : (
                <div className="space-y-4" data-production-products-sku-dropdown="compact-select">
                  <div className="space-y-2">
                    <Label>Chọn SKU thành phẩm</Label>
                    <Select value={selectedSkuId} onValueChange={handleSelectSkuId}>
                      <SelectTrigger className="h-12 rounded-2xl bg-background text-left font-bold">
                        <SelectValue placeholder="Chọn SKU để cấu hình tem nhãn..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-80 rounded-2xl">
                        {skus.map((sku) => {
                          const spec = specBySku.get(sku.id);
                          return (
                            <SelectItem key={sku.id} value={sku.id} className="rounded-xl py-2">
                              {(sku.product_name || sku.sku_code || "SKU chưa đặt tên") + (sku.sku_code ? ` · ${sku.sku_code}` : "") + (spec ? " · Đã cấu hình" : " · Thiếu tem")}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <p className="text-xs font-semibold text-muted-foreground">Danh sách SKU được thu gọn vào dropdown để tránh kéo dài màn hình.</p>
                  </div>

                  {selectedSku ? (
                    <div className="rounded-3xl border border-primary/20 bg-primary/5 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="line-clamp-2 text-base font-black text-foreground">{selectedSku.product_name || selectedSku.sku_code}</p>
                          <p className="mt-1 truncate font-mono text-xs font-bold text-muted-foreground">{selectedSku.sku_code || "-"}</p>
                        </div>
                        {(() => {
                          const spec = specBySku.get(selectedSku.id);
                          return <Badge className={spec ? "bg-success/15 text-success hover:bg-success/15" : "bg-warning text-warning-foreground hover:bg-warning"}>{spec ? "Đã cấu hình" : "Thiếu tem"}</Badge>;
                        })()}
                      </div>
                      {(() => {
                        const spec = specBySku.get(selectedSku.id);
                        return spec ? <p className="mt-3 text-sm font-bold text-muted-foreground">HSD {spec.shelf_life_days} ngày · {spec.net_weight_value || "-"}{spec.net_weight_unit || ""}{spec.barcode_value ? ` · Mã vạch ${spec.barcode_value}` : ""}{spec.partner_product_code ? ` · Mã SP ${spec.partner_product_code}` : ""}</p> : <p className="mt-3 text-sm font-bold text-muted-foreground">SKU này chưa có thông số tem, nhập bên phải rồi lưu.</p>;
                      })()}
                    </div>
                  ) : (
                    <div className="rounded-3xl border border-dashed border-border bg-muted/40 p-4 text-sm font-bold text-muted-foreground">Chưa chọn SKU.</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="card-elevated rounded-[1.5rem]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl font-black"><ShieldCheck className="h-5 w-5 text-success" /> Thông số tem</CardTitle>
              <CardDescription>{selectedSku ? selectedSku.product_name : "Chọn SKU bên trái để sửa."}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>HSD (ngày)</Label>
                  <Input type="number" className="mt-1 rounded-2xl" value={draft.shelf_life_days} onChange={(event) => setDraft((cur) => ({ ...cur, shelf_life_days: Number(event.target.value) }))} />
                </div>
                <div>
                  <Label>Khối lượng</Label>
                  <Input type="number" className="mt-1 rounded-2xl" value={draft.net_weight_value ?? ""} onChange={(event) => setDraft((cur) => ({ ...cur, net_weight_value: event.target.value === "" ? null : Number(event.target.value) }))} />
                </div>
              </div>
              <div>
                <Label>Đơn vị khối lượng</Label>
                <Input className="mt-1 rounded-2xl" value={draft.net_weight_unit || ""} onChange={(event) => setDraft((cur) => ({ ...cur, net_weight_unit: event.target.value }))} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label>Mã vạch</Label>
                  <Input className="mt-1 rounded-2xl font-mono" placeholder="Ví dụ: 893..." value={draft.barcode_value || ""} onChange={(event) => setDraft((cur) => ({ ...cur, barcode_value: event.target.value }))} />
                </div>
                <div>
                  <Label>Mã SP theo đối tác</Label>
                  <Input className="mt-1 rounded-2xl font-mono" placeholder="Ví dụ: SP001986" value={draft.partner_product_code || ""} onChange={(event) => setDraft((cur) => ({ ...cur, partner_product_code: event.target.value }))} />
                </div>
              </div>
              <div>
                <Label>Link Google Sheet truy xuất</Label>
                <Input className="mt-1 rounded-2xl" placeholder="https://docs.google.com/spreadsheets/..." value={draft.traceability_sheet_url || ""} onChange={(event) => setDraft((cur) => ({ ...cur, traceability_sheet_url: event.target.value }))} />
              </div>
              <div className="rounded-2xl bg-muted/60 p-3 text-sm font-semibold text-muted-foreground">
                Ví dụ ngày SX 06/06/2026: tem phải in NSX {formatDateKeyVi(demoDates.expectedNsx)} · HSD {formatDateKeyVi(demoDates.expectedHsd)}.
              </div>
              <Button className="h-12 w-full rounded-2xl font-black" disabled={!selectedSkuId || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Save className="mr-2 h-5 w-5" />}
                Lưu thông số tem
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
