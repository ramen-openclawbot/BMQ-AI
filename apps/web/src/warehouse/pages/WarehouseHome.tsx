import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { WarehouseLayout } from "../components/WarehouseLayout";
import { CameraCapture } from "../components/CameraCapture";
import { PhotoPreview } from "../components/PhotoPreview";
import { ScanResultEditor, EditableItem } from "../components/ScanResultEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";
import { supabase } from "@/integrations/supabase/client";
import { 
  Camera, 
  Search,
  Package,
  Loader2,
  CheckCircle,
  RotateCcw
} from "lucide-react";

type CaptureMode = "none" | "delivery" | "product";
type AppStep = "capture" | "edit" | "complete";

interface MatchItem {
  deliveryName: string;
  deliveryQty: number;
  deliveryUnit: string;
  matchedName?: string;
  matchedQty?: number;
  matchedUnit?: string;
  status: "match" | "mismatch" | "extra" | "missing";
}

interface MatchResult {
  isMatched: boolean;
  matchScore: number;
  matchSource?: "purchase_order_receipt" | "payment_request" | "none";
  goodsReceiptId?: string;
  receiptNumber?: string;
  purchaseOrderId?: string;
  poNumber?: string;
  poTitle?: string;
  paymentRequestId?: string;
  paymentRequestNumber?: string;
  paymentRequestTitle?: string;
  supplierId?: string;
  supplierName?: string;
  items: MatchItem[];
  extractedItems?: Array<{
    product_name: string;
    quantity: number;
    unit: string;
    expiry_date?: string;
    unit_price?: number;
  }>;
}

