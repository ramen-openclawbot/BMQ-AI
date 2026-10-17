import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useLinkQ7ExactMaterials, useLinkQ7ItemMaterial, useQ7MaterialLinkReview } from "@/hooks/useQ7MaterialLinks";
import { q7MaterialLinkErrorCode, q7MaterialLinkErrorText, type Q7MaterialLinkCandidate, type Q7MaterialLinkReviewItem, type Q7UnitStatus } from "@/lib/q7-material-links";
import { factorPrefill } from "@/lib/material-link-quest";
import { useItemReceiptLines } from "@/hooks/useWarehouseGame";
import { ReceiptNotes } from "./ReceiptNotes";

export { factorPrefill } from "@/lib/material-link-quest";

const parsePositive = (text: string) => {
  const value = Number(text.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
};

function errorText(error: unknown) {
  return q7MaterialLinkErrorText(q7MaterialLinkErrorCode(error));
}

/** One unlinked Q7 item: exact match (with an optional unit factor), a chosen candidate, or a new code. */
function LinkRow({ item, canEdit, onDone }: { item: Q7MaterialLinkReviewItem; canEdit: boolean; onDone: (message: string) => void }) {
  const link = useLinkQ7ItemMaterial();
  const exactAsCandidate: Q7MaterialLinkCandidate | null = item.exact_material && item.unit_status
    ? { ...item.exact_material, score: 1, unit_status: item.unit_status }
    : null;
  const candidates = item.candidates.filter((c) => c.score > 0).slice(0, 3);
  const [picked, setPicked] = useState<Q7MaterialLinkCandidate | null>(exactAsCandidate ?? (candidates[0]?.score >= 0.999 ? candidates[0] : null));
  const status: Q7UnitStatus | null = picked?.unit_status ?? null;
  const [factorText, setFactorText] = useState(() => {
    const target = exactAsCandidate ?? candidates[0];
    const prefill = target ? factorPrefill(item.name, item.unit, target.default_unit) : null;
    return prefill ? String(prefill) : "";
  });
  const perUnit = parsePositive(factorText);
  const needsFactor = status === "needs_factor";
  const ready = canEdit && !link.isPending && picked && (!needsFactor || perUnit !== null);

  const pick = (candidate: Q7MaterialLinkCandidate) => {
    link.reset();
    setPicked(candidate);
    if (candidate.unit_status === "needs_factor") {
      const prefill = factorPrefill(item.name, item.unit, candidate.default_unit);
      setFactorText(prefill ? String(prefill) : "");
    }
  };
  const save = () => {
    if (!picked) return;
    link.mutate(
      { itemId: item.item_id, materialId: picked.id, unitFactor: needsFactor && perUnit ? 1 / perUnit : null },
      { onSuccess: (result) => onDone(`🧩 ${item.name} → ${result.canonical_name}`) },
    );
  };
  const create = () => {
    link.reset();
    link.mutate({ itemId: item.item_id, createNew: true }, { onSuccess: (result) => onDone(`🧩 Tạo mã ${result.material_code} cho ${item.name}`) });
  };

  return (
    <li className={`link-row${picked ? " is-picked" : ""}`} data-bmq-link-row={item.name}>
      <div className="link-head">
        <span className="link-name"><b>{item.name}</b><small>Đơn vị kho: {item.unit}{item.item_code ? ` · ${item.item_code}` : ""}</small></span>
        {item.exact_material ? <em className="link-tag">Trùng tên</em> : null}
      </div>
      {exactAsCandidate ? null : candidates.length ? (
        <div className="link-picks" role="radiogroup" aria-label={`Mã hàng cho ${item.name}`}>
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={picked?.id === candidate.id}
              className={`link-pick${picked?.id === candidate.id ? " is-on" : ""}`}
              disabled={!canEdit}
              onClick={() => pick(candidate)}
              data-bmq-link-pick={candidate.canonical_name}
            >
              <b>{candidate.canonical_name}</b>
              <small>{candidate.default_unit} · {candidate.score >= 0.999 ? "trùng tên" : `giống ${Math.round(candidate.score * 100)}%`}</small>
            </button>
          ))}
        </div>
      ) : <p className="note">Không có mã hàng nào giống. Tạo mã mới từ chính món này.</p>}
      {picked ? (
        <div className="link-target">
          <span>→ <b>{picked.canonical_name}</b> <small>({picked.material_code} · {picked.default_unit})</small></span>
          {status === "auto" ? <small className="link-auto">Máy tự đổi {item.unit} → {picked.default_unit}</small> : null}
        </div>
      ) : null}
      {picked && needsFactor ? (
        <label className="link-factor" data-bmq-link-factor>
          1 {picked.default_unit} =
          <input inputMode="decimal" value={factorText} onChange={(event) => setFactorText(event.target.value)} placeholder="?" aria-label={`1 ${picked.default_unit} bằng bao nhiêu ${item.unit}`} />
          {item.unit}
        </label>
      ) : null}
      {picked && needsFactor ? <LinkFactorNotes itemId={item.item_id} /> : null}
      {link.error ? <div className="err">{errorText(link.error)}</div> : null}
      {canEdit ? (
        <div className="row link-actions">
          <button type="button" className="btn" disabled={!ready} onClick={save} data-bmq-link-save>{link.isPending ? "Đang gắn…" : "Gắn mã"}</button>
          <button type="button" className="btn ghost" disabled={link.isPending} onClick={create} data-bmq-link-create>＋ Tạo mã mới</button>
        </div>
      ) : null}
    </li>
  );
}

