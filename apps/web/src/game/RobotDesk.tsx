import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useQ7PurchaseForecast } from "@/hooks/usePurchaseForecast";
import { useCreateRobotOrderPackage, useItemPurchaseFacts, useRunDebtReview, useSupplierDebtCandidates } from "@/hooks/useRobotOrder";
import { rankDebtRows, robotOrderErrorCode, robotOrderErrorText, type ItemPurchaseFact, type RobotOrderDebtRef, type RobotOrderPackageResult, type SupplierDebtRow } from "@/lib/robot-order";
import type { WarehouseGameItem } from "@/lib/warehouse-game";
import { JevBot } from "./CrateYard";
import { fmtQty, newRequestId, normalizeName } from "./meta";

/** One line in the robot's basket. Quantities and prices stay text until sent. */
export interface BasketLine {
  key: string;
  item_id: string | null;
  name: string;
  unit: string;
  qty: string;
  supplier_id: string | null;
  price: string;
}

const BASKET_KEY = "bmq-robot-basket-v1";
export function loadBasket(): BasketLine[] {
  try { return JSON.parse(sessionStorage.getItem(BASKET_KEY) ?? "[]") as BasketLine[]; } catch { return []; }
}
export function saveBasket(lines: BasketLine[]) {
  try { sessionStorage.setItem(BASKET_KEY, JSON.stringify(lines)); } catch { /* private mode */ }
}
export const basketLineFor = (item: Pick<WarehouseGameItem, "id" | "name" | "unit">): BasketLine =>
  ({ key: newRequestId(), item_id: item.id, name: item.name, unit: item.unit, qty: "", supplier_id: null, price: "" });

