import { useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useKhoReviewCreateItem, useKhoReviewLink, useKhoReviewList } from "@/hooks/useKhoReview";
import {
  khoReviewErrorText, reviewReasonText, suggestedFactor,
  type KhoReviewCandidate, type KhoReviewItem, type KhoReviewLocation, type KhoReviewMaterial,
} from "@/lib/kho-review";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { cn } from "@/lib/utils";
import { KhoDialog } from "@/components/kho/KhoDialog";
import { ReceiptNotes } from "@/components/kho/ReceiptNotes";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import { ITEM_UNITS, KHO_LABEL, KHO_LOCATIONS, fmtAmount, fmtQty, newRequestId, normalizeName, parseNum } from "@/components/kho/kho-meta";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";

type View = "items" | "materials";
const money = (value: number | null) => (value === null ? "" : `${Math.round(value).toLocaleString("vi-VN")}đ`);
const dm = (iso: string) => iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/");

/** Candidates as receipt lines, so the delivery-note viewer shows the evidence (owner rule 17/10). */
const asLines = (cands: KhoReviewCandidate[]): ReceiptLine[] => cands.map((c) => ({
  goods_receipt_id: c.receipt_item_id, goods_receipt_item_id: c.receipt_item_id,
  receipt_number: c.receipt_number, receipt_date: c.receipt_date, status: "received",
  supplier_name: c.supplier_name, raw_name: c.product_name, quantity: c.actual_quantity ?? 0,
  unit: c.unit, unit_price: c.unit_price, line_total: null, image_path: c.image_url, photo_paths: [],
}));

/**
 * Rà soát nhập kho (temporary, owner 22/10/2026): items with no purchase line or a negative balance, and recipe
 * materials without a kho item, each with the receipt lines whose names look alike. Link a line (with its
 * conversion) or create the item from it. Remove the tab once the list is empty.
 */
