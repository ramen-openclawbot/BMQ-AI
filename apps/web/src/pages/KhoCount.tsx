import { LoadingState } from "@/components/ui/loading";
import { useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useKhoCountItem, useKhoItems } from "@/hooks/useKhoItems";
import { useKhoCommitments } from "@/hooks/useKhoCommitments";
import { commitmentByItem, dayLabel, type KhoItemCommitment } from "@/lib/kho-commitments";
import { filterItems, khoErrorText, type KhoItem, type KhoLocation } from "@/lib/kho-items";
import { cn } from "@/lib/utils";
import { ItemDialog } from "@/components/kho/ItemDialog";
import { useKhoConfirm } from "@/components/kho/KhoConfirm";
import { KHO_LABEL, KHO_LOCATIONS, countUnits, dmy, fmtAmount, inCountList, newRequestId, parseNum, todayVN } from "@/components/kho/kho-meta";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";

/**
 * Kiểm kê (owner 22/10/2026, replacing the warehouse game screen): choose a kho, type what was counted, and the stock
 * ledger takes it at once. The screen answers "how much of today's count is done, and what is left".
 */
export default function KhoCount() {
  const { toast } = useToast();
  const list = useKhoItems();
  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const canCount = list.data?.can_count ?? { tan_tao: false, q7: false };
  const [loc, setLoc] = useState<KhoLocation | null>(null);
  const kho: KhoLocation = loc ?? (canCount.tan_tao || !canCount.q7 ? "tan_tao" : "q7");
  const [query, setQuery] = useState("");
  const [onlyLeft, setOnlyLeft] = useState(false);
  const [unitId, setUnitId] = useState<string | null>(null);
  const canEdit = Boolean(list.data?.can_edit);
  const unitItem = items.find((item) => item.id === unitId) ?? null;
  const { confirm, dialog } = useKhoConfirm();
  const commitments = useKhoCommitments();
  const holds = useMemo(() => (commitments.data ? commitmentByItem(commitments.data) : null), [commitments.data]);
  const today = todayVN();
  const all = useMemo(() => items.filter((item) => inCountList(item, kho)), [items, kho]);
  const done = all.filter((item) => item.last_count_date[kho] === today).length;
  const rows = useMemo(
    () => filterItems(all, query).filter((item) => !onlyLeft || item.last_count_date[kho] !== today),
    [all, query, onlyLeft, kho, today],
  );
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-count-page>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Kiểm kê</h1>
          <p className="d3-wh-tag">Gõ số đếm được, sổ tồn cập nhật ngay</p>
        </div>
        <div className="d3-sl-switch d3-kho-switch" role="tablist" aria-label="Kho" data-bmq-kho-switch>
          {KHO_LOCATIONS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={kho === id} className={cn(kho === id && "is-on")} onClick={() => setLoc(id)} data-bmq-kho-loc={id}>Kho {KHO_LABEL[id]}</button>
          ))}
        </div>
      </header>

      <section className="d3-wh-card d3-kho-progress" data-bmq-kho-progress aria-live="polite">
        <div className="d3-kho-progress-figure">
          <strong className="d3-num">{list.isLoading ? "…" : done}<small> / {list.isLoading ? "…" : all.length}</small></strong>
          <span>món đã đếm hôm nay ở Kho {KHO_LABEL[kho]}</span>
        </div>
        <div className="d3-kho-meter" role="progressbar" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={done} aria-label="Đã đếm hôm nay">
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        <Button variant={onlyLeft ? "default" : "outline"} size="sm" onClick={() => setOnlyLeft((v) => !v)} aria-pressed={onlyLeft} data-bmq-kho-only-left>
          {onlyLeft ? "Hiện tất cả" : `Chỉ món chưa đếm${all.length && !list.isLoading ? ` · ${all.length - done}` : ""}`}
        </Button>
      </section>

      <section className="d3-wh-card d3-kho-card">
        <div className="d3-kho-tools">
          <span className="d3-kho-search">
            <Search aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm món để đếm…" aria-label="Tìm món để đếm" enterKeyHint="search" data-bmq-kho-search />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="Xóa tìm kiếm"><X /></button> : null}
          </span>
        </div>
        {!list.isLoading && !list.isError && !canCount[kho] ? <p className="d3-kho-hint is-warn">Tài khoản này chưa có quyền đếm Kho {KHO_LABEL[kho]}.</p> : null}
        {list.isLoading ? (
          <LoadingState rows={6} flat label="Đang tải danh sách kiểm kê…" />
        ) : list.isError ? (
          <div className="d3-kho-failed" role="alert">
            <p>Không tải được danh sách đếm. {khoErrorText(list.error)}</p>
            <Button variant="outline" onClick={() => void list.refetch()}>Thử lại</Button>
          </div>
        ) : (
          <>
            <ul className="d3-kho-list" data-bmq-kho-count={kho}>
              {rows.map((item) => <CountRow key={`${kho}:${item.id}`} item={item} loc={kho} today={today} canCount={canCount[kho]} onSaved={(text) => toast({ title: text })} onOpen={() => setUnitId(item.id)}
                hold={holds?.get(`${kho}:${item.id}`) ?? null} asOf={commitments.data?.as_of ?? ""} />)}
            </ul>
            {rows.length === 0 ? (
              <p className="d3-kho-empty" data-bmq-kho-empty>
                {query ? `Không có món nào khớp “${query}”.` : onlyLeft ? `Đã đếm hết các món của Kho ${KHO_LABEL[kho]} hôm nay.` : `Kho ${KHO_LABEL[kho]} chưa có món nào để đếm.`}
              </p>
            ) : null}
          </>
        )}
      </section>
      {unitItem ? (
        <ItemDialog key={unitItem.id} item={unitItem} items={items} canEdit={canEdit} confirm={confirm}
          onDone={(text) => { toast({ title: text }); setUnitId(null); }} onClose={() => setUnitId(null)}
          onToast={(text) => toast({ title: text })} onReplaced={setUnitId} />
      ) : null}
      {dialog}
    </div>
  );
}

