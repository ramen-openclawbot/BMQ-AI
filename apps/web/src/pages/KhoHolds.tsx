import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading";
import { useDecideKhoHold, useKhoHolds } from "@/hooks/useKhoHolds";
import {
  KHO_HOLD_REASON_LABELS,
  KHO_HOLD_STATUS_LABELS,
  KHO_HOLD_STATUSES,
  filterKhoHolds,
  groupKhoHoldsByDay,
  holdDecisionError,
  holdMultiple,
  type KhoHoldDecision,
  type KhoHoldFilters,
  type KhoHoldRow,
  type KhoHoldStatus,
} from "@/lib/kho-holds";
import { KHO_LABEL, dmy, fmtAmount, todayVN } from "@/components/kho/kho-meta";
import { cn } from "@/lib/utils";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";
import "@/styles/bmq-kho-audit.css";
import "@/styles/bmq-kho-holds.css";

/**
 * Trừ kho chờ duyệt (owner 28/10). The revenue-based deduction holds back a day that is far above the
 * item's usual usage, or that it cannot compare yet. The owner approves (the next hourly run posts it)
 * or drops it (never posted). Decisions are final; the server refuses a second, different decision.
 */

const LOCATION_FILTERS: { id: KhoHoldFilters["location"]; label: string }[] = [
  { id: "all", label: "Cả hai kho" },
  { id: "q7", label: "Q7" },
  { id: "tan_tao", label: "Tân Tạo" },
];
const REASON_FILTERS: { id: KhoHoldFilters["reason"]; label: string }[] = [
  { id: "all", label: "Mọi lý do" },
  { id: "outlier", label: KHO_HOLD_REASON_LABELS.outlier },
  { id: "no_reference", label: KHO_HOLD_REASON_LABELS.no_reference },
];

const deniedText = (error: unknown) => {
  const raw = error as { code?: string; message?: string } | null;
  return raw?.code === "42501" || /insufficient_privilege/.test(raw?.message ?? "")
    ? "Chỉ chủ mới xem được danh sách này."
    : "Không tải được danh sách. Thử lại sau ít giây.";
};

function dayLabel(day: string, today: string) {
  if (day === today) return `Hôm nay · ${dmy(day)}`;
  return dmy(day) ?? day;
}

function measure(row: KhoHoldRow) {
  const qty = fmtAmount(row.desired_qty, row.item_unit);
  const multiple = holdMultiple(row);
  if (row.reason === "outlier" && row.reference_qty !== null) {
    return {
      qty,
      usual: `Thường ${fmtAmount(row.reference_qty, row.item_unit)}/ngày`,
      note: multiple !== null ? `gấp ${multiple.toLocaleString("vi-VN")} lần` : null,
    };
  }
  return {
    qty,
    usual: row.reference_days > 0
      ? `Mới có ${row.reference_days} ngày dùng để so (cần 5)`
      : "Chưa có ngày dùng nào để so",
    note: null,
  };
}

