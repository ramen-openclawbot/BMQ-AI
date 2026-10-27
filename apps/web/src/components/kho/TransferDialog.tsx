import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateManualTransfer } from "@/hooks/useWarehouseGame";
import { manualTransferErrorText, type WarehouseGameItem } from "@/lib/warehouse-game";
import { cn } from "@/lib/utils";
import { fmtQty, newRequestId, normalizeName } from "./kho-meta";
import { KhoDialog } from "./KhoDialog";

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

/**
 * "Phiếu chuyển kho" (owner 12/10): staff move any Tân Tạo item to Q7 on a slip.
 * Pastry items still move by themselves; supplies (băng keo, hộp…) go on a manual slip.
 */
export function TransferDialog({ items, ttStarted, q7Started, initialItemId, onDone, onClose }: {
  items: WarehouseGameItem[]; ttStarted: boolean; q7Started: boolean;
  /** Open with this item already on the slip (from an item's detail). */
  initialItemId?: string;
  onDone: (message: string) => void; onClose: () => void;
}) {
  const create = useCreateManualTransfer();
  const started = ttStarted && q7Started;
  const [lines, setLines] = useState<Line[]>(() => (initialItemId ? [{ id: initialItemId, qty: "" }] : []));
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
  const ready = started && lines.length > 0 && lines.length <= 30
    && checked.every((row) => row.item && row.qty > 0 && !row.problem) && !create.isPending;

  const setQty = (id: string, qty: string) => setLines((prev) => prev.map((line) => (line.id === id ? { ...line, qty } : line)));
  const add = (id: string) => { setLines((prev) => [...prev, { id, qty: "" }]); setQuery(""); };
  const remove = (id: string) => setLines((prev) => prev.filter((line) => line.id !== id));

  const submit = () => {
    create.mutate(
      { lines: checked.map((row) => ({ itemId: row.line.id, quantity: row.qty })), note: note.trim() || null, requestId },
      {
        onSuccess: (result) => {
          setLines([]); setNote(""); setRequestId(newRequestId());
          onDone(`${result.slip_number} · ${result.lines.length} món đã sang Kho Q7`);
          onClose();
        },
      },
    );
  };

  const missing = !ttStarted && !q7Started ? "Tân Tạo và Q7" : !ttStarted ? "Tân Tạo" : "Q7";

  return (
    <KhoDialog title="Lập phiếu chuyển Tân Tạo → Q7" sub="Trừ ở Tân Tạo, cộng vào Q7 ngay khi chuyển" onClose={onClose} data={{ "data-bmq-transfer-slip": "" }}>
      {!started ? <p className="d3-kho-hint is-warn">Sổ kho {missing} chưa bắt đầu. Kiểm kê lần đầu xong mới chuyển được.</p> : null}
      {lines.length ? (
        <ul className="d3-kho-slip-lines">
          {checked.map(({ line, item, problem }) => (
            <li key={line.id} className={cn(problem && "is-bad")} data-bmq-slip-line>
              <span className="d3-kho-slip-name"><b>{item?.name ?? "?"}</b><small>{item ? `Tân Tạo còn ${fmtQty(item.on_hand)} ${item.unit}` : ""}</small></span>
              <label className="d3-kho-qty">
                <input inputMode="decimal" value={line.qty} placeholder="SL" aria-label={`Số lượng ${item?.name ?? ""}`} autoFocus={Boolean(initialItemId) && line.id === initialItemId} onChange={(event) => setQty(line.id, event.target.value)} />
                <i>{item?.unit}</i>
              </label>
              <button type="button" className="d3-kho-icon is-small" onClick={() => remove(line.id)} aria-label={`Bỏ ${item?.name ?? "món"}`}><X /></button>
              {problem ? <small className="d3-kho-slip-problem">{problem}</small> : null}
            </li>
          ))}
        </ul>
      ) : <p className="d3-kho-quiet">Phiếu đang trống. Tìm món ở Tân Tạo rồi bấm để thêm.</p>}

      {lines.length < 30 ? (
        <div className="d3-kho-field">
          <span>Thêm món</span>
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Gõ tên: băng keo, hộp…" aria-label="Tìm món ở Tân Tạo" data-bmq-slip-search />
          </span>
          {candidates.length ? (
            <ul className="d3-kho-picks">
              {candidates.map((item) => (
                <li key={item.id}>
                  <button type="button" onClick={() => add(item.id)} data-bmq-slip-pick={item.name}>
                    <b>{item.name}</b><small>còn {fmtQty(item.on_hand)} {item.unit}{item.pastry_q7 ? " · tự chuyển sang Q7" : ""}</small>
                    <Plus aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : needle ? <p className="d3-kho-quiet">Không thấy món còn hàng ở Tân Tạo khớp tên này.</p> : null}
        </div>
      ) : null}

      <label className="d3-kho-field">
        <span>Ghi chú (không bắt buộc)</span>
        <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="vd: hàng cho ca sáng Q7" />
      </label>
      {create.error ? <p className="d3-kho-error">{transferError(create.error)}</p> : null}
      <div className="d3-kho-actions">
        <Button disabled={!ready} onClick={submit} data-bmq-slip-submit>
          {create.isPending ? "Đang chuyển…" : lines.length ? `Chuyển ${lines.length} món` : "Chuyển"}
        </Button>
        <Button variant="outline" onClick={onClose}>Đóng</Button>
      </div>
    </KhoDialog>
  );
}
