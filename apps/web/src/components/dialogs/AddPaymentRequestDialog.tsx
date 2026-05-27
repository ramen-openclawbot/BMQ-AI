import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Upload, Loader2, Plus, Trash2, Scan, TrendingUp, TrendingDown, Package, AlertTriangle, CreditCard, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useGoodsReceipts } from "@/hooks/useGoodsReceipts";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  useCreatePaymentRequest,
  useCreatePaymentRequestItem,
  uploadPaymentRequestImage,
} from "@/hooks/usePaymentRequests";
import {
  findSKUByCodeOrName,
  getLastPrice,
  checkInventory,
} from "@/hooks/useProductSKUs";
import { cn } from "@/lib/utils";
import { generateShortCode } from "@/components/dialogs/AddSupplierDialog";

// Prefill data interface for Drive import
export interface PRPrefillData {
  poId: string;
  poNumber: string;
  supplierId: string | null;
  supplierName: string;
  items: Array<{
    product_name: string;
    quantity: number;
    unit: string;
    unit_price: number;
    line_total?: number;
  }>;
  total: number;
  vat: number;
  imagePath?: string | null;
}

interface AddPaymentRequestDialogProps {
  // Standard trigger mode
  trigger?: React.ReactNode;
  // Controlled mode for external open/close
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // Prefill data from PO
  prefillData?: PRPrefillData;
}

interface ExtractedInvoiceData {
  invoice_number?: string;
  invoice_date?: string;
  supplier_name?: string;
  vat_amount?: number;
  items: Array<{
    product_code?: string;
    product_name: string;
    unit?: string;
    quantity: number;
    unit_price: number;
    standard_cost_label?: string | null;
    ocr_cost_classification?: PaymentRequestItemCostClassification | null;
  }>;
}

type PaymentRequestItemCostClassification = {
  raw_product_name?: string | null;
  suggested_standard_cost_code?: string | null;
  confirmed_standard_cost_code?: string | null;
  standard_cost_code_type?: "NVL" | "OPEX" | "OTHER" | null;
  canonical_cost_item_name?: string | null;
  canonical_cost_item_source?: string | null;
  cost_category_code?: string | null;
  cost_product_line?: string | null;
  cost_allocation_rule?: string | null;
  cost_review_routing?: "none" | "needs_review" | string | null;
  unit_conversion_note?: string | null;
  matched_finished_skus?: string[] | null;
  ocr_classification_json?: Record<string, unknown> | null;
};

interface ItemPriceInfo {
  lastPrice: number | null;
  priceChangePercent: number | null;
  inventoryExists: boolean;
  currentQuantity: number;
  inventoryItemId: string | null;
  skuCode: string | null;
}

const paymentRequestItemSchema = z.object({
  product_code: z.string().optional(),
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  quantity: z.coerce.number().min(0.01, "Số lượng phải lớn hơn 0"),
  unit: z.string().optional(),
  unit_price: z.coerce.number(), // Cho phép số âm để nhập khoản khấu trừ (VD: gas thừa)
  raw_product_name: z.string().nullable().optional(),
  suggested_standard_cost_code: z.string().nullable().optional(),
  confirmed_standard_cost_code: z.string().nullable().optional(),
  standard_cost_code_type: z.enum(["NVL", "OPEX", "OTHER"]).nullable().optional(),
  canonical_cost_item_name: z.string().nullable().optional(),
  canonical_cost_item_source: z.string().nullable().optional(),
  cost_category_code: z.string().nullable().optional(),
  cost_product_line: z.string().nullable().optional(),
  cost_allocation_rule: z.string().nullable().optional(),
  cost_review_routing: z.string().nullable().optional(),
  unit_conversion_note: z.string().nullable().optional(),
  matched_finished_skus: z.array(z.string()).nullable().optional(),
  ocr_classification_json: z.record(z.unknown()).nullable().optional(),
});

