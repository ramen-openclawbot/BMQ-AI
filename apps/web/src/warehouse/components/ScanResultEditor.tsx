import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { 
  CheckCircle, 
  AlertTriangle, 
  Package,
  Plus,
  Trash2,
  Loader2,
  ArrowLeft,
  Save
} from "lucide-react";
import { useSuppliers } from "@/hooks/useSuppliers";

export interface EditableItem {
  id: string;
  product_name: string;
  quantity: number;
  unit: string;
  expiry_date?: string;
  unit_price?: number;
  status?: "match" | "mismatch" | "extra" | "missing" | "new";
  originalName?: string;
  originalQty?: number;
  originalUnit?: string;
  ordered_quantity?: number | null;
  actual_quantity?: number | null;
  line_status?: "du" | "thieu" | "du_thua";
}

export interface ScanResultEditorProps {
  // Matched source info
  isMatched: boolean;
  matchScore?: number;
  matchSource?: "purchase_order_receipt" | "payment_request" | "none";
  goodsReceiptId?: string;
  receiptNumber?: string;
  purchaseOrderId?: string;
  poNumber?: string;
  poTitle?: string;
  paymentRequestId?: string;
  paymentRequestNumber?: string;
  paymentRequestTitle?: string;
  // Supplier info
  supplierId?: string;
  supplierName?: string;
  // Items to edit
  items: EditableItem[];
  // Callbacks
  onItemsChange: (items: EditableItem[]) => void;
  onSupplierChange: (supplierId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isConfirming?: boolean;
}

export function ScanResultEditor({
  isMatched,
  matchScore,
  matchSource,
  goodsReceiptId,
  receiptNumber,
  purchaseOrderId,
  poNumber,
  poTitle,
  paymentRequestId,
  paymentRequestNumber,
  paymentRequestTitle,
  supplierId,
  supplierName,
  items,
  onItemsChange,
  onSupplierChange,
  onConfirm,
  onCancel,
  isConfirming = false,
}: ScanResultEditorProps) {
  const { data: suppliers = [], isLoading: loadingSuppliers } = useSuppliers();
  const [selectedSupplierId, setSelectedSupplierId] = useState(supplierId || "");

  const handleSupplierChange = (value: string) => {
    setSelectedSupplierId(value);
    onSupplierChange(value);
  };

  const parseQuantity = (v: unknown) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const raw = String(v ?? "").trim();
    if (!raw) return 0;

    const m = raw.match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/);
    if (!m) return 0;
    const token = m[0];

