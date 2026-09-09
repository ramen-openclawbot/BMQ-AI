import { useWarehouseCopy } from "@/i18n/useWarehouseCopy";
import type { KitchenItem, KitchenMonthlyClosing } from "@/hooks/useKitchenInventory";
import { money } from "@/lib/kitchen-inventory/calculations";

interface DraftClosingRow {
  item: KitchenItem;
  openingQty: number;
  purchaseQty: number;
  usageQty: number;
  adjustmentQty: number;
  systemEndingQty: number;
  countedEnding: number | null;
  varianceQty: number | null;
  usageAmount: number;
}

interface MonthlyCloseTabProps {
  periodMonth: string;
  draftClosings: DraftClosingRow[];
  savedClosings: KitchenMonthlyClosing[];
  canEdit: boolean;
  closeMonth: {
    mutate: () => void;
    isPending: boolean;
  };
}

export function MonthlyCloseTab({ periodMonth, draftClosings, savedClosings, canEdit, closeMonth }: MonthlyCloseTabProps) {
  const c = useWarehouseCopy();
  const closedCount = savedClosings.filter((closing) => closing.status === "closed").length;
  const totalUsage = draftClosings.reduce((sum, row) => sum + row.usageAmount, 0);
  const ingredientUsage = draftClosings
    .filter((row) => row.item.item_type === "ingredient")
    .reduce((sum, row) => sum + row.usageAmount, 0);
  const toolUsage = draftClosings
    .filter((row) => row.item.item_type === "tool_supply")
    .reduce((sum, row) => sum + row.usageAmount, 0);
  const missingStockRows = draftClosings.filter((row) => row.countedEnding === null);
  const missingStockPreview = missingStockRows.slice(0, 6).map((row) => `${row.item.item_code} - ${row.item.name}`).join(", ");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{c("Chốt tháng")} {periodMonth.slice(5, 7)}/{periodMonth.slice(0, 4)}</h2>
            <p className="text-sm text-muted-foreground">
              {c("Draft tính từ import T3/T4 và ledger hằng ngày. Tháng đã closed sẽ được khóa ở lớp quy trình.")} </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="rounded-full bg-muted px-3 py-1 text-sm">
              {closedCount > 0 ? c("closedItems", { count: closedCount }) : "DRAFT"}
            </div>
            <button
              type="button"
              onClick={() => closeMonth.mutate()}
              disabled={!canEdit || closeMonth.isPending || draftClosings.length === 0 || closedCount > 0 || missingStockRows.length > 0}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {closeMonth.isPending ? c("Đang chốt...") : c("Chốt tháng")}
            </button>
          </div>
        </div>
      </div>

      {missingStockRows.length > 0 && (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{c("Chưa thể chốt: còn")} {missingStockRows.length} {c("item chưa có dòng kiểm kê cuối tháng.")}</p>
          <p className="mt-1">
            {c("Vào tab Ledger hằng ngày, chọn loại “Kiểm kê cuối”, nhập số lượng cho:")} {missingStockPreview}
            {missingStockRows.length > 6 ? "..." : ""}
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Metric label={c("NVL sử dụng")} value={ingredientUsage} />
        <Metric label={c("CCDC sử dụng")} value={toolUsage} />
        <Metric label={c("Tổng CP dùng")} value={totalUsage} />
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{c("Mã")}</th>
                <th className="px-4 py-3">{c("Item")}</th>
                <th className="px-4 py-3 text-right">{c("Đầu")}</th>
                <th className="px-4 py-3 text-right">{c("Nhập")}</th>
                <th className="px-4 py-3 text-right">{c("Xuất")}</th>
                <th className="px-4 py-3 text-right">{c("Điều chỉnh")}</th>
                <th className="px-4 py-3 text-right">{c("Cuối hệ thống")}</th>
                <th className="px-4 py-3 text-right">{c("Kiểm kê")}</th>
                <th className="px-4 py-3 text-right">{c("Lệch")}</th>
                <th className="px-4 py-3 text-right">{c("CP dùng")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {draftClosings.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={10}>{c("Chưa có dữ liệu để chốt tháng.")}</td>
                </tr>
              )}
              {draftClosings.map((row) => (
                <tr key={row.item.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3 font-medium">{row.item.item_code}</td>
                  <td className="px-4 py-3">{row.item.name}</td>
                  <td className="px-4 py-3 text-right">{row.openingQty}</td>
                  <td className="px-4 py-3 text-right">{row.purchaseQty}</td>
                  <td className="px-4 py-3 text-right">{row.usageQty}</td>
                  <td className="px-4 py-3 text-right">{row.adjustmentQty}</td>
                  <td className="px-4 py-3 text-right">{row.systemEndingQty}</td>
                  <td className="px-4 py-3 text-right">{row.countedEnding ?? "-"}</td>
                  <td className="px-4 py-3 text-right">{row.varianceQty ?? "-"}</td>
                  <td className="px-4 py-3 text-right">{money(row.usageAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t bg-muted/30 px-4 py-3 text-sm font-medium">
          {c("NVL:")} {money(ingredientUsage)} {c("| CCDC:")} {money(toolUsage)} {c("| Tổng chi phí bếp:")} {money(totalUsage)}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{money(value)}</div>
    </div>
  );
}
