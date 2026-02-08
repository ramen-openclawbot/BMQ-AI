import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSuppliers } from "@/hooks/useSuppliers";
import ExcelJS from "exceljs";

export function ExportSuppliersButton() {
  const { data: suppliers } = useSuppliers();

  const handleExport = async () => {
    if (!suppliers || suppliers.length === 0) {
      return;
    }

    try {
      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Suppliers");

      // Define columns
      worksheet.columns = [
        { header: "Name", key: "name", width: 25 },
        { header: "Category", key: "category", width: 20 },
        { header: "Description", key: "description", width: 40 },
        { header: "Phone", key: "phone", width: 15 },
        { header: "Email", key: "email", width: 30 },
      ];

      // Add data rows
      suppliers.forEach((supplier) => {
        worksheet.addRow({
          name: supplier.name,
          category: supplier.category || "",
          description: supplier.description || "",
          phone: supplier.phone || "",
          email: supplier.email || "",
        });
      });

      // Style header row
      worksheet.getRow(1).font = { bold: true };

      // Generate filename with date
      const date = new Date().toISOString().split("T")[0];
      const filename = `suppliers_backup_${date}.xlsx`;

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
    <Button variant="outline" onClick={handleExport}>
      <Download className="h-4 w-4 mr-2" />
      Export
    </Button>
  );
}
