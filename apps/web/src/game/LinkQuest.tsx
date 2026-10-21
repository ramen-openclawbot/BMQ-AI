import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCompleteMission } from "@/hooks/useMissions";
import { useDiscontinueStockItem, useDiscontinuedStockItems, useReactivateStockItem } from "@/hooks/useStockItemDiscontinue";
import { discontinueErrorCode, discontinueErrorText } from "@/lib/stock-item-discontinue";
import { useLinkExactMaterials, useLinkItemMaterial, useMaterialLinkPendingFactors, useMaterialLinkReview, useSetItemMaterialFactor, useSkipItemLink } from "@/hooks/useMaterialLinkQuest";
import { useItemReceiptLines } from "@/hooks/useWarehouseGame";
import { bulkableRows, deckOrder, factorPrefill, itemFactorPrefill, type MaterialLinkCandidate, type MaterialLinkLocation, type MaterialLinkPendingFactor, type MaterialLinkPurchaseLine, type MaterialLinkReviewItem } from "@/lib/material-link-quest";
import { q7MaterialLinkErrorCode, q7MaterialLinkErrorText } from "@/lib/q7-material-links";
import { missionErrorMessage, type CompleteMissionResult, type Mission } from "@/lib/missions";
import { Defs } from "./Toon";
import { GoodsIcon } from "./GoodsArt";
import { ReceiptNotes } from "./ReceiptNotes";
import { C } from "./theme";
import { fmtQty, newRequestId } from "./meta";
import { askGame } from "./ConfirmDialog";

export const QUEST_LABEL: Record<MaterialLinkLocation, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };
const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const errorText = (error: unknown) => q7MaterialLinkErrorText(q7MaterialLinkErrorCode(error));
const parsePositive = (text: string) => { const v = Number(text.replace(/\s/g, "").replace(",", ".")); return Number.isFinite(v) && v > 0 ? v : null; };

/** "Để sau" is only a shuffle: the card comes back at the end of the deck, per warehouse, per tab. */
const deferKey = (location: MaterialLinkLocation) => `bmq-link-quest-defer-${location}`;
const loadDeferred = (location: MaterialLinkLocation): string[] => { try { return JSON.parse(sessionStorage.getItem(deferKey(location)) ?? "[]") as string[]; } catch { return []; } };

/** Recent delivery notes of the item, shown under the unit question (owner 15/10: always with the invoice). */
function ItemPhotos({ itemId, title }: { itemId: string; title: string }) {
  const lines = useItemReceiptLines(itemId, true);
  return <ReceiptNotes title={title} lines={lines.data} loading={lines.isLoading} error={lines.error} />;
}

function Candidate({ item, candidate, picked, onPick, disabled }: { item: MaterialLinkReviewItem; candidate: MaterialLinkCandidate; picked: boolean; onPick: () => void; disabled: boolean }) {
  const exact = candidate.score >= 0.999;
  return (
    <button type="button" role="radio" aria-checked={picked} className={`lq-cand${picked ? " is-on" : ""}`} disabled={disabled} onClick={onPick} data-bmq-lq-cand={candidate.canonical_name}>
      <b>{candidate.canonical_name}</b>
      <span className={`lq-tag${exact ? " is-exact" : ""}`}>{exact ? "trùng tên" : candidate.unit_status === "same" ? "cùng đơn vị kho" : `giống ${Math.round(candidate.score * 100)}%`}</span>
      <small>{candidate.material_code} · đơn vị {candidate.default_unit}{candidate.unit_status === "same" ? " · cùng đơn vị" : candidate.unit_status === "auto" ? ` · máy tự đổi ${item.unit} → ${candidate.default_unit}` : " · cần số quy đổi"}</small>
      {candidate.skus.length ? (
        <span className="lq-skus"><em>nuôi</em>{candidate.skus.slice(0, 2).map((sku) => <span key={sku}>{sku}</span>)}{candidate.skus.length > 2 ? <em>+{candidate.skus.length - 2} SKU</em> : null}</span>
      ) : null}
    </button>
  );
}

const MEASURE = new Set(["g", "gr", "gram", "kg", "ml", "l", "lit", "lít"]);
const isMeasure = (unit: string) => MEASURE.has(unit.trim().toLowerCase());

