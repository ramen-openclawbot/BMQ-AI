import { useEffect, useMemo, useState } from "react";
import { Check, FileText, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { OptionPicker } from "@/components/OptionPicker";
import { useCrateReceiptLines, useSetItemPastryQ7 } from "@/hooks/useWarehouseGame";
import { useConfirmMaterialAlias, useCreateStockMaterialItem } from "@/hooks/useMaterialAlias";
import { useSuggestStockItemName } from "@/hooks/useSuggestStockItemName";
import type { WarehouseGameItem, WarehouseGameLocation, WarehouseGamePendingRow, WarehouseGameSnapshot } from "@/lib/warehouse-game";
import { defaultNewItemUnit, packFactorFor, unitFactor } from "@/components/material-alias/new-stock-item";
import { cn } from "@/lib/utils";
import { CLASS_LABEL, ITEM_UNITS, asClass, cleanCrateName, fmtQty, newRequestId, normalizeName, strongCandidate, type ItemClass } from "./kho-meta";
import { KhoDialog } from "./KhoDialog";
import { ReceiptNotes } from "./ReceiptNotes";
import { InvoiceScanner } from "./InvoiceScanner";

/**
 * One name printed on delivery notes that the warehouse does not know yet: pick the right item once and every
 * later note from the same supplier lands on it; or make a new item; or mark the line as not stocked.
 */

/**
 * How a receipt's unit maps onto the stock unit (owner 12/10: "đơn vị ghi trên phiếu" was a guess).
 * pack: the receipt counts packs (PACK, gói, thùng…) → ask "1 PACK = ? g", prefilled from the name ("1KG").
 * auto: kg / g / l / ml lines convert by themselves. unknown: no receipt unit known → free label.
 */
type UnitPlan = { mode: "pack" | "auto" | "unknown"; unit: string | null; auto: number | null; prefill: number | null; units: Array<{ unit: string; line_count: number }> };
function unitPlanFor(crate: WarehouseGamePendingRow, stockUnit: string): UnitPlan {
  const units = (crate.raw_units ?? []).filter((row) => row.unit.trim());
  const ordered = units.length ? units : crate.raw_unit ? [{ unit: crate.raw_unit, line_count: crate.line_count }] : [];
  const pack = ordered.find((row) => unitFactor(row.unit, stockUnit) === null);
  const measure = ordered.find((row) => unitFactor(row.unit, stockUnit) !== null);
  const guess = packFactorFor(crate.raw_name, stockUnit)?.factor ?? null;
  if (pack) return { mode: "pack", unit: pack.unit.trim(), auto: null, prefill: guess, units: ordered };
  if (measure) return { mode: "auto", unit: measure.unit.trim(), auto: unitFactor(measure.unit, stockUnit), prefill: null, units: ordered };
  return { mode: "unknown", unit: null, auto: null, prefill: guess, units: ordered };
}

/** Count units (cái, gói, hộp…) are neither weight nor volume: the receipt and the shelf both count pieces. */
const isCountUnit = (unit: string) => unitFactor(unit, "g") === null && unitFactor(unit, "ml") === null;
const trimNumber = (value: number) => String(Math.round(value * 1e6) / 1e6);

/**
 * Receipt counts pieces, the shelf counts packs (owner 12/10: "cái" on the receipt, "gói" on the shelf).
 * Owner 15/10 (IMG_5718): OCR read "cái" as "đệnh" / "định". A misread unit is the stock unit itself,
 * so it saves 1 = 1 like "Là một"; count lines all use the alias factor, so every misread line is covered.
 */
type CountChoice = "same" | "misread" | "stock_has" | "receipt_has";
function CountUnitQuestion({ receiptUnit, oddUnits, stockUnit, factorText, onFactor }: { receiptUnit: string; oddUnits: string[]; stockUnit: string; factorText: string; onFactor: (value: string) => void }) {
  const [choice, setChoice] = useState<CountChoice | null>(null);
  const [n, setN] = useState("");
  const pick = (next: CountChoice) => {
    setChoice(next);
    setN("");
    onFactor(next === "same" || next === "misread" ? "1" : "");
  };
  const misreadList = (oddUnits.length ? oddUnits : [receiptUnit]).map((unit) => `“${unit}”`).join(", ");
  const typeN = (value: string) => {
    setN(value);
    const parsed = Number(value.replace(",", "."));
    if (!(parsed > 0)) return onFactor("");
    onFactor(trimNumber(choice === "stock_has" ? 1 / parsed : parsed));
  };
  const options: Array<{ id: CountChoice; title: string; detail: string }> = [
    { id: "same", title: "Là một", detail: `1 ${receiptUnit} = 1 ${stockUnit}` },
    { id: "misread", title: "Phiếu đọc sai chữ", detail: `${misreadList} chính là ${stockUnit}` },
    { id: "stock_has", title: `${stockUnit} gồm nhiều ${receiptUnit}`, detail: `vd 1 ${stockUnit} = 10 ${receiptUnit}` },
    { id: "receipt_has", title: `${receiptUnit} gồm nhiều ${stockUnit}`, detail: `vd 1 ${receiptUnit} = 12 ${stockUnit}` },
  ];
  return (
    <div className="d3-kho-unitq" data-bmq-count-q>
      <p>Phiếu đếm bằng <b>{receiptUnit}</b>, kho đếm bằng <b>{stockUnit}</b>. Hai đơn vị này liên quan thế nào?</p>
      <div className="d3-kho-options" role="radiogroup" aria-label="Quan hệ đơn vị">
        {options.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={choice === option.id} className={cn("d3-kho-option", choice === option.id && "is-on")}
            onClick={() => pick(option.id)} data-bmq-count-misread={option.id === "misread" ? "" : undefined}>
            <b>{option.title}</b><small>{option.detail}</small>
          </button>
        ))}
      </div>
      {choice === "stock_has" || choice === "receipt_has" ? (
        <label className="d3-kho-conv">
          1 {choice === "stock_has" ? stockUnit : receiptUnit} =
          <Input inputMode="decimal" value={n} onChange={(event) => typeN(event.target.value)} placeholder="?" aria-label="Số lượng" autoFocus />
          {choice === "stock_has" ? receiptUnit : stockUnit}
        </label>
      ) : null}
      {choice === "misread" ? <small className="d3-kho-quiet">Máy coi {misreadList} là {stockUnit}: phiếu ghi bao nhiêu thì nhập kho bấy nhiêu {stockUnit}.</small>
        : choice && factorText ? <small className="d3-kho-quiet">Máy sẽ tính: 1 {receiptUnit} = {fmtQty(Number(factorText))} {stockUnit}.</small> : null}
    </div>
  );
}

