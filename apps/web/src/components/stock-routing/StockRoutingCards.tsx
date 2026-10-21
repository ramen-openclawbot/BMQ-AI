import { useState } from "react";
import { OptionPicker } from "@/components/OptionPicker";
import { RotateCcw, Sparkles, Truck, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useDecideMaterialCategory,
  useDecideSupplierRouting,
  useRevertMaterialCategory,
  useRevertSupplierRouting,
  useRunStockRoutingJev,
  useStockRoutingReview,
} from "@/hooks/useStockRouting";
import {
  materialCategoryLabel,
  stockRoutingLocationLabel,
  STOCK_ROUTING_LOCATIONS,
  type StockRoutingLocation,
  type StockRoutingMaterialPending,
  type StockRoutingSupplierPending,
} from "@/lib/stock-routing";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}` : iso;
};
const errorText = (error: unknown) => {
  const message = String((error as { message?: string })?.message ?? error);
  if (message.includes("insufficient_privilege")) return "Tài khoản chưa có quyền thao tác này. Gắn nhóm mã chuẩn cần quyền Material Master.";
  if (message.includes("daily") || message.includes("quota")) return "Đã hết hạn mức gọi Sushi hôm nay.";
  if (message.includes("version conflict")) return "Mã này vừa được người khác sửa, tải lại rồi thử lại.";
  return message;
};
const evidenceNames = (evidence: Record<string, unknown> | null) => {
  const names = evidence?.top_names ?? evidence?.names ?? evidence?.lines;
  if (!Array.isArray(names)) return "";
  return names
    .slice(0, 5)
    .map((entry) => (typeof entry === "string" ? entry : String((entry as { name?: string })?.name ?? "")))
    .filter(Boolean)
    .join(", ");
};

function SupplierRow({ row, canEdit }: { row: StockRoutingSupplierPending; canEdit: boolean }) {
  const { toast } = useToast();
  const decide = useDecideSupplierRouting();
  const [location, setLocation] = useState<StockRoutingLocation>(row.proposed_location);
  const act = (action: "approve" | "reject") =>
    decide.mutate(
      { suggestionId: row.id, action, location: action === "approve" && location !== row.proposed_location ? location : null },
      {
        onSuccess: (data) => {
          const filled = Number((data as { receipts_filled?: number })?.receipts_filled ?? 0);
          toast({ title: action === "approve" ? "Đã áp kho nhận" : "Đã bỏ đề xuất", description: action === "approve" ? `${row.supplier_name ?? "NCC"} → ${stockRoutingLocationLabel(location)}${filled ? ` · ${filled} phiếu cũ đã điền kho` : ""}` : undefined });
        },
        onError: (error) => toast({ title: "Chưa làm được", description: errorText(error), variant: "destructive" }),
      },
    );
  return (
    <li className={`d3-sc-row${row.conflict ? " is-flagged" : ""}`} data-bmq-routing-supplier>
      <div className="d3-sc-side">
        <strong>{row.supplier_name ?? "—"}</strong>
        <span>
          {row.category ? `${row.category} · ` : ""}{evidenceNames(row.evidence) || "chưa có tên hàng"}
        </span>
      </div>
      <div className="d3-sc-meta">
        <span className={`d3-sc-prob${row.probability >= 0.9 ? " is-high" : row.probability < 0.7 ? " is-low" : ""}`}>Sushi {pct(row.probability)} → {stockRoutingLocationLabel(row.proposed_location)}</span>
        {row.conflict ? <span className="d3-sc-warn">Luật đoán: {stockRoutingLocationLabel(row.rule_hint)}</span> : null}
      </div>
      {canEdit ? (
        <div className="d3-sc-actions is-routing">
          <OptionPicker value={location} onChange={(value) => setLocation(value as StockRoutingLocation)} title={`Kho nhận cho ${row.supplier_name ?? "NCC"}`} ariaLabel={`Kho nhận cho ${row.supplier_name ?? "NCC"}`} options={STOCK_ROUTING_LOCATIONS.map((value) => ({ value, label: stockRoutingLocationLabel(value) }))} />
          <Button type="button" size="sm" onClick={() => act("approve")} disabled={decide.isPending}>Áp</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => act("reject")} disabled={decide.isPending}>Bỏ</Button>
        </div>
      ) : null}
    </li>
  );
}

function MaterialRow({ row, categories, canEdit }: { row: StockRoutingMaterialPending; categories: Array<{ code: string; label_vi: string }>; canEdit: boolean }) {
  const { toast } = useToast();
  const decide = useDecideMaterialCategory();
  const [category, setCategory] = useState(row.proposed_category);
  const act = (action: "approve" | "reject") =>
    decide.mutate(
      { suggestionId: row.id, action, category: action === "approve" && category !== row.proposed_category ? category : null },
      {
        onSuccess: () => toast({ title: action === "approve" ? "Đã gắn nhóm" : "Đã bỏ đề xuất", description: `${row.canonical_name}${action === "approve" ? ` → ${materialCategoryLabel(category)}` : ""}` }),
        onError: (error) => toast({ title: "Chưa làm được", description: errorText(error), variant: "destructive" }),
      },
    );
  return (
    <li className="d3-sc-row" data-bmq-routing-material>
      <div className="d3-sc-side">
        <strong>{row.canonical_name}</strong>
        <span>{row.material_code}{row.current_category ? ` · đang ở ${materialCategoryLabel(row.current_category)}` : ""} · Sushi {pct(row.probability)}</span>
      </div>
      {canEdit ? (
        <div className="d3-sc-actions is-routing">
          <OptionPicker value={category} onChange={setCategory} title={`Nhóm cho ${row.canonical_name}`} ariaLabel={`Nhóm cho ${row.canonical_name}`} options={categories.map((item) => ({ value: item.code, label: item.label_vi }))} />
          <Button type="button" size="sm" onClick={() => act("approve")} disabled={decide.isPending}>Duyệt</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => act("reject")} disabled={decide.isPending}>Bỏ</Button>
        </div>
      ) : (
        <span className="d3-wh-pill">{row.proposed_label ?? materialCategoryLabel(row.proposed_category)}</span>
      )}
    </li>
  );
}

/** Two review cards for Giai đoạn 3: supplier receiving warehouse and material groups. */
export function StockRoutingCards({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const reviewQuery = useStockRoutingReview();
  const runSuppliers = useRunStockRoutingJev("suppliers");
  const runMaterials = useRunStockRoutingJev("materials");
  const revertSupplier = useRevertSupplierRouting();
  const revertMaterial = useRevertMaterialCategory();
  const review = reviewQuery.data;
  const counts = review?.supplier_counts;
  const quotaLeft = review ? Math.max(0, review.jev_usage.call_limit - review.jev_usage.calls) : null;
  const fail = (title: string) => (error: unknown) => toast({ title, description: errorText(error), variant: "destructive" });
  const runToast = (label: string) => (data: { suggestions: number; applied: number; pending: number; failed: number; calls: number; stopped: string | null }) =>
    toast({ title: `Sushi đã ${label}`, description: `${data.applied} tự áp, ${data.pending} chờ duyệt, ${data.failed} lỗi, ${data.calls} lượt gọi${data.stopped ? " · dừng vì hết hạn mức" : ""}.` });
  const catCounts = review?.material_category_counts ?? {};
  const classified = Object.entries(catCounts).filter(([key]) => key !== "unclassified").reduce((sum, [, n]) => sum + n, 0);

  const loadState = reviewQuery.isLoading ? <div className="d3-wh-empty">Đang tải…</div> : reviewQuery.isError ? <div className="d3-wh-empty">Không tải được: {errorText(reviewQuery.error)}</div> : null;

  return (
    <>
      <section className="d3-wh-card" style={{ ["--i" as string]: 5 }} data-bmq-routing-suppliers>
        <div className="d3-wh-card-h">
          <h2>Kho nhận theo nhà cung cấp</h2>
          <span className="d3-wh-pill">
            {counts ? `Q7 ${counts.q7} · Tân Tạo ${counts.tan_tao} · miễn ${counts.non_stock} · chưa có ${counts.none}` : "…"}
          </span>
          <p>Sushi xếp nhà cung cấp theo tên và hàng đã giao. Tin trên 90% thì tự áp; mâu thuẫn với luật đoán thì chờ anh.</p>
          {canEdit ? (
            <button type="button" className="d3-ap-link" disabled={runSuppliers.isPending || quotaLeft === 0} onClick={() => runSuppliers.mutate(undefined, { onSuccess: runToast("xếp nhà cung cấp"), onError: fail("Sushi chưa chạy được") })}>
              <Truck className="inline h-3.5 w-3.5" /> {runSuppliers.isPending ? "Sushi đang xếp…" : "Xếp kho nhận bằng Sushi"}
            </button>
          ) : null}
        </div>
        {loadState ?? (
          (review?.supplier_pending.length ?? 0) === 0 && (review?.supplier_recent.length ?? 0) === 0 ? (
            <div className="d3-wh-empty">Chưa có đề xuất. Bấm "Xếp kho nhận bằng Sushi".</div>
          ) : (
            <ul className="d3-sc-list">
              {review?.supplier_pending.map((row) => <SupplierRow key={row.id} row={row} canEdit={canEdit} />)}
              {review?.supplier_recent.slice(0, 8).map((row) => (
                <li key={row.id} className={`d3-sc-row is-history${row.status === "reverted" ? " is-reverted" : ""}`} data-bmq-routing-recent>
                  <div className="d3-sc-side">
                    <strong>{row.supplier_name ?? "—"} → {stockRoutingLocationLabel(row.proposed_location)}</strong>
                    <span>{row.status === "applied" ? `đã áp ${shortDate(row.applied_at)}` : "đã hoàn tác"} · Sushi {pct(row.probability)}</span>
                  </div>
                  {canEdit && row.status === "applied" ? (
                    <Button type="button" variant="outline" size="sm" disabled={revertSupplier.isPending} onClick={() => revertSupplier.mutate({ suggestionId: row.id }, { onSuccess: () => toast({ title: "Đã hoàn tác kho nhận" }), onError: fail("Chưa hoàn tác được") })}>
                      <RotateCcw className="h-3.5 w-3.5" /> Hoàn tác
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        )}
      </section>

      <section className="d3-wh-card" style={{ ["--i" as string]: 6 }} data-bmq-routing-materials>
        <div className="d3-wh-card-h">
          <h2>Nhóm nguyên vật liệu</h2>
          <span className="d3-wh-pill">{review ? `${classified} có nhóm · ${catCounts.unclassified ?? 0} chưa` : "…"}</span>
          <p>Mã chuẩn được gắn nhóm để báo cáo giá vốn theo nhóm. Tin trên 85% thì tự áp.</p>
          {canEdit ? (
            <button type="button" className="d3-ap-link" disabled={runMaterials.isPending || quotaLeft === 0} onClick={() => runMaterials.mutate(undefined, { onSuccess: runToast("gắn nhóm"), onError: fail("Sushi chưa chạy được") })}>
              <Tags className="inline h-3.5 w-3.5" /> {runMaterials.isPending ? "Sushi đang gắn…" : "Gắn nhóm bằng Sushi"}
            </button>
          ) : null}
        </div>
        {loadState ?? (
          (review?.material_pending.length ?? 0) === 0 ? (
            <div className="d3-wh-empty">Không có mã chờ duyệt nhóm.</div>
          ) : (
            <ul className="d3-sc-list">
              {review?.material_pending.map((row) => <MaterialRow key={row.id} row={row} categories={review.categories} canEdit={canEdit} />)}
            </ul>
          )
        )}
        {review && Object.keys(catCounts).length ? (
          <div className="d3-ma-chips" style={{ marginTop: 10 }}>
            {Object.entries(catCounts).filter(([key]) => key !== "unclassified").map(([code, n]) => (
              <span key={code} className="d3-ma-chip is-new"><Sparkles className="h-3 w-3" />{materialCategoryLabel(code)}: {n}</span>
            ))}
          </div>
        ) : null}
        {revertMaterial.isPending ? <p className="d3-wh-note">Đang hoàn tác…</p> : null}
      </section>
    </>
  );
}