export default function KhoReview() {
  const list = useKhoReviewList();
  const [view, setView] = useState<View>("items");
  const [kho, setKho] = useState<KhoReviewLocation>("q7");
  const [query, setQuery] = useState("");
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [openMat, setOpenMat] = useState<string | null>(null);
  const { confirm, dialog } = useKhoConfirm();
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const materials = useMemo(() => list.data?.materials ?? [], [list.data]);
  const key = normalizeName(query);
  const rows = items.filter((r) => r.location === kho && (!key || normalizeName(r.name).includes(key)));
  const mats = materials.filter((m) => !key || normalizeName(m.name).includes(key));
  const counts = { tan_tao: items.filter((r) => r.location === "tan_tao").length, q7: items.filter((r) => r.location === "q7").length };
  const item = items.find((r) => `${r.item_id}:${r.location}` === openItem) ?? null;
  const mat = materials.find((m) => `${m.canonical_material_id}:${m.recipe_unit}` === openMat) ?? null;

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-review>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Rà soát nhập kho</h1>
          <p className="d3-wh-tag">{list.isLoading ? "Đang đọc phiếu mua…" : list.isError ? "Chưa đọc được" : `${items.length} món kho · ${materials.length} NVL giá vốn cần xử lý`}</p>
        </div>
        {view === "items" ? (
          <div className="d3-sl-switch d3-kho-switch" role="tablist" aria-label="Kho">
            {KHO_LOCATIONS.map((loc) => (
              <button key={loc} type="button" role="tab" aria-selected={kho === loc} className={cn(kho === loc && "is-on")} onClick={() => setKho(loc)} data-bmq-review-loc={loc}>
                Kho {KHO_LABEL[loc]}{list.data ? <small>{counts[loc]}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <section className="d3-wh-card d3-kho-card">
        <div className="d3-kho-tabs" role="tablist" aria-label="Nhóm">
          <button type="button" role="tab" aria-selected={view === "items"} className={cn(view === "items" && "is-on")} onClick={() => setView("items")} data-bmq-review-view="items">
            Món kho<small>{list.data ? items.length : "…"}</small>
          </button>
          <button type="button" role="tab" aria-selected={view === "materials"} className={cn(view === "materials" && "is-on")} onClick={() => setView("materials")} data-bmq-review-view="materials">
            NVL giá vốn<small>{list.data ? materials.length : "…"}</small>
          </button>
        </div>
        <div className="d3-kho-tools">
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm món…" aria-label="Tìm món" enterKeyHint="search" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
          </span>
        </div>
        <p className="d3-kho-hint">
          {view === "items"
            ? "Món chưa có phiếu mua nào hoặc đang âm. Chọn món, xem phiếu có tên gần giống rồi nối vào đúng món."
            : "Nguyên liệu trong công thức giá vốn chưa có món kho. Tạo món từ phiếu mua, công thức tự trừ vào món đó."}
        </p>

        {list.isLoading ? <LoadingState label="Đang đọc phiếu mua" /> : list.isError ? (
          <div className="d3-kho-failed" role="alert">
            <p>Không tải được danh sách. {khoReviewErrorText(list.error)}</p>
            <Button variant="outline" onClick={() => void list.refetch()}>Thử lại</Button>
          </div>
        ) : view === "items" ? (
          rows.length ? (
            <ul className="d3-kho-list" data-bmq-review-items>
              {rows.map((r) => (
                <li key={`${r.item_id}:${r.location}`} className="d3-kho-row">
                  <button type="button" className="d3-kho-row-main" onClick={() => setOpenItem(`${r.item_id}:${r.location}`)} data-bmq-review-item={r.item_id}>
                    <b>{r.name}</b>
                    <small>
                      <span className={cn(r.reason !== "no_docs" && "is-flag")}>{reviewReasonText(r.reason)}</span>
                      <span>{r.candidates.length ? `${r.candidates.length} phiếu gần giống` : "chưa thấy phiếu gần giống"}</span>
                    </small>
                  </button>
                  <span className={cn("d3-kho-row-qty", r.qty < 0 && "is-short")}>{fmtAmount(r.qty, r.unit)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="d3-kho-empty">Kho {KHO_LABEL[kho]} không còn món nào cần rà soát.</p>
        ) : mats.length ? (
          <ul className="d3-kho-list" data-bmq-review-materials>
            {mats.map((m) => (
              <li key={`${m.canonical_material_id}:${m.recipe_unit}`} className="d3-kho-row is-link">
                <button type="button" className="d3-kho-row-main" onClick={() => setOpenMat(`${m.canonical_material_id}:${m.recipe_unit}`)} data-bmq-review-material={m.canonical_material_id}>
                  <b>{m.name}</b>
                  <small>
                    <span>{m.recipe_unit}</span>
                    <span>{m.sku_codes.join(", ")}</span>
                    <span className={cn(!m.candidates.length && "is-flag")}>{m.candidates.length ? `${m.candidates.length} phiếu gần giống` : "chưa có phiếu mua"}</span>
                  </small>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="d3-kho-empty">Mọi NVL trong giá vốn đã có món kho.</p>}
      </section>

      {item ? <ItemReview item={item} confirm={confirm} onClose={() => setOpenItem(null)} /> : null}
      {mat ? <MaterialReview mat={mat} onClose={() => setOpenMat(null)} /> : null}
      {dialog}
    </div>
  );
}

function CandidateCard({ c, children, note }: { c: KhoReviewCandidate; children?: ReactNode; note?: string }) {
  return (
    <li className="d3-kr-cand" data-bmq-review-cand={c.receipt_item_id}>
      <div className="d3-kr-cand-head">
        <b>{c.product_name}</b>
        <span className="d3-kr-score" title="Mức giống tên">{Math.round(c.score * 100)}%</span>
      </div>
      <small>
        {c.receipt_number} · {dm(c.receipt_date)} · Kho {c.location ? KHO_LABEL[c.location] : "?"}
        {c.supplier_name ? ` · ${c.supplier_name}` : ""}
      </small>
      <small>
        {c.actual_quantity !== null ? `${fmtQty(c.actual_quantity)} ${c.unit ?? ""}` : "chưa ghi số lượng"}
        {c.unit_price !== null ? ` × ${money(c.unit_price)}` : ""}
        {c.posted ? " · đã vào sổ kho" : ""}
      </small>
      {note ? <small className="is-flag">{note}</small> : null}
      {children}
    </li>
  );
}

function ItemReview({ item, confirm, onClose }: { item: KhoReviewItem; confirm: ReturnType<typeof useKhoConfirm>["confirm"]; onClose: () => void }) {
  const { toast } = useToast();
  const link = useKhoReviewLink();
  const [picked, setPicked] = useState<string | null>(null);
  const [factorText, setFactorText] = useState("");
  const cand = item.candidates.find((c) => c.receipt_item_id === picked) ?? null;
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const pick = (c: KhoReviewCandidate) => {
    setPicked(c.receipt_item_id);
    const f = suggestedFactor(c.unit, item.unit);
    setFactorText(f !== null ? String(f) : "");
  };
  const save = async () => {
    if (!cand || !factorOk) return;
    if (cand.location !== item.location) {
      const ok = await confirm({ title: "Phiếu ở kho khác", message: `Phiếu này nhận ở Kho ${cand.location ? KHO_LABEL[cand.location] : "?"}, món đang rà ở Kho ${KHO_LABEL[item.location]}. Vẫn nối?`, ok: "Vẫn nối", cancel: "Thôi" });
      if (!ok) return;
    }
    link.mutate({ receiptItemId: cand.receipt_item_id, itemId: item.item_id, factor: x, requestId: newRequestId() }, {
      onSuccess: (r) => {
        toast({ title: `Đã nối “${cand.product_name}” vào ${item.name}`, description: r.posted ? "Phiếu đã vào sổ kho." : "Phiếu trước ngày kiểm kê nên không cộng tồn; các phiếu sau tự vào đúng món." });
        onClose();
      },
    });
  };

  return (
    <KhoDialog title={item.name} sub={`Kho ${KHO_LABEL[item.location]} · ${reviewReasonText(item.reason)} · tồn ${fmtAmount(item.qty, item.unit)}`} onClose={onClose} wide data={{ "data-bmq-review-dialog": "" }}>
      {item.candidates.length ? (
        <ul className="d3-kr-cands">
          {item.candidates.map((c) => (
            <CandidateCard key={c.receipt_item_id} c={c} note={c.linked_item_id && c.linked_item_id !== item.item_id ? "Tên này đang nối vào món khác" : c.linked_item_id === item.item_id ? "Đã nối vào món này" : undefined}>
              {picked === c.receipt_item_id ? (
                <div className="d3-kho-ask">
                  <b>Quy đổi: xem ảnh phiếu bên dưới rồi gõ</b>
                  <label className="d3-kho-conv">
                    1 {c.unit ?? "đơn vị"} =
                    <Input inputMode="decimal" value={factorText} onChange={(e) => setFactorText(e.target.value)} placeholder="?" aria-label={`1 ${c.unit ?? "đơn vị"} bằng bao nhiêu ${item.unit}`} data-bmq-review-factor />
                    {item.unit}
                  </label>
                  {link.error ? <p className="d3-kho-error">{khoReviewErrorText(link.error)}</p> : null}
                  <div className="d3-kho-actions">
                    <Button disabled={!factorOk || link.isPending} onClick={() => void save()} data-bmq-review-link>{link.isPending ? "Đang nối…" : "Nối vào món này"}</Button>
                    <Button variant="outline" onClick={() => setPicked(null)}>Thôi</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="d3-kr-pick" onClick={() => pick(c)} data-bmq-review-pick>Chọn dòng này</Button>
              )}
            </CandidateCard>
          ))}
        </ul>
      ) : <p className="d3-kho-hint">Chưa thấy phiếu mua nào có tên gần giống. Gửi ảnh phiếu cho VNAgent trong chat để nối, hoặc tắt món nếu không dùng nữa.</p>}
      {item.candidates.length ? <ReceiptNotes title="Ảnh phiếu giao của các dòng trên" lines={asLines(item.candidates)} loading={false} error={null} /> : null}
    </KhoDialog>
  );
}

function MaterialReview({ mat, onClose }: { mat: KhoReviewMaterial; onClose: () => void }) {
  const { toast } = useToast();
  const create = useKhoReviewCreateItem();
  const [picked, setPicked] = useState<string | null>(null);
  const cand = mat.candidates.find((c) => c.receipt_item_id === picked) ?? null;
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("g");
  const [cls, setCls] = useState<"raw_material" | "packaging_supply">("raw_material");
  const [factorText, setFactorText] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const x = parseNum(factorText);
  const factorOk = Number.isFinite(x) && x > 0;

  const pick = (c: KhoReviewCandidate) => {
    setPicked(c.receipt_item_id);
    setName(c.product_name.trim());
    const f = suggestedFactor(c.unit, unit);
    setFactorText(f !== null ? String(f) : "");
  };
  const save = () => {
    if (!cand || !factorOk || name.trim().length < 2) return;
    setLinkError(null);
    create.mutate({ receiptItemId: cand.receipt_item_id, name: name.trim(), unit, itemClass: cls, factor: x, requestId: newRequestId() }, {
      onSuccess: async (r) => {
        // Point the recipe line at the new item when the recipe unit converts by the standard table.
        const recipeFactor = suggestedFactor(mat.recipe_unit, unit);
        let recipeLinked = false;
        if (r.item_id && recipeFactor !== null) {
          const { error } = await (supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }> })
            .rpc("cogs_decide_ingredient", {
              p_canonical_material_id: mat.canonical_material_id, p_recipe_unit: mat.recipe_unit, p_action: "deduct",
              p_location: r.location, p_item_id: r.item_id, p_factor: recipeFactor, p_request_id: newRequestId(),
            });
          recipeLinked = !error;
          if (error) setLinkError("Đã tạo món nhưng chưa nối được vào công thức giá vốn. Nhắn VNAgent để nối.");
        }
        toast({
          title: `Đã tạo món “${name.trim()}” ở Kho ${KHO_LABEL[r.location]}`,
          description: recipeLinked ? "Công thức giá vốn đã trừ vào món này." : `Đơn vị công thức (${mat.recipe_unit}) khác đơn vị món (${unit}): nhắn VNAgent để nối công thức.`,
        });
        if (recipeLinked || recipeFactor === null) onClose();
      },
    });
  };

  return (
    <KhoDialog title={mat.name} sub={`NVL giá vốn · ${mat.recipe_unit} · ${mat.sku_codes.join(", ")}`} onClose={onClose} wide data={{ "data-bmq-review-dialog": "" }}>
      {mat.candidates.length ? (
        <ul className="d3-kr-cands">
          {mat.candidates.map((c) => (
            <CandidateCard key={c.receipt_item_id} c={c} note={c.linked_item_id ? "Tên này đã nối vào một món kho, nhắn VNAgent để nối công thức" : undefined}>
              {picked === c.receipt_item_id ? (
                <div className="d3-kho-ask">
                  <label className="d3-kho-field"><span>Tên món kho</span>
                    <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-bmq-review-name />
                  </label>
                  <div className="d3-kho-field"><span>Loại hàng</span>
                    <div className="d3-kho-seg" role="group" aria-label="Loại hàng">
                      <button type="button" aria-pressed={cls === "raw_material"} className={cn(cls === "raw_material" && "is-on")} onClick={() => setCls("raw_material")}>Nguyên liệu</button>
                      <button type="button" aria-pressed={cls === "packaging_supply"} className={cn(cls === "packaging_supply" && "is-on")} onClick={() => setCls("packaging_supply")}>Bao bì & vật tư</button>
                    </div>
                  </div>
                  <label className="d3-kho-field"><span>Đơn vị kho</span>
                    <select className="d3-kr-select" value={unit} onChange={(e) => { setUnit(e.target.value); const f = suggestedFactor(c.unit, e.target.value); if (f !== null) setFactorText(String(f)); }} data-bmq-review-unit>
                      {ITEM_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </label>
                  <label className="d3-kho-conv">
                    1 {c.unit ?? "đơn vị"} =
                    <Input inputMode="decimal" value={factorText} onChange={(e) => setFactorText(e.target.value)} placeholder="?" aria-label={`1 ${c.unit ?? "đơn vị"} bằng bao nhiêu ${unit}`} data-bmq-review-factor />
                    {unit}
                  </label>
                  {create.error ? <p className="d3-kho-error">{khoReviewErrorText(create.error)}</p> : null}
                  {linkError ? <p className="d3-kho-error">{linkError}</p> : null}
                  <div className="d3-kho-actions">
                    <Button disabled={!factorOk || name.trim().length < 2 || create.isPending} onClick={save} data-bmq-review-create>{create.isPending ? "Đang tạo…" : "Tạo món từ dòng này"}</Button>
                    <Button variant="outline" onClick={() => setPicked(null)}>Thôi</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="d3-kr-pick" onClick={() => pick(c)} data-bmq-review-pick>Tạo món từ dòng này</Button>
              )}
            </CandidateCard>
          ))}
        </ul>
      ) : <p className="d3-kho-hint">Chưa có phiếu mua nào cho NVL này. Khi mua lần đầu, phiếu nhập sẽ hiện ở đây; hoặc nhắn VNAgent để tạo món trước.</p>}
      {mat.candidates.length ? <ReceiptNotes title="Ảnh phiếu giao của các dòng trên" lines={asLines(mat.candidates)} loading={false} error={null} /> : null}
    </KhoDialog>
  );
}