const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const money = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${Math.round(value).toLocaleString("vi-VN")}đ`);
const num = (text: string) => { const v = Number(text.replace(/\s/g, "").replace(",", ".")); return Number.isFinite(v) ? v : NaN; };

/** Sent packages, newest first (RLS: any signed-in user may read). */
function useRobotPackages() {
  return useQuery({
    queryKey: ["robot-order-packages"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("robot_order_packages").select("id, supplier_id, result, note, created_at").order("created_at", { ascending: false }).limit(12);
      if (error) throw error;
      return (data ?? []) as { id: string; supplier_id: string; result: RobotOrderPackageResult | null; note: string | null; created_at: string }[];
    },
  });
}

const markLabel = (row: SupplierDebtRow) => {
  if (row.mark === "settled_outside") return row.mark_source === "learned" ? "đã chi ngoài hệ thống (học)" : row.mark_source === "manual" ? "đã chi ngoài hệ thống" : `Jev: có thể đã chi${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}`;
  if (row.mark === "real_debt") return row.mark_source === "jev" ? `Jev: nợ thật${row.probability != null ? ` ${Math.round(row.probability * 100)}%` : ""}` : "nợ thật";
  if (row.mark === "unsure") return "Jev: chưa rõ";
  return null;
};

/** The old-debt picker for one supplier: farthest first; rows before the learned cutover fold away. */
function DebtPicker({ supplierId, picked, onPick }: { supplierId: string; picked: RobotOrderDebtRef | null | "none"; onPick: (ref: RobotOrderDebtRef | "none") => void }) {
  const debts = useSupplierDebtCandidates(supplierId);
  const review = useRunDebtReview();
  const [showOld, setShowOld] = useState(false);
  const ranked = useMemo(() => rankDebtRows(debts.data?.rows ?? []), [debts.data]);
  const live = ranked.filter((row) => !row.collapsed);
  const folded = ranked.filter((row) => row.collapsed);
  const stats = debts.data?.stats;
  const cutover = debts.data?.cutover;
  const isPicked = (row: SupplierDebtRow) => picked !== "none" && picked?.kind === row.kind && picked.id === row.id;
  const rowButton = (row: SupplierDebtRow) => {
    const label = markLabel(row);
    const faded = row.mark === "settled_outside";
    return (
      <button key={`${row.kind}-${row.id}`} type="button" role="radio" aria-checked={isPicked(row)} className={`pick robot-debt${isPicked(row) ? " is-top" : ""}${faded ? " is-faded" : ""}`} onClick={() => onPick({ kind: row.kind, id: row.id })} data-bmq-robot-debt={row.number ?? row.id}>
        <span>
          <b>{row.kind === "pr" ? "Đề nghị chi" : "PO chưa có đề nghị chi"} {row.number}</b>
          <small>{dmy(row.doc_date)}{row.age_days != null ? ` · ${row.age_days} ngày` : ""}{row.po_number && row.kind === "pr" ? ` · ${row.po_number}` : ""}{row.has_receipt ? " · đã nhận hàng" : ""}{row.last_submission_number ? ` · đã trình ${row.last_submission_number}` : ""}</small>
          {label ? <small className={`robot-mark is-${row.mark}`}>{label}</small> : null}
        </span>
        <em>{money(row.remaining ?? row.amount)}</em>
      </button>
    );
  };
  return (
    <div className="robot-debt-box" data-bmq-robot-debts>
      <div className="robot-debt-head">
        <b>Đơn cũ cần trả để NCC giao</b>
        <small>{cutover ? `Mốc đã học: từ ${cutover.number ?? ""} (${dmy(cutover.start_date)})` : "Chưa có mốc · lựa chọn đầu tiên sẽ dạy hệ thống"}{stats?.paid_90d ? ` · 90 ngày chi ${stats.paid_90d} lần${stats.median_lag_days != null ? `, trung bình sau ${stats.median_lag_days} ngày` : ""}` : ""}</small>
      </div>
      {debts.isLoading ? <p className="note">Đang tìm phiếu cũ…</p> : null}
      {debts.error ? <div className="err">{robotOrderErrorText(robotOrderErrorCode(debts.error))}</div> : null}
      {debts.data ? (
        <div className="picks robot-picks" role="radiogroup" aria-label="Đơn cũ cần trả">
          <button type="button" role="radio" aria-checked={picked === "none"} className={`pick${picked === "none" ? " is-top" : ""}`} onClick={() => onPick("none")} data-bmq-robot-debt="none">
            <span><b>Không kèm đơn cũ</b><small>Chỉ tạo PO mới · chi khi nhận hàng như hiện nay</small></span>
          </button>
          {live.map(rowButton)}
          {live.length === 0 ? <p className="note">NCC này không còn phiếu nào chưa chi sau mốc.</p> : null}
          {folded.length ? (
            <button type="button" className="robot-fold" onClick={() => setShowOld((v) => !v)} data-bmq-robot-fold>
              {showOld ? "Ẩn" : "Xem"} {folded.length} phiếu trước mốc đã học
            </button>
          ) : null}
          {showOld ? folded.map(rowButton) : null}
        </div>
      ) : null}
      <div className="row">
        <button type="button" className="btn ghost jev-run" disabled={review.isPending || !debts.data?.rows.length} onClick={() => review.mutate(supplierId)} data-bmq-robot-jev>
          {review.isPending ? "Jev đang rà…" : "🤖 Jev rà phiếu cũ"}
        </button>
        {review.data ? <small className="robot-jev-note">Jev xem {review.data.evaluated}, đánh dấu {review.data.marked}{review.data.stopped === "quota" ? " · hết hạn mức hôm nay" : ""}</small> : null}
        {review.error ? <small className="robot-jev-note">Jev chưa chạy được</small> : null}
      </div>
    </div>
  );
}

/** One supplier's package: the lines going on a new PO plus the old debt to pay. */
function SupplierPackage({ supplierId, supplierName, lines, canDebt, onSent, onError }: {
  supplierId: string; supplierName: string; lines: BasketLine[]; canDebt: boolean;
  onSent: (result: RobotOrderPackageResult, keys: string[]) => void; onError: (text: string) => void;
}) {
  const create = useCreateRobotOrderPackage();
  const [debt, setDebt] = useState<RobotOrderDebtRef | "none" | null>(canDebt ? null : "none");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);
  const ready = lines.every((line) => num(line.qty) > 0 && num(line.price) >= 0);
  const total = lines.reduce((sum, line) => sum + (num(line.qty) > 0 ? num(line.qty) * (num(line.price) || 0) : 0), 0);
  const send = () => {
    if (!ready || debt === null) return;
    create.mutate(
      {
        lines: lines.map((line) => ({ supplier_id: supplierId, product_name: line.name, quantity: num(line.qty), unit: line.unit, unit_price: num(line.price) || 0, item_id: line.item_id })),
        debt: debt === "none" ? null : debt,
        note: note.trim() || null,
        idempotency_key: requestId,
      },
      {
        onSuccess: (result) => { setRequestId(newRequestId()); onSent(result, lines.map((line) => line.key)); },
        onError: (error) => onError(robotOrderErrorText(robotOrderErrorCode(error))),
      },
    );
  };
  return (
    <section className="robot-pack" data-bmq-robot-pack={supplierName}>
      <div className="robot-pack-head">
        <span><small>Gói cho NCC</small><b>{supplierName}</b></span>
        <em>{lines.length} món · {money(total)}</em>
      </div>
      <ul className="robot-pack-lines">
        {lines.map((line) => <li key={line.key}><span>{line.name}</span><em>{num(line.qty) > 0 ? `${fmtQty(num(line.qty))} ${line.unit}` : "? " + line.unit}{num(line.price) > 0 ? ` × ${money(num(line.price))}` : ""}</em></li>)}
      </ul>
      {canDebt ? <DebtPicker supplierId={supplierId} picked={debt} onPick={setDebt} /> : <p className="note">Bạn không có quyền trình chi, robot chỉ tạo PO mới.</p>}
      <label className="field"><span>Ghi chú cho Duyệt chi (không bắt buộc)</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="vd. hàng cần cho ca sáng mai" /></label>
      {create.error ? <div className="err">{robotOrderErrorText(robotOrderErrorCode(create.error))}</div> : null}
      <button type="button" className="btn submit is-ready robot-send" disabled={!ready || debt === null || create.isPending} onClick={send} data-bmq-robot-send>
        {create.isPending ? "Robot đang lập gói…" : debt === null ? "Chọn đơn cũ (hoặc Không kèm) trước" : !ready ? "Nhập đủ số lượng trước" : debt === "none" ? "🤖 Tạo PO mới" : "🤖 Tạo PO mới + trình chi đơn cũ"}
      </button>
    </section>
  );
}

function BasketRow({ line, fact, suppliers, onChange, onRemove }: {
  line: BasketLine; fact: ItemPurchaseFact | undefined; suppliers: { id: string; name: string }[];
  onChange: (next: BasketLine) => void; onRemove: () => void;
}) {
  const qtyBad = line.qty !== "" && !(num(line.qty) > 0);
  return (
    <li className={`robot-line${qtyBad ? " is-bad" : ""}`} data-bmq-robot-line={line.name}>
      <div className="robot-line-head">
        <span className="slip-name"><b>{line.name}</b><small>{fact?.last_date ? `Mua gần nhất ${dmy(fact.last_date)}${fact.last_supplier_name ? ` · ${fact.last_supplier_name}` : ""}${fact.last_unit_price != null ? ` · ${money(fact.last_unit_price)}/${fact.last_unit ?? line.unit}` : ""}` : "Chưa thấy lần mua nào"}</small></span>
        <button type="button" className="slip-x" onClick={onRemove} aria-label={`Bỏ ${line.name}`}>✕</button>
      </div>
      <div className="robot-line-fields">
        <label className="slip-qty"><input inputMode="decimal" value={line.qty} onChange={(event) => onChange({ ...line, qty: event.target.value })} placeholder={fact?.suggested_qty ? fmtQty(fact.suggested_qty) : "SL"} aria-label={`Số lượng ${line.name}`} data-bmq-robot-qty /><i>{line.unit}</i></label>
        <label className="slip-qty robot-price"><input inputMode="decimal" value={line.price} onChange={(event) => onChange({ ...line, price: event.target.value })} placeholder="đơn giá" aria-label={`Đơn giá ${line.name}`} /><i>đ</i></label>
        <select value={line.supplier_id ?? ""} onChange={(event) => onChange({ ...line, supplier_id: event.target.value || null })} aria-label={`NCC cho ${line.name}`} data-bmq-robot-supplier>
          <option value="">NCC?</option>
          {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
        </select>
      </div>
      {fact?.suggested_qty && line.qty === "" ? <button type="button" className="robot-suggest" onClick={() => onChange({ ...line, qty: fmtQty(fact.suggested_qty!) })}>Dùng gợi ý {fmtQty(fact.suggested_qty)} {line.unit}</button> : null}
    </li>
  );
}

/**
 * Bàn robot đặt hàng (owner 14/10, GĐ1 bán thủ công): staff drop low items into the basket, the robot
 * finds supplier + last price, groups a package per supplier, lists that supplier's old unpaid
 * documents farthest-first, and one tap makes the new PO + the Zalo "Duyệt chi" submission.
 */
export function RobotDesk({ items, basket, setBasket, canOrder, canDebt, onToast }: {
  items: WarehouseGameItem[]; basket: BasketLine[]; setBasket: (next: BasketLine[]) => void;
  canOrder: boolean; canDebt: boolean; onToast: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<RobotOrderPackageResult[]>([]);
  const suppliers = useSuppliers();
  const packages = useRobotPackages();
  const forecast = useQ7PurchaseForecast();
  const facts = useItemPurchaseFacts(basket.map((line) => line.item_id ?? "").filter(Boolean));
  const factById = useMemo(() => new Map((facts.data ?? []).map((fact) => [fact.item_id, fact])), [facts.data]);
  const supplierList = useMemo(() => (suppliers.data ?? []).map((s) => ({ id: s.id, name: s.name })).sort((a, b) => a.name.localeCompare(b.name, "vi")), [suppliers.data]);
  const supplierName = (id: string) => supplierList.find((s) => s.id === id)?.name ?? "NCC";

  // Facts fill the supplier and price the first time they arrive for a line.
  useEffect(() => {
    if (!facts.data) return;
    let changed = false;
    const next = basket.map((line) => {
      const fact = line.item_id ? factById.get(line.item_id) : undefined;
      if (!fact) return line;
      const patch: Partial<BasketLine> = {};
      if (!line.supplier_id && fact.last_supplier_id) patch.supplier_id = fact.last_supplier_id;
      if (line.price === "" && fact.last_unit_price != null) patch.price = String(Math.round(fact.last_unit_price));
      if (Object.keys(patch).length) { changed = true; return { ...line, ...patch }; }
      return line;
    });
    if (changed) setBasket(next);
  }, [facts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const inBasket = new Set(basket.map((line) => line.item_id));
  const needle = normalizeName(query);
  const picks = needle.length >= 2 ? items.filter((item) => !inBasket.has(item.id) && normalizeName(item.name).includes(needle)).slice(0, 8) : [];
  const low = (forecast.data?.items ?? []).filter((row) => row.suggested_qty > 0 && !inBasket.has(row.item_id)).sort((a, b) => b.suggested_qty - a.suggested_qty).slice(0, 8);
  const add = (item: Pick<WarehouseGameItem, "id" | "name" | "unit">, qty?: number, supplierId?: string | null, price?: number | null) => {
    setBasket([...basket, { ...basketLineFor(item), qty: qty ? fmtQty(qty) : "", supplier_id: supplierId ?? null, price: price != null ? String(Math.round(price)) : "" }]);
    setQuery("");
  };
  const update = (key: string, next: BasketLine) => setBasket(basket.map((line) => (line.key === key ? next : line)));
  const remove = (key: string) => setBasket(basket.filter((line) => line.key !== key));

  const groups = useMemo(() => {
    const map = new Map<string, BasketLine[]>();
    for (const line of basket) if (line.supplier_id) map.set(line.supplier_id, [...(map.get(line.supplier_id) ?? []), line]);
    return [...map.entries()];
  }, [basket]);
  const unassigned = basket.filter((line) => !line.supplier_id);

  const sentCount = (packages.data?.length ?? 0) + sent.length;
  const bubble = !canOrder
    ? "Bạn chỉ xem được. Người có quyền kho mới nhờ tôi đặt hàng."
    : basket.length === 0 ? "Kéo món sắp hết vào giỏ. Tôi tìm NCC, giá gần nhất và phiếu cũ cần trả để NCC giao."
    : unassigned.length ? `Còn ${unassigned.length} món chưa rõ NCC. Chọn NCC để tôi gom gói.`
    : `Đã gom ${groups.length} gói. Mỗi gói: PO mới + đơn cũ cần trả. Bấm gửi là lên Zalo Duyệt chi.`;

  return (
    <div className="shelf-view robot-desk" data-bmq-robot-desk>
      <div className="jev-stage robot-stage">
        <div className="jev-figure"><JevBot state={basket.length ? "working" : "idle"} size={104} /></div>
        <div className="jev-talk">
          <div className="jev-bubble"><small>Robot đặt hàng</small><p>{bubble}</p></div>
          <div className="jev-meter robot-meter">
            <div><small>Trong giỏ</small><b data-bmq-robot-count>{basket.length}</b></div>
            <div><small>Gói</small><b>{groups.length}</b></div>
            <div><small>Đã gửi</small><b>{sentCount}</b></div>
          </div>
        </div>
      </div>

      {canOrder ? (
        <section className="robot-add">
          <label className="field"><span>Thêm món vào giỏ</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ tên món kho…" aria-label="Tìm món kho" data-bmq-robot-search /></label>
          {picks.length ? (
            <div className="picks slip-picks">
              {picks.map((item) => <button key={item.id} type="button" className="pick" onClick={() => add(item)} data-bmq-robot-pick={item.name}><span><b>{item.name}</b><small>{item.unit}{item.on_hand > 0 ? ` · tồn ${fmtQty(item.on_hand)}` : ""}</small></span><em className="pick-go">＋</em></button>)}
            </div>
          ) : null}
          {low.length ? (
            <div className="robot-low">
              <small>Dự báo sắp hết (Q7, 14 ngày)</small>
              <div className="row">
                {low.map((row) => <button key={row.item_id} type="button" className="robot-chip" onClick={() => add({ id: row.item_id, name: row.item_name, unit: row.unit }, row.suggested_qty, row.supplier_id, row.last_unit_price)} data-bmq-robot-low={row.item_name}>＋ {row.item_name} <em>{fmtQty(row.suggested_qty)} {row.unit}</em></button>)}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {basket.length ? (
        <section className="robot-basket">
          <h3 className="robot-h">🧺 Giỏ của robot · {basket.length} món</h3>
          <ul className="slip-lines robot-lines">
            {basket.map((line) => <BasketRow key={line.key} line={line} fact={line.item_id ? factById.get(line.item_id) : undefined} suppliers={supplierList} onChange={(next) => update(line.key, next)} onRemove={() => remove(line.key)} />)}
          </ul>
          {basket.length ? <button type="button" className="btn ghost" onClick={() => setBasket([])}>Dọn giỏ</button> : null}
        </section>
      ) : null}

      {groups.map(([supplierId, lines]) => (
        <SupplierPackage
          key={supplierId}
          supplierId={supplierId}
          supplierName={supplierName(supplierId)}
          lines={lines}
          canDebt={canDebt}
          onSent={(result, keys) => {
            setSent((list) => [result, ...list]);
            setBasket(basket.filter((line) => !keys.includes(line.key)));
            onToast(`🤖 ${result.po_numbers.join(", ")} nháp${result.debt ? ` · trả ${result.debt.number} · đợt ${result.debt.submission_number ?? ""} đã lên Zalo` : ""}`);
          }}
          onError={onToast}
        />
      ))}

      {sent.length || packages.data?.length ? (
        <section className="robot-history">
          <h3 className="robot-h">📨 Gói đã gửi</h3>
          <ul className="slip-lines">
            {[...sent.map((result) => ({ id: result.package_id, result, created_at: null as string | null })), ...(packages.data ?? []).filter((row) => !sent.some((s) => s.package_id === row.id))].slice(0, 10).map((row) => (
              <li key={row.id}>
                <span className="slip-name">
                  <b>{row.result?.po_numbers?.join(", ") ?? "PO"}</b>
                  <small>{row.result?.debt ? `Trả ${row.result.debt.number}${row.result.debt.submission_number ? ` · đợt ${row.result.debt.submission_number}` : ""}` : "Không kèm đơn cũ"}{row.result?.marked_settled_outside_count ? ` · ${row.result.marked_settled_outside_count} phiếu cũ hơn đánh dấu đã chi ngoài` : ""}{row.created_at ? ` · ${dmy(row.created_at)}` : " · vừa gửi"}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
