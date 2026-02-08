import { useState } from "react";
import { FileDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { vi } from "date-fns/locale";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import bmqLogo from "@/assets/bmq-logo.png";
import { loadRobotoFont, loadRobotoBoldFont, loadImageWithDimensions } from "@/lib/pdf-fonts";
import { toast } from "sonner";

export interface ItemWithSupplier {
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number | null;
  unit: string | null;
  supplier_name: string;
  payment_method: string | null;
  request_number: string;
}

interface ExportApprovedPDFDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uncItems: ItemWithSupplier[];
  cashItems: ItemWithSupplier[];
  uncTotal: number;
  cashTotal: number;
  grandTotal: number;
  uncVat: number;
  cashVat: number;
  uncSubtotal: number;
  cashSubtotal: number;
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat("vi-VN").format(amount);
};

export function ExportApprovedPDFDialog({
  open,
  onOpenChange,
  uncItems,
  cashItems,
  uncTotal,
  cashTotal,
  grandTotal,
  uncVat,
  cashVat,
  uncSubtotal,
  cashSubtotal,
}: ExportApprovedPDFDialogProps) {
  const [isExporting, setIsExporting] = useState(false);

  const handleDownload = async () => {
    setIsExporting(true);

    try {
      const doc = new jsPDF();

      // Load and register Roboto fonts for Vietnamese support
      try {
        const [robotoBase64, robotoBoldBase64] = await Promise.all([
          loadRobotoFont(),
          loadRobotoBoldFont()
        ]);
        doc.addFileToVFS("Roboto-Regular.ttf", robotoBase64);
        doc.addFileToVFS("Roboto-Bold.ttf", robotoBoldBase64);
        doc.addFont("Roboto-Regular.ttf", "Roboto", "normal");
        doc.addFont("Roboto-Bold.ttf", "Roboto", "bold");
        doc.setFont("Roboto");
      } catch (fontError) {
        console.warn("Could not load Roboto fonts, falling back to default:", fontError);
      }

      // Load logo with proper aspect ratio
      try {
        const logoData = await loadImageWithDimensions(bmqLogo);
        const targetHeight = 20;
        const aspectRatio = logoData.width / logoData.height;
        const targetWidth = targetHeight * aspectRatio;
        doc.addImage(logoData.base64, "PNG", 15, 10, targetWidth, targetHeight);
      } catch {
        console.log("Could not load logo");
      }

      // Header
      doc.setFontSize(18);
      doc.setFont("Roboto", "bold");
      doc.text("PHIẾU DUYỆT CHI", 105, 25, { align: "center" });

      doc.setFont("Roboto", "normal");
      doc.setFontSize(11);
      doc.text(`Ngày: ${format(new Date(), "dd/MM/yyyy", { locale: vi })}`, 105, 33, { align: "center" });

      let currentY = 45;

      // Table columns with Vietnamese text
      const tableHead = [["STT", "Tên sản phẩm", "NCC", "SL", "Đơn giá", "Thành tiền"]];
      const columnStyles = {
        0: { cellWidth: 12 },
        1: { cellWidth: 55 },
        2: { cellWidth: 35 },
        3: { cellWidth: 18 },
        4: { cellWidth: 28 },
        5: { cellWidth: 30 }
      };

      // Common table styles with Roboto font
      const tableStyles = {
        font: "Roboto",
        fontSize: 9,
        cellPadding: 3
      };

      // UNC Section
      if (uncItems.length > 0) {
        doc.setFont("Roboto", "bold");
        doc.setFontSize(12);
        doc.text("I. THANH TOÁN CHUYỂN KHOẢN (UNC)", 15, currentY);
        doc.setFont("Roboto", "normal");
        currentY += 5;

        const uncBody = uncItems.map((item, i) => [
          (i + 1).toString(),
          item.product_name,
          item.supplier_name,
          `${item.quantity} ${item.unit || ""}`.trim(),
          formatCurrency(item.unit_price),
          formatCurrency(item.line_total || item.quantity * item.unit_price)
        ]);

        // Build footer rows with subtotal, VAT (if any), and total
        const uncFootRows: string[][] = [];
        if (uncVat > 0) {
          uncFootRows.push(["", "", "", "", "Tạm tính:", formatCurrency(uncSubtotal)]);
          uncFootRows.push(["", "", "", "", "VAT:", formatCurrency(uncVat)]);
        }
        uncFootRows.push(["", "", "", "", "Tổng UNC:", formatCurrency(uncTotal)]);

        autoTable(doc, {
          startY: currentY,
          head: tableHead,
          body: uncBody,
          foot: uncFootRows,
          theme: "striped",
          headStyles: { fillColor: [100, 100, 100], textColor: 255, font: "Roboto", fontStyle: "bold", halign: "center" },
          footStyles: { fillColor: [236, 240, 241], textColor: [0, 0, 0], font: "Roboto", fontStyle: "bold" },
          columnStyles,
          styles: tableStyles,
          margin: { left: 15, right: 15 }
        });

        currentY = (doc as any).lastAutoTable.finalY + 10;
      }

      // Cash Section
      if (cashItems.length > 0) {
        // Check if we need a new page
        if (currentY > 230) {
          doc.addPage();
          currentY = 20;
        }

        doc.setFont("Roboto", "bold");
        doc.setFontSize(12);
        doc.text("II. THANH TOÁN TIỀN MẶT", 15, currentY);
        doc.setFont("Roboto", "normal");
        currentY += 5;

        const cashBody = cashItems.map((item, i) => [
          (i + 1).toString(),
          item.product_name,
          item.supplier_name,
          `${item.quantity} ${item.unit || ""}`.trim(),
          formatCurrency(item.unit_price),
          formatCurrency(item.line_total || item.quantity * item.unit_price)
        ]);

        // Build footer rows with subtotal, VAT (if any), and total
        const cashFootRows: string[][] = [];
        if (cashVat > 0) {
          cashFootRows.push(["", "", "", "", "Tạm tính:", formatCurrency(cashSubtotal)]);
          cashFootRows.push(["", "", "", "", "VAT:", formatCurrency(cashVat)]);
        }
        cashFootRows.push(["", "", "", "", "Tổng tiền mặt:", formatCurrency(cashTotal)]);

        autoTable(doc, {
          startY: currentY,
          head: tableHead,
          body: cashBody,
          foot: cashFootRows,
          theme: "striped",
          headStyles: { fillColor: [100, 100, 100], textColor: 255, font: "Roboto", fontStyle: "bold", halign: "center" },
          footStyles: { fillColor: [236, 240, 241], textColor: [0, 0, 0], font: "Roboto", fontStyle: "bold" },
          columnStyles,
          styles: tableStyles,
          margin: { left: 15, right: 15 }
        });

        currentY = (doc as any).lastAutoTable.finalY + 10;
      }

      // Grand Total
      if (currentY > 250) {
        doc.addPage();
        currentY = 20;
      }

      doc.setFillColor(52, 73, 94);
      doc.rect(15, currentY, 180, 12, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(12);
      doc.text(`TỔNG CỘNG ĐỢT DUYỆT CHI: ${formatCurrency(grandTotal)} VNĐ`, 105, currentY + 8, { align: "center" });
      doc.setTextColor(0, 0, 0);

      currentY += 25;

      // Signature section
      if (currentY > 250) {
        doc.addPage();
        currentY = 20;
      }

      doc.setFontSize(11);
      doc.text("Người lập phiếu", 55, currentY, { align: "center" });
      doc.text("Người duyệt", 155, currentY, { align: "center" });

      doc.setFontSize(9);
      doc.text("(Ký, ghi rõ họ tên)", 55, currentY + 6, { align: "center" });
      doc.text("(Ký, ghi rõ họ tên)", 155, currentY + 6, { align: "center" });

      // Save PDF
      const fileName = `phieu-duyet-chi-${format(new Date(), "dd-MM-yyyy-HHmm")}.pdf`;
      doc.save(fileName);

      toast.success(`Đã xuất ${fileName}`);
      onOpenChange(false);
    } catch (error) {
      console.error("Export error:", error);
      toast.error("Lỗi khi xuất PDF");
    } finally {
      setIsExporting(false);
    }
  };

  const renderItemsTable = (
    items: ItemWithSupplier[], 
    title: string, 
    subtotal: number, 
    vat: number, 
    total: number
  ) => {
    if (items.length === 0) return null;

    const isUNC = title.includes("UNC");

    return (
      <div className="mb-6">
        <h3 className="font-bold text-sm mb-2 border-b border-black pb-1">{title}</h3>
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-100 border border-black">
              <TableHead className="w-12 text-center text-black font-bold border-r border-black">STT</TableHead>
              <TableHead className="text-black font-bold border-r border-black">Tên sản phẩm</TableHead>
              <TableHead className="text-black font-bold border-r border-black">NCC</TableHead>
              <TableHead className="text-center text-black font-bold border-r border-black">SL</TableHead>
              <TableHead className="text-right text-black font-bold border-r border-black">Đơn giá</TableHead>
              <TableHead className="text-right text-black font-bold">Thành tiền</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={index} className="border border-black">
                <TableCell className="text-center border-r border-black">{index + 1}</TableCell>
                <TableCell className="border-r border-black">{item.product_name}</TableCell>
                <TableCell className="border-r border-black">{item.supplier_name}</TableCell>
                <TableCell className="text-center border-r border-black">
                  {item.quantity} {item.unit || ""}
                </TableCell>
                <TableCell className="text-right border-r border-black">
                  {formatCurrency(item.unit_price)}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(item.line_total || item.quantity * item.unit_price)}
                </TableCell>
              </TableRow>
            ))}
            {/* Subtotal and VAT rows if VAT exists */}
            {vat > 0 && (
              <>
                <TableRow className="border border-black bg-gray-50">
                  <TableCell colSpan={5} className="text-right font-medium border-r border-black">
                    Tạm tính:
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(subtotal)}</TableCell>
                </TableRow>
                <TableRow className="border border-black bg-gray-50">
                  <TableCell colSpan={5} className="text-right font-medium border-r border-black">
                    VAT:
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(vat)}</TableCell>
                </TableRow>
              </>
            )}
            {/* Total row */}
            <TableRow className="bg-gray-200 font-bold border border-black">
              <TableCell colSpan={5} className="text-right border-r border-black">
                {isUNC ? "Tổng UNC:" : "Tổng tiền mặt:"}
              </TableCell>
              <TableCell className="text-right">{formatCurrency(total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-black">Xem trước Phiếu Duyệt Chi</DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 h-[60vh] pr-4">
          <div className="space-y-4 p-4 bg-white rounded-lg border text-black">
            {/* Header */}
            <div className="flex items-start gap-4">
              <img src={bmqLogo} alt="BMQ Logo" className="h-12 w-auto" />
              <div className="flex-1 text-center">
                <h2 className="text-xl font-bold text-black">PHIẾU DUYỆT CHI</h2>
                <p className="text-sm text-gray-600">
                  Ngày: {format(new Date(), "dd/MM/yyyy", { locale: vi })}
                </p>
              </div>
            </div>

            {/* UNC Section */}
            {renderItemsTable(
              uncItems,
              "I. THANH TOÁN CHUYỂN KHOẢN (UNC)",
              uncSubtotal,
              uncVat,
              uncTotal
            )}

            {/* Cash Section */}
            {renderItemsTable(
              cashItems,
              "II. THANH TOÁN TIỀN MẶT",
              cashSubtotal,
              cashVat,
              cashTotal
            )}

            {/* Grand Total */}
            <div className="bg-gray-800 text-white p-3 rounded-md text-center font-bold border-2 border-black">
              TỔNG CỘNG ĐỢT DUYỆT CHI: {formatCurrency(grandTotal)} VNĐ
            </div>

            {/* Signature Section */}
            <div className="flex justify-around pt-6 pb-4">
              <div className="text-center">
                <p className="font-medium text-black">Người lập phiếu</p>
                <p className="text-sm text-gray-600">(Ký, ghi rõ họ tên)</p>
              </div>
              <div className="text-center">
                <p className="font-medium text-black">Người duyệt</p>
                <p className="text-sm text-gray-600">(Ký, ghi rõ họ tên)</p>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="h-4 w-4 mr-2" />
            Hủy
          </Button>
          <Button onClick={handleDownload} disabled={isExporting}>
            <FileDown className="h-4 w-4 mr-2" />
            {isExporting ? "Đang xuất..." : "Tải xuống"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