/** Owner 13/10: Q7 stock counts need every Q7 item linked to a Material Master code. */
export function LinkStation({ canEdit: canEditStock }: { canEdit: boolean }) {
  const { toast } = useToast();
  const { isOwner, canEditModule } = useAuth();
  // Same gate as public.can_edit_material_master (server re-checks).
  const canEdit = canEditStock && (isOwner || canEditModule("material_master"));
  const review = useQ7MaterialLinkReview(canEdit);
  const bulk = useLinkQ7ExactMaterials();
  if (!canEdit) return <p className="note">Chỉ chủ hoặc người được quyền sửa mã hàng được gắn mã hàng.</p>;
  if (review.isLoading) return <div className="d3-wh-empty">Đang tải…</div>;
  if (review.error || !review.data) return <div className="err">{errorText(review.error)}</div>;

  const { items, counts } = review.data;
  const bulkable = items.filter((item) => item.exact_material && (item.unit_status === "same" || item.unit_status === "auto"));
  const needsFactor = items.filter((item) => item.exact_material && item.unit_status === "needs_factor");
  const rest = items.filter((item) => !item.exact_material);
  const done = (message: string) => toast({ title: message });
  const runBulk = () => bulk.mutate(undefined, {
    onSuccess: (result) => toast({
      title: `Đã gắn ${result.linked} món trùng tên`,
      description: [
        result.needs_factor.length ? `${result.needs_factor.length} món cần số quy đổi` : null,
        result.failed.length ? `${result.failed.length} món lỗi: ${result.failed.map((f) => f.name).join(", ")}` : null,
      ].filter(Boolean).join(" · ") || undefined,
    }),
    onError: (error) => toast({ title: "Chưa gắn được", description: errorText(error), variant: "destructive" }),
  });

  return (
    <div className="link-station" data-bmq-link-station>
      <div className="flow-note">
        <span>📋 Kiểm kê Q7 cần mỗi món có <b>mã nguyên liệu chuẩn</b></span>
      </div>
      <div className="jev-meter link-meter">
        <div><small>Chưa gắn</small><b>{counts.total}</b></div>
        <div><small>Trùng tên</small><b>{counts.exact}</b></div>
        <div><small>Đã gắn</small><b>{counts.linked_total}</b></div>
      </div>
      {bulkable.length ? (
        <button type="button" className="btn link-bulk" disabled={bulk.isPending} onClick={runBulk} data-bmq-link-bulk>
          {bulk.isPending ? "Đang gắn…" : `🧩 Gắn ${bulkable.length} món trùng tên`}
        </button>
      ) : null}
      {needsFactor.length ? (
        <section className="link-sec">
          <h3>Trùng tên · cần số quy đổi · {needsFactor.length}</h3>
          <p className="note">Đơn vị kho khác đơn vị của mã hàng. Nhập 1 đơn vị chuẩn bằng bao nhiêu đơn vị kho.</p>
          <ul className="link-list">{needsFactor.map((item) => <LinkRow key={item.item_id} item={item} canEdit={canEdit} onDone={done} />)}</ul>
        </section>
      ) : null}
      {rest.length ? (
        <section className="link-sec">
          <h3>Chưa có mã trùng tên · {rest.length}</h3>
          <p className="note">Chọn mã gần nhất hoặc tạo mã mới. Vật tư (băng keo, bao tay…) không cần nếu không kiểm kê ở Q7.</p>
          <ul className="link-list">{rest.map((item) => <LinkRow key={item.item_id} item={item} canEdit={canEdit} onDone={done} />)}</ul>
        </section>
      ) : null}
      {bulkable.length ? (
        <section className="link-sec">
          <h3>Trùng tên · gắn được ngay · {bulkable.length}</h3>
          <ul className="link-list">{bulkable.map((item) => <LinkRow key={item.item_id} item={item} canEdit={canEdit} onDone={done} />)}</ul>
        </section>
      ) : null}
      {items.length === 0 ? <div className="d3-wh-empty">Mọi món Q7 đã có mã hàng ✓ Kiểm kê Q7 chốt được rồi.</div> : null}
    </div>
  );
}

/** Owner rule 17/10: a factor is typed with the item's delivery notes in view. */
function LinkFactorNotes({ itemId }: { itemId: string }) {
  const lines = useItemReceiptLines(itemId, true);
  return <ReceiptNotes title="Phiếu giao hàng" lines={lines.data} loading={lines.isLoading} error={lines.error} />;
}
