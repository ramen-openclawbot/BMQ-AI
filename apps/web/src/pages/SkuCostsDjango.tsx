import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ChevronRight, Download, ImageIcon, Loader2, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { parseCostValues, toNumber } from "@/lib/sku-cost-template";
import { isFinishedSku } from "@/lib/skuType";
import { cn } from "@/lib/utils";
import { SkuCostHeader } from "@/components/sku-costs/SkuCostMenuBar";

const SKU_IMAGE_BUCKET = "sku-images";
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

type DbError = { message?: string } | null;
type SupabaseSkuClient = {
  from: (table: "product_skus") => {
    select: (columns: string) => {
      order: (column: string, options: { ascending: boolean }) => Promise<{ data: SkuRow[] | null; error: DbError }>;
    };
    update: (values: Record<string, unknown>) => {
      eq: (column: "id", value: string) => {
        select: (columns: string) => {
          single: () => Promise<{ data: SkuRow | null; error: DbError }>;
        };
      };
    };
  };
  storage: {
    from: (bucket: string) => {
      upload: (path: string, file: File, options: { upsert: boolean; contentType: string }) => Promise<{ error: DbError }>;
      getPublicUrl: (path: string) => { data: { publicUrl: string } };
    };
  };
};

const sb = supabase as unknown as SupabaseSkuClient;
const errorMessage = (error: unknown, fallback: string) => (error && typeof error === "object" && "message" in error ? String((error as { message?: unknown }).message || fallback) : fallback);


type SkuRow = {
  id: string;
  sku_code: string | null;
  product_name: string;
  category: string | null;
  unit: string | null;
  unit_price: number | null;
  updated_at: string | null;
  cost_values: unknown;
  image_url?: string | null;
  image_path?: string | null;
  image_updated_at?: string | null;
};

