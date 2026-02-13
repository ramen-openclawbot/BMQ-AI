import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InventoryTable } from "@/components/dashboard/InventoryTable";
import { AddInventoryDialog } from "@/components/dialogs/AddInventoryDialog";
import { ExportInventoryButton } from "@/components/inventory/ExportInventoryButton";
import { ExpiryStatsDialog } from "@/components/inventory/ExpiryStatsDialog";
import { useLanguage } from "@/contexts/LanguageContext";

const Inventory = () => {
  const { t } = useLanguage();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">
            {t.inventoryTitle}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t.inventoryDescription}
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" className="gap-2">
            <Filter className="h-4 w-4" />
            {t.filter}
          </Button>
          <ExportInventoryButton />
          <ExpiryStatsDialog />
          <AddInventoryDialog />
        </div>
      </div>

      <InventoryTable />
    </div>
  );
};

export default Inventory;
