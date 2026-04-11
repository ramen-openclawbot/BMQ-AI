import { Package, Users, FileCheck, AlertTriangle } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { AddPaymentRequestDialog } from "@/components/dialogs/AddPaymentRequestDialog";
import { useInventory, useLowStockItems } from "@/hooks/useInventory";
import { useSuppliers } from "@/hooks/useSuppliers";
import { usePaymentRequests } from "@/hooks/usePaymentRequests";

const Index = () => {
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
          <h1 className="text-3xl font-display font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Tổng quan nhanh</p>
        </div>
        <AddPaymentRequestDialog />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Items"
          value={isLoading ? "..." : String(inventory?.length || 0)}
          subtitle="In your inventory"
          icon={Package}
        />
        <StatCard
          title="Active Suppliers"
          value={isLoading ? "..." : String(suppliers?.length || 0)}
          subtitle="Managing your supply"
          icon={Users}
        />
        <StatCard
          title="Pending Approvals"
          value={isLoading ? "..." : String(pendingPaymentRequests)}
          subtitle="Awaiting review"
          icon={FileCheck}
        />
        <StatCard
          title="Low Stock Items"
          value={isLoading ? "..." : String(lowStockItems?.length || 0)}
          subtitle="Needs attention"
          icon={AlertTriangle}
          variant={lowStockItems?.length ? "warning" : undefined}
        />
      </div>

      <QuickActions />
    </div>
  );
};

export default Index;