/**
 * Owner 15/10 ("1 g = ? bình" makes no sense): ask the question so the answer is a natural number.
 * Counted in a container (bình, bao, quả…) vs a weight/volume → "1 container = ? g".
 * Server stores material units per 1 warehouse unit, so `toStored` converts the typed answer.
 */
export function unitQuestion(itemName: string, itemUnit: string, materialName: string, materialUnit: string) {
  if (isMeasure(itemUnit) && !isMeasure(materialUnit)) {
    // kho g, mã quả: "1 quả = ? g" (typed x = g per quả → stored 1/x quả per g)
    return { from: materialUnit, to: itemUnit, prefill: factorPrefill(itemName, itemUnit, materialUnit), toStored: (x: number) => 1 / x, fromStored: (f: number) => 1 / f };
  }
  return { from: itemUnit, to: materialUnit, prefill: itemFactorPrefill(itemName, itemUnit, materialName, materialUnit), toStored: (x: number) => x, fromStored: (f: number) => f };
}
const tidy = (value: number) => Number(value.toPrecision(10));

const money = (value: number | null) => (value === null ? null : `${Math.round(value).toLocaleString("vi-VN")}đ`);

/** The last PO / receipt line of the item: evidence for the unit question when there is no photo. */
function PurchaseLine({ line }: { line: MaterialLinkPurchaseLine | null }) {
  if (!line) return <p className="lq-evidence is-none">Chưa thấy dòng mua nào của món này.</p>;
  return (
    <p className="lq-evidence" data-bmq-lq-evidence>
      <b>{line.doc_kind === "po" ? "PO" : "Phiếu nhập"} {line.doc_number}</b> · {dmy(line.date)}{line.supplier_name ? ` · ${line.supplier_name}` : ""}
      <span>“{line.raw_name}”: {line.quantity != null ? fmtQty(line.quantity) : "?"} {line.unit ?? ""}{line.unit_price != null ? ` × ${money(line.unit_price)}` : ""}</span>
    </p>
  );
}

/** "Chờ quy đổi": linked items without a factor yet; set it whenever the paper is at hand. */
function PendingFactors({ location, onToast }: { location: MaterialLinkLocation; onToast: (text: string) => void }) {
  const pending = useMaterialLinkPendingFactors(location, true);
  const rows = pending.data ?? [];
  if (!rows.length) return null;
  return (
    <section className="lq-pending" data-bmq-lq-pending>
      <h3>⏳ Chờ quy đổi · {rows.length}</h3>
      <p className="note">Đã gắn mã, chưa có số quy đổi. Nhập kho và kiểm kê vẫn chạy; số này chỉ dùng để tính giá vốn.</p>
      <ul>{rows.map((row) => <PendingRow key={row.item_id} row={row} onToast={onToast} />)}</ul>
    </section>
  );
}

function PendingRow({ row, onToast }: { row: MaterialLinkPendingFactor; onToast: (text: string) => void }) {
  const set = useSetItemMaterialFactor();
  const q = unitQuestion(row.name, row.unit, row.canonical_name, row.material_unit);
  const [text, setText] = useState(q.prefill ? String(q.prefill) : "");
  const typed = parsePositive(text);
  const value = typed !== null ? q.toStored(typed) : null;
  return (
    <li data-bmq-lq-pending-row={row.name}>
      <span className="lq-pending-name"><b>{row.name}</b><small>→ {row.canonical_name} ({row.material_unit})</small></span>
      <PurchaseLine line={row.last_purchase_line} />
      <span className="lq-conv">
        1 {q.from} =
        <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label={`1 ${q.from} bằng bao nhiêu ${q.to}`} />
        {q.to}
        <button type="button" className="btn" disabled={value === null || set.isPending} onClick={() => set.mutate({ itemId: row.item_id, factor: value }, { onSuccess: () => onToast(`✓ ${row.name}: 1 ${q.from} = ${fmtQty(typed!)} ${q.to}`), onError: (error) => onToast(errorText(error)) })}>Lưu</button>
      </span>
    </li>
  );
}