const vnd = (n: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(n || 0)))}đ`;
const formatDateTime = (value?: string | null) => {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
};

const slugFilePart = (value: string) =>
  String(value || "sku")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[đĐ]/g, "d")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sku";

function validateImageFile(file: File | null) {
  if (!file) return "Vui lòng chọn ảnh SKU.";
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return "Chỉ hỗ trợ JPG, JPEG, PNG hoặc WEBP.";
  if (file.size > MAX_IMAGE_SIZE) return "Ảnh tối đa 5MB.";
  return null;
}

function SkuImageThumb({ sku, uploading, onClick }: { sku: SkuRow; uploading?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="gv-thumb" aria-label={`Cập nhật ảnh ${sku.product_name}`} title="Đổi ảnh">
      {sku.image_url ? (
        <img src={sku.image_url} alt="" loading="lazy" />
      ) : (
        <span><ImageIcon /></span>
      )}
      {uploading && (
        <span className="gv-thumb-busy"><Loader2 /></span>
      )}
    </button>
  );
}

type SortMode = "lc" | "price" | "updated";
type FilterMode = "all" | "missing";

const sortLabels: Record<SortMode, string> = { lc: "LC thấp nhất", price: "Giá bán cao", updated: "Mới sửa" };
const pctText = (n: number) => `${Math.round(n)}%`;

export default function SkuCostsDjango() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("lc");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingSku, setEditingSku] = useState<SkuRow | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadingSkuId, setUploadingSkuId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await sb
          .from("product_skus")
          .select("id,sku_code,product_name,category,unit,unit_price,updated_at,cost_values,image_url,image_path,image_updated_at")
          .order("updated_at", { ascending: false });
        if (error) throw error;
        const finished = (data || []).filter((s: SkuRow) => isFinishedSku(s));
        setSkus(finished);
      } catch (error: unknown) {
        setLoadError(errorMessage(error, "Vui lòng thử lại."));
        toast.error("Không tải được SKU", { description: errorMessage(error, "Vui lòng thử lại.") });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const enrichedSkus = useMemo(() => {
    return skus.map((sku) => {
      const costValues = parseCostValues(sku.cost_values);
      const sellingPrice = toNumber(costValues.selling_price, 0);
      const totalCost =
        toNumber(costValues.material_cost, 0) ||
        toNumber(costValues.ingredient_cost, 0) +
          toNumber(costValues.packaging_cost, 0) +
          toNumber(costValues.labor_cost, 0) +
          toNumber(costValues.delivery_cost, 0) +
          toNumber(costValues.other_production_cost, 0) +
          toNumber(costValues.sga_cost, 0);
      const marginPct = sellingPrice > 0 ? ((sellingPrice - totalCost) / sellingPrice) * 100 : 0;
      // LC only means something when both numbers exist; a missing cost would otherwise read as 100%.
      const hasLc = sellingPrice > 0 && totalCost > 0;
      return { ...sku, sellingPrice, totalCost, marginPct, hasLc };
    });
  }, [skus]);

  const stats = useMemo(() => {
    const count = enrichedSkus.length;
    const priced = enrichedSkus.filter((s) => s.sellingPrice > 0);
    const costed = enrichedSkus.filter((s) => s.totalCost > 0);
    const withLc = enrichedSkus.filter((s) => s.hasLc);
    const avg = (rows: number[]) => (rows.length ? rows.reduce((sum, n) => sum + n, 0) / rows.length : 0);
    const updatedAt = enrichedSkus.reduce<string | null>((latest, s) => (s.updated_at && (!latest || s.updated_at > latest) ? s.updated_at : latest), null);
    const missing = enrichedSkus.filter((s) => !s.hasLc).length;
    return {
      count,
      pricedCount: priced.length,
      costedCount: costed.length,
      lcCount: withLc.length,
      missingPrice: count - priced.length,
      missingCost: count - costed.length,
      missing,
      avgSelling: avg(priced.map((s) => s.sellingPrice)),
      avgCost: avg(costed.map((s) => s.totalCost)),
      avgLc: avg(withLc.map((s) => s.marginPct)),
      lowestLc: withLc.length ? withLc.reduce((low, s) => (s.marginPct < low.marginPct ? s : low)) : null,
      updatedAt,
    };
  }, [enrichedSkus]);

  const filteredSkus = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = enrichedSkus.filter((sku) => {
      if (filterMode === "missing" && sku.hasLc) return false;
      if (!needle) return true;
      return `${sku.product_name} ${sku.sku_code || ""}`.toLowerCase().includes(needle);
    });
    return rows.sort((a, b) => {
      if (sortMode === "price") return b.sellingPrice - a.sellingPrice;
      if (sortMode === "lc") {
        if (a.hasLc !== b.hasLc) return a.hasLc ? -1 : 1;
        if (a.hasLc && b.hasLc) return a.marginPct - b.marginPct;
      }
      return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    });
  }, [enrichedSkus, query, sortMode, filterMode]);

  const openUploadModal = (sku: SkuRow) => {
    setEditingSku(sku);
    setSelectedFile(null);
    setUploadError(null);
  };

  const openSkuDetail = (sku: SkuRow) => {
    navigate(`/sku-costs/management?sku=${encodeURIComponent(sku.id)}`);
  };

  const exportSkuSheet = () => {
    if (!filteredSkus.length) {
      toast.info("Không có SKU để xuất");
      return;
    }

    const escapeCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const headers = ["Mã SKU", "Tên SKU", "Đơn vị", "Giá bán", "Giá vốn", "LC %", "Trạng thái giá", "Cập nhật lúc"];
    const rows = filteredSkus.map((sku) => [
      sku.sku_code || sku.id,
      sku.product_name,
      sku.unit || "",
      Math.round(sku.sellingPrice || 0),
      Math.round(sku.totalCost || 0),
      Number.isFinite(sku.marginPct) ? Math.round(sku.marginPct) : "",
      sku.sellingPrice > 0 ? "Có giá" : "Chưa giá",
      sku.updated_at || "",
    ]);

    const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sku-gia-von-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success("Đã xuất sheet SKU", { description: `${filteredSkus.length} SKU trong file CSV.` });
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    const error = validateImageFile(file);
    setUploadError(error);
    setSelectedFile(error ? null : file);
    if (event.target) event.target.value = "";
  };

  const saveSkuImage = async () => {
    if (!editingSku) return;
    const validation = validateImageFile(selectedFile);
    if (validation) {
      setUploadError(validation);
      return;
    }

    const file = selectedFile!;
    const extFromName = file.name.split(".").pop()?.toLowerCase();
    const ext = extFromName && ["jpg", "jpeg", "png", "webp"].includes(extFromName) ? extFromName : file.type.split("/").pop() || "jpg";
    const base = slugFilePart(editingSku.sku_code || editingSku.product_name || editingSku.id);
    const filePath = `${base}/${Date.now()}.${ext}`;
    setUploadingSkuId(editingSku.id);
    setUploadError(null);

    try {
      const { error: uploadError } = await sb.storage.from(SKU_IMAGE_BUCKET).upload(filePath, file, {
        upsert: false,
        contentType: file.type,
      });
      if (uploadError) throw uploadError;

      const publicUrl = sb.storage.from(SKU_IMAGE_BUCKET).getPublicUrl(filePath).data?.publicUrl || filePath;
      const imageUpdatedAt = new Date().toISOString();
      const { data, error: updateError } = await sb
        .from("product_skus")
        .update({ image_url: publicUrl, image_path: filePath, image_updated_at: imageUpdatedAt, updated_at: imageUpdatedAt })
        .eq("id", editingSku.id)
        .select("id,sku_code,product_name,category,unit,unit_price,updated_at,cost_values,image_url,image_path,image_updated_at")
        .single();
      if (updateError) throw updateError;

      setSkus((current) => current.map((sku) => (sku.id === editingSku.id ? { ...sku, ...(data as SkuRow) } : sku)));
      toast.success("Đã cập nhật ảnh SKU");
      setEditingSku(null);
      setSelectedFile(null);
    } catch (error: unknown) {
      const message = errorMessage(error, "Upload ảnh thất bại.");
      setUploadError(message);
      toast.error("Không thể lưu ảnh SKU", { description: message });
    } finally {
      setUploadingSkuId(null);
    }
  };

  const lcCell = (sku: (typeof enrichedSkus)[number]) => {
    if (!sku.hasLc) {
      return (
        <div className="gv-lc">
          <small>LC</small>
          <span className="gv-chip is-warn">{sku.sellingPrice > 0 ? "Thiếu giá vốn" : "Thiếu giá bán"}</span>
        </div>
      );
    }
    const costShare = (sku.totalCost / sku.sellingPrice) * 100;
    return (
      <div className="gv-lc">
        <small>LC</small>
        <b className={cn("gv-num", sku.marginPct < 0 && "gv-bad")}>{pctText(sku.marginPct)}</b>
        <span className={cn("gv-lc-bar", costShare > 100 && "is-over")} title={`Giá vốn = ${pctText(costShare)} giá bán`}>
          <span style={{ width: `${Math.min(100, Math.max(2, costShare))}%` }} />
        </span>
      </div>
    );
  };

  return (
    <div data-stitch-sku-cost-dashboard-theme="pantone-2026-light" className="gv">
      <SkuCostHeader
        title="Tổng quan giá vốn"
        description={
          loading ? "Đang tải SKU thành phẩm…" : (
            <>
              <b>{stats.count} SKU thành phẩm</b>
              {stats.updatedAt ? <> · cập nhật {formatDateTime(stats.updatedAt)}</> : null}
            </>
          )
        }
        actions={
          <>
            <button type="button" className="gv-btn" onClick={exportSkuSheet} disabled={loading || !filteredSkus.length}>
              <Download /> Xuất CSV
            </button>
            <button type="button" className="gv-btn is-primary" onClick={() => navigate("/sku-costs/management")}>
              Cập nhật giá
            </button>
          </>
        }
      />

      {loadError ? (
        <div className="gv-notice" role="alert">
          <AlertCircle />
          <p><b>Không tải được SKU.</b> {loadError}</p>
        </div>
      ) : null}

      <section className="gv-kpis" aria-label="Chỉ số giá vốn">
        <div className="gv-kpi">
          <span className="gv-kpi-label">Giá vốn TB</span>
          <strong>{loading ? "…" : stats.costedCount ? vnd(stats.avgCost) : "—"}</strong>
          <span className="gv-kpi-sub">{loading ? " " : `${stats.costedCount}/${stats.count} SKU có giá vốn`}</span>
        </div>
        <div className="gv-kpi">
          <span className="gv-kpi-label">LC TB</span>
          <strong>{loading ? "…" : stats.lcCount ? pctText(stats.avgLc) : "—"}</strong>
          <span className="gv-kpi-sub">{loading ? " " : stats.lowestLc ? `Thấp nhất: ${stats.lowestLc.product_name} ${pctText(stats.lowestLc.marginPct)}` : "Chưa SKU nào đủ giá vốn và giá bán"}</span>
        </div>
        <div className="gv-kpi">
          <span className="gv-kpi-label">Giá bán TB</span>
          <strong>{loading ? "…" : stats.pricedCount ? vnd(stats.avgSelling) : "—"}</strong>
          <span className="gv-kpi-sub">{loading ? " " : `${stats.pricedCount}/${stats.count} SKU có giá bán`}</span>
        </div>
        <div className="gv-kpi">
          <span className="gv-kpi-label">Thiếu dữ liệu</span>
          <strong className={cn(!loading && stats.missing > 0 && "gv-bad")}>{loading ? "…" : stats.missing}<small>SKU</small></strong>
          <span className="gv-kpi-sub">{loading ? " " : stats.missing ? `${stats.missingCost} chưa giá vốn · ${stats.missingPrice} chưa giá bán` : "Đủ giá vốn và giá bán"}</span>
        </div>
      </section>

      <section className="gv-panel is-flush" aria-label="Danh sách SKU">
        <div className="gv-panel-h">
          <div>
            <h2>SKU thành phẩm</h2>
            <p>Bấm vào SKU để xem công thức và lịch sử giá vốn. Bấm ảnh để đổi ảnh.</p>
          </div>
        </div>
        <div className="gv-tools">
          <label className="gv-search">
            <Search />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm theo tên hoặc mã SKU" aria-label="Tìm SKU" />
          </label>
          <div className="gv-seg" role="group" aria-label="Lọc SKU">
            <button type="button" className={cn(filterMode === "all" && "is-on")} aria-pressed={filterMode === "all"} onClick={() => setFilterMode("all")}>Tất cả</button>
            <button type="button" className={cn(filterMode === "missing" && "is-on")} aria-pressed={filterMode === "missing"} onClick={() => setFilterMode("missing")}>
              Thiếu dữ liệu{!loading && stats.missing ? <em>{stats.missing}</em> : null}
            </button>
          </div>
          <div className="gv-seg" role="group" aria-label="Sắp xếp">
            {(Object.keys(sortLabels) as SortMode[]).map((mode) => (
              <button key={mode} type="button" className={cn(sortMode === mode && "is-on")} aria-pressed={sortMode === mode} onClick={() => setSortMode(mode)}>
                {sortLabels[mode]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="gv-loading" aria-label="Đang tải SKU"><span /><span /><span /></div>
        ) : filteredSkus.length === 0 ? (
          <p className="gv-empty">
            <b>{enrichedSkus.length === 0 ? "Chưa có SKU thành phẩm" : "Không có SKU phù hợp"}</b>
            {enrichedSkus.length === 0 ? "Tạo SKU ở tab Quản trị SKU." : filterMode === "missing" && !query ? "Mọi SKU đã đủ giá vốn và giá bán." : "Thử từ khoá khác."}
          </p>
        ) : (
          <>
            <div className="gv-list-head" aria-hidden="true">
              <span />
              <span>SKU</span>
              <span>Giá vốn</span>
              <span>Giá bán</span>
              <span>LC</span>
              <span />
            </div>
            <ul className="gv-list">
              {filteredSkus.map((sku) => (
                <li key={sku.id} className="gv-row">
                  <button type="button" className="gv-row-link" onClick={() => openSkuDetail(sku)} aria-label={`Xem chi tiết ${sku.product_name}`} />
                  <SkuImageThumb sku={sku} uploading={uploadingSkuId === sku.id} onClick={() => openUploadModal(sku)} />
                  <div className="gv-name">
                    <b>{sku.product_name}</b>
                    <small>
                      <code>{sku.sku_code || "—"}</code>
                      {sku.unit ? <span>{sku.unit}</span> : null}
                    </small>
                  </div>
                  <div className="gv-fig is-cost">
                    <small>Giá vốn</small>
                    {sku.totalCost > 0 ? <b>{vnd(sku.totalCost)}</b> : <b className="is-missing">Chưa có</b>}
                  </div>
                  <div className="gv-fig is-price">
                    <small>Giá bán</small>
                    {sku.sellingPrice > 0 ? <b>{vnd(sku.sellingPrice)}</b> : <b className="is-missing">Chưa có</b>}
                  </div>
                  {lcCell(sku)}
                  <ChevronRight className="gv-chev" aria-hidden="true" />
                </li>
              ))}
            </ul>
            <p className="gv-list-foot">LC = (giá bán − giá vốn) ÷ giá bán. Vạch xám là phần giá vốn trong giá bán; vạch đỏ là giá vốn vượt giá bán.</p>
          </>
        )}
      </section>

      <Dialog open={!!editingSku} onOpenChange={(open) => { if (!open && !uploadingSkuId) { setEditingSku(null); setSelectedFile(null); setUploadError(null); } }}>
        <DialogContent className="border-border/70 bg-card text-foreground sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-foreground">Cập nhật ảnh SKU</DialogTitle>
          </DialogHeader>
          {editingSku && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border/70 bg-muted/40 p-3">
                <p className="text-sm font-black text-foreground">{editingSku.product_name}</p>
                <p className="mt-1 font-mono text-xs font-bold text-muted-foreground">{editingSku.sku_code || editingSku.id}</p>
              </div>
              <div className="overflow-hidden rounded-[22px] border border-border/70 bg-muted/45">
                {previewUrl || editingSku.image_url ? (
                  <img src={previewUrl || editingSku.image_url || ""} alt="Preview ảnh SKU" className="h-56 w-full object-cover" />
                ) : (
                  <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
                    <ImageIcon className="h-8 w-8" />
                    <span className="text-sm font-extrabold">Chưa có ảnh</span>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileChange} />
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!!uploadingSkuId} className="h-11 w-full rounded-2xl border-primary/25 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary">
                <Upload className="mr-2 h-4 w-4" /> Chọn ảnh
              </Button>
              {selectedFile && <p className="text-xs font-bold text-muted-foreground">Đã chọn: {selectedFile.name}</p>}
              {uploadError && (
                <div className="flex items-start gap-2 rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-xs font-bold text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" disabled={!!uploadingSkuId} onClick={() => { setEditingSku(null); setSelectedFile(null); setUploadError(null); }} className="text-muted-foreground hover:bg-muted/50 hover:text-foreground">Hủy</Button>
            <Button type="button" onClick={saveSkuImage} disabled={!selectedFile || !!uploadingSkuId} className="bg-primary font-extrabold text-primary-foreground hover:bg-primary/90">
              {uploadingSkuId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Lưu ảnh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
