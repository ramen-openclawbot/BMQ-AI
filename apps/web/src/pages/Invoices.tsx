import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useInvoices, useDeleteInvoice } from "@/hooks/useInvoices";
import { AddInvoiceDialog } from "@/components/dialogs/AddInvoiceDialog";
import { EditInvoiceDialog } from "@/components/dialogs/EditInvoiceDialog";
import { InvoiceDetailsDialog } from "@/components/dialogs/InvoiceDetailsDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FileText, Pencil, Trash2, Image, RefreshCw, CreditCard, Eye } from "lucide-react";
import { format } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { resolveImageUrl } from "@/lib/storage-url";
import { toast } from "sonner";

const Invoices = () => {
  const { user } = useAuth();
  const { language } = useLanguage();
  const isVi = language === "vi";

  const [searchParams, setSearchParams] = useSearchParams();
  const { data: invoices, isLoading, isError, error, refetch, isFetching } = useInvoices();
  const deleteInvoice = useDeleteInvoice();
  const [viewingInvoiceId, setViewingInvoiceId] = useState<string | null>(null);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [deletingInvoiceId, setDeletingInvoiceId] = useState<string | null>(null);
  const [viewingImageUrl, setViewingImageUrl] = useState<string | null>(null);
  const [viewingImageTitle, setViewingImageTitle] = useState<string>(isVi ? "Ảnh hóa đơn" : "Invoice image");

  useEffect(() => {
    if (user && !isLoading && !invoices?.length && !isError) {
      refetch();
    }
  }, [user, isLoading, invoices, isError, refetch]);

  useEffect(() => {
    const viewInvoiceId = searchParams.get("view");
    if (viewInvoiceId && invoices?.some((inv) => inv.id === viewInvoiceId)) {
      setViewingInvoiceId(viewInvoiceId);
      searchParams.delete("view");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, invoices, setSearchParams]);

  const openAttachmentPreview = async (rawUrl: string | null | undefined, title: string, preferredBucket = "invoices") => {
    const resolved = await resolveImageUrl(rawUrl || null, { preferredBucket });

    if (!resolved) {
      toast.error(isVi ? "Không tìm thấy file đính kèm trong kho lưu trữ" : "Attachment file was not found in storage");
      setViewingImageUrl(null);
      return;
    }

    setViewingImageUrl(resolved);
    setViewingImageTitle(title);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);
  };

  const handleDelete = async () => {
    if (deletingInvoiceId) {
      await deleteInvoice.mutateAsync(deletingInvoiceId);
      setDeletingInvoiceId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">{isVi ? "Hóa đơn" : "Invoices"}</h1>
          <p className="text-muted-foreground mt-1">{isVi ? "Quản lý hóa đơn nhà cung cấp và cập nhật tồn kho" : "Manage supplier invoices and update inventory"}</p>
        </div>
        <AddInvoiceDialog />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {isVi ? "Tất cả hóa đơn" : "All invoices"}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : isError ? (
            <div className="p-6 space-y-3">
              <p className="font-medium text-foreground">{isVi ? "Không thể tải hóa đơn" : "Couldn't load invoices"}</p>
              <p className="text-sm text-muted-foreground break-words">{error instanceof Error ? error.message : isVi ? "Lỗi không xác định" : "Unknown error"}</p>
              <Button variant="outline" onClick={() => refetch()}>{isVi ? "Thử lại" : "Retry"}</Button>
            </div>
          ) : invoices && invoices.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{isVi ? "Mã hóa đơn" : "Invoice #"}</TableHead>
                  <TableHead>{isVi ? "Ngày" : "Date"}</TableHead>
                  <TableHead>{isVi ? "Nhà cung cấp" : "Supplier"}</TableHead>
                  <TableHead className="text-right">{isVi ? "Tạm tính" : "Subtotal"}</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">{isVi ? "Tổng" : "Total"}</TableHead>
                  <TableHead>{isVi ? "Tệp đính kèm" : "Attachments"}</TableHead>
                  <TableHead className="text-right">{isVi ? "Thao tác" : "Actions"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium">{invoice.invoice_number}</TableCell>
                    <TableCell>{format(new Date(invoice.invoice_date), "dd/MM/yyyy")}</TableCell>
                    <TableCell>{invoice.suppliers?.name || <span className="text-muted-foreground">-</span>}</TableCell>
                    <TableCell className="text-right">{formatCurrency(invoice.subtotal || 0)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(invoice.vat_amount || 0)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(invoice.total_amount || 0)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {invoice.image_url && (
                          <Button variant="ghost" size="sm" onClick={() => openAttachmentPreview(invoice.image_url, isVi ? "Hóa đơn" : "Invoice", "invoices")} title={isVi ? "Xem hóa đơn" : "View invoice"}>
                            <Image className="h-4 w-4" />
                          </Button>
                        )}
                        {(invoice as any).payment_slip_url && (
                          <Button variant="ghost" size="sm" onClick={() => openAttachmentPreview((invoice as any).payment_slip_url, isVi ? "UNC / Chứng từ TT" : "UNC / Payment slip", "invoices")} title={isVi ? "Xem UNC" : "View UNC"} className="text-primary">
                            <CreditCard className="h-4 w-4" />
                          </Button>
                        )}
                        {!invoice.image_url && !(invoice as any).payment_slip_url && <span className="text-muted-foreground text-sm">-</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setViewingInvoiceId(invoice.id)} title={isVi ? "Xem chi tiết" : "View details"}><Eye className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingInvoiceId(invoice.id)} title={isVi ? "Chỉnh sửa" : "Edit"}><Pencil className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeletingInvoiceId(invoice.id)} className="text-destructive hover:text-destructive" title={isVi ? "Xóa" : "Delete"}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-12">
              <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">{isVi ? "Chưa có hóa đơn" : "No invoices yet"}</h3>
              <p className="text-muted-foreground">{isVi ? "Tải lên hóa đơn đầu tiên để bắt đầu" : "Upload your first invoice to get started"}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <InvoiceDetailsDialog invoiceId={viewingInvoiceId} open={!!viewingInvoiceId} onOpenChange={(open) => !open && setViewingInvoiceId(null)} />
      <EditInvoiceDialog invoiceId={editingInvoiceId} open={!!editingInvoiceId} onOpenChange={(open) => !open && setEditingInvoiceId(null)} />

      <AlertDialog open={!!deletingInvoiceId} onOpenChange={(open) => !open && setDeletingInvoiceId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isVi ? "Xóa hóa đơn" : "Delete invoice"}</AlertDialogTitle>
            <AlertDialogDescription>{isVi ? "Bạn có chắc muốn xóa hóa đơn này? Hành động này không thể hoàn tác." : "Are you sure you want to delete this invoice? This action cannot be undone."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{isVi ? "Hủy" : "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{isVi ? "Xóa" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!viewingImageUrl} onOpenChange={(open) => !open && setViewingImageUrl(null)}>
        <AlertDialogContent className="max-w-4xl">
          <AlertDialogHeader><AlertDialogTitle>{viewingImageTitle}</AlertDialogTitle></AlertDialogHeader>
          <div className="max-h-[70vh] overflow-auto">{viewingImageUrl && <img src={viewingImageUrl} alt={isVi ? "Hóa đơn" : "Invoice"} className="w-full h-auto rounded-lg" />}</div>
          <AlertDialogFooter><AlertDialogCancel>{isVi ? "Đóng" : "Close"}</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Invoices;
