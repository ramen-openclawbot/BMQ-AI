import { useEffect, useMemo, useState } from "react";
import { useCompleteMission } from "@/hooks/useMissions";
import { useLinkExactMaterials, useLinkItemMaterial, useMaterialLinkReview, useSkipItemLink } from "@/hooks/useMaterialLinkQuest";
import { useItemReceiptLines } from "@/hooks/useWarehouseGame";
import { bulkableRows, deckOrder, factorPrefill, type MaterialLinkCandidate, type MaterialLinkLocation, type MaterialLinkReviewItem } from "@/lib/material-link-quest";
import { q7MaterialLinkErrorCode, q7MaterialLinkErrorText } from "@/lib/q7-material-links";
import { missionErrorMessage, type CompleteMissionResult, type Mission } from "@/lib/missions";
import { JevBot } from "./CrateYard";
import { Defs } from "./Toon";
import { GoodsIcon } from "./GoodsArt";
import { ReceiptNotes } from "./ReceiptNotes";
import { C } from "./theme";
import { fmtQty, newRequestId } from "./meta";

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
      <span className={`lq-tag${exact ? " is-exact" : ""}`}>{exact ? "trùng tên" : `giống ${Math.round(candidate.score * 100)}%`}</span>
      <small>{candidate.material_code} · đơn vị {candidate.default_unit}{candidate.unit_status === "same" ? " · cùng đơn vị" : candidate.unit_status === "auto" ? ` · máy tự đổi ${item.unit} → ${candidate.default_unit}` : " · cần số quy đổi"}</small>
      {candidate.skus.length ? (
        <span className="lq-skus"><em>nuôi</em>{candidate.skus.slice(0, 2).map((sku) => <span key={sku}>{sku}</span>)}{candidate.skus.length > 2 ? <em>+{candidate.skus.length - 2} SKU</em> : null}</span>
      ) : null}
    </button>
  );
}

/** One card of the deck: the item, Jev's candidates, the unit question (with the delivery notes), four decisions. */
function ItemCard({ item, canEdit, onLinked, onSkipped, onDefer }: {
  item: MaterialLinkReviewItem; canEdit: boolean;
  onLinked: (text: string) => void; onSkipped: (text: string) => void; onDefer: () => void;
}) {
  const link = useLinkItemMaterial();
  const skip = useSkipItemLink();
  const exactAsCandidate: MaterialLinkCandidate | null = item.exact_material && item.unit_status
    ? { ...item.exact_material, score: 1, unit_status: item.unit_status }
    : null;
  const candidates = useMemo(() => {
    const rest = item.candidates.filter((c) => c.score > 0 && c.id !== exactAsCandidate?.id).slice(0, exactAsCandidate ? 2 : 3);
    return exactAsCandidate ? [exactAsCandidate, ...rest] : rest;
  }, [item, exactAsCandidate]);
  const [picked, setPicked] = useState<MaterialLinkCandidate | null>(exactAsCandidate ?? (candidates[0]?.score >= 0.999 ? candidates[0] : null));
  const [factorText, setFactorText] = useState(() => { const target = exactAsCandidate ?? candidates[0]; const p = target ? factorPrefill(item.name, item.unit, target.default_unit) : null; return p ? String(p) : ""; });
  const [requestId, setRequestId] = useState(newRequestId);
  const [leaving, setLeaving] = useState(false);
  const status = picked?.unit_status ?? null;
  const perUnit = parsePositive(factorText);
  const needsFactor = status === "needs_factor";
  const busy = link.isPending || skip.isPending || leaving;
  const ready = canEdit && !busy && Boolean(picked) && (!needsFactor || perUnit !== null);

  const pick = (candidate: MaterialLinkCandidate) => {
    link.reset(); setPicked(candidate);
    if (candidate.unit_status === "needs_factor") { const p = factorPrefill(item.name, item.unit, candidate.default_unit); setFactorText(p ? String(p) : ""); }
  };
  const fly = (after: () => void) => { setLeaving(true); window.setTimeout(after, 380); };
  const save = () => {
    if (!picked || !ready) return;
    link.mutate(
      { itemId: item.item_id, materialId: picked.id, createNew: false, requestId, unitFactor: needsFactor && perUnit ? 1 / perUnit : null },
      { onSuccess: (result) => fly(() => onLinked(`🧩 ${item.name} → ${result.canonical_name}`)), onError: () => setRequestId(newRequestId()) },
    );
  };
  const create = () => {
    link.reset();
    link.mutate(
      { itemId: item.item_id, materialId: null, createNew: true, requestId, unitFactor: null },
      { onSuccess: (result) => fly(() => onLinked(`✨ Tạo mã ${result.material_code} cho ${item.name}`)), onError: () => setRequestId(newRequestId()) },
    );
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

      <div className="lq-jev"><span className="lq-jev-bot"><JevBot state={candidates.length ? "done" : "error"} size={30} /></span>{candidates.length ? "Jev gợi ý mã chuẩn" : "Jev không thấy mã nào giống"}</div>
      {candidates.length ? (
        <div className="lq-cands" role="radiogroup" aria-label={`Mã chuẩn cho ${item.name}`}>
          {candidates.map((candidate) => <Candidate key={candidate.id} item={item} candidate={candidate} picked={picked?.id === candidate.id} onPick={() => pick(candidate)} disabled={!canEdit || busy} />)}
        </div>
      ) : <p className="lq-none">Không có mã chuẩn nào giống tên. Tạo mã mới từ chính món này, hoặc đánh dấu không phải nguyên liệu (băng keo, bao tay…).</p>}

      {picked ? (
        <div className="lq-target" data-bmq-lq-target>
          <span>→ <b>{picked.canonical_name}</b> <small>({picked.material_code} · {picked.default_unit})</small></span>
          {status === "same" ? <small className="lq-auto">✓ Cùng đơn vị, gắn được ngay</small> : null}
          {status === "auto" ? <small className="lq-auto">✓ Máy tự đổi {item.unit} → {picked.default_unit}</small> : null}
          {needsFactor ? (
            <>
              <label className="lq-conv">
                1 {picked.default_unit} =
                <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`1 ${picked.default_unit} bằng bao nhiêu ${item.unit}`} data-bmq-lq-factor />
                {item.unit}
                {factorText && factorPrefill(item.name, item.unit, picked.default_unit) === perUnit ? <span className="lq-pre">đọc từ tên món</span> : null}
              </label>
              {/* Owner 15/10: the unit question always comes with the delivery note, so the pack size can be read off the paper. */}
              <ItemPhotos itemId={item.item_id} title="Phiếu giao hàng gần nhất · xem quy cách" />
            </>
          ) : null}
        </div>
      ) : null}

      {link.error ? <div className="err">{errorText(link.error)}</div> : null}
      {skip.error ? <div className="err">{errorText(skip.error)}</div> : null}
      {canEdit ? (
        <div className="lq-actions">
          <button type="button" className="btn main" disabled={!ready} onClick={save} data-bmq-lq-link>{link.isPending ? "Đang gắn…" : "🧩 Gắn mã"}</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={create} data-bmq-lq-new>＋ Tạo mã mới</button>
          <button type="button" className="btn ghost" disabled={busy} onClick={notMaterial} data-bmq-lq-not>Không phải NVL</button>
          <button type="button" className="btn ghost soft" disabled={busy} onClick={() => fly(onDefer)} data-bmq-lq-defer>Để sau ↓</button>
        </div>
      ) : <p className="note">Chỉ chủ hoặc người sửa Material Master được gắn mã chuẩn.</p>}
    </article>
  );
}