/** Receipt count units other than the stock unit itself ("cái ×2 · Cái ×1 · đệnh ×1 · định ×1" → đệnh, định). */
function oddCountUnits(plan: UnitPlan, stockUnit: string): string[] {
  const key = (unit: string) => unit.normalize("NFC").trim().toLowerCase();
  const seen = new Set<string>([key(stockUnit)]);
  return plan.units.flatMap((row) => {
    const k = key(row.unit);
    if (seen.has(k) || !isCountUnit(row.unit)) return [];
    seen.add(k);
    return [row.unit.trim()];
  });
}

function UnitQuestion({ plan, stockUnit, label, onLabel, factorText, onFactor }: {
  plan: UnitPlan; stockUnit: string; label: string; onLabel: (value: string) => void; factorText: string; onFactor: (value: string) => void;
}) {
  const mixed = plan.units.length > 1;
  const countPair = plan.mode === "pack" && plan.unit !== null && isCountUnit(stockUnit) && isCountUnit(plan.unit);
  return (
    <div className={cn("d3-kho-unit", `is-${plan.mode}`)} data-bmq-unit-q={plan.mode}>
      {plan.mode === "auto" ? (
        <p><b>Phiếu ghi “{plan.unit}”</b>: kho tự đổi 1 {plan.unit} = {fmtQty(plan.auto ?? 1)} {stockUnit}. Không cần điền gì.</p>
      ) : countPair ? (
        <CountUnitQuestion key={`${plan.unit}-${stockUnit}`} receiptUnit={plan.unit ?? ""} oddUnits={oddCountUnits(plan, stockUnit)} stockUnit={stockUnit} factorText={factorText} onFactor={onFactor} />
      ) : plan.mode === "pack" ? (
        <>
          <p><b>Phiếu ghi “{plan.unit}”</b>, kho tính bằng <b>{stockUnit}</b>. Mỗi khi phiếu ghi {plan.unit}, máy nhân với số này:</p>
          <label className="d3-kho-conv">
            1 {plan.unit} =
            <Input inputMode="decimal" value={factorText} onChange={(event) => onFactor(event.target.value)} placeholder="?" aria-label={`1 ${plan.unit} bằng bao nhiêu ${stockUnit}`} />
            {stockUnit}
          </label>
          <small className="d3-kho-quiet">{plan.prefill ? `Máy đọc từ tên hàng: ${fmtQty(plan.prefill)} ${stockUnit}. Kiểm lại cho đúng.` : "Ví dụ: 1 PACK phô mai 1 kg → 1000; 1 thùng 12 hộp × 1 lít → 12000."}</small>
        </>
      ) : (
        <>
          <p>Chưa đọc được đơn vị trên phiếu. Ghi đơn vị nhà cung cấp dùng và quy đổi ra <b>{stockUnit}</b>:</p>
          <div className="d3-kho-pair">
            <label className="d3-kho-field"><span>Đơn vị trên phiếu</span><Input value={label} onChange={(event) => onLabel(event.target.value)} placeholder="PACK, gói, thùng…" /></label>
            <label className="d3-kho-field"><span>1 {label.trim() || "đơn vị"} = ? {stockUnit}</span><Input inputMode="decimal" value={factorText} onChange={(event) => onFactor(event.target.value)} /></label>
          </div>
        </>
      )}
      {mixed ? <small className="d3-kho-quiet">Các dòng phiếu ghi: {plan.units.map((row) => `${row.unit} ×${row.line_count}`).join(" · ")}. Dòng kg, g, lít, ml luôn tự đổi.</small> : null}
    </div>
  );
}