/** Item sheet box (owner 15/10: "quy định lại thủ công"): see and set / clear the factor of a linked item. */
export function ItemFactorBox({ itemId, onToast }: { itemId: string; onToast: (text: string) => void }) {
  const info = useQuery({
    queryKey: ["item-material-factor", itemId],
    queryFn: async () => {
      const db = supabase as any;
      const { data: item, error } = await db.from("kitchen_inventory_items").select("unit, canonical_material_id").eq("id", itemId).maybeSingle();
      if (error) throw error;
      if (!item?.canonical_material_id) return null;
      const { data: mat } = await db.from("sku_cogs_materials").select("id, material_code, canonical_name, default_unit").eq("id", item.canonical_material_id).maybeSingle();
      if (!mat) return null;
      const { data: convs } = await db.from("material_unit_conversions").select("from_unit, to_unit, factor, active").eq("material_id", mat.id).eq("active", true);
      const key = (u: string | null) => (u ?? "").trim().toLowerCase();
      const conv = (convs ?? []).find((c: { from_unit: string; to_unit: string }) => key(c.from_unit) === key(item.unit) && key(c.to_unit) === key(mat.default_unit));
      return { unit: item.unit as string, material: mat as { material_code: string; canonical_name: string; default_unit: string }, factor: conv ? Number(conv.factor) : null };
    },
  });
  const set = useSetItemMaterialFactor();
  const [text, setText] = useState<string | null>(null);
  if (!info.data) return null;
  const { unit, material, factor } = info.data;
  const sameUnit = unit.trim().toLowerCase() === material.default_unit.trim().toLowerCase();
  const q = unitQuestion("", unit, "", material.default_unit);
  const shown = text ?? (factor !== null ? String(tidy(q.fromStored(factor))) : "");
  const typed = parsePositive(shown);
  const value = typed !== null ? q.toStored(typed) : null;
  const save = (next: number | null) => set.mutate({ itemId, factor: next }, {
    onSuccess: () => { setText(null); void info.refetch(); onToast(next === null ? "Đã xoá số quy đổi · món về Chờ quy đổi" : `✓ 1 ${q.from} = ${fmtQty(typed!)} ${q.to}`); },
    onError: (error) => onToast(errorText(error)),
  });
  return (
    <div className="lq-factor-box" data-bmq-item-factor>
      <small>Mã hàng · quy đổi</small>
      <b>{material.canonical_name} <em>({material.material_code} · {material.default_unit})</em></b>
      {sameUnit ? <span className="lq-auto">✓ Cùng đơn vị, không cần quy đổi</span> : (
        <span className="lq-conv">
          1 {q.from} =
          <input inputMode="decimal" value={shown} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label={`1 ${q.from} bằng bao nhiêu ${q.to}`} />
          {q.to}
          <button type="button" className="btn" disabled={value === null || text === null || set.isPending} onClick={() => save(value)}>Lưu</button>
          {factor !== null ? <button type="button" className="btn ghost" disabled={set.isPending} onClick={() => save(null)}>Xoá</button> : null}
        </span>
      )}
      {!sameUnit && factor === null ? <small className="lq-hint">Chưa có số quy đổi · nhập kho vẫn chạy bình thường.</small> : null}
    </div>
  );
}

