import { Download, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSuppliers } from "@/hooks/useSuppliers";
import ExcelJS from "exceljs";

interface ExportSuppliersButtonProps {
  compactIcon?: LucideIcon;
}

export function ExportSuppliersButton({ compactIcon: Icon = Download }: ExportSuppliersButtonProps = {}) {
  const { data: suppliers } = useSuppliers();

  const handleExport = async () => {
    if (!suppliers || suppliers.length === 0) {
      return;
    }

    try {
      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Nhà cung cấp");

      // Define columns
      worksheet.columns = [
        { header: "Tên NCC", key: "name", width: 25 },
        { header: "Nhóm", key: "category", width: 20 },
        { header: "Mô tả", key: "description", width: 40 },
        { header: "SĐT", key: "phone", width: 15 },
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
      const filename = `nha_cung_cap_${date}.xlsx`;

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
    <Button variant="outline" onClick={handleExport} className="h-10 rounded-xl border-amber-200 bg-white px-2 text-xs text-amber-800 hover:bg-amber-50 sm:px-3 sm:text-sm">
      <Icon className="mr-1.5 h-4 w-4 sm:mr-2" />
      Xuất Excel
    </Button>
  );
}