function errorText(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error);
  const known: Array<[string, string]> = [
    ["item_name_duplicate", "Tên này đã có ở một mặt hàng khác."],
    ["invalid_name", "Tên phải dài 2–120 ký tự."],
    ["rename_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được đổi tên."],
    ["unit_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được đổi đơn vị."],
    ["unit_not_allowed", "Đơn vị không có trong bảng chuẩn."],
    ["unit_unchanged", "Đơn vị mới giống đơn vị cũ (kho lưu g / ml)."],
    ["invalid_factor", "Cần hệ số quy đổi lớn hơn 0."],
    ["create_item_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được tạo mặt hàng."],
    ["non_stock_requires_admin", "Chỉ chủ hoặc người sửa kho Q7 được đánh dấu không nhập kho."],
    ["insufficient_privilege", "Tài khoản chưa có quyền với kho này."],
    ["q7_pastry_only", "Kho Q7 chỉ nhận món để ở Q7. Bật “Để ở Q7” cho món này, hoặc chọn “Không nhập kho”."],
    ["pastry_forbidden", "Chỉ chủ hoặc người sửa kho Q7 được đổi nơi để."],
  ];
  return known.find(([code]) => message.includes(code))?.[1] ?? message;
}

/** "Để ở Q7": flagged items move on to Q7 by themselves after landing at Tân Tạo. */
function PastrySwitch({ item }: { item: WarehouseGameItem }) {
  const setFlag = useSetItemPastryQ7();
  const [value, setValue] = useState(item.pastry_q7);
  const flip = (next: boolean) => {
    setValue(next);
    setFlag.mutate({ itemId: item.id, value: next }, { onError: () => setValue(!next) });
  };
  return (
    <div className="d3-kho-switchrow" data-bmq-item-pastry>
      <span><b>Để ở Q7</b><small>{value ? "Nhập ở Tân Tạo xong tự chuyển sang Q7" : "Để ở Tân Tạo, Q7 không nhận"}</small></span>
      <Switch checked={value} onCheckedChange={flip} disabled={setFlag.isPending} aria-label="Để ở Q7" />
      {setFlag.error ? <p className="d3-kho-error">{errorText(setFlag.error)}</p> : null}
    </div>
  );
}

