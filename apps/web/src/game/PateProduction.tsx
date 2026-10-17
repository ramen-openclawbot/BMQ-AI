import { useMemo, useState } from "react";
import { useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import { useAnswerTanTaoPateLine, useRecordTanTaoPateProduction, useSetTanTaoPateBatch, useTanTaoPateRecipe } from "@/hooks/useTanTaoPate";
import { missionErrorMessage } from "@/lib/missions";
import { packUsage, recipeProgress, usageForBatches, type TanTaoPateLine } from "@/lib/tan-tao-pate";
import { GamePicker } from "./GamePicker";
import { Sheet } from "./Sheet";
import { fmtQty, newRequestId } from "./meta";

/**
 * Tân Tạo pate (owner 17/10, part D of "trừ kho"): the owner answers the recipe once through mission cards,
 * then every "Sản xuất pate" slip deducts the ingredients, hộp and tem, and adds the packed pate SKUs.
 */

const vnToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const num = (text: string) => Number(text.replace(/\s/g, "").replace(",", "."));

type ItemOption = { id: string; name: string; unit: string };

function itemOptions(items: ItemOption[]) {
  return items.map((item) => ({ value: item.id, label: `${item.name} · ${item.unit}` }));
}

function BatchCard({ batchKg, onSaved }: { batchKg: number | null; onSaved: (text: string) => void }) {
  const save = useSetTanTaoPateBatch();
  const [requestId] = useState(newRequestId);
  const [text, setText] = useState(batchKg ? String(batchKg) : "");
  const value = num(text);
  return (
    <li className={`task-row${batchKg ? " is-fixed" : ""} pate-row`} data-bmq-pate-batch>
      <div className="task-head"><b>1 mẻ pate ra bao nhiêu kg?</b><small>Dùng để tính hộp đóng được từ số mẻ</small></div>
      <label className="conv">
        1 mẻ =
        <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label="Số kg pate mỗi mẻ" />
        kg
        <button type="button" className="btn" disabled={!(value > 0) || save.isPending} onClick={() => save.mutate({ batchOutputKg: value, requestId }, { onSuccess: () => onSaved(`1 mẻ = ${fmtQty(value)} kg`) })}>{save.isPending ? "Đang lưu…" : "Lưu"}</button>
      </label>
      {save.error ? <div className="err">{missionErrorMessage(save.error)}</div> : null}
    </li>
  );
}

function IngredientCard({ line, items, onSaved }: { line: TanTaoPateLine; items: ItemOption[]; onSaved: (text: string) => void }) {
  const answer = useAnswerTanTaoPateLine();
  const [itemId, setItemId] = useState(line.kitchen_inventory_item_id ?? "");
  const [text, setText] = useState(line.grams_per_batch ? String(line.grams_per_batch) : "");
  const grams = num(text);
  const done = line.status !== "open";
  const options = useMemo(() => {
    const list = itemOptions(items);
    if (line.kitchen_inventory_item_id && !items.some((item) => item.id === line.kitchen_inventory_item_id)) {
      list.unshift({ value: line.kitchen_inventory_item_id, label: `${line.item_name ?? "Món kho"} · ${line.item_unit ?? ""}` });
    }
    return list;
  }, [items, line]);
  return (
    <li className={`task-row${done ? " is-fixed" : ""} pate-row`} data-bmq-pate-line={line.label} data-status={line.status}>
      <div className="task-head">
        <b>{line.label}</b>
        <small>{line.status === "answered" ? `✓ ${fmtQty(line.grams_per_batch ?? 0)} g/mẻ · ${line.item_name ?? ""}` : line.status === "not_used" ? "Không dùng trong pate" : "gram cho 1 mẻ"}</small>
      </div>
      <GamePicker value={itemId} onChange={setItemId} placeholder="Chọn món kho…" title={`${line.label} lấy từ món nào`} ariaLabel={`Món kho cho ${line.label}`} options={options} />
      <label className="conv">
        1 mẻ dùng
        <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label={`Gram ${line.label} mỗi mẻ`} data-bmq-pate-grams />
        g
      </label>
      <div className="row pate-actions">
        <button type="button" className="btn" disabled={!itemId || !(grams > 0) || answer.isPending} onClick={() => answer.mutate({ lineId: line.id, itemId, grams }, { onSuccess: () => onSaved(`${line.label}: ${fmtQty(grams)} g/mẻ`) })} data-bmq-pate-save>
          {answer.isPending ? "Đang lưu…" : done ? "Sửa" : "Lưu"}
        </button>
        <button type="button" className="btn ghost" disabled={answer.isPending} onClick={() => answer.mutate({ lineId: line.id, notUsed: true }, { onSuccess: () => onSaved(`${line.label}: không dùng`) })} data-bmq-pate-not-used>Không dùng</button>
      </div>
      {answer.error ? <div className="err">{missionErrorMessage(answer.error)}</div> : null}
    </li>
  );
}

function PackCard({ line, items, onSaved }: { line: TanTaoPateLine; items: ItemOption[]; onSaved: (text: string) => void }) {
  const answer = useAnswerTanTaoPateLine();
  const [packId, setPackId] = useState(line.pack_item_id ?? "");
  const [labelId, setLabelId] = useState(line.label_item_id ?? "");
  const [text, setText] = useState(line.pate_grams_per_pack ? String(line.pate_grams_per_pack) : "");
  const grams = num(text);
  const done = line.status === "answered";
  const options = itemOptions(items);
  return (
    <li className={`task-row${done ? " is-fixed" : ""} pate-row`} data-bmq-pate-line={line.label} data-status={line.status}>
      <div className="task-head"><b>{line.label}</b><small>Mỗi hộp dùng 1 hộp rỗng + 1 tem · {line.sku_code}</small></div>
      <label className="pate-field"><span>Hộp rỗng</span><GamePicker value={packId} onChange={setPackId} placeholder="Chọn hộp…" title="Hộp rỗng" ariaLabel={`Hộp rỗng cho ${line.label}`} options={options} /></label>
      <label className="pate-field"><span>Tem / nhãn</span><GamePicker value={labelId} onChange={setLabelId} placeholder="Chọn tem…" title="Tem / nhãn" ariaLabel={`Tem cho ${line.label}`} options={options} /></label>
      <label className="conv">
        1 hộp chứa
        <input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} placeholder="?" aria-label={`Gram pate mỗi ${line.label}`} />
        g pate
      </label>
      <button type="button" className="btn" disabled={!packId || !(grams > 0) || answer.isPending} onClick={() => answer.mutate({ lineId: line.id, packItemId: packId, labelItemId: labelId || null, pateGrams: grams }, { onSuccess: () => onSaved(`${line.label}: đã lưu`) })} data-bmq-pate-save>
        {answer.isPending ? "Đang lưu…" : done ? "Sửa" : "Đúng, lưu"}
      </button>
      {answer.error ? <div className="err">{missionErrorMessage(answer.error)}</div> : null}
    </li>
  );
}

