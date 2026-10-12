import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { C } from "./theme";
import { CLASS_META, asClass, fmtQty, type GameClass } from "./meta";
import { GoodsIcon } from "./GoodsArt";
import { Sheet } from "./Sheet";
import { GameLoading } from "./Loading";
import type { StockCountLine, StockCountLocation, StockCountReview, StockCountSession, StockCountSummary } from "@/lib/stock-count";

/**
 * Kiểm kê (owner 12/10): one count sheet per warehouse. The lobby picks the
 * warehouse, the sheet is a tally list (type the counted quantity next to the
 * book quantity), the review sheet shows every difference before "Chốt phiếu".
 * Uncounted lines keep their book quantity — they are never written as 0.
 */

export const COUNT_LABEL: Record<StockCountLocation, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };
const COUNT_ICON: Record<StockCountLocation, string> = { q7: "🧁", tan_tao: "🏭" };
export const dmy = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const signed = (value: number) => (value > 0 ? `+${fmtQty(value)}` : fmtQty(value));

export function countErrorText(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error);
  const known: Array<[string, string]> = [
    ["q7_canonical_link_required", "Kho Q7: có món chưa gắn mã Material Master nên chưa ghi được điều chỉnh. Phiếu vẫn mở; gắn mã xong chốt lại."],
    ["stock_count_not_open", "Phiếu này đã chốt hoặc đã hủy. Mở phiếu mới để đếm tiếp."],
    ["stock_count_session_not_found", "Không tìm thấy phiếu kiểm kê."],
    ["stock_count_line_not_found", "Dòng này không còn trong phiếu."],
    ["invalid_counted_qty", "Số đếm phải là số không âm."],
    ["insufficient_privilege", "Tài khoản chưa có quyền kiểm kê kho này."],
    ["unit_mismatch", "Đơn vị món này đã đổi sau khi mở phiếu. Hủy phiếu và mở lại."],
    ["actor_required", "Cần đăng nhập để kiểm kê."],
  ];
  return known.find(([code]) => message.includes(code))?.[1] ?? message;
}

export function countProgress(session: StockCountSession | null | undefined): { done: number; total: number; diff: number } {
  const lines = session?.lines ?? [];
  const counted = lines.filter((line) => line.counted_qty !== null);
  return { done: counted.length, total: lines.length, diff: counted.filter((line) => line.counted_qty !== line.book_qty).length };
}

/* ---------------------------------------------------------------- lobby */

function ClipCard({ location, review, isLoading, error, starting, onEnter, onStart }: {
  location: StockCountLocation; review: StockCountReview | undefined; isLoading: boolean; error: unknown; starting: boolean;
  onEnter: () => void; onStart: () => void;
}) {
  const open = review?.open_session ?? null;
  const progress = countProgress(open);
  const last = review?.history.find((entry) => entry.status === "submitted") ?? null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <article className={`cnt-card is-${location}${open ? " has-open" : ""}`} data-bmq-count-card={location}>
      <span className="cnt-clip" aria-hidden="true" />
      <header className="cnt-card-h">
        <span className="cnt-icon">{COUNT_ICON[location]}</span>
        <span className="cnt-title">
          <h3>{COUNT_LABEL[location]}</h3>
          <small>{review?.cutover_date ? `Sổ tồn từ ${dmy(review.cutover_date)}` : "Sổ chưa bắt đầu · lần chốt đầu tiên sẽ khởi động sổ"}</small>
        </span>
      </header>
      {isLoading && !review ? <p className="cnt-meta">Đang mở sổ…</p> : null}
      {error && !review ? <div className="err">{countErrorText(error)}</div> : null}
      {review ? (
        open ? (
          <div className="cnt-open">
            <div className="cnt-line"><b>Phiếu ngày {dmy(open.count_date)}</b><span>{progress.done}/{progress.total} món đã đếm{progress.diff ? ` · ${progress.diff} lệch` : ""}</span></div>
            <span className="cnt-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>
            <button type="button" className="btn" onClick={onEnter} data-bmq-count-enter={location}>{review.can_edit ? "Đếm tiếp ›" : "Xem phiếu ›"}</button>
          </div>
        ) : (
          <div className="cnt-open">
            <div className="cnt-line"><b>Chưa có phiếu đang mở</b><span>Phiếu chốt số sổ hôm nay, đếm xong chốt một lần.</span></div>
            {review.can_edit
              ? <button type="button" className="btn" disabled={starting} onClick={onStart} data-bmq-count-start={location}>{starting ? "Đang mở…" : "📋 Mở phiếu kiểm kê"}</button>
              : <span className="kg-locked">Chỉ người quản kho được mở phiếu</span>}
          </div>
        )
      ) : null}
      {location === "q7" ? <p className="cnt-note">Chốt phiếu Q7 cần món đã gắn mã Material Master. Đếm trước được, chốt sau khi gắn mã.</p> : null}
      {last ? (
        <p className="cnt-meta">Lần gần nhất: {dmy(last.submitted_at ?? last.count_date)} · {last.summary ? `${last.summary.counted} món đếm · ${last.summary.lines_with_diff} lệch` : "đã chốt"}{last.submitted_by_name ? ` · ${last.submitted_by_name}` : ""}</p>
      ) : review ? <p className="cnt-meta">Chưa có lần kiểm kê nào.</p> : null}
    </article>
  );
}

