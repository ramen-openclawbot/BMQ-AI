import { useLanguage } from "@/contexts/LanguageContext";
import { Package, Users, FileCheck, AlertTriangle } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { AddPaymentRequestDialog } from "@/components/dialogs/AddPaymentRequestDialog";
import { useInventory, useLowStockItems } from "@/hooks/useInventory";
import { useSuppliers } from "@/hooks/useSuppliers";
import { usePaymentRequests } from "@/hooks/usePaymentRequests";

const Index = () => {
  const { t } = useLanguage();
  const { data: inventory, isLoading: inventoryLoading } = useInventory();
  const { data: suppliers, isLoading: suppliersLoading } = useSuppliers();
  const { data: lowStockItems, isLoading: lowStockLoading } = useLowStockItems();
  const { data: paymentRequests, isLoading: paymentRequestsLoading } = usePaymentRequests();

  const isLoading = inventoryLoading || suppliersLoading || lowStockLoading || paymentRequestsLoading;
  const pendingPaymentRequests = paymentRequests?.filter((r) => r.status === "pending").length || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">{t.dashboardTitle}</h1>
          <p className="text-muted-foreground mt-1">{t.dashboardDescription}</p>
        </div>
        <AddPaymentRequestDialog />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t.dashboardTotalItems}
          value={isLoading ? "..." : String(inventory?.length || 0)}
          subtitle={t.dashboardTotalItemsDesc}
          icon={Package}
        />
        <StatCard
          title={t.dashboardActiveSuppliers}
          value={isLoading ? "..." : String(suppliers?.length || 0)}
          subtitle={t.dashboardActiveSuppliersDesc}
          icon={Users}
        />
        <StatCard
          title={t.dashboardPendingApprovals}
          value={isLoading ? "..." : String(pendingPaymentRequests)}
          subtitle={t.dashboardPendingApprovalsDesc}
          icon={FileCheck}
        />
        <StatCard
          title={t.dashboardLowStockItems}
          value={isLoading ? "..." : String(lowStockItems?.length || 0)}
          subtitle={t.dashboardLowStockItemsDesc}
          icon={AlertTriangle}
          variant={lowStockItems?.length ? "warning" : undefined}
        />
      </div>

      <QuickActions />
    </div>
  );
};

export default Index;