/** Mission tool: the pate recipe as cards (batch size, grams per ingredient, hộp + tem per pack). */
export function PateRecipeTool({ onSaved }: { onSaved: (text: string) => void }) {
  const recipe = useTanTaoPateRecipe();
  const snapshot = useWarehouseGameSnapshot("tan_tao");
  if (recipe.isLoading) return <p className="note">Đang đọc công thức…</p>;
  if (recipe.error || !recipe.data) return <div className="err">{missionErrorMessage(recipe.error)}</div>;
  const items = (snapshot.data?.items ?? []).map((item) => ({ id: item.id, name: item.name, unit: item.unit }));
  const progress = recipeProgress(recipe.data);
  const lines = [...recipe.data.lines].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || a.sort_order - b.sort_order);
  return (
    <>
      <p className="hint">Khai một lần: 1 mẻ pate ra bao nhiêu kg, mỗi nguyên liệu bao nhiêu gram cho 1 mẻ (không dùng thì bấm “Không dùng”), và hộp + tem cho mỗi hộp 500g, 200g. Sau đó phiếu “Sản xuất pate” ở kệ thành phẩm Tân Tạo tự trừ NVL.</p>
      <p className="note" data-bmq-pate-progress>Còn {progress.left} câu · đã trả lời {progress.answered + progress.notUsed + (progress.batchSet ? 1 : 0)}/{progress.total}</p>
      <ul className="task-list" data-bmq-pate-lines>
        <BatchCard batchKg={recipe.data.batch_output_kg} onSaved={onSaved} />
        {lines.map((line) => line.line_kind === "pack"
          ? <PackCard key={line.id} line={line} items={items} onSaved={onSaved} />
          : <IngredientCard key={line.id} line={line} items={items} onSaved={onSaved} />)}
      </ul>
    </>
  );
}

