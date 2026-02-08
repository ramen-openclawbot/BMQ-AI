import { useState } from "react";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ExportApprovedPDFDialog, ItemWithSupplier } from "./ExportApprovedPDFDialog";
import type { PaymentRequestWithSupplier } from "@/hooks/usePaymentRequests";

interface ExportApprovedPDFProps {
  selectedIds: string[];
  requests: PaymentRequestWithSupplier[];
}

export function ExportApprovedPDF({ selectedIds, requests }: ExportApprovedPDFProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [uncItems, setUncItems] = useState<ItemWithSupplier[]>([]);
  const [cashItems, setCashItems] = useState<ItemWithSupplier[]>([]);
  const [uncTotal, setUncTotal] = useState(0);
  const [cashTotal, setCashTotal] = useState(0);
  const [grandTotal, setGrandTotal] = useState(0);
  const [uncVat, setUncVat] = useState(0);
  const [cashVat, setCashVat] = useState(0);
  const [uncSubtotal, setUncSubtotal] = useState(0);
  const [cashSubtotal, setCashSubtotal] = useState(0);

  // Filter only approved requests from selected IDs
  const selectedApprovedIds = selectedIds.filter(id => {
    const request = requests.find(r => r.id === id);
    return request?.status === "approved";
  });

  const handleClick = async () => {
    if (selectedApprovedIds.length === 0) {
      toast.error("Không có đề nghị chi đã duyệt nào được chọn");
      return;
    }

    setIsLoading(true);

    try {
      // Get selected approved requests with their details
      const selectedApproved = requests.filter(
        r => selectedApprovedIds.includes(r.id)
      );

      // Fetch items for each request
      const allItemsPromises = selectedApproved.map(async (pr) => {
        const { data: items, error } = await supabase
          .from("payment_request_items")
          .select("product_name, quantity, unit_price, line_total, unit")
          .eq("payment_request_id", pr.id);

        if (error) throw error;

        return (items || []).map(item => ({
          ...item,
          supplier_name: pr.suppliers?.name || "Không xác định",
          payment_method: pr.payment_method,
          request_number: pr.request_number
        }));
      });

      const allItemsNested = await Promise.all(allItemsPromises);
      const allItems: ItemWithSupplier[] = allItemsNested.flat();

      // Separate by payment method
      const unc = allItems.filter(i => i.payment_method === "bank_transfer");
      const cash = allItems.filter(i => i.payment_method === "cash");

      // Calculate totals from payment_requests.total_amount (includes VAT)
      // This ensures the PDF total matches the UI selection total
      const uncRequestsTotal = selectedApproved
        .filter(pr => pr.payment_method === "bank_transfer")
        .reduce((sum, pr) => sum + (pr.total_amount || 0), 0);
      const cashRequestsTotal = selectedApproved
        .filter(pr => pr.payment_method === "cash")
        .reduce((sum, pr) => sum + (pr.total_amount || 0), 0);
      const total = uncRequestsTotal + cashRequestsTotal;

      // Calculate VAT totals for display
      const uncVat = selectedApproved
        .filter(pr => pr.payment_method === "bank_transfer")
        .reduce((sum, pr) => sum + (pr.vat_amount || 0), 0);
      const cashVat = selectedApproved
        .filter(pr => pr.payment_method === "cash")
        .reduce((sum, pr) => sum + (pr.vat_amount || 0), 0);

      // Calculate subtotals (total - vat)
      const uncSubtotal = uncRequestsTotal - uncVat;
      const cashSubtotal = cashRequestsTotal - cashVat;

      setUncItems(unc);
      setCashItems(cash);
      setUncTotal(uncRequestsTotal);
      setCashTotal(cashRequestsTotal);
      setGrandTotal(total);
      setUncVat(uncVat);
      setCashVat(cashVat);
      setUncSubtotal(uncSubtotal);
      setCashSubtotal(cashSubtotal);
      setDialogOpen(true);
    } catch (error) {
      console.error("Error loading items:", error);
      toast.error("Lỗi khi tải dữ liệu");
    } finally {
      setIsLoading(false);
    }
  };

  if (selectedApprovedIds.length === 0) {
    return null;
  }

  return (
    <>
      <Button
        onClick={handleClick}
        disabled={isLoading}
        variant="outline"
        className="gap-2"
      >
        <FileDown className="h-4 w-4" />
        {isLoading ? "Đang tải..." : `Xuất PDF (${selectedApprovedIds.length})`}
      </Button>

      <ExportApprovedPDFDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        uncItems={uncItems}
        cashItems={cashItems}
        uncTotal={uncTotal}
        cashTotal={cashTotal}
        grandTotal={grandTotal}
        uncVat={uncVat}
        cashVat={cashVat}
        uncSubtotal={uncSubtotal}
        cashSubtotal={cashSubtotal}
      />
    </>
  );
}
