import { SupplierList } from "@/components/dashboard/SupplierList";
import { AddSupplierDialog } from "@/components/dialogs/AddSupplierDialog";
import { ExportSuppliersButton } from "@/components/suppliers/ExportSuppliersButton";
import { ImportSuppliersButton } from "@/components/suppliers/ImportSuppliersButton";

const Suppliers = () => {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">
            Suppliers
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your supplier relationships
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportSuppliersButton />
          <ExportSuppliersButton />
          <AddSupplierDialog />
        </div>
      </div>

      <SupplierList />
    </div>
  );
};

export default Suppliers;
