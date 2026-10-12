import { useMemo, useState } from "react";
import { useCreateManualTransfer, useStockTransfers } from "@/hooks/useWarehouseGame";
import { manualTransferErrorText, type WarehouseGameItem, type WarehouseGameTransfer } from "@/lib/warehouse-game";
import { Sheet } from "./Sheet";
import { fmtQty, newRequestId, normalizeName } from "./meta";

const dmy = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");
const parseQty = (text: string) => {
  const value = Number(text.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : NaN;
};

interface Line { id: string; qty: string }

/** Supabase errors carry the RPC code in message / details; map either onto Vietnamese. */
const transferError = (error: unknown) => {
  if (!error) return null;
  const raw = error as { message?: string; details?: string };
  return manualTransferErrorText(`${raw.message ?? ""} ${raw.details ?? ""}`);
};

/** One history row: a manual slip line or an automatic pastry transfer. */
function HistoryRow({ row }: { row: WarehouseGameTransfer }) {
  const manual = row.source === "manual";
  return (
    <li className={manual ? "is-manual" : undefined}>
      <span>
        <b>{row.item_name}</b>
        <small>
          {manual ? `Phiếu ${row.slip_number ?? row.transfer_number}` : `Tự động${row.receipt_number ? ` · từ ${row.receipt_number}` : ""}`} · {dmy(row.transfer_date)}
          {manual && row.note ? ` · ${row.note}` : ""}
        </small>
      </span>
      <em>+{fmtQty(row.quantity)} {row.unit}</em>
    </li>
  );
}

/**
 * "Phiếu chuyển kho" (owner 12/10): staff move any Tân Tạo item to Q7 on a slip.
 * Pastry items still move by themselves; supplies (băng keo, hộp…) go on a manual slip.
 */
export function TransferSheet({ items, ttStarted, q7Started, canTransfer, prefillId, onDone, onClose }: {
  items: WarehouseGameItem[]; ttStarted: boolean; q7Started: boolean; canTransfer: boolean;
  prefillId?: string | null; onDone: (message: string) => void; onClose: () => void;
}) {
  const history = useStockTransfers(40);
  const create = useCreateManualTransfer();
  const started = ttStarted && q7Started;
  const [mode, setMode] = useState<"list" | "new">(prefillId && canTransfer ? "new" : "list");
  const [lines, setLines] = useState<Line[]>(prefillId ? [{ id: prefillId, qty: "" }] : []);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState(newRequestId);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const picked = new Set(lines.map((line) => line.id));
  const needle = normalizeName(query);
  const candidates = items
    .filter((item) => !picked.has(item.id) && item.on_hand > 0)
    .filter((item) => needle && (normalizeName(item.name).includes(needle) || normalizeName(item.code).includes(needle)))
    .slice(0, 12);

  const checked = lines.map((line) => {
    const item = byId.get(line.id);
    const qty = parseQty(line.qty);
    const problem = !item ? "Món không còn trong kho"
      : !line.qty.trim() ? null
      : !(qty > 0) ? "Số lượng phải lớn hơn 0"
      : qty > item.on_hand ? `Chỉ còn ${fmtQty(item.on_hand)} ${item.unit}`
      : null;
    return { line, item, qty, problem };
  });
  const ready = started && canTransfer && lines.length > 0 && lines.length <= 30
    && checked.every((row) => row.item && row.qty > 0 && !row.problem) && !create.isPending;

  const setQty = (id: string, qty: string) => setLines((prev) => prev.map((line) => (line.id === id ? { ...line, qty } : line)));
  const add = (id: string) => { setLines((prev) => [...prev, { id, qty: "" }]); setQuery(""); };
  const remove = (id: string) => setLines((prev) => prev.filter((line) => line.id !== id));

  const submit = () => {
    create.mutate(
      { lines: checked.map((row) => ({ itemId: row.line.id, quantity: row.qty })), note: note.trim() || null, requestId },
      {
        onSuccess: (result) => {
          setLines([]); setNote(""); setRequestId(newRequestId()); setMode("list");
          onDone(`🚚 ${result.slip_number} · ${result.lines.length} món đã sang Q7`);
        },
      },
    );
  };

  if (mode === "new") {
    return (
      <Sheet title="Lập phiếu chuyển" tag="🚚 Tân Tạo → Q7" sub="Trừ ở Tân Tạo, cộng vào Q7 ngay khi chuyển" onClose={onClose}>
        <div className="slip" data-bmq-transfer-slip>
          {!started ? <div className="warn">Sổ kho {!ttStarted && !q7Started ? "Tân Tạo và Q7" : !ttStarted ? "Tân Tạo" : "Q7"} chưa bắt đầu. Kiểm kê lần đầu xong mới chuyển được.</div> : null}
          {lines.length ? (
            <ul className="slip-lines">
              {checked.map(({ line, item, problem }, index) => (
                <li key={line.id} className={problem ? "is-bad" : undefined} data-bmq-slip-line>
                  <span className="slip-no">{index + 1}</span>
                  <span className="slip-name"><b>{item?.name ?? "?"}</b><small>{item ? `Tân Tạo còn ${fmtQty(item.on_hand)} ${item.unit}` : ""}</small></span>
                  <label className="slip-qty">
                    <input inputMode="decimal" value={line.qty} placeholder="SL" aria-label={`Số lượng ${item?.name ?? ""}`} onChange={(event) => setQty(line.id, event.target.value)} />
                    <i>{item?.unit}</i>
                  </label>
                  <button type="button" className="slip-x" onClick={() => remove(line.id)} aria-label={`Bỏ ${item?.name ?? "món"}`}>✕</button>
                  {problem ? <small className="slip-problem">{problem}</small> : null}
                </li>
              ))}
            </ul>
          ) : <p className="note">Phiếu đang trống. Tìm món ở Tân Tạo rồi bấm để thêm.</p>}

          {lines.length < 30 ? (
            <>
              <label className="field">
                Thêm món
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ tên: băng keo, hộp…" data-bmq-slip-search />
              </label>
              {candidates.length ? (
                <div className="picks slip-picks">
                  {candidates.map((item) => (
                    <button key={item.id} type="button" className="pick" onClick={() => add(item.id)} data-bmq-slip-pick={item.name}>
                      <span><b>{item.name}</b><small>còn {fmtQty(item.on_hand)} {item.unit}{item.pastry_q7 ? " · 🧁 tự chuyển" : ""}</small></span>
                      <span className="pick-go">＋</span>
                    </button>
                  ))}
                </div>
              ) : needle ? <p className="note">Không thấy món còn hàng ở Tân Tạo khớp tên này.</p> : null}
            </>
          ) : null}

          <label className="field">
            Ghi chú (không bắt buộc)
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="vd: hàng cho ca sáng Q7" />
          </label>
          {create.error ? <div className="err">{transferError(create.error)}</div> : null}
          <div className="row slip-actions">
            <button type="button" className="btn" disabled={!ready} onClick={submit} data-bmq-slip-submit>
              {create.isPending ? "Đang chuyển…" : lines.length ? `🚚 Chuyển ${lines.length} món` : "🚚 Chuyển"}
            </button>
            <button type="button" className="btn ghost" onClick={() => { create.reset(); setMode("list"); }}>Quay lại</button>
          </div>
        </div>
      </Sheet>
    );
  }

  const rows = history.data ?? [];
  return (
    <Sheet title="Phiếu chuyển kho" tag="🚚 Tân Tạo → Q7" sub="Bánh ngọt tự chuyển · vật tư lập phiếu" onClose={onClose}>
      {canTransfer ? (
        <>
          <button type="button" className="btn slip-new" onClick={() => setMode("new")} data-bmq-transfer-new>＋ Lập phiếu chuyển</button>
          {!started ? <p className="note">Sổ kho chưa bắt đầu ở {!ttStarted && !q7Started ? "cả hai kho" : !ttStarted ? "Tân Tạo" : "Q7"}: kiểm kê lần đầu xong mới chuyển được.</p> : null}
        </>
      ) : null}
      {history.error ? <div className="err">Chưa tải được phiếu chuyển.</div> : null}
      {history.isLoading ? <p className="note">Đang tải…</p> : rows.length ? (
        <ul className="transfer-list" data-bmq-transfer-list>
          {rows.map((row) => <HistoryRow key={row.transfer_number} row={row} />)}
        </ul>
      ) : <p className="note">Chưa có phiếu chuyển nào.</p>}
    </Sheet>
  );
}
