import { useWarehouseCopy } from "@/i18n/useWarehouseCopy";
import { useMemo, useState } from "react";
import { AlertTriangle, BookOpenCheck, FileSpreadsheet, ListChecks, PackageSearch, Utensils } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { useKitchenInventory } from "@/hooks/useKitchenInventory";
import { money, summarizeKitchenMovements } from "@/lib/kitchen-inventory/calculations";
import { periodMonthFromDate } from "@/lib/kitchen-inventory/normalize";
import { DailyLedgerTab } from "@/pages/kitchen-inventory/DailyLedgerTab";
import { ImportReviewTab } from "@/pages/kitchen-inventory/ImportReviewTab";
import { ItemMasterTab } from "@/pages/kitchen-inventory/ItemMasterTab";
import { MonthlyCloseTab } from "@/pages/kitchen-inventory/MonthlyCloseTab";

type TabKey = "overview" | "import" | "master" | "ledger" | "closing";

export default function KitchenInventory() {
  const c = useWarehouseCopy();
  const tabs: { key: TabKey; label: string; icon: typeof Utensils }[] = [
    { key: "overview", label: c("Tổng quan"), icon: Utensils },
    { key: "import", label: c("Import T3/T4"), icon: FileSpreadsheet },
    { key: "master", label: c("Danh mục chuẩn"), icon: PackageSearch },
    { key: "ledger", label: c("Ledger hằng ngày"), icon: BookOpenCheck },
    { key: "closing", label: c("Chốt tháng"), icon: ListChecks },
  ];
  const { canAccessModule } = useAuth();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [periodMonth, setPeriodMonth] = useState(periodMonthFromDate(new Date()));

  const kitchen = useKitchenInventory(periodMonth);
  const movements = kitchen.movementsQuery.data;
  const rows = kitchen.rowsQuery.data || [];
  const items = kitchen.itemsQuery.data || [];
  const batches = kitchen.batchesQuery.data || [];
  const otherCosts = kitchen.otherCostsQuery.data;

  const summary = useMemo(() => summarizeKitchenMovements(movements ?? [], otherCosts ?? []), [movements, otherCosts]);
  const reviewCount = rows.filter((row) => row.approval_decision === "REVIEW").length;
  const stagedApprovedCount = rows.filter((row) => row.approval_decision === "APPROVE" && row.import_status === "staged").length;
  const closedCount = (kitchen.closingsQuery.data || []).filter((row) => row.status === "closed").length;

  if (!canAccessModule("kitchen_inventory")) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
          <h1 className="mt-3 text-xl font-semibold">{c("Không có quyền truy cập")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {c("Module Kiểm soát kho bếp yêu cầu quyền kitchen_inventory.view.")} </p>
        </div>
      </div>
    );
  }

  return (
    <div data-bmq-warehouse-i18n="v1" className="space-y-6 p-4 md:p-6">
      <div className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Utensils className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">{c("Kiểm soát kho bếp")}</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {c("File kế toán là nguồn chuẩn cho danh mục và chi phí kho bếp. Kho hàng hiện tại chỉ dùng tham khảo.")} </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setActiveTab("import")}>{c("Import")}</Button>
          <Button variant="outline" disabled>{c("Export")}</Button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto rounded-xl border bg-card p-2 shadow-sm">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">{c("Period:")}</span>
          <input
            type="month"
            value={periodMonth.slice(0, 7)}
            onChange={(event) => setPeriodMonth(`${event.target.value}-01`)}
            className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <div className="text-sm text-muted-foreground">
          {c("Trusted source: accounting-reviewed workbook / approved rows")} </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <OverviewMetric label={c("NVL sử dụng")} value={summary.usageAmount} />
            <OverviewMetric label={c("Nhập trong kỳ")} value={summary.purchaseAmount} />
            <OverviewMetric label={c("Sửa chữa/khác")} value={summary.otherAmount} />
            <OverviewMetric label={c("Tổng chi phí")} value={summary.totalKitchenCost} emphasize />
          </div>

          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="font-semibold">{c("Cảnh báo")}</h2>
            <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
              <StatusLine label={c("reviewRows", { count: reviewCount })} warning={reviewCount > 0} />
              <StatusLine label={c("stagedRows", { count: stagedApprovedCount })} warning={stagedApprovedCount > 0} />
              <StatusLine label={c("closingStatus", { month: periodMonth.slice(5, 7), year: periodMonth.slice(0, 4), status: closedCount > 0 ? "CLOSED" : "DRAFT" })} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <QuickCard title={c("Danh mục chuẩn")} value={items.length} description={c("Item kế toán đã duyệt")} onClick={() => setActiveTab("master")} />
            <QuickCard title={c("Ledger tháng")} value={(movements ?? []).length} description={c("Dòng phát sinh/import")} onClick={() => setActiveTab("ledger")} />
            <QuickCard title={c("Batch import")} value={batches.length} description={c("File đã staging/apply")} onClick={() => setActiveTab("import")} />
          </div>
        </div>
      )}

      {activeTab === "import" && (
        <ImportReviewTab
          batches={batches}
          rows={rows}
          loading={kitchen.rowsQuery.isLoading || kitchen.batchesQuery.isLoading}
        />
      )}
      {activeTab === "master" && (
        <ItemMasterTab items={items} loading={kitchen.itemsQuery.isLoading} />
      )}
      {activeTab === "ledger" && (
        <DailyLedgerTab
          periodMonth={periodMonth}
          items={items}
          movements={movements ?? []}
          canEdit={kitchen.canEdit}
          addMovement={kitchen.addMovement}
        />
      )}
      {activeTab === "closing" && (
        <MonthlyCloseTab
          periodMonth={periodMonth}
          draftClosings={kitchen.draftClosings}
          savedClosings={kitchen.closingsQuery.data || []}
          canEdit={kitchen.canEdit}
          closeMonth={kitchen.closeMonth}
        />
      )}
    </div>
  );
}

function OverviewMetric({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={`mt-2 text-xl font-semibold ${emphasize ? "text-primary" : ""}`}>{money(value)}</div>
    </div>
  );
}

function StatusLine({ label, warning }: { label: string; warning?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warning ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200" : "bg-muted/40"}`}>
      {label}
    </div>
  );
}

function QuickCard({ title, value, description, onClick }: { title: string; value: number; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/40"
    >
      <div className="text-sm text-muted-foreground">{title}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </button>
  );
}
