import { useMemo, useState } from "react";
import { useCreateQ7FinishedGoodsIssue, useCreateQ7FinishedGoodsReceipt, useQ7FinishedGoodsPlanned } from "@/hooks/useWarehouseGame";
import type { Q7FinishedGoodsLine, WarehouseGameSnapshot } from "@/lib/warehouse-game";
import { Sheet } from "./Sheet";
import { fmtQty, newRequestId, normalizeName } from "./meta";

type Sku = WarehouseGameSnapshot["skus"][number];
export type FinishedGoodsMode = "in" | "out";

const vnToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const parseQty = (text: string) => {
  const value = Number(text.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : NaN;
};

/** Map the RPC error codes (message or details) onto short Vietnamese text. */
export function finishedGoodsErrorText(error: unknown): string | null {
  if (!error) return null;
  const raw = error as { message?: string; details?: string };
  const text = `${raw.message ?? ""} ${raw.details ?? ""}`;
  if (text.includes("finished_goods_insufficient")) {
    const detail = /finished_goods_insufficient:\s*([^\n]+)/.exec(raw.message ?? "");
    return detail ? `Không đủ tồn: ${detail[1].trim()}` : "Không đủ tồn để xuất.";
  }
  if (text.includes("finished_goods_forbidden")) return "Tài khoản chưa có quyền nhập/xuất thành phẩm Q7.";
  if (text.includes("too_many_lines")) return "Một phiếu tối đa 30 dòng.";
  if (text.includes("date_invalid")) return "Ngày phiếu không được ở tương lai.";
  if (text.includes("production_order_item_invalid")) return "Dòng lệnh sản xuất không còn khớp. Đóng phiếu rồi mở lại.";
  return "Chưa lưu được phiếu. Thử lại sau ít phút.";
}

interface Row { skuId: string; qty: string; orderItemId: string | null }

/**
 * Phiếu nhập / xuất thành phẩm Q7 (owner 16/10): Q7 bakes some SKUs itself, so its
 * finished goods come in from the day's production plan and leave on delivery or write-off.
 */
export function FinishedGoodsSheet({ mode: initialMode, skus, canEdit, prefillSkuId, onDone, onClose }: {
  mode: FinishedGoodsMode; skus: Sku[]; canEdit: boolean; prefillSkuId?: string | null;
  onDone: (message: string) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState<FinishedGoodsMode>(initialMode);
  const today = useMemo(vnToday, []);
  const planned = useQ7FinishedGoodsPlanned(today);
  const receipt = useCreateQ7FinishedGoodsReceipt();
  const issue = useCreateQ7FinishedGoodsIssue();
  const [extra, setExtra] = useState<Row[]>(() => (prefillSkuId ? [{ skuId: prefillSkuId, qty: "", orderItemId: null }] : []));
  const [planQty, setPlanQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<"dispatch" | "write_off">("dispatch");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);

  const byId = useMemo(() => new Map(skus.map((sku) => [sku.id, sku])), [skus]);

  // Today's plan, one row per SKU; the receipt points at the SKU's first plan line.
  const planRows = useMemo(() => {
    const grouped = new Map<string, { skuId: string; name: string; unit: string; planned: number; received: number; orderItemId: string }>();
    for (const line of planned.data ?? []) {
      const row = grouped.get(line.sku_id);
      if (row) { row.planned += Number(line.planned_qty) || 0; row.received += Number(line.already_received) || 0; continue; }
      grouped.set(line.sku_id, {
        skuId: line.sku_id, name: line.product_name, unit: byId.get(line.sku_id)?.unit ?? line.unit,
        planned: Number(line.planned_qty) || 0, received: Number(line.already_received) || 0, orderItemId: line.production_order_item_id,
      });
    }
    return [...grouped.values()];
  }, [planned.data, byId]);

  const switchMode = (next: FinishedGoodsMode) => {
    if (next === mode) return;
    setMode(next); setExtra([]); setPlanQty({}); setQuery(""); receipt.reset(); issue.reset(); setRequestId(newRequestId());
  };

  const inPlan = new Set(mode === "in" ? planRows.map((row) => row.skuId) : []);
  // A prefilled SKU that is already on today's plan uses the plan row instead.
  const extraRows = extra.filter((row) => !inPlan.has(row.skuId));
  const picked = new Set(extraRows.map((row) => row.skuId));
  const needle = normalizeName(query);
  const candidates = skus
    .filter((sku) => !picked.has(sku.id) && !inPlan.has(sku.id) && (mode === "in" || sku.on_hand > 0))
    .filter((sku) => !needle || normalizeName(sku.product_name).includes(needle) || normalizeName(sku.sku_code).includes(needle))
    .slice(0, needle ? 12 : 6);

  const extraChecked = extraRows.map((row) => {
    const sku = byId.get(row.skuId);
    const qty = parseQty(row.qty);
    const problem = !sku ? "Mã không còn ở Q7"
      : !row.qty.trim() ? null
      : !(qty > 0) ? "Số lượng phải lớn hơn 0"
      : mode === "out" && qty > sku.on_hand ? `Chỉ còn ${fmtQty(sku.on_hand)} ${sku.unit}`
      : null;
    return { row, sku, qty, problem };
  });
  const planChecked = mode === "in" ? planRows.map((row) => {
    const text = planQty[row.skuId] ?? "";
    const qty = parseQty(text);
    const problem = !text.trim() ? null : !(qty > 0) ? "Số lượng phải lớn hơn 0" : null;
    return { row, text, qty, problem };
  }) : [];

  const lines: Q7FinishedGoodsLine[] = [
    ...planChecked.filter((entry) => entry.text.trim() && entry.qty > 0).map((entry) => ({ sku_id: entry.row.skuId, quantity: entry.qty, production_order_item_id: entry.row.orderItemId })),
    ...extraChecked.filter((entry) => entry.qty > 0).map((entry) => ({ sku_id: entry.row.skuId, quantity: entry.qty, production_order_item_id: null })),
  ];
  const pending = receipt.isPending || issue.isPending;
  const bad = planChecked.some((entry) => entry.problem) || extraChecked.some((entry) => entry.problem || !entry.sku || !(entry.qty > 0));
  const ready = canEdit && lines.length > 0 && lines.length <= 30 && !bad && !pending;
  const error = finishedGoodsErrorText(mode === "in" ? receipt.error : issue.error);

  const setExtraQty = (skuId: string, qty: string) => setExtra((prev) => prev.map((row) => (row.skuId === skuId ? { ...row, qty } : row)));
  const add = (skuId: string) => { setExtra((prev) => [...prev, { skuId, qty: "", orderItemId: null }]); setQuery(""); };
  const remove = (skuId: string) => setExtra((prev) => prev.filter((row) => row.skuId !== skuId));
  const fillPlan = () => setPlanQty(Object.fromEntries(planRows.map((row) => [row.skuId, String(Math.max(row.planned - row.received, 0) || "")])));

  const submit = () => {
    const finish = (slip: string, count: number) => {
      setExtra([]); setPlanQty({}); setNote(""); setRequestId(newRequestId());
      onDone(mode === "in" ? `🥖 ${slip} · đã nhập ${count} món vào Q7` : `📦 ${slip} · đã ${reason === "dispatch" ? "xuất" : "hủy"} ${count} món`);
      onClose();
    };
    if (mode === "in") {
      receipt.mutate({ lines, note: note.trim() || null, requestId }, { onSuccess: (result) => finish(result.slip_number, result.lines.length) });
    } else {
      issue.mutate({ lines, reason, note: note.trim() || null, requestId }, { onSuccess: (result) => finish(result.slip_number, result.lines.length) });
    }
  };

  const title = mode === "in" ? "Nhập thành phẩm" : "Xuất thành phẩm";
  const sub = mode === "in" ? "Bánh làm xong ở Q7 → cộng vào kệ Thành phẩm" : "Trừ khỏi kệ Thành phẩm Q7";

  return (
    <Sheet title={title} tag="🥖 Thành phẩm Q7" sub={sub} onClose={onClose}>
      <div className="slip" data-bmq-fg-slip={mode}>
        <div className="seg" role="tablist" aria-label="Loại phiếu">
          <button type="button" role="tab" aria-selected={mode === "in"} className={mode === "in" ? "is-on" : undefined} onClick={() => switchMode("in")} data-bmq-fg-mode="in">⬇ Nhập</button>
          <button type="button" role="tab" aria-selected={mode === "out"} className={mode === "out" ? "is-on" : undefined} onClick={() => switchMode("out")} data-bmq-fg-mode="out">⬆ Xuất</button>
        </div>
        {!canEdit ? <div className="warn">Tài khoản chỉ được xem. Cần quyền kho để lập phiếu.</div> : null}

        {mode === "out" ? (
          <div className="seg" role="radiogroup" aria-label="Lý do xuất">
            <button type="button" role="radio" aria-checked={reason === "dispatch"} className={reason === "dispatch" ? "is-on" : undefined} onClick={() => setReason("dispatch")} data-bmq-fg-reason="dispatch">🚚 Giao hàng</button>
            <button type="button" role="radio" aria-checked={reason === "write_off"} className={reason === "write_off" ? "is-on" : undefined} onClick={() => setReason("write_off")} data-bmq-fg-reason="write_off">🗑 Hủy / hỏng</button>
          </div>
        ) : null}

        {mode === "in" ? (
          planned.isLoading ? <p className="note">Đang tải kế hoạch sản xuất hôm nay…</p>
          : planned.error ? <div className="err">Chưa tải được kế hoạch sản xuất. Vẫn có thể thêm món bên dưới.</div>
          : planRows.length ? (
            <>
              <div className="fg-plan-head">
                <b>Kế hoạch hôm nay · {planRows.length} món</b>
                <button type="button" className="btn ghost" onClick={fillPlan} disabled={!canEdit} data-bmq-fg-fill>Điền theo kế hoạch</button>
              </div>
              <ul className="slip-lines">
                {planChecked.map(({ row, text, problem }, index) => (
                  <li key={row.skuId} className={problem ? "is-bad" : undefined} data-bmq-fg-plan-line>
                    <span className="slip-no">{index + 1}</span>
                    <span className="slip-name"><b>{row.name}</b><small>Kế hoạch {fmtQty(row.planned)} · đã nhập {fmtQty(row.received)} {row.unit}</small></span>
                    <label className="slip-qty">
                      <input inputMode="decimal" value={text} placeholder="SL" aria-label={`Số làm ra ${row.name}`} disabled={!canEdit}
                        onChange={(event) => setPlanQty((prev) => ({ ...prev, [row.skuId]: event.target.value }))} />
                      <i>{row.unit}</i>
                    </label>
                    {problem ? <small className="slip-problem">{problem}</small> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="note">Hôm nay chưa có lệnh sản xuất Q7. Thêm món làm ra ở bên dưới.</p>
        ) : null}

        {extraRows.length ? (
          <ul className="slip-lines">
            {extraChecked.map(({ row, sku, problem }, index) => (
              <li key={row.skuId} className={problem ? "is-bad" : undefined} data-bmq-fg-line>
                <span className="slip-no">{(mode === "in" ? planRows.length : 0) + index + 1}</span>
                <span className="slip-name"><b>{sku?.product_name ?? "?"}</b><small>{sku ? `Tồn ${fmtQty(sku.on_hand)} ${sku.unit}${mode === "in" ? " · ngoài kế hoạch" : ""}` : ""}</small></span>
                <label className="slip-qty">
                  <input inputMode="decimal" value={row.qty} placeholder="SL" aria-label={`Số lượng ${sku?.product_name ?? ""}`} onChange={(event) => setExtraQty(row.skuId, event.target.value)} />
                  <i>{sku?.unit}</i>
                </label>
                <button type="button" className="slip-x" onClick={() => remove(row.skuId)} aria-label={`Bỏ ${sku?.product_name ?? "món"}`}>✕</button>
                {problem ? <small className="slip-problem">{problem}</small> : null}
              </li>
            ))}
          </ul>
        ) : mode === "out" ? <p className="note">Chọn món còn tồn để xuất.</p> : null}

        {canEdit && extraRows.length + planRows.length < 30 ? (
          <>
            <label className="field">
              {mode === "in" ? "Thêm món ngoài kế hoạch" : "Thêm món"}
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ tên: croissant, chà bông…" data-bmq-fg-search />
            </label>
            {candidates.length ? (
              <div className="picks slip-picks">
                {candidates.map((sku) => (
                  <button key={sku.id} type="button" className="pick" onClick={() => add(sku.id)} data-bmq-fg-pick={sku.product_name}>
                    <span><b>{sku.product_name}</b><small>tồn {fmtQty(sku.on_hand)} {sku.unit}</small></span>
                    <span className="pick-go">＋</span>
                  </button>
                ))}
              </div>
            ) : needle ? <p className="note">{mode === "out" ? "Không thấy món còn tồn khớp tên này." : "Không thấy mã thành phẩm Q7 khớp tên này."}</p> : null}
          </>
        ) : null}

        <label className="field">
          Ghi chú (không bắt buộc)
          <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder={mode === "in" ? "vd: ca sáng" : reason === "dispatch" ? "vd: giao Kingfood" : "vd: cháy, rơi"} />
        </label>
        {error ? <div className="err" data-bmq-fg-error>{error}</div> : null}
        <div className="row slip-actions">
          <button type="button" className="btn" disabled={!ready} onClick={submit} data-bmq-fg-submit>
            {pending ? "Đang lưu…" : mode === "in" ? `⬇ Nhập ${lines.length || ""} món`.replace("  ", " ") : `${reason === "dispatch" ? "🚚 Xuất" : "🗑 Hủy"} ${lines.length || ""} món`.replace("  ", " ")}
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </Sheet>
  );
}
