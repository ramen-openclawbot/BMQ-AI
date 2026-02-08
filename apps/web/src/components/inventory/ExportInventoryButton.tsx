import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInventory } from "@/hooks/useInventory";
import ExcelJS from "exceljs";

export function ExportInventoryButton() {
  const { data: inventory } = useInventory();

  const handleExport = async () => {
    if (!inventory || inventory.length === 0) {
      return;
    }

    try {
      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Inventory");

      // Define columns
      worksheet.columns = [
        { header: "Name", key: "name", width: 30 },
        { header: "Category", key: "category", width: 20 },
        { header: "Quantity", key: "quantity", width: 12 },
        { header: "Unit", key: "unit", width: 10 },
        { header: "Min Stock", key: "min_stock", width: 12 },
      ];

      // Add data rows
      inventory.forEach((item) => {
        worksheet.addRow({
          name: item.name,
          category: item.category || "",
          quantity: item.quantity,
          unit: item.unit || "",
          min_stock: item.min_stock || 0,
        });
      });

      // Style header row
      worksheet.getRow(1).font = { bold: true };

      // Generate filename with date
      const date = new Date().toISOString().split("T")[0];
      const filename = `inventory_backup_${date}.xlsx`;

      // Generate buffer and download
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Export error:", error);
    }
  };

  return (
    <Button variant="outline" onClick={handleExport} className="gap-2">
      <Download className="h-4 w-4" />
      Export
    </Button>
  );
}
