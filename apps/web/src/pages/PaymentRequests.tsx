import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { vi, enUS } from "date-fns/locale";
import { Eye, Trash2, Filter, FileCheck, AlertTriangle, Banknote, CreditCard, X, CheckCircle, Wallet, FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddPaymentRequestDialog } from "@/components/dialogs/AddPaymentRequestDialog";
import { PaymentRequestDetailsDialog } from "@/components/dialogs/PaymentRequestDetailsDialog";
import { ExportApprovedPDF } from "@/components/payment-requests/ExportApprovedPDF";

import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import { usePaymentRequests, useDeletePaymentRequest, useBulkMarkPaid, useBulkApprovePaymentRequest } from "@/hooks/usePaymentRequests";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";

type CardFilterType = "pending" | "approved" | "unc" | "cash" | "delivered" | "needs_invoice" | null;

const PaymentRequests = () => {
  const queryClient = useQueryClient();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [deletingRequestId, setDeletingRequestId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const [activeCardFilter, setActiveCardFilter] = useState<CardFilterType>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkApproveConfirm, setShowBulkApproveConfirm] = useState(false);
  const [showDriveInvoiceDialog, setShowDriveInvoiceDialog] = useState(false);
  
  useAuth();
  const { language, t } = useLanguage();

  const {
    data: requests,
    isLoading,
    isError,
    error,
    refetch,
  } = usePaymentRequests();
  const { data: paymentStats } = usePaymentStats();
  const deleteRequest = useDeletePaymentRequest();
  const bulkMarkPaid = useBulkMarkPaid();
  const bulkApprove = useBulkApprovePaymentRequest();

  const dateLocale = language === "vi" ? vi : enUS;



  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const handleDelete = async () => {
    if (!deletingRequestId) return;
    await deleteRequest.mutateAsync(deletingRequestId);
    setDeletingRequestId(null);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary">{t.pending}</Badge>;
      case "approved":
        return <Badge className="bg-green-500">{t.approved}</Badge>;
      case "rejected":
        return <Badge variant="destructive">{t.rejected}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getDeliveryStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="outline">{t.notDelivered}</Badge>;
      case "delivered":
        return <Badge className="bg-blue-500">{t.delivered}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentStatusBadge = (status: string) => {
    switch (status) {
      case "unpaid":
        return <Badge variant="destructive">{t.unpaid}</Badge>;
      case "paid":
        return <Badge className="bg-green-500">{t.paid}</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentMethodBadge = (method: string | null) => {
    switch (method) {
      case "bank_transfer":
        return (
          <Badge variant="outline" className="gap-1">
            <CreditCard className="h-3 w-3" />
            {t.bankTransfer}
          </Badge>
        );
      case "cash":
        return (
          <Badge variant="secondary" className="gap-1">
            <Banknote className="h-3 w-3" />
            {t.cash}
          </Badge>
        );
      default:
        return <Badge variant="outline">-</Badge>;
    }
  };

  // Filter requests based on dropdown and card filters
  const filteredRequests = useMemo(() => {
    return requests?.filter((r) => {
      // Dropdown filters
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (deliveryFilter !== "all" && r.delivery_status !== deliveryFilter) return false;
      
      // Card filter
      if (activeCardFilter) {
        switch (activeCardFilter) {
          case "pending":
            return r.status === "pending";
          case "approved":
            return r.status === "approved" && r.payment_status === "unpaid";
          case "unc":
            return r.payment_status === "unpaid" && r.payment_method === "bank_transfer";
          case "cash":
            return r.payment_status === "unpaid" && r.payment_method === "cash";
          case "delivered":
            return r.delivery_status === "delivered";
          case "needs_invoice":
            return r.status === "approved" && !r.invoice_created;
        }
      }
      
      return true;
    });
  }, [requests, statusFilter, deliveryFilter, activeCardFilter]);

  // Get selectable requests (pending OR approved + unpaid)
  const selectableRequests = useMemo(() => {
    return filteredRequests?.filter(r => 
      r.status === "pending" || (r.status === "approved" && r.payment_status === "unpaid")
    ) || [];
  }, [filteredRequests]);

  // Calculate selected pending requests for bulk approve
  const selectedPendingIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const request = requests?.find(r => r.id === id);
      return request?.status === "pending";
    });
  }, [selectedIds, requests]);

  const selectedPendingTotal = useMemo(() => {
    return selectedPendingIds.reduce((sum, id) => {
      const request = requests?.find(r => r.id === id);
      return sum + (request?.total_amount || 0);
    }, 0);
  }, [selectedPendingIds, requests]);

  // Calculate selected approved+unpaid requests for bulk mark paid
  const selectedApprovedUnpaidIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const request = requests?.find(r => r.id === id);
      return request?.status === "approved" && request?.payment_status === "unpaid";
    });
  }, [selectedIds, requests]);

  const handleBulkApprove = () => {
    bulkApprove.mutate(selectedPendingIds, {
      onSuccess: () => {
        setSelectedIds(new Set());
        setShowBulkApproveConfirm(false);
      },
    });
  };

  // Use centralized stats from usePaymentStats for real-time sync
  const pendingCount = paymentStats?.pendingCount || 0;
  const approvedCount = paymentStats?.approvedCount || 0;
  const deliveredCount = paymentStats?.deliveredCount || 0;
  const uncTotal = paymentStats?.uncTotal || 0;
  const cashTotal = paymentStats?.cashTotal || 0;
  const totalUnpaid = paymentStats?.totalUnpaid || 0;
  const needsInvoiceCount = paymentStats?.pendingInvoiceCount || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">{t.paymentRequestsTitle}</h1>
          <p className="text-muted-foreground">{t.paymentRequestsDesc}</p>
        </div>
        <div className="flex items-center gap-2">
          <AddPaymentRequestDialog />
        </div>
      </div>

      {/* Warning Banner for pending invoices */}
      {needsInvoiceCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t.needsInvoiceWarning}: {needsInvoiceCount}</AlertTitle>
          <AlertDescription>
            {t.needsInvoiceWarningDesc}
          </AlertDescription>
        </Alert>
      )}

      {/* Stats Cards - Redesigned for cleaner UI */}
      <div className="space-y-4">
        {/* Row 1: Status cards */}
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:shadow-md",
              activeCardFilter === "pending" && "ring-2 ring-primary"
            )}
            onClick={() => setActiveCardFilter(activeCardFilter === "pending" ? null : "pending")}
          >
            <CardContent className="p-4">
              <div className="text-xs font-medium text-muted-foreground mb-1">{t.pendingApproval}</div>
              <div className="text-2xl font-bold text-yellow-600">{pendingCount}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:shadow-md",
              activeCardFilter === "approved" && "ring-2 ring-primary"
            )}
            onClick={() => setActiveCardFilter(activeCardFilter === "approved" ? null : "approved")}
          >
            <CardContent className="p-4">
              <div className="text-xs font-medium text-muted-foreground mb-1">{t.approved}</div>
              <div className="text-2xl font-bold text-green-600">{approvedCount}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:shadow-md",
              activeCardFilter === "delivered" && "ring-2 ring-primary"
            )}
            onClick={() => setActiveCardFilter(activeCardFilter === "delivered" ? null : "delivered")}
          >
            <CardContent className="p-4">
              <div className="text-xs font-medium text-muted-foreground mb-1">{t.delivered}</div>
              <div className="text-2xl font-bold text-blue-600">{deliveredCount}</div>
            </CardContent>
          </Card>
          <Card 
            className={cn(
              "cursor-pointer transition-all hover:shadow-md",
              needsInvoiceCount > 0 && "border-destructive",
              activeCardFilter === "needs_invoice" && "ring-2 ring-primary"
            )}
            onClick={() => setActiveCardFilter(activeCardFilter === "needs_invoice" ? null : "needs_invoice")}
          >
            <CardContent className="p-4">
              <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                <FileCheck className="h-3 w-3" />
                {t.needsInvoice}
              </div>
              <div className={cn("text-2xl font-bold", needsInvoiceCount > 0 ? "text-destructive" : "text-muted-foreground")}>
                {needsInvoiceCount}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Row 2: Payment summary card */}
        <Card className="bg-gradient-to-r from-primary/5 to-primary/10 border-primary/20">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              {/* Total */}
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Wallet className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t.totalNeedToPay}</div>
                  <div className="text-2xl font-bold text-primary">{formatCurrency(totalUnpaid)}</div>
                </div>
              </div>
              
              {/* UNC and Cash breakdown */}
              <div className="flex gap-3">
                <div 
                  className={cn(
                    "flex-1 p-3 rounded-lg bg-background/80 cursor-pointer transition-all hover:bg-background",
                    activeCardFilter === "unc" && "ring-2 ring-primary"
                  )}
                  onClick={() => setActiveCardFilter(activeCardFilter === "unc" ? null : "unc")}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <CreditCard className="h-3 w-3" />
                    {t.totalUNC}
                  </div>
                  <div className="text-lg font-semibold text-blue-600">{formatCurrency(uncTotal)}</div>
                </div>
                <div 
                  className={cn(
                    "flex-1 p-3 rounded-lg bg-background/80 cursor-pointer transition-all hover:bg-background",
                    activeCardFilter === "cash" && "ring-2 ring-primary"
                  )}
                  onClick={() => setActiveCardFilter(activeCardFilter === "cash" ? null : "cash")}
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <Banknote className="h-3 w-3" />
                    {t.totalCash}
                  </div>
                  <div className="text-lg font-semibold text-orange-600">{formatCurrency(cashTotal)}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Action bar when filter needs_invoice */}
      {activeCardFilter === "needs_invoice" && needsInvoiceCount > 0 && (
        <div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-200 dark:border-amber-800">
          <div className="flex items-center gap-2">
            <FileCheck className="h-5 w-5 text-amber-600" />
            <span className="text-sm font-medium">
              {language === "vi" 
                ? `Có ${needsInvoiceCount} đề nghị thanh toán cần tạo hoá đơn`
                : `${needsInvoiceCount} payment requests need invoice`
              }
            </span>
          </div>
          <Button 
            onClick={() => setShowDriveInvoiceDialog(true)}
            className="gap-2"
          >
            <FolderSearch className="h-4 w-4" />
            {language === "vi" ? "Tạo hoá đơn từ Google Drive" : "Create Invoice from Google Drive"}
          </Button>
        </div>
      )}

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between p-4 bg-primary/10 rounded-lg border border-primary/20">
          <div className="flex items-center gap-4">
            <span className="font-medium">
              {t.selected}: {selectedIds.size}
            </span>
            <span className="text-muted-foreground">|</span>
            <span className="font-medium">
              {t.total}: {formatCurrency(
                Array.from(selectedIds).reduce((sum, id) => {
                  const request = requests?.find(r => r.id === id);
                  return sum + (request?.total_amount || 0);
                }, 0)
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Quick Approve button - only show when pending requests are selected */}
            {selectedPendingIds.length > 0 && (
              <Button 
                onClick={() => setShowBulkApproveConfirm(true)}
                disabled={bulkApprove.isPending}
                className="gap-2 bg-green-600 hover:bg-green-700"
              >
                <CheckCircle className="h-4 w-4" />
                {t.quickApprove} ({selectedPendingIds.length})
              </Button>
            )}
            {/* Export PDF button - show when approved requests are selected */}
            {requests && (
              <ExportApprovedPDF 
                selectedIds={Array.from(selectedIds)} 
                requests={requests} 
              />
            )}
            {/* Mark as Paid button - only show when approved+unpaid requests are selected */}
            {selectedApprovedUnpaidIds.length > 0 && (
              <Button 
                onClick={() => {
                  bulkMarkPaid.mutate(selectedApprovedUnpaidIds);
                  setSelectedIds(new Set());
                }}
                disabled={bulkMarkPaid.isPending}
                className="gap-2"
              >
                <Wallet className="h-4 w-4" />
                {t.markAsPaid} ({selectedApprovedUnpaidIds.length})
              </Button>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue placeholder={t.status} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.all}</SelectItem>
            <SelectItem value="pending">{t.pending}</SelectItem>
            <SelectItem value="approved">{t.approved}</SelectItem>
            <SelectItem value="rejected">{t.rejected}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t.delivery} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.all}</SelectItem>
            <SelectItem value="pending">{t.notDelivered}</SelectItem>
            <SelectItem value="delivered">{t.delivered}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Requests Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="p-6 space-y-3">
              <p className="font-medium text-foreground">
                {language === "vi" ? "Không thể tải dữ liệu" : "Couldn't load data"}
              </p>
              <p className="text-sm text-muted-foreground break-words">
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => refetch()}>
                  {language === "vi" ? "Thử lại" : "Retry"}
                </Button>
                <Button variant="outline" onClick={() => window.location.reload()}>
                  {language === "vi" ? "Tải lại trang" : "Reload Page"}
                </Button>
              </div>
            </div>
          ) : filteredRequests?.length === 0 ? (
            <div className="p-12 text-center">
              <FileCheck className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <p className="text-muted-foreground">{t.noPaymentRequests}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <Checkbox
                      checked={selectableRequests.length > 0 && selectableRequests.every(r => selectedIds.has(r.id))}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setSelectedIds(new Set(selectableRequests.map(r => r.id)));
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                    />
                  </TableHead>
                  <TableHead>{t.supplier}</TableHead>
                  <TableHead>{t.createdDate}</TableHead>
                  <TableHead className="text-right">{t.totalAmount}</TableHead>
                  <TableHead>{t.status}</TableHead>
                  <TableHead>{t.paymentMethod}</TableHead>
                  <TableHead>{t.delivery}</TableHead>
                  <TableHead>{t.payment}</TableHead>
                  <TableHead>{t.invoiceStatus}</TableHead>
                  <TableHead className="text-right">{t.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRequests?.map((request) => {
                  const isSelectable = request.status === "pending" || (request.status === "approved" && request.payment_status === "unpaid");
                  const isSelected = selectedIds.has(request.id);
                  
                  return (
                    <TableRow key={request.id} className={cn(
                      request.payment_status === "paid" && !request.invoice_created && "bg-destructive/5",
                      isSelected && "bg-primary/5"
                    )}>
                      <TableCell>
                        {isSelectable ? (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={(checked) => {
                              const newSet = new Set(selectedIds);
                              if (checked) {
                                newSet.add(request.id);
                              } else {
                                newSet.delete(request.id);
                              }
                              setSelectedIds(newSet);
                            }}
                          />
                        ) : (
                          <div className="w-4" />
                        )}
                      </TableCell>
                      <TableCell>{request.suppliers?.name || "-"}</TableCell>
                    <TableCell>
                      {format(new Date(request.created_at), "dd/MM/yyyy", { locale: dateLocale })}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(request.total_amount || 0)}
                    </TableCell>
                    <TableCell>{getStatusBadge(request.status)}</TableCell>
                    <TableCell>{getPaymentMethodBadge(request.payment_method)}</TableCell>
                    <TableCell>{getDeliveryStatusBadge(request.delivery_status)}</TableCell>
                    <TableCell>{getPaymentStatusBadge(request.payment_status)}</TableCell>
                    <TableCell>
                      {request.invoice_created ? (
                        <Badge className="bg-green-500 gap-1">
                          <FileCheck className="h-3 w-3" />
                          {t.invoiceCreated}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {t.invoiceNotCreated}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setSelectedRequestId(request.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {(
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingRequestId(request.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Details Dialog */}
      <PaymentRequestDetailsDialog
        requestId={selectedRequestId}
        open={!!selectedRequestId}
        onOpenChange={(open) => !open && setSelectedRequestId(null)}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deletingRequestId} onOpenChange={(open) => !open && setDeletingRequestId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{language === "vi" ? "Xác nhận xóa" : "Confirm Delete"}</AlertDialogTitle>
            <AlertDialogDescription>
              {language === "vi" 
                ? "Bạn có chắc chắn muốn xóa đề nghị duyệt chi này? Hành động này không thể hoàn tác."
                : "Are you sure you want to delete this payment request? This action cannot be undone."
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive hover:bg-destructive/90">
              {t.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Approve Confirmation Dialog */}
      <AlertDialog open={showBulkApproveConfirm} onOpenChange={setShowBulkApproveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.confirmBulkApprove}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.confirmBulkApproveDesc
                .replace("{count}", String(selectedPendingIds.length))
                .replace("{amount}", formatCurrency(selectedPendingTotal))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.cancel}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleBulkApprove}
              disabled={bulkApprove.isPending}
              className="bg-green-600 hover:bg-green-700"
            >
              {bulkApprove.isPending ? t.approving : t.confirmApproveAction}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Drive Invoice Import Dialog */}
      <DriveImportProgressDialog
        open={showDriveInvoiceDialog}
        onClose={(success) => {
          setShowDriveInvoiceDialog(false);
          if (success) {
            // Invalidate all related queries to refresh UI immediately
            queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
            queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
            queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
            queryClient.invalidateQueries({ queryKey: ["invoices"] });
          }
        }}
        importType="bank_slip"
      />
    </div>
  );
};

export default PaymentRequests;