/** Daily slip: batches + packed boxes → ingredients, hộp, tem out; Pate 500g / 200g in. */
export function PateProductionSheet({ canEdit, onDone, onClose }: { canEdit: boolean; onDone: (text: string) => void; onClose: () => void }) {
  const recipe = useTanTaoPateRecipe();
  const record = useRecordTanTaoPateProduction();
  const [requestId] = useState(newRequestId);
  const [date, setDate] = useState(vnToday);
  const [batchText, setBatchText] = useState("");
  const [p500, setP500] = useState("");
  const [p200, setP200] = useState("");
  const batches = num(batchText) || 0;
  const packs = [{ sku_code: "PATE-500G", quantity: num(p500) || 0 }, { sku_code: "PATE-200G", quantity: num(p200) || 0 }];
  const data = recipe.data;
  const complete = data?.status === "complete";
  const usage = data ? usageForBatches(data.lines, batches) : [];
  const boxes = data ? packUsage(packs, data.lines) : [];
  const pateMade = (data?.batch_output_kg ?? 0) * batches * 1000;
  const pateUsed = boxes.reduce((sum, row) => sum + row.pateGrams, 0);
  const ready = canEdit && complete && (batches > 0 || packs.some((p) => p.quantity > 0)) && !record.isPending;
  const submit = () => record.mutate(
    { date, batches, packs: packs.filter((p) => p.quantity > 0), requestId },
    { onSuccess: (result) => { onDone(result.replay ? "Phiếu này đã ghi trước đó" : `Đã ghi sản xuất pate ${date.slice(8, 10)}/${date.slice(5, 7)} · ${result.movement_count} dòng trừ kho`); onClose(); } },
  );
  return (
    <Sheet title="Sản xuất pate" tag="🍲 Tân Tạo" sub="Trừ NVL theo công thức, cộng hộp pate vào kho" onClose={onClose}>
      {recipe.isLoading ? <p className="note">Đang đọc công thức…</p> : null}
      {recipe.error ? <div className="err">{missionErrorMessage(recipe.error)}</div> : null}
      {data && !complete ? <div className="warn" data-bmq-pate-incomplete>Công thức pate chưa khai xong ({recipeProgress(data).left} câu). Chủ khai ở Bảng nhiệm vụ → “Công thức pate Tân Tạo”.</div> : null}
      <label className="field">Ngày sản xuất<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label className="conv">Số mẻ<input inputMode="decimal" value={batchText} onChange={(event) => setBatchText(event.target.value)} placeholder="0" aria-label="Số mẻ pate" data-bmq-pate-batches />mẻ</label>
      <label className="conv">Đóng hộp 500g<input inputMode="numeric" value={p500} onChange={(event) => setP500(event.target.value)} placeholder="0" aria-label="Số hộp 500g" data-bmq-pate-p500 />hộp</label>
      <label className="conv">Đóng hộp 200g<input inputMode="numeric" value={p200} onChange={(event) => setP200(event.target.value)} placeholder="0" aria-label="Số hộp 200g" data-bmq-pate-p200 />hộp</label>
      {complete && (usage.length || boxes.length) ? (
        <div className="pate-preview" data-bmq-pate-preview>
          <b>Sẽ trừ kho</b>
          <ul>
            {usage.map((row) => <li key={row.itemId}><span>{row.itemName}</span><em>{fmtQty(row.grams)} g</em></li>)}
            {boxes.map((row) => <li key={row.lineId}><span>{row.label} (hộp + tem)</span><em>{fmtQty(row.quantity)}</em></li>)}
          </ul>
          {batches > 0 && pateUsed > 0 ? <small>Pate làm ra {fmtQty(pateMade / 1000)} kg · đóng hộp {fmtQty(pateUsed / 1000)} kg</small> : null}
        </div>
      ) : null}
      {record.error ? <div className="err">{missionErrorMessage(record.error)}</div> : null}
      <div className="submit-bar">
        <button type="button" className={`btn submit${ready ? " is-ready" : ""}`} disabled={!ready} onClick={submit} data-bmq-pate-submit>{record.isPending ? "Đang ghi…" : "Ghi phiếu sản xuất"}</button>
      </div>
    </Sheet>
  );
}
