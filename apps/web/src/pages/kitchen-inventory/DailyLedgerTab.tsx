import { FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AddKitchenMovementInput, KitchenItem, KitchenMovement } from "@/hooks/useKitchenInventory";
import { money } from "@/lib/kitchen-inventory/calculations";
import type { KitchenMovementType } from "@/lib/kitchen-inventory/normalize";

interface DailyLedgerTabProps {
  periodMonth: string;
  items: KitchenItem[];
  movements: KitchenMovement[];
  canEdit: boolean;
  addMovement: {
    mutate: (input: AddKitchenMovementInput) => void;
    isPending: boolean;
  };
}

const movementLabels: Record<KitchenMovementType, string> = {
  opening: "Tồn đầu kỳ",
  purchase: "Nhập",
  usage: "Xuất dùng",
  stock_count: "Kiểm kê cuối",
  adjustment: "Điều chỉnh",
};

export function DailyLedgerTab({ periodMonth, items, movements, canEdit, addMovement }: DailyLedgerTabProps) {
  const periodStart = `${periodMonth.slice(0, 7)}-01`;
  const periodEnd = new Date(Number(periodMonth.slice(0, 4)), Number(periodMonth.slice(5, 7)), 0).toISOString().slice(0, 10);
  const [movementDate, setMovementDate] = useState(periodStart);
  const [movementType, setMovementType] = useState<KitchenMovementType>("usage");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const selectedItem = useMemo(() => items.find((item) => item.id === itemId), [items, itemId]);

  useEffect(() => {
    if (movementDate.slice(0, 7) !== periodMonth.slice(0, 7)) {
      setMovementDate(periodStart);
    }
  }, [movementDate, periodMonth, periodStart]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!selectedItem) {
      setFormError("Vui lòng chọn item từ danh mục chuẩn.");
      return;
    }
    if (movementDate.slice(0, 7) !== periodMonth.slice(0, 7)) {
      setFormError("Ngày ghi sổ phải nằm trong tháng đang xem để tránh nhập nhầm kỳ kế toán.");
      return;
    }
    const parsedQuantity = Number(quantity);
    if (!Number.isFinite(parsedQuantity)) {
      setFormError("Số lượng không hợp lệ.");
      return;
    }
    if (movementType === "stock_count" && parsedQuantity < 0) {
      setFormError("Kiểm kê cuối không được âm; nhập 0 nếu hết tồn.");
      return;
    }
    if (movementType === "adjustment" && parsedQuantity === 0) {
      setFormError("Điều chỉnh phải khác 0.");
      return;
    }
    if (movementType !== "stock_count" && movementType !== "adjustment" && parsedQuantity <= 0) {
      setFormError("Số lượng phải lớn hơn 0.");
      return;
    }
    if (movementType === "adjustment" && !note.trim()) {
      setFormError("Điều chỉnh bắt buộc có ghi chú lý do.");
      return;
    }
    addMovement.mutate({
      movement_date: movementDate,
      movement_type: movementType,
      item_id: selectedItem.id,
      quantity: parsedQuantity,
      note,
    });
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Ledger hằng ngày</h2>
          <p className="text-sm text-muted-foreground">
            Nhập theo form kế toán gốc, chọn item từ danh mục chuẩn để tự điền đơn vị và đơn giá.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-6">
          <label className="space-y-1 md:col-span-1">
            <span className="text-sm font-medium">Ngày</span>
            <input
              type="date"
              value={movementDate}
              onChange={(event) => setMovementDate(event.target.value)}
              min={periodStart}
              max={periodEnd}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              disabled={!canEdit}
            />
          </label>
          <label className="space-y-1 md:col-span-1">
            <span className="text-sm font-medium">Loại</span>
            <select
              value={movementType}
              onChange={(event) => setMovementType(event.target.value as KitchenMovementType)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              disabled={!canEdit}
            >
              {Object.entries(movementLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium">Nguyên vật liệu</span>
            <select
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              disabled={!canEdit}
              required
            >
              <option value="">Chọn item chuẩn...</option>
              {items.filter((item) => item.active).map((item) => (
                <option key={item.id} value={item.id}>{item.item_code} - {item.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">SL</span>
            <input
              type="number"
              step="0.001"
              min={movementType === "adjustment" ? undefined : "0"}
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              disabled={!canEdit}
              required
            />
          </label>
          <div className="space-y-1">
            <span className="text-sm font-medium">Đơn giá chuẩn</span>
            <div className="flex h-10 items-center rounded-md border bg-muted/50 px-3 text-sm">
              {selectedItem ? `${money(selectedItem.standard_unit_cost)} / ${selectedItem.unit}` : "-"}
            </div>
          </div>
        </div>

        <label className="mt-3 block space-y-1">
          <span className="text-sm font-medium">Ghi chú</span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Bắt buộc khi điều chỉnh hoặc override sau này"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            disabled={!canEdit}
            required={movementType === "adjustment"}
          />
        </label>

        {formError && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        )}

        <div className="mt-4 flex justify-end">
          <Button type="submit" disabled={!canEdit || addMovement.isPending || !selectedItem}>
            {addMovement.isPending ? "Đang ghi..." : "Ghi sổ"}
          </Button>
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h3 className="font-semibold">Dòng ledger trong tháng</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Ngày</th>
                <th className="px-4 py-3">Loại</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3 text-right">SL</th>
                <th className="px-4 py-3">ĐVT</th>
                <th className="px-4 py-3 text-right">Thành tiền</th>
                <th className="px-4 py-3">Nguồn</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {movements.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>Chưa có phát sinh trong tháng.</td>
                </tr>
              )}
              {movements.map((movement) => {
                const item = items.find((candidate) => candidate.id === movement.item_id);
                return (
                  <tr key={movement.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">{movement.movement_date}</td>
                    <td className="px-4 py-3">{movementLabels[movement.movement_type]}</td>
                    <td className="px-4 py-3 font-medium">{item?.name || movement.item_id}</td>
                    <td className="px-4 py-3 text-right">{movement.quantity}</td>
                    <td className="px-4 py-3">{movement.unit}</td>
                    <td className="px-4 py-3 text-right">{money(movement.amount)}</td>
                    <td className="px-4 py-3">{movement.source}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