export function CountLobby({ reviews, starting, onEnter, onStart }: {
  reviews: Record<StockCountLocation, { data: StockCountReview | undefined; isLoading: boolean; error: unknown }>;
  starting: StockCountLocation | null;
  onEnter: (location: StockCountLocation) => void; onStart: (location: StockCountLocation) => void;
}) {
  const order: StockCountLocation[] = ["tan_tao", "q7"];
  return (
    <div className="shelf-view cnt-lobby" data-bmq-count-lobby>
      <div className="flow-note"><span>✅ Đếm thực tế từng kệ</span><span className="flow-arrow">→</span><span>xem chênh lệch</span><span className="flow-arrow">→</span><span><b>Chốt phiếu</b> ghi vào sổ</span></div>
      <div className="cnt-cards">
        {order.map((location) => (
          <ClipCard
            key={location}
            location={location}
            review={reviews[location].data}
            isLoading={reviews[location].isLoading}
            error={reviews[location].error}
            starting={starting === location}
            onEnter={() => onEnter(location)}
            onStart={() => onStart(location)}
          />
        ))}
      </div>
      <p className="yard-rule">Món không đếm giữ nguyên số sổ, không bị ghi về 0. Phiếu lưu dở được, quay lại đếm tiếp bất cứ lúc nào.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- tally sheet */

export type CountFilter = "all" | "todo" | "diff" | GameClass;

function lineClass(line: StockCountLine): GameClass {
  return line.target_kind === "sku" ? "finished_goods" : asClass(line.item_class);
}

function matches(line: StockCountLine, filter: CountFilter, q: string): boolean {
  if (q && !`${line.target_name} ${line.target_code}`.toLowerCase().includes(q)) return false;
  if (filter === "all") return true;
  if (filter === "todo") return line.counted_qty === null;
  if (filter === "diff") return line.counted_qty !== null && line.counted_qty !== line.book_qty;
  return lineClass(line) === filter;
}

function TallyRow({ line, canEdit, saving, started, onSave }: {
  line: StockCountLine; canEdit: boolean; saving: boolean; started: boolean; onSave: (qty: number | null) => void;
}) {
  const [text, setText] = useState(line.counted_qty === null ? "" : String(line.counted_qty));
  const lastServer = useRef(line.counted_qty);
  // Server truth wins once the saved value comes back; typing in between is kept.
  useEffect(() => {
    if (line.counted_qty !== lastServer.current) {
      lastServer.current = line.counted_qty;
      setText(line.counted_qty === null ? "" : String(line.counted_qty));
    }
  }, [line.counted_qty]);
  const parsed = text.trim() === "" ? null : Number(text.replace(",", "."));
  const valid = parsed === null || (Number.isFinite(parsed) && parsed >= 0);
  const commit = () => {
    if (!canEdit || !valid || parsed === line.counted_qty) return;
    onSave(parsed);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); (event.target as HTMLInputElement).blur(); }
  };
  const cls = lineClass(line);
  const diff = line.counted_qty === null ? null : line.counted_qty - line.book_qty;
  const state = line.counted_qty === null ? "todo" : diff === 0 ? "ok" : "diff";
  return (
    <li className={`tally-row is-${state}${saving ? " is-saving" : ""}`} data-bmq-count-row={line.id} data-bmq-count-state={state}>
      <svg viewBox="-24 -22 48 44" className="tally-icon" aria-hidden="true">
        <GoodsIcon name={line.target_name} unit={line.unit} color={line.target_kind === "sku" ? C.coral : CLASS_META[cls].tint} size={1.25} />
      </svg>
      <span className="tally-name">
        <b>{line.target_name}</b>
        <small>{line.target_kind === "sku" ? "Thành phẩm" : CLASS_META[cls].label} · sổ: <em>{started ? fmtQty(line.book_qty) : "—"}</em> {line.unit}</small>
      </span>
      <span className="tally-in">
        <label>
          <span className="sr-only">Số đếm {line.target_name}</span>
          <input
            inputMode="decimal"
            value={text}
            placeholder="?"
            disabled={!canEdit}
            aria-invalid={!valid}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={onKey}
            data-bmq-count-input
          />
        </label>
        <small className={`tally-tag is-${state}`}>
          {saving ? "đang lưu…" : !valid ? "số không hợp lệ" : state === "todo" ? line.unit : state === "ok" ? "✓ khớp sổ" : `${signed(diff ?? 0)} ${line.unit}`}
        </small>
      </span>
    </li>
  );
}

