import { LoadingState } from "@/components/ui/loading";
import { useState } from "react";
import { ArrowDownToLine, ArrowRightLeft, ArrowUpFromLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useStockTransfers, useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import { useKhoCommitments } from "@/hooks/useKhoCommitments";
import { commitmentBySku, dayLabel } from "@/lib/kho-commitments";
import type { WarehouseGameTransfer } from "@/lib/warehouse-game";
import { cn } from "@/lib/utils";
import { dmy, fmtQty } from "@/components/kho/kho-meta";
import { FinishedGoodsDialog, type FinishedGoodsMode } from "@/components/kho/FinishedGoodsDialog";
import { TransferDialog } from "@/components/kho/TransferDialog";
import "@/styles/bmq-warehouse.css";
import "@/styles/bmq-stock-ledger.css";
import "@/styles/bmq-kho.css";

/**
 * Phiếu kho (owner 21/10/2026): finished goods of Kho Q7 in and out, and the Tân Tạo → Q7 transfer slip.
 * The page shows what those slips change: Q7 finished-goods stock and the latest transfers.
 */
type Panel = { kind: "finished"; mode: FinishedGoodsMode } | { kind: "transfer" } | null;

function TransferRow({ row }: { row: WarehouseGameTransfer }) {
  const manual = row.source === "manual";
  return (
    <li className="d3-kho-row is-static" data-bmq-transfer-row={row.source}>
      <span className="d3-kho-row-main">
        <b>{row.item_name}</b>
        <small>
          <span>{manual ? `Phiếu ${row.slip_number ?? row.transfer_number}` : `Tự động${row.receipt_number ? ` · từ ${row.receipt_number}` : ""}`}</span>
          <span>{dmy(row.transfer_date)}</span>
          {manual && row.note ? <span>{row.note}</span> : null}
        </small>
      </span>
      <span className="d3-kho-row-qty">+{fmtQty(row.quantity)} {row.unit}</span>
    </li>
  );
}

export default function WarehouseSlips() {
  const { toast } = useToast();
  const q7 = useWarehouseGameSnapshot("q7");
  const tt = useWarehouseGameSnapshot("tan_tao");
  const history = useStockTransfers(40);
  const commitments = useKhoCommitments();
  const orders = commitments.data ? commitmentBySku(commitments.data) : null;
  const { isOwner, canEditModule, roles } = useAuth();
  const canTransfer = isOwner || roles.includes("warehouse") || canEditModule("inventory") || canEditModule("q7_material_inventory");
  const [panel, setPanel] = useState<Panel>(null);
  const say = (title: string) => toast({ title });
  const skus = q7.data?.skus ?? [];
  const transfers = history.data ?? [];
  const started = Boolean(tt.data?.cutover_date) && Boolean(q7.data?.cutover_date);

  return (
    <div className="d3-wh d3-kho min-w-0" data-bmq-warehouse-slips>
      <header className="d3-wh-head">
        <div className="min-w-0">
          <h1>Phiếu kho</h1>
          <p className="d3-wh-tag">Thành phẩm Kho Q7 · chuyển kho Tân Tạo → Q7</p>
        </div>
        <div className="d3-kho-head-actions">
          <Button variant="outline" onClick={() => setPanel({ kind: "finished", mode: "in" })} data-bmq-slip-open="in"><ArrowDownToLine aria-hidden="true" />Nhập thành phẩm</Button>
          <Button variant="outline" onClick={() => setPanel({ kind: "finished", mode: "out" })} data-bmq-slip-open="out"><ArrowUpFromLine aria-hidden="true" />Xuất thành phẩm</Button>
          <Button variant="outline" disabled={!canTransfer || tt.isLoading} onClick={() => setPanel({ kind: "transfer" })} data-bmq-slip-open="transfer"><ArrowRightLeft aria-hidden="true" />Chuyển sang Q7</Button>
        </div>
      </header>
      {!canTransfer ? <p className="d3-kho-hint is-warn">Tài khoản này chỉ xem được, chưa lập phiếu được.</p> : null}

      <div className="d3-kho-split">
        <section className="d3-wh-card d3-kho-card" data-bmq-slip-fg>
          <div className="d3-wh-card-h">
            <h2>Thành phẩm Kho Q7</h2>
            {!q7.isLoading && !q7.isError ? <span className="d3-wh-pill">{skus.length} mã</span> : null}
          </div>
          {q7.isLoading ? (
            <LoadingState rows={4} flat label="Đang tải…" />
          ) : q7.isError ? (
            <div className="d3-kho-failed" role="alert"><p>Không tải được tồn thành phẩm Q7.</p><Button variant="outline" onClick={() => void q7.refetch()}>Thử lại</Button></div>
          ) : skus.length ? (
            <ul className="d3-kho-list">
              {skus.map((sku) => {
                const c = orders?.get(`q7:${sku.sku_code}`);
                return (
                  <li key={sku.id} className={cn("d3-kho-row is-static", sku.on_hand <= 0 && !c && "is-off")} data-bmq-slip-sku={sku.sku_code}>
                    <span className="d3-kho-row-main">
                      <b>{sku.product_name}</b>
                      <small>
                        <span>{sku.sku_code}</span>
                        {c ? <span className="d3-kho-hold">Đã đặt {fmtQty(c.committed_qty)} · {c.orders} đơn · {dayLabel(commitments.data?.as_of ?? "", c.next_date)}</span> : null}
                        {c && c.incoming_qty > 0 ? <span>sẽ làm {fmtQty(c.incoming_qty)}</span> : null}
                      </small>
                    </span>
                    <span className="d3-kho-row-qty">
                      {fmtQty(sku.on_hand)} {sku.unit}
                      {c ? <small className={cn(c.available < 0 && "is-short")}>còn bán {fmtQty(c.available)}</small> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="d3-kho-empty">Kho Q7 chưa có mã thành phẩm nào.</p>}
        </section>

        <section className="d3-wh-card d3-kho-card" data-bmq-transfer-list>
          <div className="d3-wh-card-h">
            <h2>Chuyển Tân Tạo → Q7 gần đây</h2>
            {!history.isLoading && !history.isError ? <span className="d3-wh-pill">{transfers.length} dòng</span> : null}
            <p>Bánh ngọt tự chuyển khi nhập ở Tân Tạo; vật tư lập phiếu chuyển.{!started && !tt.isLoading && !q7.isLoading ? " Sổ kho chưa bắt đầu: kiểm kê lần đầu xong mới chuyển được." : ""}</p>
          </div>
          {history.isLoading ? (
            <LoadingState rows={4} flat label="Đang tải…" />
          ) : history.isError ? (
            <div className="d3-kho-failed" role="alert"><p>Không tải được phiếu chuyển.</p><Button variant="outline" onClick={() => void history.refetch()}>Thử lại</Button></div>
          ) : transfers.length ? (
            <ul className="d3-kho-list">{transfers.map((row) => <TransferRow key={`${row.source}:${row.transfer_number}:${row.item_name}`} row={row} />)}</ul>
          ) : <p className="d3-kho-empty">Chưa có phiếu chuyển nào.</p>}
        </section>
      </div>

      {panel?.kind === "finished" ? (
        <FinishedGoodsDialog key={panel.mode} mode={panel.mode} skus={skus} canEdit={canTransfer} onDone={say} onClose={() => setPanel(null)} />
      ) : null}
      {panel?.kind === "transfer" ? (
        <TransferDialog items={tt.data?.items ?? []} ttStarted={Boolean(tt.data?.cutover_date)} q7Started={Boolean(q7.data?.cutover_date)}
          onDone={say} onClose={() => setPanel(null)} />
      ) : null}
    </div>
  );
}