/**
 * "Gắn mã chuẩn" as a card deck (owner approved the demo 15/10): one item per card, Jev's candidates
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

  const items = review.data?.items ?? [];
  const counts = review.data?.counts;
  const deck = useMemo(() => deckOrder(items, deferred), [items, deferred]);
  const combo = useMemo(() => bulkableRows(items), [items]);
  const current = deck[0] ?? null;
  const total = (counts?.linked_total ?? 0) + (counts?.total ?? 0);
  const done = counts?.linked_total ?? 0;
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
      showPop(`⚡ ${result.linked} món!`);
      if (result.needs_factor.length || result.failed.length) onToast([result.needs_factor.length ? `${result.needs_factor.length} món cần số quy đổi` : null, result.failed.length ? `${result.failed.length} món lỗi` : null].filter(Boolean).join(" · "));
    },
    onError: (error) => { setBulkRequestId(newRequestId()); onToast(errorText(error)); },
  });
  const missionOpen = mission && mission.status === "open";
  const missionDone = mission && mission.status === "completed";

  if (!canEdit) return <div className="lq"><p className="note">Chỉ chủ hoặc người sửa Material Master được gắn mã chuẩn.</p></div>;
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
          <div className="row" style={{ alignItems: "center", flexWrap: "nowrap" }}>
            <JevBot state="done" size={56} />
            <div><h3>Jev thấy {combo.length} món trùng tên mã chuẩn</h3><p>Cùng đơn vị hoặc máy tự đổi được. Gắn một lần, khỏi lật từng thẻ.</p></div>
          </div>
          <div className="lq-combo-list">{combo.slice(0, 8).map((row) => <span key={row.item_id}>{row.name}</span>)}{combo.length > 8 ? <span>+{combo.length - 8} món</span> : null}</div>
          <div className="row">
            <button type="button" className="btn" disabled={bulk.isPending} onClick={runCombo} data-bmq-lq-combo-all>{bulk.isPending ? "Đang gắn…" : `⚡ Gắn ${combo.length} món`}</button>
            <button type="button" className="btn ghost" onClick={() => setComboHidden(true)}>Để tôi xem từng món</button>
          </div>
        </section>
      ) : null}

      <div className="lq-deck">
        {current ? (
          <ItemCard key={current.item_id} item={current} canEdit={canEdit} onLinked={advance} onSkipped={advance} onDefer={() => defer(current)} />
        ) : (
          <section className="lq-done" data-bmq-lq-done>
            <JevBot state="done" size={80} />
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
    </div>
  );
}