function HoldRow({ row, onDecide, busy }: {
  row: KhoHoldRow;
  onDecide: (row: KhoHoldRow, decision: KhoHoldDecision) => Promise<string | null>;
  busy: boolean;
}) {
  const [asking, setAsking] = useState<KhoHoldDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = measure(row);
  const place = `Kho ${KHO_LABEL[row.location]}`;
  const confirm = async () => {
    if (!asking) return;
    const failed = await onDecide(row, asking);
    if (failed) setError(failed);
    else setAsking(null);
  };

  return (
    <li className={cn("d3-kh-row", row.reason === "outlier" && "is-outlier")} data-bmq-hold-row={row.reason} data-bmq-hold-id={row.id}>
      <div className="d3-kh-main">
        <div className="d3-kh-what">
          <b>{row.item_name}</b>
          <small>
            <span>{place}</span>
            <span className={cn("d3-kh-reason", row.reason === "outlier" && "is-warn")}>{KHO_HOLD_REASON_LABELS[row.reason]}</span>
          </small>
        </div>
        <div className="d3-kh-qty">
          <b data-bmq-hold-qty>{m.qty}</b>
          <small>{m.usual}{m.note ? <> · <em>{m.note}</em></> : null}</small>
        </div>
        {row.status === "held" && !asking ? (
          <div className="d3-kh-actions">
            <Button size="sm" onClick={() => { setError(null); setAsking("approve"); }} disabled={busy} data-bmq-hold-approve>Duyệt</Button>
            <Button size="sm" variant="outline" onClick={() => { setError(null); setAsking("reject"); }} disabled={busy} data-bmq-hold-reject>Bỏ</Button>
          </div>
        ) : row.status !== "held" ? (
          <p className="d3-kh-done">{KHO_HOLD_STATUS_LABELS[row.status]}{row.decided_at ? ` · ${dmy(row.decided_at)}` : ""}</p>
        ) : null}
      </div>
      {asking ? (
        <div className="d3-kh-confirm" role="group" aria-label="Xác nhận quyết định" data-bmq-hold-confirm={asking}>
          <p>
            {asking === "approve"
              ? <>Trừ <b>{m.qty}</b> {row.item_name} khỏi {place} ngày {dmy(row.movement_date)}. Sổ kho ghi ở lần chạy kế tiếp, trong vòng 1 giờ.</>
              : <>Không trừ dòng này. {row.item_name} ngày {dmy(row.movement_date)} sẽ không vào sổ kho.</>}
          </p>
          {error ? <p className="d3-kho-error" role="alert">{error}</p> : null}
          <div className="d3-kh-actions">
            <Button size="sm" variant={asking === "reject" ? "destructive" : "default"} onClick={() => void confirm()} disabled={busy} data-bmq-hold-confirm-yes>
              {busy ? "Đang lưu…" : asking === "approve" ? "Xác nhận duyệt" : "Xác nhận bỏ"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAsking(null); setError(null); }} disabled={busy} data-bmq-hold-confirm-no>Huỷ</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export default function KhoHolds() {
  const [status, setStatus] = useState<KhoHoldStatus>("held");
  const [filters, setFilters] = useState<KhoHoldFilters>({ location: "all", reason: "all" });
  const holds = useKhoHolds(status);
  const decide = useDecideKhoHold();
  const rows = useMemo(() => filterKhoHolds(holds.data ?? [], filters), [holds.data, filters]);
  const days = useMemo(() => groupKhoHoldsByDay(rows), [rows]);
  const total = holds.data?.length ?? 0;
  const filtered = filters.location !== "all" || filters.reason !== "all";
  const today = todayVN();

  const onDecide = async (row: KhoHoldRow, decision: KhoHoldDecision) => {
    try {
      await decide.mutateAsync({ id: row.id, decision });
      return null;
    } catch (error) {
      return holdDecisionError(error);
    }
  };

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-kho-holds>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Trừ kho chờ duyệt</h1>
          <p className="d3-wh-tag">Ngày trừ theo doanh thu bị giữ lại vì cao bất thường hoặc chưa đủ lịch sử để so</p>
        </div>
      </header>

      <section className="d3-wh-card d3-kho-card d3-kh-filters" aria-label="Lọc danh sách" data-bmq-hold-filters>
        <div className="d3-kho-seg" role="group" aria-label="Trạng thái" data-bmq-hold-status>
          {KHO_HOLD_STATUSES.map((s) => (
            <button key={s} type="button" aria-pressed={status === s} className={cn(status === s && "is-on")} onClick={() => setStatus(s)} data-bmq-hold-status-btn={s}>
              {KHO_HOLD_STATUS_LABELS[s]}
              {s === "held" && status === "held" && total > 0 ? <span className="d3-kh-count">{total}</span> : null}
            </button>
          ))}
        </div>
        <div className="d3-kh-segs">
          <div className="d3-kho-seg is-small" role="group" aria-label="Kho" data-bmq-hold-kho>
            {LOCATION_FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filters.location === f.id} className={cn(filters.location === f.id && "is-on")} onClick={() => setFilters((v) => ({ ...v, location: f.id }))} data-bmq-hold-kho-btn={f.id}>{f.label}</button>
            ))}
          </div>
          <div className="d3-kho-seg is-small" role="group" aria-label="Lý do" data-bmq-hold-reason>
            {REASON_FILTERS.map((f) => (
              <button key={f.id} type="button" aria-pressed={filters.reason === f.id} className={cn(filters.reason === f.id && "is-on")} onClick={() => setFilters((v) => ({ ...v, reason: f.id }))} data-bmq-hold-reason-btn={f.id}>{f.label}</button>
            ))}
          </div>
        </div>
        {status === "held" ? (
          <p className="d3-kho-hint is-warn d3-kh-hint">
            Kiểm tra công thức giá vốn trước khi duyệt dòng cao bất thường: số lớn gấp nhiều lần thường do công thức sai đơn vị. Duyệt và bỏ đều không đổi lại được.
          </p>
        ) : null}
      </section>

      <section className="d3-wh-card d3-kho-card" data-bmq-hold-feed>
        {holds.isLoading ? (
          <LoadingState rows={5} flat label="Đang tải danh sách…" />
        ) : holds.isError ? (
          <div className="d3-kho-failed" role="alert"><p>{deniedText(holds.error)}</p><Button variant="outline" onClick={() => void holds.refetch()}>Thử lại</Button></div>
        ) : rows.length === 0 ? (
          <p className="d3-kho-empty" data-bmq-hold-empty>
            {filtered
              ? "Không có dòng nào khớp bộ lọc."
              : status === "held" ? "Không có dòng nào chờ duyệt. Bộ trừ đang ghi sổ bình thường." : `Chưa có dòng nào ${KHO_HOLD_STATUS_LABELS[status].toLowerCase()}.`}
          </p>
        ) : (
          days.map((day) => (
            <div key={day.day} className="d3-ka-day">
              <h2 className="d3-ka-dayhead">{dayLabel(day.day, today)}<span>{day.rows.length}</span></h2>
              <ul className="d3-kho-list d3-kh-list">
                {day.rows.map((row) => (
                  <HoldRow key={row.id} row={row} onDecide={onDecide} busy={decide.isPending && decide.variables?.id === row.id} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