/** "Đã ngưng dùng" (owner 15/10): items taken off shelves, counts and decks; bring one back with "Dùng lại". */
export function DiscontinuedList({ onToast }: { onToast: (text: string) => void }) {
  const list = useDiscontinuedStockItems(true);
  const reactivate = useReactivateStockItem();
  const rows = list.data ?? [];
  if (!rows.length) return null;
  return (
    <section className="lq-pending lq-stopped" data-bmq-discontinued>
      <h3>⏸ Đã ngưng dùng · {rows.length}</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.item_id} data-bmq-discontinued-row={row.name}>
            <span className="lq-pending-name"><b>{row.name}</b><small>{row.unit}{row.item_code ? ` · ${row.item_code}` : ""} · ngưng {dmy(row.discontinued_at)}{row.discontinued_by_name ? ` · ${row.discontinued_by_name}` : ""}</small></span>
            <button type="button" className="btn ghost" disabled={reactivate.isPending} onClick={() => reactivate.mutate({ itemId: row.item_id }, { onSuccess: () => onToast(`▶ ${row.name}: dùng lại`), onError: (error) => onToast(discontinueErrorText(discontinueErrorCode(error))) })}>▶ Dùng lại</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Item sheet button: discontinue from the shelf. */
export function DiscontinueButton({ itemId, name, onDone, onToast }: { itemId: string; name: string; onDone: () => void; onToast: (text: string) => void }) {
  const discontinue = useDiscontinueStockItem();
  return (
    <button
      type="button"
      className="btn ghost slip-new"
      disabled={discontinue.isPending}
      onClick={async () => {
        if (!(await askGame({ title: `Ngưng dùng “${name}”?`, message: "Món sẽ rời khỏi kệ, phiếu kiểm kê, đặt hàng tự động và bộ bài gắn mã. Bật lại được ở mục Đã ngưng dùng.", ok: "Ngưng dùng", cancel: "Giữ lại", tone: "danger" }))) return;
        discontinue.mutate({ itemId, reason: "Ngưng dùng từ kệ" }, { onSuccess: () => { onToast(`⏸ ${name}: đã ngưng dùng`); onDone(); }, onError: (error) => onToast(discontinueErrorText(discontinueErrorCode(error))) });
      }}
      data-bmq-item-stop
    >
      {discontinue.isPending ? "Đang ngưng…" : "⏸ Ngưng dùng món này"}
    </button>
  );
}

/** One card of the deck: the item, its suggested candidates, the unit question (with the delivery notes), four decisions. */
function ItemCard({ item, canEdit, onLinked, onSkipped, onDefer }: {
  item: MaterialLinkReviewItem; canEdit: boolean;
  onLinked: (text: string) => void; onSkipped: (text: string) => void; onDefer: () => void;
}) {
  const link = useLinkItemMaterial();
  const skip = useSkipItemLink();
  const exactAsCandidate: MaterialLinkCandidate | null = item.exact_material && item.unit_status
    ? { ...item.exact_material, score: 1, unit_status: item.unit_status }
    : null;
  // Server order = same unit first, then auto, then needs a factor (owner 15/10: the warehouse unit wins).
  const candidates = useMemo(() => {
    const list = item.candidates.filter((c) => c.score > 0 || c.unit_status === "same").slice(0, 3);
    if (exactAsCandidate && !list.some((c) => c.id === exactAsCandidate.id)) {
      return exactAsCandidate.unit_status === "needs_factor" ? [...list.slice(0, 2), exactAsCandidate] : [exactAsCandidate, ...list.slice(0, 2)];
    }
    return list;
  }, [item, exactAsCandidate]);
  const firstPick = candidates.find((c) => c.unit_status === "same") ?? exactAsCandidate ?? (candidates[0]?.score >= 0.999 ? candidates[0] : null);
  const questionFor = (c: MaterialLinkCandidate) => unitQuestion(item.name, item.unit, c.canonical_name, c.default_unit);
  const prefillFor = (c: MaterialLinkCandidate | null) => (c && c.unit_status === "needs_factor" ? questionFor(c).prefill : null);
  const [picked, setPicked] = useState<MaterialLinkCandidate | null>(firstPick);
  const [factorText, setFactorText] = useState(() => { const p = prefillFor(firstPick); return p ? String(p) : ""; });
  const [requestId, setRequestId] = useState(newRequestId);
  const [leaving, setLeaving] = useState(false);
  const status = picked?.unit_status ?? null;
  const typed = parsePositive(factorText);
  const question = picked ? questionFor(picked) : null;
  /** Material units per 1 warehouse unit — what the server stores ("1 bình = 20000 g" → 20000). */
  const perItem = typed !== null && question ? question.toStored(typed) : null;
  const needsFactor = status === "needs_factor";
  const busy = link.isPending || skip.isPending || leaving;
  const ready = canEdit && !busy && Boolean(picked) && (!needsFactor || perItem !== null);

  const pick = (candidate: MaterialLinkCandidate) => {
    link.reset(); setPicked(candidate);
    const p = prefillFor(candidate); setFactorText(p ? String(p) : "");
  };
  const fly = (after: () => void) => { setLeaving(true); window.setTimeout(after, 380); };
  const save = (defer = false) => {
    if (!picked || !canEdit || busy) return;
    if (!defer && !ready) return;
    link.mutate(
      { itemId: item.item_id, materialId: picked.id, createNew: false, requestId, unitFactor: needsFactor && !defer && perItem ? perItem : null, deferFactor: defer },
      { onSuccess: (result) => fly(() => onLinked(`🧩 ${item.name} → ${result.canonical_name}${defer ? " · quy đổi sau" : ""}`)), onError: () => setRequestId(newRequestId()) },
    );
  };
  const create = () => {
    link.reset();
    link.mutate(
      { itemId: item.item_id, materialId: null, createNew: true, requestId, unitFactor: null },
      { onSuccess: (result) => fly(() => onLinked(`✨ Tạo mã ${result.material_code} cho ${item.name}`)), onError: () => setRequestId(newRequestId()) },
    );
  };
  const discontinue = useDiscontinueStockItem();
  const stopUsing = async () => {
    if (!(await askGame({ title: `Ngưng dùng “${item.name}”?`, message: "Món sẽ rời khỏi kệ, phiếu kiểm kê, đặt hàng tự động và bộ bài gắn mã. Bật lại được ở mục Đã ngưng dùng.", ok: "Ngưng dùng", cancel: "Giữ lại", tone: "danger" }))) return;
    discontinue.mutate({ itemId: item.item_id, reason: "Ngưng dùng từ bộ bài gắn mã" }, { onSuccess: () => fly(() => onSkipped(`⏸ ${item.name}: đã ngưng dùng`)) });
  };
  const notMaterial = () => {
    skip.mutate({ itemId: item.item_id, note: null }, { onSuccess: () => fly(() => onSkipped(`🚫 ${item.name}: không phải NVL`)) });
  };

  return (
    <article className={`lq-card${leaving ? " is-leaving" : ""}`} data-bmq-lq-card={item.name}>
      <span className="lq-tape" aria-hidden="true" />
      <div className="lq-head">
        <div className="lq-art"><svg viewBox="-30 -30 60 56"><Defs /><GoodsIcon name={item.name} unit={item.unit} color={C.kraft} size={1.15} /></svg></div>
        <div>
          <h3 className="lq-name">{item.name}</h3>
          <div className="lq-chips">
            <span className="chip is-unit">Kho tính: {item.unit}</span>
            {item.item_code ? <span className="chip">{item.item_code}</span> : null}
            {item.last_buy ? <span className="chip is-buy">Mua gần nhất: {item.last_buy.supplier_name ?? "—"} · {dmy(item.last_buy.date)}</span> : null}
            {item.receipt_photo_count ? <span className="chip">📷 {item.receipt_photo_count} phiếu có ảnh</span> : null}
          </div>
        </div>
      </div>

      <div className="lq-hint">{candidates.length ? "Gợi ý mã hàng" : "Không thấy mã nào giống"}</div>
      {candidates.length ? (
        <div className="lq-cands" role="radiogroup" aria-label={`Mã hàng cho ${item.name}`}>
          {candidates.map((candidate) => <Candidate key={candidate.id} item={item} candidate={candidate} picked={picked?.id === candidate.id} onPick={() => pick(candidate)} disabled={!canEdit || busy} />)}
        </div>
      ) : <p className="lq-none">Không có mã hàng nào giống tên. Tạo mã mới từ chính món này, hoặc đánh dấu không phải nguyên liệu (băng keo, bao tay…).</p>}

      {picked ? (
        <div className="lq-target" data-bmq-lq-target>
          <span>→ <b>{picked.canonical_name}</b> <small>({picked.material_code} · {picked.default_unit})</small></span>
          {status === "same" ? <small className="lq-auto">✓ Cùng đơn vị, gắn được ngay</small> : null}
          {status === "auto" ? <small className="lq-auto">✓ Máy tự đổi {item.unit} → {picked.default_unit}</small> : null}
          {needsFactor ? (
            <>
              <label className="lq-conv">
                1 {question!.from} =
                <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`1 ${question!.from} bằng bao nhiêu ${question!.to}`} data-bmq-lq-factor />
                {question!.to}
                {factorText && prefillFor(picked) === typed ? <span className="lq-pre">đọc từ tên</span> : null}
              </label>
              <small className="lq-hint">Không chắc? Bấm “Gắn, quy đổi sau” — món vẫn nhập kho, kiểm kê bình thường; số quy đổi điền sau ở mục Chờ quy đổi.</small>
              <PurchaseLine line={item.last_purchase_line} />
              {/* Owner 15/10: the unit question always comes with the delivery note, so the pack size can be read off the paper. */}
              <ItemPhotos itemId={item.item_id} title="Phiếu giao hàng gần nhất · xem quy cách" />
            </>
          ) : null}
        </div>
      ) : null}

      {link.error ? <div className="err">{errorText(link.error)}</div> : null}
      {skip.error ? <div className="err">{errorText(skip.error)}</div> : null}
      {discontinue.error ? <div className="err">{discontinueErrorText(discontinueErrorCode(discontinue.error))}</div> : null}
      {canEdit ? (
        <div className="lq-actions">
          <button type="button" className="btn main" disabled={!ready} onClick={() => save(false)} data-bmq-lq-link>{link.isPending ? "Đang gắn…" : "🧩 Gắn mã"}</button>
          {needsFactor && picked ? <button type="button" className="btn ghost wide" disabled={busy || !canEdit} onClick={() => save(true)} data-bmq-lq-defer-factor>🧩 Gắn, quy đổi sau</button> : null}
          <button type="button" className="btn ghost" disabled={busy} onClick={create} data-bmq-lq-new>＋ Tạo mã mới</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={notMaterial} data-bmq-lq-not>Không phải NVL</button>
          <button type="button" className="btn ghost" disabled={busy || discontinue.isPending} onClick={stopUsing} data-bmq-lq-stop>⏸ Ngưng dùng</button>
          <button type="button" className="btn ghost soft" disabled={busy} onClick={() => fly(onDefer)} data-bmq-lq-defer>Để sau ↓</button>
        </div>
      ) : <p className="note">Chỉ chủ hoặc người được quyền sửa mã hàng được gắn mã hàng.</p>}
    </article>
  );
}

