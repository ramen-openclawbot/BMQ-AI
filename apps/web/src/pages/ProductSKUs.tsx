import { useState, useMemo } from "react";
import { Plus, Pencil, Trash2, Search, Package, Barcode, RefreshCw, Filter, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AddSKUDialog } from "@/components/dialogs/AddSKUDialog";
import { EditSKUDialog } from "@/components/dialogs/EditSKUDialog";
import { useProductSKUs, useDeleteProductSKU, ProductSKU } from "@/hooks/useProductSKUs";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";

import { formatDistanceToNow } from "date-fns";
import { vi, enUS } from "date-fns/locale";

// Category badge colors based on SKU prefix
const getCategoryStyle = (skuCode: string | undefined, category: string | undefined) => {
  const prefix = skuCode?.split("-")[0]?.toUpperCase();
  
  switch (prefix) {
    case "NL":
      return { bg: "bg-blue-100 dark:bg-blue-900/30", text: "text-blue-700 dark:text-blue-300", label: "Nguyên liệu" };
    case "BB":
      return { bg: "bg-green-100 dark:bg-green-900/30", text: "text-green-700 dark:text-green-300", label: "Bao bì" };
    case "PG":
      return { bg: "bg-orange-100 dark:bg-orange-900/30", text: "text-orange-700 dark:text-orange-300", label: "Phụ gia" };
    case "GV":
      return { bg: "bg-purple-100 dark:bg-purple-900/30", text: "text-purple-700 dark:text-purple-300", label: "Gia vị" };
    case "TP":
      return { bg: "bg-pink-100 dark:bg-pink-900/30", text: "text-pink-700 dark:text-pink-300", label: "Thực phẩm" };
    case "DU":
      return { bg: "bg-cyan-100 dark:bg-cyan-900/30", text: "text-cyan-700 dark:text-cyan-300", label: "Đồ uống" };
    default:
      return { bg: "bg-gray-100 dark:bg-gray-800", text: "text-gray-700 dark:text-gray-300", label: category || "Khác" };
  }
};

