import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeftRight, Check, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionPicker } from "@/components/OptionPicker";
import { useKhoSaveItem } from "@/hooks/useKhoItems";
import { useAddKhoUnit, useKhoConversionPreview, useKhoItemConversions, useKhoUnits, useSetKhoItemConversion } from "@/hooks/useKhoUnits";
import { khoErrorText, standardUnitFactor, type KhoItem } from "@/lib/kho-items";
import { conversionSentence, type KhoConversionGroup, type KhoConversionPreview, type KhoUnit } from "@/lib/kho-units";
import type { ReceiptLine } from "@/lib/receipt-lines";
import { cn } from "@/lib/utils";
import { KHO_LABEL, fmtAmount, fmtQty, newRequestId, normalizeName, parseNum } from "./kho-meta";
import { ReceiptNotes } from "./ReceiptNotes";

/**
 * Đơn vị & quy đổi (owner 22/10), shown inside an item's detail dialog: the warehouse editor changes an item's unit (any unit in the catalogue,
 * or a new one) and the factor each delivery-note unit converts by. Saving a factor corrects the stock of
 * receipts already in the ledger; the preview shows by how much before anything is written.
 * Every factor input sits next to the delivery notes it comes from (owner rule 17/10).
 */

const same = (a: string, b: string) => normalizeName(a) === normalizeName(b);
/** Weighed or measured (g, kg, ml, lít): a pack of it is the bigger unit. */
const measureUnit = (unit: string) => ["g", "kg", "ml", "l", "lit", "lít"].includes(normalizeName(unit));

/** Delivery-note lines written in one unit; every line of the item when none match. */
function linesIn(lines: ReceiptLine[] | undefined, unit: string | null): { lines: ReceiptLine[] | undefined; matched: boolean } {
  if (!lines || !unit) return { lines, matched: false };
  const hit = lines.filter((line) => line.unit && same(line.unit, unit));
  return hit.length ? { lines: hit, matched: true } : { lines, matched: false };
}

/**
 * "1 [left] = [n] [right]". The factor is always stock units per 1 receipt unit; the swap key flips which
 * unit stands alone on the left, so a person types whichever number is on the delivery note.
 */
function SentenceEditor({ receiptUnit, stockUnit, factor, onFactor, autoFocus = false, stockFirst = false }: {
  receiptUnit: string; stockUnit: string; factor: number | null; onFactor: (value: number | null) => void; autoFocus?: boolean;
  /** Start with the stock unit alone on the left (no factor yet): "1 khay = ? g" when g becomes khay. */
  stockFirst?: boolean;
}) {
  const startLeft = factor === null ? !stockFirst : factor >= 1;
  const [receiptLeft, setReceiptLeft] = useState(startLeft);
  const toText = (f: number | null, left: boolean) => {
    if (f === null || !(f > 0)) return "";
    const n = left ? f : 1 / f;
    return String(Math.round(n * 1000) / 1000).replace(".", ",");
  };
  const [text, setText] = useState(() => toText(factor, startLeft));
  const left = receiptLeft ? receiptUnit : stockUnit;
  const right = receiptLeft ? stockUnit : receiptUnit;
  const read = (value: string, flag: boolean) => {
    const n = parseNum(value);
    onFactor(Number.isFinite(n) && n > 0 ? (flag ? n : 1 / n) : null);
  };
  const swap = () => {
    const next = !receiptLeft;
    setReceiptLeft(next);
    const nextText = toText(factor, next);
    setText(nextText);
    read(nextText, next);
  };
  return (
    <div className="d3-kho-sentence" data-bmq-unit-sentence>
      <span className="d3-kho-sentence-one">1</span>
      <span className="d3-kho-sentence-unit">{left}</span>
      <span className="d3-kho-sentence-eq" aria-hidden="true">=</span>
      <input
        className="d3-kho-sentence-n"
        inputMode="decimal"
        value={text}
        placeholder="?"
        autoFocus={autoFocus}
        aria-label={`1 ${left} bằng bao nhiêu ${right}`}
        onChange={(event) => { setText(event.target.value); read(event.target.value, receiptLeft); }}
        data-bmq-unit-factor
      />
      <span className="d3-kho-sentence-unit">{right}</span>
      <button type="button" className={cn("d3-kho-swap", !receiptLeft && "is-flipped")} onClick={swap}
        aria-label={`Đảo chiều: nhập 1 ${right} bằng bao nhiêu ${left}`} title="Đảo chiều" data-bmq-unit-swap>
        <ArrowLeftRight aria-hidden="true" />
      </button>
    </div>
  );
}

