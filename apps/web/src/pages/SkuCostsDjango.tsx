import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { AlertCircle, BarChart3, Camera, ChevronRight, ImageIcon, Loader2, Package2, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { parseCostValues, toNumber } from "@/lib/sku-cost-template";
import { isFinishedSku } from "@/lib/skuType";
import { cn } from "@/lib/utils";

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

const navItems = [
  { to: "/sku-costs/dashboard", label: "Tổng quan giá vốn", icon: BarChart3 },
  { to: "/sku-costs/analysis", label: "Xu hướng giá vốn", icon: BarChart3 },
  { to: "/sku-costs/management", label: "Quản trị SKU", icon: Package2 },
];

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

function priceBandLabel(price: number) {
  if (price <= 0) return "0đ";
  if (price < 10000) return "0-10k";
  if (price < 15000) return "10-15k";
  if (price < 20000) return "15-20k";
  return ">20k";
}

function SkuImageThumb({ sku, uploading, onClick }: { sku: SkuRow; uploading?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-[18px] border border-white/10 bg-[#231913] shadow-inner transition hover:border-amber-300/40"
      aria-label={`Cập nhật ảnh ${sku.product_name}`}
    >
      {sku.image_url ? (
        <img src={sku.image_url} alt={sku.product_name} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-[radial-gradient(circle_at_50%_30%,rgba(245,158,11,0.18),transparent_60%)] text-white/40">
          <ImageIcon className="h-5 w-5" />
          <span className="text-[9px] font-bold leading-none">Chưa có ảnh</span>
        </div>
      )}
      <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/58 py-1 text-[9px] font-extrabold text-amber-200 opacity-0 backdrop-blur transition group-hover:opacity-100">
        <Camera className="h-3 w-3" /> Đổi ảnh
      </span>
      {uploading && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-amber-200 backdrop-blur-sm">
          <Loader2 className="h-5 w-5 animate-spin" />
        </span>
      )}
    </button>
  );
}

export default function SkuCostsDjango() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<SkuRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<"updated" | "price">("updated");
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
      return { ...sku, sellingPrice, totalCost, marginPct };
    });
  }, [skus]);

  const stats = useMemo(() => {
    const count = enrichedSkus.length;
    const priced = enrichedSkus.filter((s) => s.sellingPrice > 0);
    const avgSelling = priced.length ? priced.reduce((sum, s) => sum + s.sellingPrice, 0) / priced.length : 0;
    const maxSelling = priced.length ? Math.max(...priced.map((s) => s.sellingPrice)) : 0;
    const imageCount = enrichedSkus.filter((s) => !!s.image_url).length;
    const updatedAt = enrichedSkus[0]?.updated_at;
    const bandCounts = ["0đ", "0-10k", "10-15k", "15-20k", ">20k"].map((label) => ({
      label,
      count: enrichedSkus.filter((s) => priceBandLabel(s.sellingPrice) === label).length,
    }));
    return { count, pricedCount: priced.length, missingPrice: count - priced.length, avgSelling, maxSelling, imageCount, updatedAt, bandCounts };
  }, [enrichedSkus]);

  const filteredSkus = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = enrichedSkus.filter((sku) => {
      if (!needle) return true;
      return `${sku.product_name} ${sku.sku_code || ""}`.toLowerCase().includes(needle);
    });
    return rows.sort((a, b) => {
      if (sortMode === "price") return b.sellingPrice - a.sellingPrice;
      return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    });
  }, [enrichedSkus, query, sortMode]);

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

  const maxBand = Math.max(1, ...stats.bandCounts.map((b) => b.count));

  return (
    <div className="-m-4 min-h-screen bg-[#0b0908] text-white md:-m-6">
      <div className="mx-auto min-h-screen w-full max-w-[430px] bg-[radial-gradient(circle_at_50%_-8%,rgba(245,158,11,0.26),transparent_34%),linear-gradient(180deg,#17100c_0%,#0b0908_44%,#070605_100%)] px-4 pb-28 pt-3 shadow-2xl md:max-w-[560px] md:px-5 lg:hidden">
        <header className="sticky top-0 z-20 -mx-4 bg-gradient-to-b from-[#17100c]/98 via-[#17100c]/90 to-[#17100c]/70 px-4 pb-3 pt-2 backdrop-blur-xl md:-mx-5 md:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-amber-100 shadow-inner">
              <Package2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 text-center">
              <h1 className="text-[21px] font-black leading-tight tracking-[-0.03em] text-white">Tổng quan giá vốn</h1>
              <p className="mt-0.5 text-[11px] font-bold text-white/42">Toàn bộ SKU thành phẩm hiện có</p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-300/20 bg-amber-300/10 text-amber-200 shadow-inner">
              <Camera className="h-5 w-5" />
            </div>
          </div>

          <nav className="mt-4 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Điều hướng giá vốn">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-[12px] font-extrabold transition",
                      isActive ? "bg-amber-400 text-[#1b1004] shadow-[0_10px_24px_rgba(245,158,11,0.24)]" : "border border-white/10 bg-white/[0.045] text-white/48 hover:text-white"
                    )
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </header>

        <main className="space-y-4 pt-4">
          <section className="rounded-[28px] border border-white/10 bg-white/[0.055] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "SKU thành phẩm", value: loading ? "..." : stats.count, sub: "đang quản lý" },
                { label: "Giá bán TB", value: loading ? "..." : vnd(stats.avgSelling), sub: `${stats.pricedCount} SKU có giá` },
                { label: "Giá cao nhất", value: loading ? "..." : vnd(stats.maxSelling), sub: "top giá bán" },
                { label: "Cập nhật", value: loading ? "..." : formatDateTime(stats.updatedAt), sub: "gần nhất" },
              ].map((card) => (
                <article key={card.label} className="min-h-[94px] rounded-[22px] border border-white/10 bg-[#14100d]/88 p-3.5 shadow-inner">
                  <p className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-white/35">{card.label}</p>
                  <div className="mt-3 text-[22px] font-black leading-none tracking-[-0.04em] text-white">{card.value}</div>
                  <p className="mt-2 text-[11px] font-bold text-white/38">{card.sub}</p>
                </article>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                { label: "Có giá bán", value: stats.pricedCount, tone: "text-emerald-300" },
                { label: "Chưa có giá", value: stats.missingPrice, tone: stats.missingPrice ? "text-rose-300" : "text-white/70" },
                { label: "Có ảnh", value: stats.imageCount, tone: "text-amber-200" },
              ].map((chip) => (
                <div key={chip.label} className="rounded-2xl border border-white/10 bg-[#211915]/80 px-3 py-2 text-center">
                  <div className={cn("text-[18px] font-black", chip.tone)}>{loading ? "..." : chip.value}</div>
                  <div className="mt-0.5 text-[10px] font-bold text-white/38">{chip.label}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[24px] border border-white/10 bg-[#14100d]/95 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.34)]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-black tracking-[-0.02em] text-white">Phân bổ giá bán SKU</h2>
                <p className="mt-0.5 text-[11px] font-semibold text-white/38">Nhìn nhanh dải giá toàn bộ SKU.</p>
              </div>
              <span className="rounded-full bg-amber-300/10 px-2.5 py-1 text-[11px] font-extrabold text-amber-200 ring-1 ring-amber-300/20">{stats.count} SKU</span>
            </div>
            <div className="space-y-2.5">
              {stats.bandCounts.map((band) => (
                <div key={band.label} className="grid grid-cols-[48px_minmax(0,1fr)_28px] items-center gap-2">
                  <span className="text-[11px] font-bold text-white/45">{band.label}</span>
                  <div className="h-3 overflow-hidden rounded-full bg-white/[0.07]">
                    <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-300" style={{ width: `${Math.max(6, (band.count / maxBand) * 100)}%` }} />
                  </div>
                  <span className="text-right text-[12px] font-black tabular-nums text-white">{loading ? "-" : band.count}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-[18px] font-black tracking-[-0.02em] text-white">Toàn bộ SKU hiện có</h2>
                <p className="mt-0.5 text-[11px] font-bold text-white/38">Bấm ảnh để upload/cập nhật hình SKU.</p>
              </div>
              <button
                type="button"
                onClick={() => setSortMode((mode) => (mode === "price" ? "updated" : "price"))}
                className="rounded-full border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2 text-[11px] font-extrabold text-amber-200"
              >
                {sortMode === "price" ? "Giá bán" : "Mới cập nhật"}
              </button>
            </div>
            <div className="flex items-center gap-2 rounded-[18px] border border-white/10 bg-[#211915] px-3 py-2 shadow-inner">
              <Search className="h-4 w-4 shrink-0 text-white/35" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm SKU"
                className="h-9 border-0 bg-transparent px-0 text-[13px] font-bold text-white placeholder:text-white/28 focus-visible:ring-0"
              />
            </div>

            {loading ? (
              <div className="rounded-[24px] border border-white/10 bg-white/[0.04] px-4 py-8 text-center text-[13px] font-bold text-white/45">Đang tải SKU...</div>
            ) : filteredSkus.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-white/12 bg-white/[0.035] px-4 py-8 text-center text-[13px] font-bold text-white/45">Không tìm thấy SKU phù hợp.</div>
            ) : (
              <div className="space-y-3">
                {filteredSkus.map((sku) => {
                  const hasPrice = sku.sellingPrice > 0;
                  return (
                    <article key={sku.id} className="flex items-center gap-3 rounded-[24px] border border-white/10 bg-[#14100d]/95 p-3 shadow-[0_14px_42px_rgba(0,0,0,0.28)]">
                      <SkuImageThumb sku={sku} uploading={uploadingSkuId === sku.id} onClick={() => openUploadModal(sku)} />
                      <button type="button" onClick={() => openSkuDetail(sku)} className="min-w-0 flex-1 text-left" aria-label={`Xem chi tiết ${sku.product_name}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-[14px] font-black leading-tight text-white">{sku.product_name}</h3>
                            <p className="mt-1 truncate font-mono text-[10px] font-bold text-white/35">{sku.sku_code || sku.id}</p>
                          </div>
                          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-white/25" />
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <div>
                            <div className="text-[17px] font-black leading-none tracking-[-0.03em] text-amber-300">{vnd(sku.sellingPrice)}</div>
                            <div className="mt-1 text-[10px] font-bold text-white/34">Giá bán</div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={cn("rounded-full px-2 py-1 text-[10px] font-extrabold ring-1", hasPrice ? "bg-emerald-400/10 text-emerald-300 ring-emerald-300/20" : "bg-rose-400/10 text-rose-300 ring-rose-300/20")}>
                              {hasPrice ? "Có giá" : "Chưa giá"}
                            </span>
                            <span className="rounded-xl border border-white/10 bg-white/[0.045] px-2 py-1 text-[10px] font-black text-white/58">
                              LC {Number.isFinite(sku.marginPct) ? `${Math.round(sku.marginPct)}%` : "—"}
                            </span>
                          </div>
                        </div>
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[430px] bg-gradient-to-t from-[#070605] via-[#070605]/96 to-transparent px-4 pb-4 pt-8 md:max-w-[560px] lg:hidden">
          <div className="grid grid-cols-2 gap-3 rounded-[24px] border border-white/10 bg-[#14100d]/92 p-2 shadow-[0_-14px_48px_rgba(0,0,0,0.42)] backdrop-blur-xl">
            <Button onClick={exportSkuSheet} className="h-12 rounded-[18px] border border-white/10 bg-white/[0.06] text-[13px] font-extrabold text-white hover:bg-white/[0.1]">Xuất sheet SKU</Button>
            <Button onClick={() => navigate("/sku-costs/management")} className="h-12 rounded-[18px] bg-amber-400 text-[13px] font-extrabold text-[#1b1004] shadow-[0_12px_26px_rgba(245,158,11,0.22)] hover:bg-amber-300">Cập nhật giá</Button>
          </div>
        </div>
      </div>

      <div className="hidden min-h-screen bg-[radial-gradient(circle_at_18%_-12%,rgba(245,158,11,0.18),transparent_34%),linear-gradient(180deg,#140f0c_0%,#0b0908_42%,#070605_100%)] px-8 py-8 lg:block">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
          <header className="rounded-[32px] border border-white/10 bg-white/[0.055] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.34)] backdrop-blur-xl">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200 shadow-inner">
                  <Package2 className="h-7 w-7" />
                </div>
                <div>
                  <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-amber-200/70">SKU Costs</p>
                  <h1 className="mt-1 text-[34px] font-black leading-tight tracking-[-0.04em] text-white">Tổng quan giá vốn</h1>
                  <p className="mt-2 max-w-2xl text-sm font-semibold text-white/45">Dashboard desktop cho toàn bộ SKU thành phẩm, giá bán, giá vốn và trạng thái ảnh sản phẩm.</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Button onClick={exportSkuSheet} className="h-11 rounded-2xl border border-white/10 bg-white/[0.06] px-5 text-sm font-extrabold text-white hover:bg-white/[0.1]">Xuất sheet SKU</Button>
                <Button onClick={() => navigate("/sku-costs/management")} className="h-11 rounded-2xl bg-amber-400 px-5 text-sm font-extrabold text-[#1b1004] shadow-[0_12px_28px_rgba(245,158,11,0.22)] hover:bg-amber-300">Cập nhật giá</Button>
              </div>
            </div>

            <nav className="mt-6 flex flex-wrap gap-2" aria-label="Điều hướng giá vốn desktop">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        "inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-extrabold transition",
                        isActive ? "bg-amber-400 text-[#1b1004] shadow-[0_10px_24px_rgba(245,158,11,0.22)]" : "border border-white/10 bg-white/[0.045] text-white/50 hover:text-white"
                      )
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </NavLink>
                );
              })}
            </nav>
          </header>

          <section className="grid grid-cols-4 gap-4">
            {[
              { label: "SKU thành phẩm", value: loading ? "..." : stats.count, sub: "đang quản lý", tone: "text-white" },
              { label: "Giá bán TB", value: loading ? "..." : vnd(stats.avgSelling), sub: `${stats.pricedCount} SKU có giá`, tone: "text-amber-200" },
              { label: "Giá cao nhất", value: loading ? "..." : vnd(stats.maxSelling), sub: "top giá bán", tone: "text-orange-200" },
              { label: "Cập nhật", value: loading ? "..." : formatDateTime(stats.updatedAt), sub: "gần nhất", tone: "text-emerald-200" },
            ].map((card) => (
              <article key={card.label} className="rounded-[28px] border border-white/10 bg-[#14100d]/90 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)]">
                <p className="text-xs font-extrabold uppercase tracking-[0.15em] text-white/35">{card.label}</p>
                <div className={cn("mt-4 text-[30px] font-black leading-none tracking-[-0.04em]", card.tone)}>{card.value}</div>
                <p className="mt-3 text-sm font-bold text-white/38">{card.sub}</p>
              </article>
            ))}
          </section>

          <section className="grid grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)] gap-5">
            <article className="rounded-[30px] border border-white/10 bg-[#14100d]/92 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.3)]">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-black tracking-[-0.03em] text-white">Phân bổ giá bán SKU</h2>
                  <p className="mt-1 text-sm font-semibold text-white/38">Dải giá toàn bộ SKU thành phẩm.</p>
                </div>
                <span className="rounded-full bg-amber-300/10 px-3 py-1.5 text-xs font-extrabold text-amber-200 ring-1 ring-amber-300/20">{stats.count} SKU</span>
              </div>
              <div className="space-y-4">
                {stats.bandCounts.map((band) => (
                  <div key={band.label} className="grid grid-cols-[64px_minmax(0,1fr)_40px] items-center gap-3">
                    <span className="text-sm font-bold text-white/48">{band.label}</span>
                    <div className="h-4 overflow-hidden rounded-full bg-white/[0.07]">
                      <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-300" style={{ width: `${Math.max(6, (band.count / maxBand) * 100)}%` }} />
                    </div>
                    <span className="text-right text-sm font-black tabular-nums text-white">{loading ? "-" : band.count}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-[30px] border border-white/10 bg-[#14100d]/92 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.3)]">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-black tracking-[-0.03em] text-white">Tình trạng dữ liệu</h2>
                  <p className="mt-1 text-sm font-semibold text-white/38">Theo dõi giá bán và ảnh sản phẩm trước khi review COGS.</p>
                </div>
                <Camera className="h-5 w-5 text-amber-200/70" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Có giá bán", value: stats.pricedCount, tone: "text-emerald-300" },
                  { label: "Chưa có giá", value: stats.missingPrice, tone: stats.missingPrice ? "text-rose-300" : "text-white/70" },
                  { label: "Có ảnh", value: stats.imageCount, tone: "text-amber-200" },
                ].map((chip) => (
                  <div key={chip.label} className="rounded-[24px] border border-white/10 bg-[#211915]/80 p-5 text-center">
                    <div className={cn("text-[32px] font-black leading-none", chip.tone)}>{loading ? "..." : chip.value}</div>
                    <div className="mt-3 text-xs font-extrabold uppercase tracking-[0.12em] text-white/38">{chip.label}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-[24px] border border-amber-300/15 bg-amber-300/[0.055] p-4 text-sm font-semibold leading-relaxed text-amber-50/68">
                Desktop dùng cùng dữ liệu realtime với mobile. Upload ảnh, xuất sheet và mở quản trị SKU hoạt động chung một state.
              </div>
            </article>
          </section>

          <section className="rounded-[32px] border border-white/10 bg-[#14100d]/94 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.34)]">
            <div className="mb-5 flex items-end justify-between gap-5">
              <div>
                <h2 className="text-2xl font-black tracking-[-0.03em] text-white">Toàn bộ SKU hiện có</h2>
                <p className="mt-1 text-sm font-bold text-white/38">Bấm ảnh để upload/cập nhật hình; bấm dòng để mở quản trị SKU.</p>
              </div>
              <div className="flex min-w-[420px] items-center gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-white/10 bg-[#211915] px-3 py-2.5 shadow-inner">
                  <Search className="h-4 w-4 shrink-0 text-white/35" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Tìm SKU theo tên hoặc mã"
                    className="h-9 border-0 bg-transparent px-0 text-sm font-bold text-white placeholder:text-white/28 focus-visible:ring-0"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setSortMode((mode) => (mode === "price" ? "updated" : "price"))}
                  className="h-12 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] px-4 text-sm font-extrabold text-amber-200"
                >
                  Sort: {sortMode === "price" ? "Giá bán" : "Mới cập nhật"}
                </button>
              </div>
            </div>

            {loading ? (
              <div className="rounded-[24px] border border-white/10 bg-white/[0.04] px-4 py-12 text-center text-sm font-bold text-white/45">Đang tải SKU...</div>
            ) : filteredSkus.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-white/12 bg-white/[0.035] px-4 py-12 text-center text-sm font-bold text-white/45">Không tìm thấy SKU phù hợp.</div>
            ) : (
              <div className="overflow-hidden rounded-[26px] border border-white/10">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-white/[0.045] text-xs font-extrabold uppercase tracking-[0.12em] text-white/38">
                    <tr>
                      <th className="px-4 py-3">SKU</th>
                      <th className="px-4 py-3">Giá bán</th>
                      <th className="px-4 py-3">Giá vốn</th>
                      <th className="px-4 py-3">LC %</th>
                      <th className="px-4 py-3">Trạng thái</th>
                      <th className="px-4 py-3">Cập nhật</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8">
                    {filteredSkus.map((sku) => {
                      const hasPrice = sku.sellingPrice > 0;
                      return (
                        <tr key={sku.id} className="group bg-[#120e0b]/72 transition hover:bg-white/[0.045]">
                          <td className="px-4 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <SkuImageThumb sku={sku} uploading={uploadingSkuId === sku.id} onClick={() => openUploadModal(sku)} />
                              <button type="button" onClick={() => openSkuDetail(sku)} className="min-w-0 text-left" aria-label={`Xem chi tiết ${sku.product_name}`}>
                                <div className="max-w-[340px] truncate text-sm font-black text-white group-hover:text-amber-100">{sku.product_name}</div>
                                <div className="mt-1 truncate font-mono text-xs font-bold text-white/35">{sku.sku_code || sku.id}</div>
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm font-black text-amber-300">{vnd(sku.sellingPrice)}</td>
                          <td className="px-4 py-3 text-sm font-bold text-white/72">{vnd(sku.totalCost)}</td>
                          <td className="px-4 py-3 text-sm font-black text-white">{Number.isFinite(sku.marginPct) ? `${Math.round(sku.marginPct)}%` : "—"}</td>
                          <td className="px-4 py-3">
                            <span className={cn("rounded-full px-2.5 py-1 text-xs font-extrabold ring-1", hasPrice ? "bg-emerald-400/10 text-emerald-300 ring-emerald-300/20" : "bg-rose-400/10 text-rose-300 ring-rose-300/20")}>
                              {hasPrice ? "Có giá" : "Chưa giá"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-white/45">{formatDateTime(sku.updated_at)}</td>
                          <td className="px-4 py-3 text-right">
                            <Button type="button" onClick={() => openSkuDetail(sku)} className="h-10 rounded-2xl bg-white/[0.06] px-4 text-xs font-extrabold text-white hover:bg-amber-300 hover:text-[#1b1004]">
                              Mở chi tiết
                              <ChevronRight className="ml-1.5 h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      <Dialog open={!!editingSku} onOpenChange={(open) => { if (!open && !uploadingSkuId) { setEditingSku(null); setSelectedFile(null); setUploadError(null); } }}>
        <DialogContent className="border-white/10 bg-[#14100d] text-white sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-white">Cập nhật ảnh SKU</DialogTitle>
          </DialogHeader>
          {editingSku && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                <p className="text-sm font-black text-white">{editingSku.product_name}</p>
                <p className="mt-1 font-mono text-xs font-bold text-white/40">{editingSku.sku_code || editingSku.id}</p>
              </div>
              <div className="overflow-hidden rounded-[22px] border border-white/10 bg-[#211915]">
                {previewUrl || editingSku.image_url ? (
                  <img src={previewUrl || editingSku.image_url || ""} alt="Preview ảnh SKU" className="h-56 w-full object-cover" />
                ) : (
                  <div className="flex h-56 flex-col items-center justify-center gap-2 text-white/42">
                    <ImageIcon className="h-8 w-8" />
                    <span className="text-sm font-extrabold">Chưa có ảnh</span>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleFileChange} />
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!!uploadingSkuId} className="h-11 w-full rounded-2xl border-amber-300/25 bg-amber-300/[0.06] text-amber-200 hover:bg-amber-300/10 hover:text-amber-100">
                <Upload className="mr-2 h-4 w-4" /> Chọn ảnh
              </Button>
              {selectedFile && <p className="text-xs font-bold text-white/45">Đã chọn: {selectedFile.name}</p>}
              {uploadError && (
                <div className="flex items-start gap-2 rounded-2xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs font-bold text-rose-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{uploadError}</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" disabled={!!uploadingSkuId} onClick={() => { setEditingSku(null); setSelectedFile(null); setUploadError(null); }} className="text-white/60 hover:bg-white/[0.06] hover:text-white">Hủy</Button>
            <Button type="button" onClick={saveSkuImage} disabled={!selectedFile || !!uploadingSkuId} className="bg-amber-400 font-extrabold text-[#1b1004] hover:bg-amber-300">
              {uploadingSkuId ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Lưu ảnh
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