export function CountSheet({ location, session, canEdit, started, savingIds, query, onQuery, filter, onFilter, onSave, onReview, onCancel, cancelling }: {
  location: StockCountLocation; session: StockCountSession; canEdit: boolean; started: boolean; savingIds: Set<string>;
  query: string; onQuery: (q: string) => void; filter: CountFilter; onFilter: (f: CountFilter) => void;
  onSave: (line: StockCountLine, qty: number | null) => void; onReview: () => void; onCancel: () => void; cancelling: boolean;
}) {
  const progress = countProgress(session);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const q = query.trim().toLowerCase();
  const classes = (["raw_material", "packaging_supply", "finished_goods", "unclassified", "non_stock"] as GameClass[]).filter((cls) => session.lines.some((line) => lineClass(line) === cls));
  const shown = session.lines.filter((line) => matches(line, filter, q));
  const chips: Array<[CountFilter, string]> = [["all", `Tất cả · ${session.lines.length}`], ["todo", `Chưa đếm · ${progress.total - progress.done}`], ["diff", `Lệch · ${progress.diff}`], ...classes.map((cls): [CountFilter, string] => [cls, `${CLASS_META[cls].icon} ${CLASS_META[cls].label}`])];
  return (
    <div className="shelf-view cnt-sheet" data-bmq-count-sheet={location}>
      <section className="cnt-head" data-bmq-count-head>
        <span className="cnt-clip" aria-hidden="true" />
        <div className="cnt-head-main">
          <span className="cnt-title">
            <h3>{COUNT_ICON[location]} Phiếu kiểm kê {dmy(session.count_date)}</h3>
            <small>{COUNT_LABEL[location]} · {started ? "số sổ chốt lúc mở phiếu" : "sổ chưa bắt đầu — số sổ là 0, lần chốt này khởi động sổ"}</small>
          </span>
          <div className="cnt-line"><b>{progress.done}/{progress.total} món đã đếm</b><span>{progress.diff ? `${progress.diff} món lệch sổ` : progress.done ? "chưa có món nào lệch" : "gõ số đếm vào ô bên phải mỗi món"}</span></div>
          <span className="cnt-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></span>
        </div>
        <div className="cnt-actions">
          <button type="button" className={`btn${progress.done ? " is-ready" : ""}`} disabled={!canEdit || !progress.done} onClick={onReview} data-bmq-count-review-open>
            {progress.done ? `Xem lệch & chốt · ${progress.done}` : "Đếm ít nhất 1 món"}
          </button>
          {canEdit ? <button type="button" className="btn ghost" disabled={cancelling} onClick={onCancel} data-bmq-count-cancel>{cancelling ? "Đang hủy…" : "Hủy phiếu"}</button> : null}
        </div>
      </section>

      <div className="cnt-tools">
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Tìm món…" aria-label="Tìm món trong phiếu" />
        </label>
        <div className="seg cnt-filters" role="radiogroup" aria-label="Lọc món">
          {chips.map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={filter === id} className={filter === id ? "is-on" : undefined} onClick={() => onFilter(id)} data-bmq-count-filter={id}>{label}</button>
          ))}
        </div>
      </div>

      {shown.length ? (
        <ul className="tally-list">
          {shown.map((line) => (
            <TallyRow key={line.id} line={line} canEdit={canEdit} started={started} saving={savingIds.has(line.id)} onSave={(qty) => onSave(line, qty)} />
          ))}
        </ul>
      ) : (
        <p className="empty">{q ? `Không có món nào khớp “${query}”.` : filter === "todo" ? "Đã đếm hết! Bấm “Xem lệch & chốt”." : filter === "diff" ? "Không có món nào lệch sổ." : "Phiếu không có món nào."}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- review + done */

export function ReviewSheet({ location, session, submitting, error, onSubmit, onClose }: {
  location: StockCountLocation; session: StockCountSession; submitting: boolean; error: unknown; onSubmit: () => void; onClose: () => void;
}) {
  const progress = countProgress(session);
  const diffs = session.lines.filter((line) => line.counted_qty !== null && line.counted_qty !== line.book_qty);
  const skipped = progress.total - progress.done;
  return (
    <Sheet title="Chốt phiếu kiểm kê" tag={`${COUNT_ICON[location]} ${COUNT_LABEL[location]} · ${dmy(session.count_date)}`} sub="Máy ghi phần chênh lệch vào sổ tồn, một lần duy nhất" onClose={onClose}>
      <div className="stats" data-bmq-count-review>
        <div><small>Đã đếm</small><b>{progress.done}</b></div>
        <div><small>Lệch sổ</small><b>{diffs.length}</b></div>
        <div><small>Bỏ qua</small><b>{skipped}</b></div>
      </div>
      {diffs.length ? (
        <ul className="cnt-diffs">
          {diffs.map((line) => {
            const diff = (line.counted_qty ?? 0) - line.book_qty;
            return (
              <li key={line.id} className={diff > 0 ? "is-up" : "is-down"}>
                <span><b>{line.target_name}</b><small>sổ {fmtQty(line.book_qty)} → đếm {fmtQty(line.counted_qty ?? 0)} {line.unit}</small></span>
                <em>{signed(diff)}</em>
              </li>
            );
          })}
        </ul>
      ) : <p className="task-ok big">✓ Mọi món đã đếm đều khớp sổ. Chốt để ghi ngày kiểm kê.</p>}
      {skipped ? <p className="hint">{skipped} món chưa đếm sẽ <b>giữ nguyên số sổ</b>, không bị ghi về 0.</p> : null}
      {!session.lines.length ? null : location === "q7" ? <p className="cnt-note">Q7: món chưa gắn mã Material Master sẽ làm chốt thất bại; phiếu vẫn mở để chốt lại sau.</p> : null}
      {error ? <div className="err">{countErrorText(error)}</div> : null}
      <div className="submit-bar">
        <button type="button" className="btn submit is-ready" disabled={submitting} onClick={onSubmit} data-bmq-count-submit>{submitting ? "Đang chốt…" : "✅ Chốt phiếu"}</button>
      </div>
      <div className="row"><button type="button" className="btn ghost" onClick={onClose}>Quay lại đếm</button></div>
    </Sheet>
  );
}

export function CountDone({ location, session, onClose }: { location: StockCountLocation; session: StockCountSession; onClose: () => void }) {
  const summary: StockCountSummary = session.summary ?? { counted: 0, skipped: 0, adjusted: 0, total_abs_diff: 0, lines_with_diff: 0 };
  return (
    <div className="ceremony" role="dialog" aria-label="Đã chốt phiếu kiểm kê" data-bmq-count-done>
      <div className="ceremony-card">
        <span className="ribbon">ĐÃ CHỐT</span>
        <small>{COUNT_LABEL[location]} · {dmy(session.count_date)}</small>
        <h2>Phiếu kiểm kê đã vào sổ</h2>
        <div className="stats cnt-done-stats">
          <div><small>Đã đếm</small><b>{summary.counted}</b></div>
          <div><small>Điều chỉnh</small><b>{summary.lines_with_diff}</b></div>
          <div><small>Giữ sổ</small><b>{summary.skipped}</b></div>
        </div>
        <p>{summary.lines_with_diff ? `Sổ tồn đã nhận ${summary.lines_with_diff} dòng điều chỉnh.` : "Không có chênh lệch, sổ giữ nguyên."}</p>
        <button type="button" className="btn" onClick={onClose} autoFocus>Tuyệt!</button>
      </div>
    </div>
  );
}

export function CountSheetLoading() {
  return <GameLoading lines={["Mở phiếu kiểm kê", "Chốt số sổ", "Xếp hàng lên kệ"]} />;
}