    const normalized = token
      .replace(/\.(?=\d{3}(\D|$))/g, "")
      .replace(/,/g, ".")
      .replace(/[^0-9.-]/g, "");

    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  };

  const handleItemChange = (id: string, field: keyof EditableItem, value: string | number) => {
    const normalizedValue = field === "quantity" ? parseQuantity(value) : value;
    const updated = items.map(item => 
      item.id === id ? { ...item, [field]: normalizedValue } : item
    );
    onItemsChange(updated);
  };

  const handleAddItem = () => {
    const newItem: EditableItem = {
      id: `new-${Date.now()}`,
      product_name: "",
      quantity: 1,
      unit: "kg",
      expiry_date: "",
      status: "new",
    };
    onItemsChange([...items, newItem]);
  };

  const handleRemoveItem = (id: string) => {
    onItemsChange(items.filter(item => item.id !== id));
  };

  const getStatusBadge = (status?: EditableItem["status"]) => {
    switch (status) {
      case "match":
        return (
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
            <CheckCircle className="h-3 w-3 mr-1" />
            Khớp
          </Badge>
        );
      case "mismatch":
        return (
          <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Sai SL
          </Badge>
        );
      case "extra":
        return (
          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
            <Plus className="h-3 w-3 mr-1" />
            Thêm
          </Badge>
        );
      case "missing":
        return (
          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Thiếu
          </Badge>
        );
      case "new":
        return (
          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
            Mới thêm
          </Badge>
        );
      default:
        return null;
    }
  };

  const selectedSupplier = suppliers.find(s => s.id === selectedSupplierId);
  const isPurchaseOrderReceipt = matchSource === "purchase_order_receipt";
  const matchedTitle = isPurchaseOrderReceipt
    ? "Đã tìm thấy phiếu chờ nhập kho"
    : "Đã tìm thấy Đề nghị chi khớp";
  const unmatchedTitle = isPurchaseOrderReceipt
    ? "Chưa tìm thấy phiếu chờ nhập kho"
    : "Chưa tìm thấy Đề nghị chi";
  const sourceLabel = isPurchaseOrderReceipt ? "Đối chiếu PO" : "Đề nghị chi";

  return (
    <div className="space-y-4">
      {/* Header with match status */}
      <Card className={isMatched ? "border-green-200 bg-green-50/50" : "border-yellow-200 bg-yellow-50/50"}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              {isMatched ? (
                <>
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  {matchedTitle}
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-yellow-500" />
                  {unmatchedTitle}
                </>
              )}
            </CardTitle>
            {matchScore !== undefined && (
              <Badge variant={isMatched ? "default" : "secondary"}>
                {Math.round(matchScore * 100)}% khớp
              </Badge>
            )}
          </div>
        </CardHeader>
        
        {isMatched && (paymentRequestNumber || poNumber || receiptNumber) && (
          <CardContent className="pt-0">
            <div className="bg-primary/10 rounded-lg p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-primary/70">
                {sourceLabel}
              </p>
              <p className="text-sm font-medium text-primary">
                {isPurchaseOrderReceipt ? (poNumber || receiptNumber) : paymentRequestNumber}
              </p>
              {(poTitle || paymentRequestTitle) && (
                <p className="text-sm text-muted-foreground mt-0.5">
                  {isPurchaseOrderReceipt ? poTitle : paymentRequestTitle}
                </p>
              )}
              {isPurchaseOrderReceipt && receiptNumber && (
                <p className="text-xs text-muted-foreground mt-1">
                  Phiếu chờ: {receiptNumber}
                </p>
              )}
              {isPurchaseOrderReceipt && (purchaseOrderId || goodsReceiptId) && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Đang đối chiếu phiếu nhập kho từ PO
                </p>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Supplier Selection */}
      <Card>
        <CardContent className="pt-4">
          <div className="space-y-2">
            <Label htmlFor="supplier">Nhà cung cấp</Label>
            <Select
              value={selectedSupplierId}
              onValueChange={handleSupplierChange}
              disabled={loadingSuppliers}
            >
              <SelectTrigger id="supplier">
                <SelectValue placeholder={supplierName || "Chọn nhà cung cấp"} />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((supplier) => (
                  <SelectItem key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedSupplier && selectedSupplier.name !== supplierName && (
              <p className="text-xs text-muted-foreground">
                NCC quét được: {supplierName || "Không xác định"}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Editable Items Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4" />
            Danh sách sản phẩm ({items.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {items.map((item, index) => (
              <div 
                key={item.id}
                className="border rounded-lg p-3 space-y-3 bg-background"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">
                    #{index + 1}
                  </span>
                  <div className="flex items-center gap-2">
                    {getStatusBadge(item.status)}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveItem(item.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <Label className="text-xs">Tên sản phẩm</Label>
                    <Input
                      value={item.product_name}
                      onChange={(e) => handleItemChange(item.id, "product_name", e.target.value)}
                      placeholder="Nhập tên sản phẩm"
                      className="h-9"
                    />
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Số lượng</Label>
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={item.quantity}
                        onChange={(e) => handleItemChange(item.id, "quantity", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Đơn vị</Label>
                      <Input
                        value={item.unit}
                        onChange={(e) => handleItemChange(item.id, "unit", e.target.value)}
                        placeholder="kg, lít, cái..."
                        className="h-9"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">HSD</Label>
                      <Input
                        type="date"
                        value={item.expiry_date || ""}
                        onChange={(e) => handleItemChange(item.id, "expiry_date", e.target.value)}
                        className="h-9"
                      />
                    </div>
                  </div>

                  {item.status === "mismatch" && item.originalQty !== undefined && (
                    <p className="text-xs text-yellow-600 bg-yellow-50 p-2 rounded">
                      ⚠️ Duyệt chi: {item.originalQty} {item.originalUnit || item.unit}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleAddItem}
          >
            <Plus className="h-4 w-4 mr-2" />
            Thêm sản phẩm
          </Button>
        </CardContent>
      </Card>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={isConfirming}
          className="flex-1"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>
        <Button
          onClick={onConfirm}
          disabled={isConfirming || items.length === 0}
          className="flex-1"
        >
          {isConfirming ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Đang tạo...
            </>
          ) : (
            <>
              <Save className="h-4 w-4 mr-2" />
              Xác nhận nhập kho
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