/** Stock impact of a factor before saving: one line per receipt already in the ledger. */
function PreviewNote({ preview, pending, error, stockUnit, posted }: {
  preview: KhoConversionPreview | undefined; pending: boolean; error: unknown; stockUnit: string; posted: number;
}) {
  if (posted === 0) return <p className="d3-kho-impact is-quiet" data-bmq-unit-impact="none">Chưa có phiếu nào của đơn vị này vào sổ tồn, nên tồn không đổi. Phiếu sau sẽ nhân theo số mới.</p>;
  if (error) return <p className="d3-kho-error">Chưa xem trước được: {khoErrorText(error)}</p>;
  if (!preview) return <p className="d3-kho-impact is-quiet">{pending ? "Đang tính tồn sẽ đổi…" : "Gõ số để xem tồn sẽ đổi bao nhiêu."}</p>;
  const parts = (["tan_tao", "q7"] as const)
    .filter((loc) => Math.abs(preview.total_delta[loc]) >= 0.0005)
    .map((loc) => `Kho ${KHO_LABEL[loc]} ${preview.total_delta[loc] > 0 ? "+" : "−"}${fmtAmount(Math.abs(preview.total_delta[loc]), stockUnit)}`);
  return (
    <div className={cn("d3-kho-impact", pending && "is-stale")} aria-live="polite" data-bmq-unit-impact={parts.length ? "change" : "same"}>
      <b>{parts.length ? `Tồn sẽ đổi: ${parts.join(" · ")}` : "Tồn không đổi"}</b>
      {preview.lines.length ? (
        <ul>
          {preview.lines.slice(0, 4).map((line) => (
            <li key={`${line.receipt_number}-${line.receipt_date}`}>
              <span>{line.receipt_number}</span>
              <span>{fmtAmount(line.posted_qty, stockUnit)} → {fmtAmount(line.new_qty, stockUnit)}</span>
            </li>
          ))}
          {preview.lines.length > 4 ? <li className="is-more">và {preview.lines.length - 4} phiếu nữa</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

/** One delivery-note unit of the item: its sentence, its evidence, and an editor that opens in place. */
function ConversionRow({ itemId, group, stockUnit, canEdit, lines, linesLoading, linesError, onSaved }: {
  itemId: string; group: KhoConversionGroup; stockUnit: string; canEdit: boolean;
  lines: ReceiptLine[] | undefined; linesLoading: boolean; linesError: unknown; onSaved: (text: string) => void;
}) {
  const current = group.factors.length === 1 ? group.factors[0] : null;
  const [open, setOpen] = useState(false);
  const [factor, setFactor] = useState<number | null>(current);
  const [requestId, setRequestId] = useState(newRequestId);
  const [flash, setFlash] = useState(false);
  const preview = useKhoConversionPreview();
  const save = useSetKhoItemConversion();
  const changed = factor !== null && (current === null || Math.abs(factor - current) > 1e-9);

  // Preview the stock impact a moment after the number settles.
  useEffect(() => {
    if (!open || factor === null || group.posted_count === 0) return;
    const id = window.setTimeout(() => preview.mutate({ itemId, unit: group.unit, factor }), 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, factor, itemId, group.unit, group.posted_count]);

  const sentence = current !== null ? conversionSentence(group.unit, current, stockUnit) : null;
  const evidence = linesIn(lines, group.unit);
  const submit = () => {
    if (factor === null) return;
    save.mutate(
      { itemId, unit: group.unit, factor, requestId },
      {
        onSuccess: (result) => {
          const moved = (["tan_tao", "q7"] as const).filter((loc) => Math.abs(result.total_delta[loc]) >= 0.0005)
            .map((loc) => `Kho ${KHO_LABEL[loc]} ${result.total_delta[loc] > 0 ? "+" : "−"}${fmtAmount(Math.abs(result.total_delta[loc]), stockUnit)}`);
          onSaved(`Đã lưu ${conversionSentence(group.unit, factor, stockUnit)}${moved.length ? ` · tồn ${moved.join(", ")}` : ""}`);
          setOpen(false);
          setRequestId(newRequestId());
          setFlash(true);
          window.setTimeout(() => setFlash(false), 900);
        },
      },
    );
  };

  return (
    <li className={cn("d3-kho-conv-row", open && "is-open", flash && "is-saved", group.disagree && !group.auto && "is-warn")} data-bmq-conversion={group.unit}>
      <div className="d3-kho-conv-head">
        <div className="d3-kho-conv-main">
          <b>{group.auto ? `${group.unit} tự đổi sang ${stockUnit}` : sentence ?? `1 ${group.unit} = ? ${stockUnit}`}</b>
          <small>
            <span>{group.alias_count} tên trên phiếu</span>
            <span>{group.line_count} dòng phiếu</span>
            {group.posted_count ? <span>{group.posted_count} đã vào sổ</span> : null}
            {group.supplier_names[0] ? <span>{group.supplier_names.join(", ")}</span> : null}
          </small>
          {group.disagree && !group.auto ? (
            <p className="d3-kho-conv-warn" data-bmq-conversion-disagree>
              <AlertTriangle aria-hidden="true" />
              Đang có {group.factors.length} cách quy đổi khác nhau: {group.factors.map((f) => conversionSentence(group.unit, f, stockUnit)).join(" · ")}. Chọn một số đúng cho mọi phiếu.
            </p>
          ) : null}
        </div>
        {group.auto ? <span className="d3-kho-tag">Tự đổi</span>
          : canEdit && !open ? <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-bmq-conversion-edit>Sửa</Button> : null}
      </div>
      <div className="d3-kho-reveal" aria-hidden={!open}>
        <div className="d3-kho-reveal-inner">
          {open ? (
            <div className="d3-kho-conv-editor">
              <SentenceEditor receiptUnit={group.unit} stockUnit={stockUnit} factor={current} onFactor={setFactor} autoFocus />
              <PreviewNote preview={changed ? preview.data : undefined} pending={preview.isPending} error={changed ? preview.error : null}
                stockUnit={stockUnit} posted={group.posted_count} />
              <ReceiptNotes title={evidence.matched ? `Phiếu giao ghi “${group.unit}”` : "Phiếu giao của món này"} lines={evidence.lines} loading={linesLoading} error={linesError} />
              {save.error ? <p className="d3-kho-error">{khoErrorText(save.error)}</p> : null}
              <div className="d3-kho-actions">
                <Button disabled={!changed || save.isPending} onClick={submit} data-bmq-conversion-save>{save.isPending ? "Đang lưu…" : "Lưu quy đổi"}</Button>
                <Button variant="ghost" onClick={() => { setOpen(false); setFactor(current); preview.reset(); }}>Hủy</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** A conversion for a unit no supplier has written yet ("nhà cung cấp mới giao theo thùng"). */
function NewConversion({ itemId, stockUnit, units, taken, onSaved }: {
  itemId: string; stockUnit: string; units: KhoUnit[]; taken: string[]; onSaved: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState("");
  const [factor, setFactor] = useState<number | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const save = useSetKhoItemConversion();
  // Delivery notes also write kg and lít; a count item converts those by a factor too.
  const pool: KhoUnit[] = [...units, { code: "kg", label: "kg", kind: "weight", base_code: "g", to_base: 1000 }, { code: "l", label: "lít", kind: "volume", base_code: "ml", to_base: 1000 }];
  const options = pool
    .filter((u) => !same(u.code, stockUnit) && !taken.some((t) => same(t, u.code)) && standardUnitFactor(u.code, stockUnit) === null)
    .map((u) => ({ value: u.code, label: u.label }));
  const submit = () => {
    if (!unit || factor === null) return;
    save.mutate({ itemId, unit, factor, requestId }, {
      onSuccess: () => {
        onSaved(`Đã lưu ${conversionSentence(unit, factor, stockUnit)}`);
        setOpen(false); setUnit(""); setFactor(null); setRequestId(newRequestId());
      },
    });
  };
  return (
    <li className={cn("d3-kho-conv-row is-add", open && "is-open")} data-bmq-conversion-new>
      {!open ? (
        <button type="button" className="d3-kho-addrow" onClick={() => setOpen(true)} data-bmq-conversion-add>
          <Plus aria-hidden="true" />Thêm quy đổi
          <small>khi nhà cung cấp giao theo đơn vị khác (thùng, bao, kg…)</small>
        </button>
      ) : null}
      <div className="d3-kho-reveal" aria-hidden={!open}>
        <div className="d3-kho-reveal-inner">
          {open ? (
            <div className="d3-kho-conv-editor">
              <div className="d3-kho-field">
                <span>Phiếu giao ghi đơn vị</span>
                <OptionPicker value={unit} onChange={setUnit} options={options} title="Đơn vị trên phiếu" ariaLabel="Đơn vị trên phiếu" placeholder="Chọn đơn vị…" dataAttrs={{ "bmq-conversion-unit": "" }} />
              </div>
              {unit ? <SentenceEditor key={unit} receiptUnit={unit} stockUnit={stockUnit} factor={null} onFactor={setFactor} /> : null}
              {save.error ? <p className="d3-kho-error">{khoErrorText(save.error)}</p> : null}
              <div className="d3-kho-actions">
                <Button disabled={!unit || factor === null || save.isPending} onClick={submit} data-bmq-conversion-add-save>{save.isPending ? "Đang lưu…" : "Lưu quy đổi"}</Button>
                <Button variant="ghost" onClick={() => { setOpen(false); setUnit(""); setFactor(null); }}>Hủy</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** The item's unit: every unit in the catalogue as a chip, plus a chip that turns into a field for a new one. */
function UnitPicker({ item, units, unitsLoading, onDone, onToast, lines, linesLoading, linesError }: {
  item: KhoItem; units: KhoUnit[]; unitsLoading: boolean; onDone: (text: string, newId: string | null) => void; onToast: (text: string) => void;
  lines: ReceiptLine[] | undefined; linesLoading: boolean; linesError: unknown;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [factor, setFactor] = useState<number | null>(null);
  const [requestId, setRequestId] = useState(newRequestId);
  const [addId, setAddId] = useState(newRequestId);
  const add = useAddKhoUnit();
  const save = useKhoSaveItem();
  const inputRef = useRef<HTMLInputElement>(null);
  const measure = units.filter((u) => u.kind !== "count");
  const count = units.filter((u) => u.kind === "count");
  const standard = target ? standardUnitFactor(item.unit, target) : null;
  const ready = target !== null && !same(target, item.unit) && (standard !== null || factor !== null);
  const book = item.qty[item.in_q7 ? "q7" : "tan_tao"];
  const after = (f: number) => (book === null ? null : book * f);

  const pick = (code: string) => {
    if (same(code, item.unit)) { setTarget(null); return; }
    setTarget(code);
    setFactor(null);
    setRequestId(newRequestId());
    save.reset();
  };
  const createUnit = () => {
    const clean = label.trim();
    if (!clean) return;
    add.mutate({ label: clean, requestId: addId }, {
      onSuccess: (result) => {
        setFresh(result.unit);
        setAdding(false);
        setLabel("");
        setAddId(newRequestId());
        onToast(result.status === "created" ? `Đã thêm đơn vị “${result.unit}”` : `Đơn vị “${result.unit}” đã có sẵn`);
        pick(result.unit);
      },
    });
  };
  const submit = () => {
    if (!target) return;
    const unitFactor = standard ?? factor;
    save.mutate(
      { itemId: item.id, name: item.name, unit: target, active: item.active, unitFactor, requestId },
      {
        onSuccess: (result) => {
          if (result.status === "saved") {
            setTarget(null);
            setFactor(null);
            setRequestId(newRequestId());
            onDone(`Đã đổi “${item.name}” sang ${result.item.unit}`, result.item.id !== item.id ? result.item.id : null);
          } else if (result.status === "unit_factor_needed") {
            setFactor(null);
            setRequestId(newRequestId());
          } else {
            onDone("Đã lưu", null);
          }
        },
      },
    );
  };
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

  const chip = (u: KhoUnit) => {
    const on = target ? same(u.code, target) : same(u.code, item.unit);
    return (
      <button key={u.code} type="button" role="radio" aria-checked={on}
        className={cn("d3-kho-chip", on && "is-on", same(u.code, item.unit) && "is-current", fresh && same(u.code, fresh) && "is-new")}
        onClick={() => pick(u.code)} data-bmq-unit-chip={u.code}>
        {u.label}
      </button>
    );
  };

  return (
    <section className="d3-kho-unitsec" aria-labelledby="kho-unit-title">
      <div className="d3-kho-sec-h">
        <h3 id="kho-unit-title">Đơn vị kho</h3>
        <small>Đơn vị dùng để đếm và ghi sổ tồn</small>
      </div>
      {unitsLoading ? <div className="d3-kho-chips" aria-hidden="true">{Array.from({ length: 8 }).map((_, i) => <span key={i} className="d3-kho-chip is-ghost" />)}</div> : (
        <div className="d3-kho-chipgroups" role="radiogroup" aria-label="Đơn vị kho" data-bmq-unit-chips>
          <div className="d3-kho-chips"><span className="d3-kho-chips-label">Cân, đong</span>{measure.map(chip)}</div>
          <div className="d3-kho-chips">
            <span className="d3-kho-chips-label">Đếm</span>
            {count.map(chip)}
            {adding ? (
              <span className="d3-kho-chip-new" data-bmq-unit-new-field>
                <input ref={inputRef} value={label} onChange={(event) => setLabel(event.target.value)} maxLength={16} placeholder="vd: khay"
                  aria-label="Tên đơn vị mới" onKeyDown={(event) => { if (event.key === "Enter") createUnit(); if (event.key === "Escape") setAdding(false); }} />
                <button type="button" onClick={createUnit} disabled={!label.trim() || add.isPending} aria-label="Thêm đơn vị" data-bmq-unit-new-save><Check /></button>
                <button type="button" onClick={() => { setAdding(false); setLabel(""); add.reset(); }} aria-label="Thôi"><X /></button>
              </span>
            ) : (
              <button type="button" className="d3-kho-chip is-add" onClick={() => setAdding(true)} data-bmq-unit-new><Plus aria-hidden="true" />Đơn vị mới</button>
            )}
          </div>
        </div>
      )}
      {add.error ? <p className="d3-kho-error">{khoErrorText(add.error)}</p> : null}
      <div className="d3-kho-reveal" aria-hidden={target === null}>
        <div className="d3-kho-reveal-inner">
          {target ? (
            <div className="d3-kho-conv-editor" data-bmq-unit-change={target}>
              <p className="d3-kho-change-title">Đổi <b>{item.unit}</b> → <b>{target}</b></p>
              {standard !== null ? (
                <p className="d3-kho-impact is-quiet">Máy tự đổi theo chuẩn: 1 {item.unit} = {fmtQty(standard)} {target}.</p>
              ) : (
                <>
                  <p className="d3-kho-impact is-quiet">Gõ quy đổi giữa hai đơn vị. Xem phiếu giao bên dưới để lấy số đúng.</p>
                  <SentenceEditor key={target} receiptUnit={item.unit} stockUnit={target} factor={null} onFactor={setFactor}
                    stockFirst={measureUnit(item.unit) && !measureUnit(target)} />
                </>
              )}
              {ready && book !== null ? (
                <p className="d3-kho-impact" data-bmq-unit-after>
                  <b>Tồn sau khi đổi: {fmtAmount(after(standard ?? factor ?? 1), target)}</b>
                  <span>đang là {fmtAmount(book, item.unit)}</span>
                </p>
              ) : null}
              {standard === null ? <ReceiptNotes title="Phiếu giao của món này" lines={lines} loading={linesLoading} error={linesError} /> : null}
              {save.error ? <p className="d3-kho-error">{khoErrorText(save.error)}</p> : null}
              <div className="d3-kho-actions">
                <Button disabled={!ready || save.isPending} onClick={submit} data-bmq-unit-save>{save.isPending ? "Đang đổi…" : `Đổi sang ${target}`}</Button>
                <Button variant="ghost" onClick={() => { setTarget(null); setFactor(null); }}>Hủy</Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The unit and conversion part of an item's detail dialog (owner 22/10: "quy đổi và bật tắt nằm trong màn
 * chi tiết"). View-only accounts see the unit and the conversions without any control.
 */
export function UnitAndConversions({ item, canEdit, lines, linesLoading, linesError, onToast, onReplaced }: {
  item: KhoItem; canEdit: boolean; lines: ReceiptLine[] | undefined; linesLoading: boolean; linesError: unknown;
  onToast: (text: string) => void; onReplaced: (newId: string) => void;
}) {
  const units = useKhoUnits();
  const conversions = useKhoItemConversions(item.id);
  const data = conversions.data;
  const stockUnit = item.unit;
  // A delivery note written in the stock unit itself at factor 1 is no conversion.
  const groups = useMemo(() => (data?.conversions ?? []).filter((g) => !(same(g.unit, stockUnit) && g.factors.every((f) => f === 1))), [data, stockUnit]);
  const savedOnly = useMemo(() => (data?.saved ?? []).filter((s) => !groups.some((g) => same(g.unit, s.unit)) && !same(s.unit, stockUnit)), [data, groups, stockUnit]);
  const editable = canEdit && (data?.can_edit ?? true);

  return (
    <>
      {editable ? (
        <UnitPicker item={item} units={units.data ?? []} unitsLoading={units.isLoading} onToast={onToast}
          lines={lines} linesLoading={linesLoading} linesError={linesError}
          onDone={(text, newId) => { onToast(text); if (newId) onReplaced(newId); }} />
      ) : (
        <section className="d3-kho-unitsec">
          <div className="d3-kho-sec-h"><h3>Đơn vị kho</h3><small>Đếm và ghi sổ tồn theo <b>{item.unit}</b></small></div>
        </section>
      )}
      {editable && units.error ? <p className="d3-kho-error">Chưa tải được danh sách đơn vị. {khoErrorText(units.error)}</p> : null}

      <section className="d3-kho-convsec" aria-labelledby={`kho-conv-${item.id}`}>
        <div className="d3-kho-sec-h">
          <h3 id={`kho-conv-${item.id}`}>Quy đổi trên phiếu giao</h3>
          <small>Phiếu ghi đơn vị khác thì máy nhân theo số này khi nhập kho</small>
        </div>
        {conversions.isLoading ? (
          <ul className="d3-kho-conv-list" aria-hidden="true">{[0, 1].map((i) => <li key={i} className="d3-kho-conv-row is-ghost"><span className="d3-kho-bar" /><span className="d3-kho-bar is-short" /></li>)}</ul>
        ) : conversions.isError ? (
          <div className="d3-kho-failed" role="alert"><p>Không tải được quy đổi. {khoErrorText(conversions.error)}</p><Button variant="outline" onClick={() => void conversions.refetch()}>Thử lại</Button></div>
        ) : (
          <ul className="d3-kho-conv-list" data-bmq-conversions>
            {groups.map((group) => (
              <ConversionRow key={group.unit} itemId={item.id} group={group} stockUnit={stockUnit} canEdit={editable}
                lines={lines} linesLoading={linesLoading} linesError={linesError} onSaved={onToast} />
            ))}
            {savedOnly.map((s) => (
              <li key={`saved-${s.unit}`} className="d3-kho-conv-row" data-bmq-conversion-saved={s.unit}>
                <div className="d3-kho-conv-head">
                  <div className="d3-kho-conv-main">
                    <b>{conversionSentence(s.unit, s.factor, stockUnit)}</b>
                    <small><span>Chưa có phiếu nào ghi {s.unit}</span></small>
                  </div>
                </div>
              </li>
            ))}
            {!groups.length && !savedOnly.length ? (
              <li className="d3-kho-conv-empty">Phiếu giao của món này đều ghi đúng đơn vị {stockUnit}, chưa cần quy đổi.</li>
            ) : null}
            {editable ? (
              <NewConversion itemId={item.id} stockUnit={stockUnit} units={units.data ?? []}
                taken={[...groups.map((g) => g.unit), ...savedOnly.map((s) => s.unit)]} onSaved={onToast} />
            ) : null}
          </ul>
        )}
      </section>
    </>
  );
}