function CountRow({ item, loc, today, canCount, onSaved, onOpen, hold, asOf }: {
  item: KhoItem; loc: KhoLocation; today: string; canCount: boolean; onSaved: (text: string) => void; onOpen: () => void;
  /** Usage already booked for a later delivery day: still on the shelf today, so it is counted. */
  hold: KhoItemCommitment | null; asOf: string;
}) {
  const count = useKhoCountItem();
  const units = countUnits(item.unit);
  const [unitIdx, setUnitIdx] = useState(0);
  const [text, setText] = useState("");
  const [last, setLast] = useState<{ qty: number; diff: number | null } | null>(null);
  const book = item.qty[loc];
  const pendingQty = item.pending_count[loc];
  const countedToday = item.last_count_date[loc] === today;
  const value = parseNum(text);
  const ok = text.trim() !== "" && Number.isFinite(value) && value >= 0;

  const send = () => {
    const qty = Math.round(value * units[unitIdx].factor * 1000) / 1000;
    count.mutate(
      { location: loc, itemId: item.id, countedQty: qty, requestId: newRequestId() },
      {
        onSuccess: (result) => {
          const diff = Number((result.result as { difference_qty?: number }).difference_qty);
          setLast({ qty, diff: Number.isFinite(diff) ? diff : null });
          setText("");
          onSaved(`${item.name}: đã ghi ${fmtAmount(qty, item.unit)}`);
        },
      },
    );
  };

  const isDone = countedToday || last !== null;
  return (
    <li className={cn("d3-kho-row d3-kho-countrow", isDone && "is-done")} data-bmq-kho-countrow={item.id}>
      <div className="d3-kho-row-main">
        <button type="button" className="d3-kho-namebtn" onClick={onOpen} title="Xem chi tiết món" data-bmq-kho-count-open={item.id}>
          {isDone ? <Check className="d3-kho-done-mark" aria-label="Đã đếm hôm nay" /> : null}{item.name}
        </button>
        <small>
          <span>Sổ {fmtAmount(book, item.unit)}</span>
          <span>{item.last_count_date[loc] ? `Đếm ${dmy(item.last_count_date[loc])}` : "Chưa đếm lần nào"}</span>
          {hold ? <span className="d3-kho-hold" title="Hàng này vẫn còn trên kệ hôm nay, cứ đếm bình thường">Giữ cho sản xuất {fmtAmount(hold.committed_qty, item.unit)} · {dayLabel(asOf, hold.next_date)}</span> : null}
        </small>
        {last ? (
          <p className="d3-kho-done" data-bmq-kho-done>
            Đã ghi {fmtAmount(last.qty, item.unit)}
            {last.diff === null ? "" : last.diff === 0 ? " · khớp sổ" : ` · chênh ${last.diff > 0 ? "+" : "−"}${fmtAmount(Math.abs(last.diff), item.unit)} so với sổ`}
          </p>
        ) : null}
        {canCount && pendingQty !== null && !last && !countedToday ? (
          <button type="button" className="d3-kho-textbtn" onClick={() => { setUnitIdx(0); setText(String(Math.round((pendingQty / units[0].factor) * 1000) / 1000).replace(".", ",")); }} data-bmq-kho-use-old>
            Phiếu đếm cũ ghi {fmtAmount(pendingQty, item.unit)} · dùng số này
          </button>
        ) : null}
      </div>
      {canCount ? (
        <div className="d3-kho-countin">
          <input className="d3-kho-countbox" inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)}
            placeholder={countedToday ? "Đếm lại?" : "Số đếm"} aria-label={`Số đếm ${item.name}`}
            onKeyDown={(event) => { if (event.key === "Enter" && ok) send(); }} />
          {units.length > 1 ? (
            <div className="d3-kho-seg is-small" role="group" aria-label="Đơn vị đếm">
              {units.map((u, idx) => <button key={u.label} type="button" aria-pressed={idx === unitIdx} className={cn(idx === unitIdx && "is-on")} onClick={() => setUnitIdx(idx)}>{u.label}</button>)}
            </div>
          ) : <span className="d3-kho-unitlabel">{units[0].label}</span>}
          <Button size="sm" variant={ok ? "default" : "outline"} disabled={!ok || count.isPending} onClick={send} data-bmq-kho-countsave>{count.isPending ? "Đang lưu…" : "Lưu"}</Button>
        </div>
      ) : null}
      {count.error ? <p className="d3-kho-error">{khoErrorText(count.error)}</p> : null}
    </li>
  );
}