interface Target { kind: "item" | "sku"; id: string; name: string; unit: string; cls: ItemClass }

export function CrateDialog({ location, crate, snapshot, autoPick = false, onAssigned, onClose }: {
  location: WarehouseGameLocation; crate: WarehouseGamePendingRow; snapshot: WarehouseGameSnapshot; autoPick?: boolean;
  onAssigned: (label: string) => void; onClose: () => void;
}) {
  const confirm = useConfirmMaterialAlias();
  const create = useCreateStockMaterialItem();
  const notes = useCrateReceiptLines(location, crate.supplier_id, crate.normalized_name, true);
  const setPastry = useSetItemPastryQ7();
  // Q7 only stocks pastry items, so a new item made from a Q7 name starts flagged.
  const [asPastry, setAsPastry] = useState(location === "q7");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(() => cleanCrateName(crate.raw_name));
  const [newUnit, setNewUnit] = useState(() => defaultNewItemUnit(crate.raw_name, crate.raw_unit));
  const [packLabel, setPackLabel] = useState("");
  const [factorText, setFactorText] = useState("1");
  const [requestId] = useState(newRequestId);
  // Owner 14/10: the new item takes the full name printed on the invoice photo, not the short name typed on the PO.
  const suggestName = useSuggestStockItemName();
  const [nameEdited, setNameEdited] = useState(false);
  const [nameSource, setNameSource] = useState<"receipt" | "invoice">("receipt");

  const preparePlan = (stockUnit: string) => {
    const plan = unitPlanFor(crate, stockUnit);
    // No unit on the receipt lines at all: assume they count in the stock unit (1 = 1), editable.
    setPackLabel(plan.unit ?? (plan.mode === "unknown" ? stockUnit : ""));
    setFactorText(plan.mode === "auto" ? "1" : plan.prefill ? String(plan.prefill) : plan.mode === "unknown" ? "1" : "");
  };

  const startCreate = () => {
    setCreating(true);
    preparePlan(newUnit);
    if (nameSource === "invoice" || suggestName.isPending) return;
    suggestName.mutate({ location, supplier_id: crate.supplier_id, normalized_name: crate.normalized_name }, {
      onSuccess: (suggestion) => {
        if (!suggestion) return;
        setNameSource("invoice");
        setNameEdited((edited) => {
          if (!edited) setNewName(cleanCrateName(suggestion.full_name));
          return edited;
        });
        const unit = suggestion.unit && ITEM_UNITS.includes(suggestion.unit) ? suggestion.unit : null;
        if (unit) { setNewUnit(unit); preparePlan(unit); }
      },
    });
  };

  const toItem = (item: WarehouseGameItem): Target => ({ kind: "item", id: item.id, name: item.name, unit: item.unit, cls: asClass(item.item_class) });
  const suggested = useMemo<Target | null>(() => {
    const near = strongCandidate(crate);
    const id = near?.item_id ?? near?.sku_id ?? null;
    if (!id) return null;
    if (!near?.item_id) {
      const sku = snapshot.skus.find((entry) => entry.id === id);
      return sku ? { kind: "sku", id: sku.id, name: sku.product_name, unit: sku.unit, cls: "finished_goods" } : null;
    }
    const item = snapshot.items.find((entry) => entry.id === id);
    return item ? toItem(item) : null;
  }, [crate, snapshot]);
  const q = normalizeName(query);
  // Only search results: an unfiltered A→Z list looked like a suggestion (owner 12/10, "tỏi ngày 10").
  const matches = q
    ? snapshot.items.filter((item) => item.id !== suggested?.id && normalizeName(item.name).includes(q)).slice(0, 8)
    : [];

  const pick = (next: Target) => {
    preparePlan(next.unit);
    setTarget(next);
  };
  // Open on the hint: the closest name is already chosen.
  useEffect(() => {
    if (autoPick && suggested) pick(suggested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const factor = Number(factorText.replace(",", "."));
  const stockUnit = creating ? newUnit : target?.unit ?? "g";
  const plan = unitPlanFor(crate, stockUnit);
  const unitOk = plan.mode === "auto" || (Number.isFinite(factor) && factor > 0 && (plan.mode === "pack" || packLabel.trim().length > 0));
  const busy = confirm.isPending || create.isPending || setPastry.isPending;
  const error = confirm.error ?? create.error ?? setPastry.error;
  const classLabel = (entry: Target) => (entry.kind === "sku" ? "Thành phẩm SKU" : CLASS_LABEL[entry.cls]);

  const send = (dest: Target | null, lineClass: "stock" | "non_stock") =>
    confirm.mutate(
      {
        supplierId: crate.supplier_id,
        location,
        rawName: crate.raw_name,
        rawUnit: crate.raw_unit ?? null,
        kitchenInventoryItemId: dest?.kind === "item" ? dest.id : null,
        tanTaoSkuId: dest?.kind === "sku" ? dest.id : null,
        enteredUnitLabel: lineClass === "stock" ? (plan.mode === "unknown" ? packLabel.trim() : plan.unit) || dest?.unit || null : null,
        // kg / g / l / ml lines convert by themselves; store that standard factor, never 1 ("1 kg = 1 g", owner 22/10).
        conversionFactor: lineClass !== "stock" ? 1 : plan.mode === "auto" ? plan.auto ?? 1 : factor,
        jevItemId: null,
        jevProbability: null,
        sourceTable: "warehouse_game",
        sourceId: null,
        lineClass,
      },
      { onSuccess: () => onAssigned(dest ? dest.name : "không nhập kho") },
    );

  const createAndSend = () =>
    create.mutate(
      { name: newName.trim(), unit: newUnit, location, requestId },
      {
        onSuccess: async (result) => {
          if (asPastry) await setPastry.mutateAsync({ itemId: result.item_id, value: true });
          send({ kind: "item", id: result.item_id, name: newName.trim(), unit: newUnit, cls: "unclassified" }, "stock");
        },
      },
    );

  return (
    <KhoDialog title={`“${crate.raw_name}”`} sub={`${crate.line_count} dòng phiếu · ${crate.supplier_name ?? "chưa rõ nhà cung cấp"}`} onClose={onClose} data={{ "data-bmq-crate-dialog": "" }}>
      <ReceiptNotes title="Phiếu giao hàng" lines={notes.data} loading={notes.isLoading} error={notes.error} />
      {creating ? (
        <>
          <label className="d3-kho-field">
            <span>Tên mặt hàng mới</span>
            <Input value={newName} onChange={(event) => { setNewName(event.target.value); setNameEdited(true); }} maxLength={120}
              className={cn(nameSource === "invoice" && "is-filled")} key={nameSource} data-bmq-new-name />
          </label>
          {suggestName.isPending ? <div data-bmq-name-hint="busy"><InvoiceScanner lines={notes.data} /></div>
            : nameSource === "invoice" ? <p className="d3-kho-hint is-ok" data-bmq-name-hint="invoice"><FileText aria-hidden="true" />Tên đầy đủ lấy từ ảnh hóa đơn. Kiểm lại trước khi tạo.</p>
            : suggestName.isError ? <p className="d3-kho-hint" data-bmq-name-hint="error">Chưa đọc được ảnh hóa đơn: {String((suggestName.error as Error)?.message ?? "").slice(0, 140)}. Tên đang lấy từ phiếu.</p>
            : suggestName.isSuccess ? <p className="d3-kho-hint" data-bmq-name-hint="none">Không tìm thấy dòng khớp trên ảnh hóa đơn; tên đang lấy từ phiếu.</p>
            : null}
          <label className="d3-kho-field">
            <span>Đơn vị kho</span>
            <OptionPicker value={newUnit} onChange={(value) => { setNewUnit(value); preparePlan(value); }} title="Đơn vị kho" ariaLabel="Đơn vị kho" options={ITEM_UNITS.map((value) => ({ value, label: value }))} />
          </label>
          <UnitQuestion plan={plan} stockUnit={newUnit} label={packLabel} onLabel={setPackLabel} factorText={factorText} onFactor={setFactorText} />
          <div className="d3-kho-switchrow" data-bmq-new-pastry>
            <span>
              <b>Để ở Q7</b>
              <small>{location === "q7" ? (asPastry ? "Kho Q7 chỉ nhận món để ở Q7" : "Tắt thì Kho Q7 không nhận món này") : asPastry ? "Nhập ở Tân Tạo xong tự chuyển sang Q7" : "Để ở Tân Tạo"}</small>
            </span>
            <Switch checked={asPastry} onCheckedChange={setAsPastry} aria-label="Để ở Q7" />
          </div>
          {error ? <p className="d3-kho-error">{errorText(error)}</p> : null}
          <div className="d3-kho-actions">
            <Button disabled={busy || newName.trim().length < 2 || !unitOk || (location === "q7" && !asPastry)} onClick={createAndSend} data-bmq-crate-create>{busy ? "Đang lưu…" : "Tạo mặt hàng"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Quay lại</Button>
          </div>
        </>
      ) : target ? (
        <>
          <div className="d3-kho-chosen" data-bmq-picked>
            <Check aria-hidden="true" />
            <span><b>{target.name}</b><small>{classLabel(target)} · {target.unit}</small></span>
            <button type="button" className="d3-kho-textbtn" onClick={() => setTarget(null)} aria-label={`Bỏ chọn ${target.name}`} data-bmq-unpick>Bỏ chọn</button>
          </div>
          <UnitQuestion plan={plan} stockUnit={target.unit} label={packLabel} onLabel={setPackLabel} factorText={factorText} onFactor={setFactorText} />
          {target.kind === "item" && location === "tan_tao" ? (() => {
            const picked = snapshot.items.find((item) => item.id === target.id);
            return picked ? <PastrySwitch key={picked.id} item={picked} /> : null;
          })() : null}
          {error ? <p className="d3-kho-error">{errorText(error)}</p> : null}
          <div className="d3-kho-actions">
            <Button disabled={busy || !unitOk} onClick={() => send(target, "stock")} data-bmq-crate-assign>{busy ? "Đang lưu…" : "Gộp vào tên này"}</Button>
            <Button variant="outline" onClick={() => setTarget(null)}>Chọn lại</Button>
          </div>
        </>
      ) : (
        <>
          {suggested ? (
            <button type="button" className="d3-kho-suggest" onClick={() => pick(suggested)} data-bmq-crate-suggest>
              <span><small>Gần nhất trong kho</small><b>{suggested.name}</b><small>{classLabel(suggested)} · {suggested.unit}</small></span>
              <span className="d3-kho-suggest-go">Chọn</span>
            </button>
          ) : (
            <div className="d3-kho-nohint" data-bmq-crate-nohint>
              <p>Kho chưa có mặt hàng giống tên này.</p>
              <Button onClick={startCreate}><Plus aria-hidden="true" />Tạo mặt hàng “{cleanCrateName(crate.raw_name)}”</Button>
            </div>
          )}
          <label className="d3-kho-field">
            <span>{suggested ? "Hoặc tìm mặt hàng khác" : "Hoặc tìm trong kho"}</span>
            <span className="d3-kho-search">
              <Search aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ tên để tìm…" aria-label="Tìm mặt hàng trong kho" enterKeyHint="search" />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
            </span>
          </label>
          {matches.length ? (
            <ul className="d3-kho-picks">
              {matches.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => pick(toItem(item))} data-bmq-crate-match={item.id}>
                    <b>{item.name}</b><small>{CLASS_LABEL[asClass(item.item_class)]} · {item.unit}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : q ? <p className="d3-kho-quiet">Không có mặt hàng nào khớp “{query}”.</p> : null}
          {error ? <p className="d3-kho-error">{errorText(error)}</p> : null}
          <div className="d3-kho-actions">
            {suggested ? <Button variant="outline" onClick={startCreate}><Plus aria-hidden="true" />Mặt hàng mới</Button> : null}
            <Button variant="outline" disabled={busy} onClick={() => send(null, "non_stock")} data-bmq-crate-nonstock>Không nhập kho</Button>
            <Button variant="ghost" onClick={onClose}>Để sau</Button>
          </div>
        </>
      )}
    </KhoDialog>
  );
}
