import { AlertCircle, CheckCircle2, FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KitchenImportBatch, KitchenImportRow } from "@/hooks/useKitchenInventory";
import { money } from "@/lib/kitchen-inventory/calculations";

interface ImportReviewTabProps {
  batches: KitchenImportBatch[];
  rows: KitchenImportRow[];
  loading: boolean;
}

const decisionClass: Record<KitchenImportRow["approval_decision"], string> = {
  APPROVE: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  REVIEW: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  REJECT: "bg-red-500/10 text-red-600 dark:text-red-300",
};

export function ImportReviewTab({ batches, rows, loading }: ImportReviewTabProps) {
  const latestBatch = batches[0];
  const reviewRows = rows.filter((row) => row.approval_decision === "REVIEW");

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold">
              <FileSpreadsheet className="h-5 w-5 text-primary" />
              Import dữ liệu kế toán T3/T4
            </div>
            <p className="text-sm text-muted-foreground">
              Sheet chuẩn: <span className="font-medium">01_IMPORT_REVIEW</span>. APPROVE ghi đè danh mục chuẩn; REVIEW/REJECT chỉ lưu audit.
            </p>
          </div>
          <Button variant="outline" disabled title="First launch uses the approved admin import script">
            Upload XLSX
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Tổng dòng" value={latestBatch?.rows_total ?? 0} />
        <Metric label="APPROVE" value={latestBatch?.rows_approved ?? 0} tone="success" />
        <Metric label="REVIEW" value={latestBatch?.rows_review ?? 0} tone="warning" />
        <Metric label="REJECT" value={latestBatch?.rows_rejected ?? 0} tone="danger" />
      </div>

      {reviewRows.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{reviewRows.length} dòng đang cần kế toán review trước khi đưa vào danh mục chuẩn.</span>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h3 className="font-semibold">Preview dòng import gần nhất</h3>
          <p className="text-sm text-muted-foreground">
            Trạng thái từng dòng phản ánh kết quả staging/apply từ script import.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead className="bg-muted/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Row</th>
                <th className="px-4 py-3">Decision</th>
                <th className="px-4 py-3">Tên chuẩn kế toán</th>
                <th className="px-4 py-3">ĐVT</th>
                <th className="px-4 py-3 text-right">Đơn giá</th>
                <th className="px-4 py-3">Kết quả</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                    Đang tải dữ liệu import...
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>
                    Chưa có batch import. Chạy script admin để staging/apply workbook đã review.
                  </td>
                </tr>
              )}
              {!loading && rows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3">{row.source_row_number}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${decisionClass[row.approval_decision]}`}>
                      {row.approval_decision}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{row.source_item_name}</td>
                  <td className="px-4 py-3">{row.source_unit || "-"}</td>
                  <td className="px-4 py-3 text-right">{money(row.source_standard_unit_cost)}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      {row.import_status === "applied" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                      {row.import_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  const toneClass =
    tone === "success" ? "text-emerald-600 dark:text-emerald-300" :
    tone === "warning" ? "text-amber-600 dark:text-amber-300" :
    tone === "danger" ? "text-red-600 dark:text-red-300" :
    "text-foreground";

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
