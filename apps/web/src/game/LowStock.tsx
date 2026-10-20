import type { LowStockRow, StockLedgerOverview } from "@/lib/stock-ledger";
import type { WarehouseGameLocation } from "@/lib/warehouse-game";
import { fmtQty } from "./meta";
import { Sheet } from "./Sheet";
import { dmy } from "./StockCount";

const WHERE: Record<WarehouseGameLocation, string> = { q7: "Kho Q7", tan_tao: "Kho Tân Tạo" };

const days = (row: LowStockRow) =>
  row.days_left <= 0 ? "Đã hết"
  : row.days_left < 1 ? "Dưới 1 ngày"
  : `Còn ~${row.days_left.toLocaleString("vi-VN", { maximumFractionDigits: row.days_left < 10 ? 1 : 0 })} ngày`;

function stockError(error: unknown): string {
  const message = String((error as { message?: string })?.message ?? error);
  if (/insufficient_privilege|actor_required|42501/.test(message)) return "Tài khoản này chưa có quyền xem sổ tồn của kho này.";
  return `Sushi chưa đọc được sổ tồn: ${message.slice(0, 160)}`;
}

/** Robot Sushi kiểm tồn (owner 20/10): NVL sắp hết in this warehouse, read-only, same rule as Sổ tồn. */
export function LowStockSheet({ location, overview, rows, loading, error, onOrder, onClose }: {
  location: WarehouseGameLocation;
  overview: StockLedgerOverview | undefined;
  rows: LowStockRow[] | null;
  loading: boolean;
  error: unknown;
  onOrder: () => void;
  onClose: () => void;
}) {
  const sub = overview ? `${WHERE[location]} · tính đến ${dmy(overview.as_of)}` : WHERE[location];
  return (
    <Sheet title="Nguyên vật liệu sắp hết" tag="🔎 Sushi kiểm tồn" sub={sub} onClose={onClose}>
      <div className="ls-body" data-bmq-low-stock={location}>
        {error ? (
          <div className="err" data-bmq-low-stock-error>{stockError(error)}</div>
        ) : loading || !rows ? (
          <p className="note">Sushi đang dò sổ tồn…</p>
        ) : !overview?.cutover_date ? (
          <p className="note" data-bmq-low-stock-empty>Sổ tồn kho này chưa bắt đầu (chưa kiểm kê lần đầu), nên Sushi chưa có số để kiểm.</p>
        ) : rows.length === 0 ? (
          <div className="ls-ok" data-bmq-low-stock-empty><b>✓ Chưa có món nào sắp hết</b><span>Mọi nguyên vật liệu đang dùng đều còn đủ ít nhất 3 ngày.</span></div>
        ) : (
          <ul className="ls-list">
            {rows.map((row) => (
              <li key={row.item_id} className={row.days_left <= 0 ? "is-out" : undefined} data-bmq-low-stock-row>
                <div className="ls-name">
                  <b>{row.item_name}</b>
                  <small>{row.item_code}</small>
                </div>
                <em className="ls-days">{days(row)}</em>
                <dl className="ls-facts">
                  <div><dt>Tồn</dt><dd>{fmtQty(Math.max(0, row.current_qty))} {row.unit}</dd></div>
                  <div><dt>Dùng / ngày</dt><dd>{fmtQty(row.daily_usage)} {row.unit}</dd></div>
                  <div><dt>Lần đếm</dt><dd>{row.last_count_date ? dmy(row.last_count_date) : "Chưa đếm"}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        )}
        <p className="ls-rule">Sắp hết = tồn còn ít hơn 3 ngày dùng, tính theo lượng xuất 7 ngày qua. Món chưa xuất trong 7 ngày chưa được báo.</p>
        <div className="row">
          <button type="button" className="btn" onClick={onOrder} data-bmq-low-stock-order>🛒 Đặt hàng</button>
          <button type="button" className="btn ghost" onClick={onClose}>Đóng</button>
        </div>
      </div>
    </Sheet>
  );
}