const ProductSKUs = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingSKU, setEditingSKU] = useState<ProductSKU | null>(null);
  const [deletingSKUId, setDeletingSKUId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("sku_code");

  const { user } = useAuth();
  const { language, t } = useLanguage();
  const { data: skus, isLoading, isError, error, refetch } = useProductSKUs();
  const { data: suppliers } = useSuppliers();
  const deleteSKU = useDeleteProductSKU();

  const dateLocale = language === "vi" ? vi : enUS;

  const formatCurrency = (amount: number | null) => {
    if (amount === null) return "-";
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const handleDelete = async () => {
    if (!deletingSKUId) return;
    await deleteSKU.mutateAsync(deletingSKUId);
    setDeletingSKUId(null);
  };

  const copySKUCode = (code: string) => {
    navigator.clipboard.writeText(code);
  };

  // Get unique categories from SKU codes
  const uniqueCategories = useMemo(() => {
    if (!skus) return [];
    const prefixes = new Set(skus.map((s) => s.sku_code.split("-")[0]?.toUpperCase()).filter(Boolean));
    return Array.from(prefixes);
  }, [skus]);

  // Filter and sort SKUs
  const filteredSKUs = useMemo(() => {
    if (!skus) return [];
    
    let result = [...skus];

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (sku) =>
          sku.sku_code.toLowerCase().includes(query) ||
          sku.product_name.toLowerCase().includes(query) ||
          sku.category?.toLowerCase().includes(query) ||
          sku.suppliers?.name?.toLowerCase().includes(query)
      );
    }

    // Category filter (by SKU prefix)
    if (categoryFilter !== "all") {
      result = result.filter((sku) => 
        sku.sku_code.split("-")[0]?.toUpperCase() === categoryFilter
      );
    }

    // Supplier filter
    if (supplierFilter !== "all") {
      result = result.filter((sku) => sku.supplier_id === supplierFilter);
    }

    // Sorting
    result.sort((a, b) => {
      switch (sortBy) {
        case "sku_code":
          return a.sku_code.localeCompare(b.sku_code);
        case "product_name":
          return a.product_name.localeCompare(b.product_name);
        case "unit_price":
          return (b.unit_price || 0) - (a.unit_price || 0);
        case "updated_at":
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        default:
          return 0;
      }
    });

    return result;
  }, [skus, searchQuery, categoryFilter, supplierFilter, sortBy]);

  // Stats
  const totalSKUs = skus?.length || 0;
  const uniqueSupplierCount = new Set(skus?.map((s) => s.supplier_id).filter(Boolean)).size;
  const uniqueCategoryCount = uniqueCategories.length;


  // Export to CSV
  const handleExport = () => {
    if (!filteredSKUs.length) return;
    
    const headers = ["SKU Code", "Product Name", "Unit", "Unit Price", "Supplier", "Category", "Notes"];
    const rows = filteredSKUs.map((sku) => [
      sku.sku_code,
      sku.product_name,
      sku.unit || "",
      sku.unit_price?.toString() || "",
      sku.suppliers?.name || "",
      sku.category || "",
      sku.notes || "",
    ]);
    
    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");
    
    const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sku-list-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <TooltipProvider>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">
              {language === "vi" ? "Quản lý SKU" : "SKU Management"}
            </h1>
            <p className="text-muted-foreground">
              {language === "vi"
                ? "Quản lý mã sản phẩm và giá chuẩn • SKU tự động tạo khi duyệt chi"
                : "Manage product codes and standard prices • Auto-created on approval"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleExport} disabled={!filteredSKUs.length}>
              <Download className="h-4 w-4 mr-2" />
              {language === "vi" ? "Xuất CSV" : "Export"}
            </Button>
            <AddSKUDialog />
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Barcode className="h-4 w-4" />
                {language === "vi" ? "Tổng mã SKU" : "Total SKUs"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalSKUs}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {language === "vi" ? `${filteredSKUs.length} đang hiển thị` : `${filteredSKUs.length} showing`}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {language === "vi" ? "Nhà cung cấp" : "Suppliers"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{uniqueSupplierCount}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {language === "vi" ? "Nhóm hàng" : "Categories"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1">
                {uniqueCategories.slice(0, 4).map((cat) => {
                  const style = getCategoryStyle(cat, undefined);
                  return (
                    <Badge key={cat} variant="outline" className={`${style.bg} ${style.text} border-0 text-xs`}>
                      {cat}
                    </Badge>
                  );
                })}
                {uniqueCategories.length > 4 && (
                  <Badge variant="outline" className="text-xs">+{uniqueCategories.length - 4}</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={language === "vi" ? "Tìm mã SKU, tên sản phẩm..." : "Search SKU, product name..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-[140px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder={language === "vi" ? "Nhóm hàng" : "Category"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{language === "vi" ? "Tất cả nhóm" : "All categories"}</SelectItem>
              {uniqueCategories.map((cat) => {
                const style = getCategoryStyle(cat, undefined);
                return (
                  <SelectItem key={cat} value={cat}>
                    <span className={`${style.text} font-medium`}>{cat}</span> - {style.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          <Select value={supplierFilter} onValueChange={setSupplierFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={language === "vi" ? "Nhà cung cấp" : "Supplier"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{language === "vi" ? "Tất cả NCC" : "All suppliers"}</SelectItem>
              {suppliers?.map((sup) => (
                <SelectItem key={sup.id} value={sup.id}>{sup.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder={language === "vi" ? "Sắp xếp" : "Sort by"} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sku_code">{language === "vi" ? "Mã SKU" : "SKU Code"}</SelectItem>
              <SelectItem value="product_name">{language === "vi" ? "Tên SP" : "Product Name"}</SelectItem>
              <SelectItem value="unit_price">{language === "vi" ? "Đơn giá" : "Unit Price"}</SelectItem>
              <SelectItem value="updated_at">{language === "vi" ? "Cập nhật" : "Last Updated"}</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="outline" onClick={() => refetch()} size="icon">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>

        {/* SKU Table */}
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
                <Button variant="outline" onClick={() => refetch()}>
                  {language === "vi" ? "Thử lại" : "Retry"}
                </Button>
              </div>
            ) : filteredSKUs.length === 0 ? (
              <div className="p-12 text-center">
                <Package className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground">
                  {searchQuery || categoryFilter !== "all" || supplierFilter !== "all"
                    ? (language === "vi" ? "Không tìm thấy mã SKU phù hợp" : "No matching SKUs found")
                    : (language === "vi" ? "Chưa có mã SKU nào • Tạo mới hoặc duyệt đề nghị chi để tự động tạo" : "No SKUs yet • Create manually or approve payment requests")}
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[180px]">{language === "vi" ? "Mã SKU" : "SKU Code"}</TableHead>
                    <TableHead>{language === "vi" ? "Tên sản phẩm" : "Product Name"}</TableHead>
                    <TableHead className="w-[80px]">{language === "vi" ? "ĐVT" : "Unit"}</TableHead>
                    <TableHead className="text-right w-[120px]">{language === "vi" ? "Đơn giá" : "Unit Price"}</TableHead>
                    <TableHead className="w-[150px]">{language === "vi" ? "Nhà cung cấp" : "Supplier"}</TableHead>
                    <TableHead className="w-[100px]">{language === "vi" ? "Cập nhật" : "Updated"}</TableHead>
                    <TableHead className="text-right w-[100px]">{t.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSKUs.map((sku) => {
                    const categoryStyle = getCategoryStyle(sku.sku_code, sku.category);
                    return (
                      <TableRow key={sku.id}>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => copySKUCode(sku.sku_code)}
                                className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                              >
                                <Badge 
                                  variant="outline" 
                                  className={`${categoryStyle.bg} ${categoryStyle.text} border-0 font-mono text-xs`}
                                >
                                  {sku.sku_code.split("-")[0]}
                                </Badge>
                                <span className="font-mono text-sm">
                                  {sku.sku_code.split("-").slice(1).join("-")}
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{language === "vi" ? "Click để sao chép" : "Click to copy"}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block max-w-[250px] truncate">{sku.product_name}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{sku.product_name}</p>
                              {sku.notes && <p className="text-xs text-muted-foreground mt-1">{sku.notes}</p>}
                            </TooltipContent>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-normal">{sku.unit || "kg"}</Badge>
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCurrency(sku.unit_price)}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {sku.suppliers?.name || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(sku.updated_at), { 
                              addSuffix: true, 
                              locale: dateLocale 
                            })}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => setEditingSKU(sku)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {(
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => setDeletingSKUId(sku.id)}
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

        {/* Edit Dialog */}
        <EditSKUDialog
          sku={editingSKU}
          open={!!editingSKU}
          onOpenChange={(open) => !open && setEditingSKU(null)}
        />

        {/* Delete Confirmation */}
        <AlertDialog open={!!deletingSKUId} onOpenChange={(open) => !open && setDeletingSKUId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {language === "vi" ? "Xác nhận xóa" : "Confirm Delete"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {language === "vi"
                  ? "Bạn có chắc chắn muốn xóa mã SKU này? Hành động này không thể hoàn tác."
                  : "Are you sure you want to delete this SKU? This action cannot be undone."}
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
      </div>
    </TooltipProvider>
  );
};

export default ProductSKUs;