const paymentRequestSchema = z.object({
  title: z.string().min(1, "Tiêu đề là bắt buộc"),
  description: z.string().optional(),
  supplier_id: z.string().optional(),
  goods_receipt_id: z.string().optional(),
  payment_type: z.enum(["old_order", "new_order"]).default("old_order"),
  payment_method: z.enum(["bank_transfer", "cash"]).default("bank_transfer"),
  vat_amount: z.coerce.number().min(0).default(0),
  notes: z.string().optional(),
  items: z.array(paymentRequestItemSchema).min(1, "Cần ít nhất một sản phẩm"),
});

type PaymentRequestFormData = z.infer<typeof paymentRequestSchema>;

export function AddPaymentRequestDialog({
  trigger,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  prefillData,
}: AddPaymentRequestDialogProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [itemPriceInfos, setItemPriceInfos] = useState<Record<number, ItemPriceInfo>>({});
  const [isLoadingPrices, setIsLoadingPrices] = useState(false);
  
  // State for inline supplier creation
  const [supplierMode, setSupplierMode] = useState<'select' | 'create'>('select');
  const [newSupplierName, setNewSupplierName] = useState("");
  const [isCreatingSupplier, setIsCreatingSupplier] = useState(false);
  
  // Use controlled or internal state
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (value: boolean) => {
    if (isControlled) {
      controlledOnOpenChange?.(value);
    } else {
      setInternalOpen(value);
    }
  };
  
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: suppliers } = useSuppliers();
  const { data: goodsReceipts = [] } = useGoodsReceipts();
  const createPaymentRequest = useCreatePaymentRequest();
  const createPaymentRequestItem = useCreatePaymentRequestItem();
  
  // Filter goods receipts that are received and not yet linked to a payment request
  const availableGoodsReceipts = goodsReceipts.filter(gr => gr.status === "received");

  const form = useForm<PaymentRequestFormData>({
    resolver: zodResolver(paymentRequestSchema),
    defaultValues: {
      title: "",
      description: "",
      supplier_id: "",
      goods_receipt_id: "",
      payment_type: "old_order",
      payment_method: "bank_transfer",
      vat_amount: 0,
      notes: "",
      items: [],
    },
  });

  // Prefill form when prefillData is provided
  useEffect(() => {
    if (prefillData && open) {
      form.reset({
        title: `Thanh toán ${prefillData.poNumber}`,
        description: `Đề nghị thanh toán cho ${prefillData.supplierName || 'NCC'}`,
        supplier_id: prefillData.supplierId || "",
        goods_receipt_id: "",
        payment_type: "new_order",
        payment_method: "bank_transfer",
        vat_amount: prefillData.vat || 0,
        notes: `Tạo từ ${prefillData.poNumber}`,
        items: prefillData.items?.map(item => ({
          product_code: "",
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
        })) || [],
      });
      
      // If no supplier, show create mode with suggested name
      if (!prefillData.supplierId && prefillData.supplierName) {
        setSupplierMode('create');
        setNewSupplierName(prefillData.supplierName);
      } else {
        setSupplierMode('select');
        setNewSupplierName("");
      }
    }
  }, [prefillData, open, form]);

  // Reset supplier mode when dialog closes
  useEffect(() => {
    if (!open) {
      setSupplierMode('select');
      setNewSupplierName("");
    }
  }, [open]);

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const watchItems = form.watch("items");
  const watchVat = form.watch("vat_amount");
  const watchSupplierId = form.watch("supplier_id");

  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const total = subtotal + (watchVat || 0);

  // Auto-fill payment method when supplier is selected
  useEffect(() => {
    if (watchSupplierId && suppliers) {
      const selectedSupplier = suppliers.find(s => s.id === watchSupplierId);
      if (selectedSupplier?.default_payment_method) {
        form.setValue("payment_method", selectedSupplier.default_payment_method);
      }
    }
  }, [watchSupplierId, suppliers, form]);

  // Get selected supplier info for display
  const selectedSupplier = watchSupplierId ? suppliers?.find(s => s.id === watchSupplierId) : null;

  // Fetch price info and SKU data when items change (with timeout protection)
  useEffect(() => {
    let cancelled = false;
    
    const fetchPriceInfos = async () => {
      if (watchItems.length === 0) {
        setItemPriceInfos({});
        return;
      }
      
      setIsLoadingPrices(true);
      const newInfos: Record<number, ItemPriceInfo> = {};
      
      // Process all items in parallel
      const promises = watchItems.map(async (item, i) => {
        if (!item.product_name && !item.product_code) return;
        
        try {
          // Run all lookups in parallel
          const [priceInfo, inventoryInfo, skuInfo] = await Promise.all([
            getLastPrice(item.product_name),
            checkInventory(item.product_name),
            findSKUByCodeOrName(item.product_code, item.product_name),
          ]);
          
          let priceChangePercent: number | null = null;
          const referencePrice = skuInfo?.unit_price || priceInfo.lastPrice;
          if (referencePrice && item.unit_price > 0) {
            priceChangePercent = ((item.unit_price - referencePrice) / referencePrice) * 100;
          }
          
          newInfos[i] = {
            lastPrice: referencePrice,
            priceChangePercent,
            inventoryExists: inventoryInfo.exists,
            currentQuantity: inventoryInfo.currentQuantity,
            inventoryItemId: inventoryInfo.inventoryItemId,
            skuCode: skuInfo?.sku_code || null,
          };
        } catch (err) {
          console.warn(`Error fetching info for item ${i}:`, err);
          newInfos[i] = {
            lastPrice: null,
            priceChangePercent: null,
            inventoryExists: false,
            currentQuantity: 0,
            inventoryItemId: null,
            skuCode: null,
          };
        }
      });
      
      await Promise.all(promises);
      
      if (!cancelled) {
        setItemPriceInfos(newInfos);
        setIsLoadingPrices(false);
      }
    };
    
    const timeoutId = setTimeout(fetchPriceInfos, 800);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [watchItems]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleScanInvoice = async () => {
    if (!imageFile) {
      return;
    }

    setIsScanning(true);

    try {
      // Convert file to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(imageFile);
      const imageBase64 = await base64Promise;

      // Get auth session for edge function call
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error("No auth session available");
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-invoice`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            imageBase64,
            mimeType: imageFile.type,
            documentType: "payment_request",
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 429) {
          console.error("Rate limit exceeded");
          return;
        }
        if (response.status === 402) {
          console.error("AI credits exhausted");
          return;
        }
        throw new Error(errorData.error || "Failed to scan invoice");
      }

      const result = await response.json();
      const extractedData = result.data as ExtractedInvoiceData;

      if (!extractedData?.items) {
        throw new Error("Không thể đọc thông tin từ hóa đơn");
      }

      // Auto-fill form with extracted data
      if (extractedData.invoice_number) {
        form.setValue("title", `Đề nghị chi - ${extractedData.invoice_number}`);
      }
      if (extractedData.vat_amount) {
        form.setValue("vat_amount", extractedData.vat_amount);
      }

      // Find supplier by name
      if (extractedData.supplier_name && suppliers) {
        const matchedSupplier = suppliers.find(
          (s) =>
            s.name.toLowerCase().includes(extractedData.supplier_name!.toLowerCase()) ||
            extractedData.supplier_name!.toLowerCase().includes(s.name.toLowerCase())
        );
        if (matchedSupplier) {
          form.setValue("supplier_id", matchedSupplier.id);
        }
      }

      // Set items with SKU matching
      if (extractedData.items && extractedData.items.length > 0) {
        // Try to match SKUs for each item
        const itemsWithSKUs = await Promise.all(
          extractedData.items.map(async (item) => {
            const sku = await findSKUByCodeOrName(item.product_code, item.product_name);
            return {
              product_code: sku?.sku_code || item.product_code || "",
              product_name: item.product_name,
              quantity: item.quantity,
              unit: item.unit || sku?.unit || "kg",
              unit_price: item.unit_price,
              ...(item.ocr_cost_classification || {}),
            };
          })
        );
        
        form.setValue("items", itemsWithSKUs);
      }
    } catch (error) {
      console.error("Scan error:", error);
    } finally {
      setIsScanning(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  const onSubmit = async (data: PaymentRequestFormData) => {
    try {
      let supplierId = data.supplier_id;
      
      // Create new supplier if user chose 'create' mode
      if (supplierMode === 'create' && newSupplierName.trim()) {
        setIsCreatingSupplier(true);
        
        const shortCode = generateShortCode(newSupplierName);
        const { data: newSupplier, error: supplierError } = await supabase
          .from('suppliers')
          .insert({
            name: newSupplierName.trim(),
            short_code: shortCode,
            default_payment_method: 'bank_transfer',
          })
          .select()
          .single();
        
        if (supplierError) {
          toast.error(`Lỗi tạo NCC: ${supplierError.message}`);
          setIsCreatingSupplier(false);
          return;
        }
        
        supplierId = newSupplier.id;
        
        // Refresh suppliers list
        queryClient.invalidateQueries({ queryKey: ["suppliers"] });
        toast.success(`Đã tạo NCC "${newSupplierName}"`);
        setIsCreatingSupplier(false);
      }
      
      // Generate request number
      const requestNumber = `PR-${Date.now().toString(36).toUpperCase()}`;

      // Upload image if exists, or use prefillData imagePath
      let imageUrl: string | undefined;
      if (imageFile) {
        imageUrl = await uploadPaymentRequestImage(imageFile);
      } else if (prefillData?.imagePath) {
        imageUrl = prefillData.imagePath;
      }

      // Create payment request with goods_receipt_id and payment_type
      const request = await createPaymentRequest.mutateAsync({
        request_number: requestNumber,
        title: data.title,
        description: data.description || null,
        supplier_id: supplierId || null,
        goods_receipt_id: data.goods_receipt_id || null,
        purchase_order_id: prefillData?.poId || null,
        payment_type: data.payment_type,
        payment_method: data.payment_method,
        vat_amount: data.vat_amount || 0,
        total_amount: total,
        image_url: imageUrl || null,
        notes: data.notes || null,
        created_by: user?.id || null,
      });

      // Create items with price info
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        const priceInfo = itemPriceInfos[i];
        
        await createPaymentRequestItem.mutateAsync({
          payment_request_id: request.id,
          product_code: item.product_code || null,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
          line_total: item.quantity * item.unit_price,
          last_price: priceInfo?.lastPrice || null,
          price_change_percent: priceInfo?.priceChangePercent || null,
          inventory_item_id: priceInfo?.inventoryItemId || null,
          raw_product_name: item.raw_product_name || item.product_name,
          suggested_standard_cost_code: item.suggested_standard_cost_code || null,
          confirmed_standard_cost_code: item.confirmed_standard_cost_code || null,
          standard_cost_code_type: item.standard_cost_code_type || null,
          canonical_cost_item_name: item.canonical_cost_item_name || null,
          canonical_cost_item_source: item.canonical_cost_item_source || null,
          cost_category_code: item.cost_category_code || null,
          cost_product_line: item.cost_product_line || null,
          cost_allocation_rule: item.cost_allocation_rule || null,
          cost_review_routing: item.cost_review_routing || "none",
          unit_conversion_note: item.unit_conversion_note || null,
          matched_finished_skus: item.matched_finished_skus || null,
          ocr_classification_json: item.ocr_classification_json || null,
        });
      }

      // Invalidate queries to refresh list immediately (like AddSupplierDialog)
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });

      toast.success("Đã tạo đề nghị duyệt chi thành công");
      setOpen(false);
      form.reset();
      setImageFile(null);
      setImagePreview(null);
      setItemPriceInfos({});
    } catch (error) {
      console.error("Error creating payment request:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error("Bạn không có quyền tạo đề nghị chi");
      } else {
        toast.error("Không thể tạo đề nghị chi. Vui lòng thử lại.");
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Only show trigger if not controlled and trigger prop is provided or using default */}
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || (
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Tạo đề nghị chi
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {prefillData ? `Tạo PR từ ${prefillData.poNumber}` : 'Tạo đề nghị duyệt chi'}
          </DialogTitle>
          <DialogDescription>
            {prefillData 
              ? 'Kiểm tra và chỉnh sửa thông tin trước khi lưu' 
              : 'Upload hóa đơn để tự động scan thông tin hoặc nhập thủ công'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Image Upload */}
            <div className="space-y-4">
              <Label>Hóa đơn mua hàng</Label>
              <div className="flex gap-4">
                <div className="flex-1">
                  <div className="border-2 border-dashed rounded-lg p-4 text-center">
                    {imagePreview ? (
                      <div className="relative">
                        <img
                          src={imagePreview}
                          alt="Invoice preview"
                          className="max-h-48 mx-auto rounded"
                        />
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          className="absolute top-2 right-2"
                          onClick={() => {
                            setImageFile(null);
                            setImagePreview(null);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <label className="cursor-pointer block">
                        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                        <span className="text-sm text-muted-foreground">
                          Click để upload hóa đơn
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={handleImageUpload}
                        />
                      </label>
                    )}
                  </div>
                </div>
                {imageFile && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleScanInvoice}
                    disabled={isScanning}
                    className="gap-2"
                  >
                    {isScanning ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Đang scan...
                      </>
                    ) : (
                      <>
                        <Scan className="h-4 w-4" />
                        Scan hóa đơn
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tiêu đề *</FormLabel>
                    <FormControl>
                      <Input placeholder="VD: Đề nghị chi mua NVL tháng 1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="supplier_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nhà cung cấp</FormLabel>
                    
                    {/* Toggle buttons for select/create mode */}
                    <div className="flex gap-2 mb-2">
                      <Button 
                        type="button" 
                        variant={supplierMode === 'select' ? 'default' : 'outline'} 
                        size="sm"
                        onClick={() => setSupplierMode('select')}
                      >
                        Chọn NCC có sẵn
                      </Button>
                      <Button 
                        type="button" 
                        variant={supplierMode === 'create' ? 'default' : 'outline'} 
                        size="sm"
                        onClick={() => setSupplierMode('create')}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Tạo NCC mới
                      </Button>
                    </div>
                    
                    {supplierMode === 'select' ? (
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn nhà cung cấp" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {suppliers?.map((supplier) => (
                            <SelectItem key={supplier.id} value={supplier.id}>
                              {supplier.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="space-y-2">
                        <Input 
                          placeholder="Nhập tên NCC mới..." 
                          value={newSupplierName}
                          onChange={(e) => setNewSupplierName(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          NCC sẽ được tạo tự động khi lưu PR
                        </p>
                      </div>
                    )}
                    
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Payment Type and Goods Receipt Link */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="payment_type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Loại thanh toán *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn loại" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="old_order">
                          <span className="flex items-center gap-2">
                            📋 Thanh toán đơn cũ (công nợ)
                          </span>
                        </SelectItem>
                        <SelectItem value="new_order">
                          <span className="flex items-center gap-2">
                            🆕 Thanh toán đơn mới
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="goods_receipt_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Liên kết Phiếu Nhập Kho</FormLabel>
                    <Select 
                      onValueChange={(value) => field.onChange(value === "_none" ? "" : value)} 
                      value={field.value || "_none"}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Chọn phiếu nhập kho (nếu có)" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="_none">Không liên kết</SelectItem>
                        {availableGoodsReceipts.map((gr) => (
                          <SelectItem key={gr.id} value={gr.id}>
                            {gr.receipt_number} - {gr.suppliers?.name || "N/A"} ({gr.receipt_date})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Payment Method Selection */}
            <FormField
              control={form.control}
              name="payment_method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phương thức thanh toán *</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="flex gap-4"
                    >
                      <div className="flex items-center space-x-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors">
                        <RadioGroupItem value="bank_transfer" id="payment_unc" />
                        <Label htmlFor="payment_unc" className="flex items-center gap-2 cursor-pointer">
                          <CreditCard className="h-4 w-4 text-blue-500" />
                          UNC
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2 p-3 border rounded-lg cursor-pointer hover:bg-muted/50 transition-colors">
                        <RadioGroupItem value="cash" id="payment_cash" />
                        <Label htmlFor="payment_cash" className="flex items-center gap-2 cursor-pointer">
                          <Banknote className="h-4 w-4 text-orange-500" />
                          Tiền mặt
                        </Label>
                      </div>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mô tả</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Mô tả chi tiết về đề nghị chi..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Items Table */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>Danh sách sản phẩm</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({
                      product_code: "",
                      product_name: "",
                      quantity: 1,
                      unit: "kg",
                      unit_price: 0,
                    })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Thêm sản phẩm
                </Button>
              </div>

              {fields.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Mã SP</TableHead>
                      <TableHead>Tên sản phẩm</TableHead>
                      <TableHead className="w-24">SL</TableHead>
                      <TableHead className="w-20">ĐVT</TableHead>
                      <TableHead className="w-32">Đơn giá</TableHead>
                      <TableHead className="w-32">Thành tiền</TableHead>
                      <TableHead className="w-36">Giá cũ / Tồn kho</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, index) => {
                      const item = watchItems[index];
                      const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);
                      const priceInfo = itemPriceInfos[index];
                      
                      return (
                        <TableRow key={field.id}>
                          <TableCell>
                            <Input
                              {...form.register(`items.${index}.product_code`)}
                              placeholder="Mã"
                              className="h-8"
                            />
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Input
                                {...form.register(`items.${index}.product_name`)}
                                placeholder="Tên sản phẩm"
                                className="h-8"
                              />
                              {item?.suggested_standard_cost_code && item?.canonical_cost_item_name && (
                                <div className="text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">Mã chuẩn</span>{" "}
                                  {item.standard_cost_code_type ? `${item.standard_cost_code_type} · ` : ""}
                                  {item.suggested_standard_cost_code} — {item.canonical_cost_item_name}
                                  {item.cost_category_code ? ` · ${item.cost_category_code}` : ""}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              step="0.01"
                              {...form.register(`items.${index}.quantity`, {
                                valueAsNumber: true,
                              })}
                              className="h-8"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              {...form.register(`items.${index}.unit`)}
                              placeholder="kg"
                              className="h-8"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              {...form.register(`items.${index}.unit_price`, {
                                valueAsNumber: true,
                              })}
                              className="h-8"
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {formatCurrency(lineTotal)}
                          </TableCell>
                          <TableCell>
                            {isLoadingPrices ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : priceInfo ? (
                              <div className="space-y-1">
                                {priceInfo.lastPrice ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-muted-foreground">
                                      {formatCurrency(priceInfo.lastPrice)}
                                    </span>
                                    {priceInfo.priceChangePercent !== null && (
                                      <Badge
                                        variant={priceInfo.priceChangePercent > 0 ? "destructive" : "secondary"}
                                        className="text-xs px-1"
                                      >
                                        {priceInfo.priceChangePercent > 0 ? (
                                          <TrendingUp className="h-3 w-3 mr-0.5" />
                                        ) : (
                                          <TrendingDown className="h-3 w-3 mr-0.5" />
                                        )}
                                        {Math.abs(priceInfo.priceChangePercent).toFixed(1)}%
                                      </Badge>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-xs text-muted-foreground">Chưa có giá cũ</span>
                                )}
                                <div className="flex items-center gap-1">
                                  {priceInfo.inventoryExists ? (
                                    <Badge variant="outline" className="text-xs px-1">
                                      <Package className="h-3 w-3 mr-0.5" />
                                      Tồn: {priceInfo.currentQuantity}
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-xs px-1">
                                      <AlertTriangle className="h-3 w-3 mr-0.5" />
                                      Mới
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => remove(index)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {form.formState.errors.items?.message && (
                <p className="text-sm text-destructive">{form.formState.errors.items.message}</p>
              )}
            </div>

            {/* Totals */}
            <div className="space-y-2 border-t pt-4">
              <div className="flex justify-between">
                <span>Tạm tính:</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>VAT:</span>
                <FormField
                  control={form.control}
                  name="vat_amount"
                  render={({ field }) => (
                    <Input
                      type="number"
                      {...field}
                      onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                      className="w-32 text-right"
                    />
                  )}
                />
              </div>
              <div className="flex justify-between font-bold text-lg border-t pt-2">
                <span>Tổng cộng:</span>
                <span>{formatCurrency(total)}</span>
              </div>
            </div>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ghi chú</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Ghi chú thêm..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={createPaymentRequest.isPending}
              >
                {createPaymentRequest.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang tạo...
                  </>
                ) : (
                  "Tạo đề nghị"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