export default function WarehouseHome() {
  const navigate = useNavigate();
  const { profile, session, signOut } = useAuth();
  const fullName = profile?.full_name;
  const { toast } = useToast();

  // Step management
  const [currentStep, setCurrentStep] = useState<AppStep>("capture");
  
  // Capture state
  const [captureMode, setCaptureMode] = useState<CaptureMode>("none");
  const [deliveryPhoto, setDeliveryPhoto] = useState<string | null>(null);
  const [productPhotos, setProductPhotos] = useState<string[]>([]);
  
  // Scanning and editing state
  const [isScanning, setIsScanning] = useState(false);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [editableItems, setEditableItems] = useState<EditableItem[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>("");
  
  // Confirm state
  const [isConfirming, setIsConfirming] = useState(false);
  const [createdReceiptNumber, setCreatedReceiptNumber] = useState<string | null>(null);

  const handleLogout = async () => {
    await signOut();
    navigate("/auth", { replace: true });
  };

  const handleDeliveryCapture = (imageData: string) => {
    setDeliveryPhoto(imageData);
    setCaptureMode("none");
  };

  const handleProductCapture = (imageData: string) => {
    setProductPhotos(prev => [...prev, imageData]);
    setCaptureMode("none");
  };

  const removeProductPhoto = (index: number) => {
    setProductPhotos(prev => prev.filter((_, i) => i !== index));
  };

  // Convert match items to editable items
  const convertToEditableItems = useCallback((result: MatchResult): EditableItem[] => {
    // Use extractedItems if available, otherwise convert from match items
    if (result.extractedItems && result.extractedItems.length > 0) {
      const extractedEditableItems = result.extractedItems.map((item, index) => {
        // Find matching item status
        const matchItem = result.items.find(
          mi => mi.deliveryName.toLowerCase() === item.product_name.toLowerCase()
        );
        return {
          id: `item-${index}`,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit,
          expiry_date: item.expiry_date,
          unit_price: item.unit_price,
          status: matchItem?.status || "extra",
          originalName: matchItem?.matchedName,
          originalQty: matchItem?.matchedQty,
          originalUnit: matchItem?.matchedUnit,
          ordered_quantity: matchItem?.matchedQty,
          actual_quantity: item.quantity,
          line_status: matchItem?.status === "match" ? "du" : matchItem?.status === "mismatch" && matchItem.matchedQty !== undefined && item.quantity < matchItem.matchedQty ? "thieu" : matchItem?.status === "mismatch" ? "du_thua" : undefined,
        };
      });

      const missingEditableItems = result.items
        .filter(item => item.status === "missing")
        .map((item, index) => ({
          id: `missing-${index}`,
          product_name: item.deliveryName,
          quantity: 0,
          unit: item.deliveryUnit,
          expiry_date: "",
          status: item.status,
          originalName: item.deliveryName,
          originalQty: item.deliveryQty,
          originalUnit: item.deliveryUnit,
          ordered_quantity: item.deliveryQty,
          actual_quantity: 0,
          line_status: "thieu" as const,
        }));

      return [...extractedEditableItems, ...missingEditableItems];
    }
    
    // Fallback to match items
    return result.items.map((item, index) => ({
      id: `item-${index}`,
      product_name: item.deliveryName,
      quantity: item.status === "missing" ? 0 : item.deliveryQty,
      unit: item.deliveryUnit,
      expiry_date: "",
      status: item.status,
      originalName: item.matchedName,
      originalQty: item.matchedQty ?? (item.status === "missing" ? item.deliveryQty : undefined),
      originalUnit: item.matchedUnit,
      ordered_quantity: item.matchedQty ?? (item.status === "missing" ? item.deliveryQty : undefined),
      actual_quantity: item.status === "missing" ? 0 : item.deliveryQty,
      line_status: item.status === "match" ? "du" : item.status === "missing" ? "thieu" : item.status === "mismatch" && item.matchedQty !== undefined && item.deliveryQty < item.matchedQty ? "thieu" : item.status === "mismatch" ? "du_thua" : undefined,
    }));
  }, []);

  // Helper to get access token
  const getAccessToken = async (): Promise<string | null> => {
    if (session?.access_token) {
      return session.access_token;
    }
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || null;
  };

  // Step 1: Scan delivery note
  const handleScan = async () => {
    if (!deliveryPhoto) {
      toast({
        title: "Thiếu ảnh",
        description: "Vui lòng chụp ảnh phiếu giao hàng",
        variant: "destructive",
      });
      return;
    }

    setIsScanning(true);

    try {
      const accessToken = await getAccessToken();
      
      if (!accessToken) {
        toast({
          title: "Phiên đăng nhập hết hạn",
          description: "Vui lòng đăng nhập lại",
          variant: "destructive",
        });
        navigate("/auth", { replace: true });
        return;
      }

      // Call edge function to match delivery note
      const response = await callEdgeFunction<MatchResult>(
        "match-delivery-note",
        { deliveryImage: deliveryPhoto },
        accessToken,
        120000 // 2 min timeout for AI processing
      );

      if (response.isSessionExpired) {
        toast({
          title: "Phiên đăng nhập hết hạn",
          description: "Vui lòng đăng nhập lại",
          variant: "destructive",
        });
        navigate("/auth", { replace: true });
        return;
      }

      if (response.error) {
        throw new Error(response.error);
      }

      if (response.data) {
        setMatchResult(response.data);
        setEditableItems(convertToEditableItems(response.data));
        setSelectedSupplierId(response.data.supplierId || "");
        setCurrentStep("edit");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Đã xảy ra lỗi khi quét phiếu giao hàng";
      toast({
        title: "Lỗi xử lý",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsScanning(false);
    }
  };

  // Step 2: Confirm and create receipt
  const handleConfirmReceipt = async () => {
    if (editableItems.length === 0) {
      toast({
        title: "Không có sản phẩm",
        description: "Vui lòng thêm ít nhất một sản phẩm",
        variant: "destructive",
      });
      return;
    }

    setIsConfirming(true);

    try {
      const accessToken = await getAccessToken();
      
      if (!accessToken) {
        toast({
          title: "Phiên đăng nhập hết hạn",
          description: "Vui lòng đăng nhập lại",
          variant: "destructive",
        });
        navigate("/auth", { replace: true });
        return;
      }

      // Call edge function to create goods receipt with edited data
      const response = await callEdgeFunction<{ receiptNumber: string; receiptId: string }>(
        "create-warehouse-receipt",
        {
          goodsReceiptId: matchResult?.goodsReceiptId,
          paymentRequestId: matchResult?.paymentRequestId,
          deliveryImage: deliveryPhoto,
          productPhotos: productPhotos,
          items: editableItems.map(item => ({
            product_name: item.product_name,
            quantity: item.quantity,
            ordered_quantity: item.ordered_quantity ?? item.originalQty ?? null,
            actual_quantity: item.actual_quantity ?? item.quantity,
            unit: item.unit,
            unit_price: item.unit_price,
            line_status: item.line_status,
          })),
          supplierId: selectedSupplierId || matchResult?.supplierId,
        },
        accessToken,
        60000
      );

      if (response.isSessionExpired) {
        toast({
          title: "Phiên đăng nhập hết hạn",
          description: "Vui lòng đăng nhập lại",
          variant: "destructive",
        });
        navigate("/auth", { replace: true });
        return;
      }

      if (response.error) {
        throw new Error(response.error);
      }

      if (response.data) {
        setCreatedReceiptNumber(response.data.receiptNumber);
        setCurrentStep("complete");
        toast({
          title: "Thành công!",
          description: `Đã tạo phiếu nhập kho ${response.data.receiptNumber}`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Đã xảy ra lỗi khi tạo phiếu nhập kho";
      toast({
        title: "Lỗi tạo phiếu",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsConfirming(false);
    }
  };

  const handleBackToCapture = () => {
    setCurrentStep("capture");
    setMatchResult(null);
    setEditableItems([]);
  };

  const handleReset = () => {
    setDeliveryPhoto(null);
    setProductPhotos([]);
    setMatchResult(null);
    setEditableItems([]);
    setSelectedSupplierId("");
    setCurrentStep("capture");
    setCreatedReceiptNumber(null);
    setCaptureMode("none");
  };

  // Success screen
  if (currentStep === "complete") {
    return (
      <WarehouseLayout userName={fullName} onLogout={handleLogout}>
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
          <div className="h-20 w-20 rounded-full bg-green-100 flex items-center justify-center mb-6">
            <CheckCircle className="h-10 w-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold text-green-600 mb-2">
            Nhập kho thành công!
          </h2>
          <p className="text-muted-foreground mb-6">
            Phiếu nhập kho: <span className="font-medium">{createdReceiptNumber}</span>
          </p>
          <Button onClick={handleReset} size="lg">
            <RotateCcw className="h-5 w-5 mr-2" />
            Nhập kho tiếp
          </Button>
        </div>
      </WarehouseLayout>
    );
  }

  // Camera capture mode
  if (captureMode !== "none") {
    return (
      <WarehouseLayout userName={fullName} onLogout={handleLogout}>
        <CameraCapture
          label={captureMode === "delivery" ? "Chụp phiếu giao hàng" : "Chụp ảnh sản phẩm"}
          onCapture={captureMode === "delivery" ? handleDeliveryCapture : handleProductCapture}
          onCancel={() => setCaptureMode("none")}
        />
      </WarehouseLayout>
    );
  }

  // Step 2: Edit scanned data
  if (currentStep === "edit" && matchResult) {
    return (
      <WarehouseLayout userName={fullName} onLogout={handleLogout}>
        <div className="space-y-4">
          <div className="text-center py-2">
            <h2 className="text-lg font-semibold">Kiểm tra thông tin</h2>
            <p className="text-sm text-muted-foreground">
              Xem và chỉnh sửa dữ liệu trước khi tạo phiếu
            </p>
          </div>
          
          <ScanResultEditor
            isMatched={matchResult.isMatched}
            matchScore={matchResult.matchScore}
            matchSource={matchResult.matchSource}
            goodsReceiptId={matchResult.goodsReceiptId}
            receiptNumber={matchResult.receiptNumber}
            purchaseOrderId={matchResult.purchaseOrderId}
            poNumber={matchResult.poNumber}
            poTitle={matchResult.poTitle}
            paymentRequestId={matchResult.paymentRequestId}
            paymentRequestNumber={matchResult.paymentRequestNumber}
            paymentRequestTitle={matchResult.paymentRequestTitle}
            supplierId={matchResult.supplierId}
            supplierName={matchResult.supplierName}
            items={editableItems}
            onItemsChange={setEditableItems}
            onSupplierChange={setSelectedSupplierId}
            onConfirm={handleConfirmReceipt}
            onCancel={handleBackToCapture}
            isConfirming={isConfirming}
          />
        </div>
      </WarehouseLayout>
    );
  }

  // Step 1: Main capture interface
  return (
    <WarehouseLayout userName={fullName} onLogout={handleLogout}>
      <div className="space-y-6">
        {/* Welcome */}
        <div className="text-center py-2">
          <h2 className="text-lg font-semibold">
            Xin chào{fullName ? `, ${fullName}` : ""}!
          </h2>
          <p className="text-sm text-muted-foreground">
            Chụp ảnh phiếu giao hàng để bắt đầu
          </p>
        </div>

        {/* Delivery Photo */}
        <Card>
          <CardContent className="pt-4">
            <PhotoPreview
              imageUrl={deliveryPhoto}
              label="1. Phiếu giao hàng"
              onCapture={() => setCaptureMode("delivery")}
              onRemove={() => setDeliveryPhoto(null)}
              isRequired
            />
          </CardContent>
        </Card>

        {/* Product Photos */}
        <Card>
          <CardContent className="pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-2">
                <Package className="h-4 w-4" />
                2. Ảnh sản phẩm
                <span className="text-muted-foreground font-normal">
                  ({productPhotos.length} ảnh)
                </span>
              </span>
            </div>
            
            {productPhotos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {productPhotos.map((photo, index) => (
                  <div key={index} className="relative aspect-square rounded-lg overflow-hidden">
                    <img src={photo} alt={`Product ${index + 1}`} className="w-full h-full object-cover" />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute top-1 right-1 h-6 w-6"
                      onClick={() => removeProductPhoto(index)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}
            
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setCaptureMode("product")}
            >
              <Camera className="h-4 w-4 mr-2" />
              Thêm ảnh sản phẩm
            </Button>
          </CardContent>
        </Card>

        {/* Scan Button */}
        <Button
          size="lg"
          className="w-full"
          onClick={handleScan}
          disabled={!deliveryPhoto || isScanning}
        >
          {isScanning ? (
            <>
              <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              Đang quét...
            </>
          ) : (
            <>
              <Search className="h-5 w-5 mr-2" />
              Quét phiếu giao hàng
            </>
          )}
        </Button>
      </div>
    </WarehouseLayout>
  );
}