/**
 * "Gắn mã hàng" as a card deck (owner approved the demo 15/10): one item per card, suggested candidates
 * with the SKUs they feed, the unit question with the delivery notes, a combo for exact matches,
 * a streak, and the warehouse mission submitted when the deck is empty.
 */
export function LinkQuest({ location, canEdit, mission, onToast, onCompleted }: {
  location: MaterialLinkLocation; canEdit: boolean; mission: Mission | undefined;
  onToast: (text: string) => void; onCompleted: (result: CompleteMissionResult, mission: Mission) => void;
}) {
  const review = useMaterialLinkReview(location, canEdit);
  const bulk = useLinkExactMaterials();
  const complete = useCompleteMission();
  const [deferred, setDeferred] = useState<string[]>(() => loadDeferred(location));
  const [streak, setStreak] = useState(0);
  const [pop, setPop] = useState<string | null>(null);
  const [comboHidden, setComboHidden] = useState(false);
  const [bulkRequestId, setBulkRequestId] = useState(newRequestId);
  const [completeRequestId] = useState(newRequestId);
  useEffect(() => { setDeferred(loadDeferred(location)); setStreak(0); setComboHidden(false); }, [location]);
  useEffect(() => { try { sessionStorage.setItem(deferKey(location), JSON.stringify(deferred)); } catch { /* private mode */ } }, [deferred, location]);

  // Owner 15/10 ("gắn xong màn hình trắng trơn"): the review takes seconds to reload, so decided cards
  // leave the deck right away and the refetch catches up in the background.
  const [decidedIds, setDecidedIds] = useState<Set<string>>(() => new Set());
  const allItems = review.data?.items ?? [];
  const items = useMemo(() => allItems.filter((item) => !decidedIds.has(item.item_id)), [allItems, decidedIds]);
  const localDone = allItems.length - items.length;
  const decide = (ids: string[]) => setDecidedIds((prev) => { const next = new Set(prev); ids.forEach((id) => next.add(id)); return next; });
  const counts = review.data?.counts;
  const deck = useMemo(() => deckOrder(items, deferred), [items, deferred]);
  const combo = useMemo(() => bulkableRows(items), [items]);
  const current = deck[0] ?? null;
  const total = (counts?.linked_total ?? 0) + (counts?.total ?? 0);
  const done = (counts?.linked_total ?? 0) + localDone;
  const showPop = (text: string) => { setPop(text); window.setTimeout(() => setPop(null), 1700); };
  const advance = (text: string) => {
    const next = streak + 1;
    setStreak(next);
    if (next % 10 === 0) showPop(`Combo ${next}! 🔥`); else onToast(text);
  };
  const defer = (item: MaterialLinkReviewItem) => { setStreak(0); setDeferred((list) => [...list.filter((id) => id !== item.item_id), item.item_id]); onToast(`↓ Để sau: ${item.name}`); };
  const runCombo = () => bulk.mutate({ location, requestId: bulkRequestId }, {
    onSuccess: (result) => {
      setBulkRequestId(newRequestId()); setComboHidden(true); setStreak((s) => s + result.linked);
      const notLinked = new Set([...result.needs_factor, ...result.failed].map((row: { item_id?: string }) => row.item_id).filter(Boolean) as string[]);
      decide(combo.map((row) => row.item_id).filter((id) => !notLinked.has(id)));
      showPop(`⚡ ${result.linked} món!`);
      if (result.needs_factor.length || result.failed.length) onToast([result.needs_factor.length ? `${result.needs_factor.length} món cần số quy đổi` : null, result.failed.length ? `${result.failed.length} món lỗi` : null].filter(Boolean).join(" · "));
    },
    onError: (error) => { setBulkRequestId(newRequestId()); onToast(errorText(error)); },
  });
  const missionOpen = mission && mission.status === "open";
  const missionDone = mission && mission.status === "completed";

  if (!canEdit) return <div className="lq"><p className="note">Chỉ chủ hoặc người được quyền sửa mã hàng được gắn mã hàng.</p></div>;
  if (review.isLoading && !review.data) return <div className="lq"><div className="d3-wh-empty">Đang xếp bài…</div></div>;
  if (review.error || !review.data) return <div className="lq"><div className="err">{errorText(review.error)}</div></div>;

  return (
    <div className="lq" data-bmq-link-quest={location}>
      <div className="lq-top">
        <div className="lq-bar">
          <small>{QUEST_LABEL[location]} · {done}/{total} món có mã{deferred.length ? ` · để sau ${deck.filter((item) => deferred.includes(item.item_id)).length}` : ""}</small>
          <div className="bar"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        </div>
        <div className={`lq-streak${streak >= 5 ? " is-hot" : ""}`} aria-label={`Chuỗi ${streak}`}><b>{streak >= 5 ? "🔥" : ""}{streak}</b><small>liên tiếp</small></div>
      </div>
      {pop ? <div className="lq-pop" aria-live="polite">{pop}</div> : null}

      {!comboHidden && combo.length >= 2 ? (
        <section className="lq-combo" data-bmq-lq-combo>
          <div><h3>Có {combo.length} món trùng tên mã hàng</h3><p>Cùng đơn vị hoặc máy tự đổi được. Gắn một lần, khỏi lật từng thẻ.</p></div>
          <div className="lq-combo-list">{combo.slice(0, 8).map((row) => <span key={row.item_id}>{row.name}</span>)}{combo.length > 8 ? <span>+{combo.length - 8} món</span> : null}</div>
          <div className="row">
            <button type="button" className="btn" disabled={bulk.isPending} onClick={runCombo} data-bmq-lq-combo-all>{bulk.isPending ? "Đang gắn…" : `⚡ Gắn ${combo.length} món`}</button>
            <button type="button" className="btn ghost" onClick={() => setComboHidden(true)}>Để tôi xem từng món</button>
          </div>
        </section>
      ) : null}

      <div className="lq-deck">
        {current ? (
          <ItemCard key={current.item_id} item={current} canEdit={canEdit} onLinked={(text) => { decide([current.item_id]); advance(text); }} onSkipped={(text) => { decide([current.item_id]); advance(text); }} onDefer={() => defer(current)} />
        ) : (
          <section className="lq-done" data-bmq-lq-done>
            <h3>{QUEST_LABEL[location]} đã có mã đủ!</h3>
            <p>{done} món có mã{counts?.skipped ? ` · ${counts.skipped} món không phải NVL` : ""}. {location === "q7" ? "Kiểm kê Q7 giờ chốt được rồi." : "Giá vốn các SKU nối thẳng vào kho."}</p>
            {missionOpen ? (
              <>
                {complete.error ? <div className="err">{missionErrorMessage(complete.error)}</div> : null}
                <button type="button" className="btn submit is-ready" disabled={complete.isPending} onClick={() => complete.mutate({ missionId: mission.id, requestId: completeRequestId }, { onSuccess: (result) => onCompleted(result, mission) })} data-bmq-lq-submit>
                  {complete.isPending ? "Đang chấm…" : "Nộp nhiệm vụ · nhận 🐝"}
                </button>
              </>
            ) : missionDone ? <p className="lq-stamped">🏅 Nhiệm vụ đã nộp</p> : null}
          </section>
        )}
      </div>
      <PendingFactors location={location} onToast={onToast} />
      <DiscontinuedList onToast={onToast} />
    </div>
  );
}
