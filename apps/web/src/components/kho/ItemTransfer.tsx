import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { KHO_ITEMS_QUERY_KEY } from "@/hooks/useKhoItems";
import { useWarehouseGameSnapshot } from "@/hooks/useWarehouseGame";
import { hasTanTaoPlace, type KhoItem } from "@/lib/kho-items";
import { fmtAmount } from "./kho-meta";
import { KhoDialog } from "./KhoDialog";
import { TransferDialog } from "./TransferDialog";

/**
 * "Chuyển sang Kho Q7" inside an item's detail (owner 27/10): the same Tân Tạo -> Q7 slip as the Phiếu kho
 * page, opened with this item already on it so only the quantity is typed. The two ledger snapshots load
 * when the button is pressed, not when the detail opens.
 */
function TransferGate({ item, onToast, onClose }: { item: KhoItem; onToast: (text: string) => void; onClose: () => void }) {
  const tt = useWarehouseGameSnapshot("tan_tao");
  const q7 = useWarehouseGameSnapshot("q7");
  const queryClient = useQueryClient();
  if (tt.isLoading || q7.isLoading) {
    return <KhoDialog title="Chuyển sang Kho Q7" sub={item.name} onClose={onClose} data={{ "data-bmq-item-transfer-loading": "" }}><p className="d3-kho-quiet">Đang tải sổ kho…</p></KhoDialog>;
  }
  if (tt.isError || q7.isError) {
    return (
      <KhoDialog title="Chuyển sang Kho Q7" sub={item.name} onClose={onClose} data={{ "data-bmq-item-transfer-error": "" }}>
        <div className="d3-kho-failed" role="alert">
          <p>Không tải được sổ kho để lập phiếu.</p>
          <Button variant="outline" onClick={() => { void tt.refetch(); void q7.refetch(); }}>Thử lại</Button>
        </div>
      </KhoDialog>
    );
  }
  return (
    <TransferDialog items={tt.data?.items ?? []} initialItemId={item.id}
      ttStarted={Boolean(tt.data?.cutover_date)} q7Started={Boolean(q7.data?.cutover_date)}
      onDone={(message) => { void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] }); onToast(message); }}
      onClose={onClose} />
  );
}

export function ItemTransfer({ item, canEdit, onToast }: { item: KhoItem; canEdit: boolean; onToast: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  const stock = item.qty.tan_tao ?? 0;
  const reason = !hasTanTaoPlace(item) ? "Món này chưa có ở Kho Tân Tạo"
    : stock <= 0 ? "Kho Tân Tạo chưa có tồn để chuyển"
    : null;
  return (
    <>
      <div className="d3-kho-switchrow" data-bmq-item-transfer>
        <span>
          <b>Chuyển sang Kho Q7</b>
          <small>{reason ?? `Tân Tạo còn ${fmtAmount(stock, item.unit)}. Trừ ở Tân Tạo, cộng vào Q7 ngay.`}</small>
        </span>
        <Button size="sm" variant="outline" disabled={reason !== null} onClick={() => setOpen(true)} data-bmq-item-transfer-open>Chuyển</Button>
      </div>
      {open ? <TransferGate item={item} onToast={onToast} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
