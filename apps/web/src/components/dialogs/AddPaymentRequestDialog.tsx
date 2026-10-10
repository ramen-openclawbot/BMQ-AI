import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import "@/styles/bmq-unc-approval.css";
import "@/styles/bmq-unc-bulk.css";
import "@/styles/bmq-cash-settlement.css";
import "@/styles/bmq-pr-create.css";
import { uploadPaymentRequestAttachments } from "@/hooks/usePaymentRequestAttachments";
import { Upload, Loader2, Plus, Trash2, Scan, TrendingUp, TrendingDown, Package, AlertTriangle, CreditCard, Banknote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  // VAT, thuế, dịch vụ, phí: no goods to deliver or receive.
  no_receipt: z.boolean().default(false),
  no_receipt_reason: z.string().optional(),
  items: z.array(paymentRequestItemSchema).min(1, "Cần ít nhất một sản phẩm"),
}).refine((d) => !d.no_receipt || (d.no_receipt_reason ?? "").trim().length >= 3, {
  message: "Ghi lý do (ít nhất 3 ký tự), ví dụ: Thuế VAT HĐ317",
  path: ["no_receipt_reason"],
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
  // Chứng từ kèm theo (many files), uploaded after the phiếu is created.
  const [docFiles, setDocFiles] = useState<File[]>([]);
  // More invoices after the first one (imageFile): each is scanned and its khoản are added
  // to the same phiếu; they are stored as Chứng từ kèm theo.
  const [extraInvoices, setExtraInvoices] = useState<{ file: File; preview: string }[]>([]);
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
      no_receipt: false,
      no_receipt_reason: "",
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
        no_receipt: false,
        no_receipt_reason: "",
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
    // Several invoices can be picked at once; each one is scanned.
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const rest = imageFile ? picked : picked.slice(1);
    rest.forEach((extra) => {
      const extraReader = new FileReader();
      extraReader.onloadend = () =>
        setExtraInvoices((prev) => [...prev, { file: extra, preview: extraReader.result as string }].slice(0, 19));
      extraReader.readAsDataURL(extra);
    });
    const file = imageFile ? undefined : picked[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const scanOneInvoice = async (file: File, accessToken: string): Promise<ExtractedInvoiceData> => {
    const imageBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ imageBase64, mimeType: file.type, documentType: "payment_request" }),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 429) throw new Error("Đang quét quá nhiều, thử lại sau ít phút");
      if (response.status === 402) throw new Error("Hết lượt AI");
      throw new Error((errorData as { error?: string }).error || "Failed to scan invoice");
    }
    const result = await response.json();
    const extractedData = result.data as ExtractedInvoiceData;
    if (!extractedData?.items) throw new Error("Không thể đọc thông tin từ hóa đơn");
    return extractedData;
  };

  const handleScanInvoice = async () => {
    if (!imageFile) {
      return;
    }
    const files = [imageFile, ...extraInvoices.map((x) => x.file)];

    setIsScanning(true);

    try {
      // Get auth session for edge function call
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error("No auth session available");
        return;
      }

      // One invoice at a time so the scan endpoint is not flooded.
      const scanned: ExtractedInvoiceData[] = [];
      const failed: number[] = [];
      let firstReason = "";
      for (let i = 0; i < files.length; i += 1) {
        try {
          scanned.push(await scanOneInvoice(files[i], session.access_token));
        } catch (scanError) {
          console.error("Scan error:", scanError);
          failed.push(i + 1);
          if (!firstReason && scanError instanceof Error) firstReason = scanError.message;
        }
      }
      if (failed.length > 0) {
        toast.error(`Chưa đọc được hoá đơn ${failed.join(", ")}${firstReason ? ` (${firstReason})` : ""}. Nhập tay các khoản đó.`);
      }
      if (scanned.length === 0) return;

      // Auto-fill form with extracted data
      if (scanned.length === 1 && scanned[0].invoice_number) {
        form.setValue("title", `Đề nghị chi - ${scanned[0].invoice_number}`);
      } else if (files.length > 1 && !form.getValues("title")) {
        form.setValue("title", `Đề nghị chi - ${files.length} hoá đơn`);
      }
      const vat = scanned.reduce((sum, d) => sum + (Number(d.vat_amount) || 0), 0);
      if (vat > 0) {
        form.setValue("vat_amount", vat);
      }

      // Supplier only when every invoice names the same one.
      const matchedIds = scanned.map((d) => {
        if (!d.supplier_name || !suppliers) return null;
        const name = d.supplier_name.toLowerCase();
        return suppliers.find((s) => s.name.toLowerCase().includes(name) || name.includes(s.name.toLowerCase()))?.id ?? null;
      });
      if (matchedIds[0] && matchedIds.every((id) => id === matchedIds[0])) {
        form.setValue("supplier_id", matchedIds[0]);
      }

      // Items of every invoice, in invoice order, with SKU matching
      const itemsWithSKUs = await Promise.all(
        scanned.flatMap((d) => d.items || []).map(async (item) => {
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
      if (itemsWithSKUs.length > 0) {
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
        ...(data.no_receipt && !prefillData?.poId && !data.goods_receipt_id
          ? {
              requires_receipt: false,
              no_receipt_reason: (data.no_receipt_reason ?? "").trim(),
              no_receipt_set_by: user?.id || null,
              no_receipt_set_at: new Date().toISOString(),
            }
          : {}),
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

      const attachmentFiles = [...extraInvoices.map((x) => x.file), ...docFiles];
      if (attachmentFiles.length > 0) {
        try {
          await uploadPaymentRequestAttachments(request.id, attachmentFiles);
        } catch (attachError) {
          console.error("Error uploading payment request attachments:", attachError);
          toast.warning("Đã tạo phiếu nhưng chưa tải được chứng từ kèm theo. Mở phiếu để thử lại.");
        }
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
      setDocFiles([]);
      setExtraInvoices([]);
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
      <DialogContent
        className="d3-unc d3-ub d3-prc"
        data-bmq-pr-create-dialog
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <DialogHeader className="d3-unc-head text-left sm:text-left">
          <span className="d3-unc-tag">{prefillData ? `Từ ${prefillData.poNumber}` : "Duyệt chi UNC"}</span>
          <DialogTitle className="d3-unc-title">
            {prefillData ? `Tạo PR từ ${prefillData.poNumber}` : "Tạo đề nghị duyệt chi"}
          </DialogTitle>
          <DialogDescription className="d3-unc-sub">
            {prefillData
              ? "Kiểm tra và chỉnh sửa thông tin trước khi lưu."
              : "Up hoá đơn để app đọc sản phẩm, hoặc nhập tay."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="d3-prc-form min-w-0">
            {/* Hoá đơn */}
            <section className="d3-prc-card" aria-label="Hóa đơn mua hàng">
              <h3>Hóa đơn mua hàng{imagePreview ? ` · ${1 + extraInvoices.length}` : ""}</h3>
              {imagePreview ? (
                <div className="d3-cpr-invoices" data-bmq-pr-invoices={1 + extraInvoices.length}>
                  {[{ preview: imagePreview }, ...extraInvoices].map((inv, i) => (
                    <figure key={i}>
                      <img src={inv.preview} alt={i === 0 ? "Invoice preview" : `Hoá đơn ${i + 1}`} />
                      <figcaption>{i + 1}</figcaption>
                      <button
                        type="button"
                        aria-label={`Bỏ hoá đơn ${i + 1}`}
                        disabled={isScanning}
                        onClick={() => {
                          if (i === 0) {
                            const next = extraInvoices[0];
                            setImageFile(next?.file ?? null);
                            setImagePreview(next?.preview ?? null);
                            setExtraInvoices((prev) => prev.slice(1));
                          } else {
                            setExtraInvoices((prev) => prev.filter((_, j) => j !== i - 1));
                          }
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </figure>
                  ))}
                  <label className="d3-cpr-add" data-bmq-pr-invoice-add>
                    <Plus className="h-5 w-5" />
                    <span>Thêm</span>
                    <input type="file" accept="image/*" multiple className="sr-only" onChange={handleImageUpload} />
                  </label>
                </div>
              ) : (
                <label className="d3-unc-drop">
                  <Upload className="h-6 w-6" />
                  <span>Chọn ảnh hoá đơn</span>
                  <small>Chọn được nhiều hoá đơn một lần</small>
                  <input type="file" accept="image/*" multiple className="sr-only" onChange={handleImageUpload} data-bmq-pr-image-input />
                </label>
              )}
              {imageFile && (
                <Button type="button" variant="outline" className="d3-prc-wide h-11 gap-2" onClick={handleScanInvoice} disabled={isScanning}>
                  {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />}
                  {isScanning ? "Đang scan…" : extraInvoices.length > 0 ? `Scan ${1 + extraInvoices.length} hóa đơn` : "Scan hóa đơn"}
                </Button>
              )}
            </section>

            {/* Thông tin phiếu */}
            <section className="d3-prc-card" aria-label="Thông tin phiếu">
              <h3>Thông tin phiếu</h3>
              <div className="d3-prc-grid">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem className="d3-prc-field">
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
                    <FormItem className="d3-prc-field">
                      <FormLabel>Nhà cung cấp</FormLabel>
                      <div className="d3-unc-chips" role="radiogroup" aria-label="Nhà cung cấp">
                        <button type="button" role="radio" aria-checked={supplierMode === "select"} className={supplierMode === "select" ? "is-on" : undefined} onClick={() => setSupplierMode("select")}>
                          Chọn NCC có sẵn
                        </button>
                        <button type="button" role="radio" aria-checked={supplierMode === "create"} className={supplierMode === "create" ? "is-on" : undefined} onClick={() => setSupplierMode("create")}>
                          <Plus className="mr-1 inline h-3 w-3" />
                          Tạo NCC mới
                        </button>
                      </div>
                      {supplierMode === "select" ? (
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
                        <>
                          <Input placeholder="Nhập tên NCC mới..." value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} />
                          <p className="d3-prc-hint">NCC sẽ được tạo tự động khi lưu PR</p>
                        </>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="payment_type"
                  render={({ field }) => (
                    <FormItem className="d3-prc-field">
                      <FormLabel>Loại thanh toán *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Chọn loại" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="old_order">Thanh toán đơn cũ (công nợ)</SelectItem>
                          <SelectItem value="new_order">Thanh toán đơn mới</SelectItem>
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
                    <FormItem className="d3-prc-field">
                      <FormLabel>Liên kết phiếu nhập kho</FormLabel>
                      <Select onValueChange={(value) => field.onChange(value === "_none" ? "" : value)} value={field.value || "_none"}>
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
                <FormField
                  control={form.control}
                  name="payment_method"
                  render={({ field }) => (
                    <FormItem className="d3-prc-field">
                      <FormLabel>Phương thức thanh toán *</FormLabel>
                      <div className="d3-unc-chips" role="radiogroup" aria-label="Phương thức thanh toán">
                        <button type="button" role="radio" id="payment_unc" aria-checked={field.value === "bank_transfer"} className={field.value === "bank_transfer" ? "is-on" : undefined} onClick={() => field.onChange("bank_transfer")}>
                          <CreditCard className="mr-1.5 inline h-4 w-4" />
                          UNC
                        </button>
                        <button type="button" role="radio" id="payment_cash" aria-checked={field.value === "cash"} className={field.value === "cash" ? "is-on" : undefined} onClick={() => field.onChange("cash")}>
                          <Banknote className="mr-1.5 inline h-4 w-4" />
                          Tiền mặt
                        </button>
                      </div>
                      {field.value === "cash" && (
                        <p className="d3-prc-hint">Chi tiền mặt: CEO chuyển tiền cho người đề nghị, sau đó người đề nghị nộp chứng từ chi lẻ qua link Zalo.</p>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="d3-prc-field" data-bmq-pr-docs>
                  <span className="d3-prc-label">Chứng từ kèm theo{form.watch("payment_method") === "cash" ? "" : " (không bắt buộc)"}</span>
                  <label className="d3-prc-file">
                    <Upload className="h-4 w-4" />
                    <span>{docFiles.length ? `Thêm tệp · đã chọn ${docFiles.length}` : "Chọn ảnh hoặc PDF"}</span>
                    <input
                      id="pr-docs"
                      type="file"
                      accept="image/*,application/pdf"
                      multiple
                      className="sr-only"
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        if (picked.length) setDocFiles((prev) => [...prev, ...picked].slice(0, 20));
                        e.currentTarget.value = "";
                      }}
                      data-bmq-pr-docs-input
                    />
                  </label>
                  {docFiles.length > 0 && (
                    <ul className="d3-prc-files" data-bmq-pr-docs-list>
                      {docFiles.map((f, i) => (
                        <li key={`${f.name}-${i}`}>
                          <span>{f.name}</span>
                          <button type="button" aria-label={`Bỏ ${f.name}`} onClick={() => setDocFiles((prev) => prev.filter((_, j) => j !== i))}>
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem className="d3-prc-field d3-prc-span">
                      <FormLabel>Mô tả</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Mô tả chi tiết về đề nghị chi..." rows={2} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </section>

            {/* Sản phẩm */}
            <section className="d3-prc-card" aria-label="Danh sách sản phẩm">
              <h3>Sản phẩm{fields.length ? ` · ${fields.length}` : ""}</h3>
              {fields.length > 0 && (
                <div className="d3-prc-items" role="table" aria-label="Danh sách sản phẩm">
                  <div className="d3-prc-item d3-prc-item-head" role="row" aria-hidden="true">
                    <span>Mã SP</span>
                    <span>Tên sản phẩm</span>
                    <span>SL</span>
                    <span>ĐVT</span>
                    <span>Đơn giá</span>
                    <span>Thành tiền</span>
                    <span />
                  </div>
                  {fields.map((field, index) => {
                    const item = watchItems[index];
                    const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);
                    const priceInfo = itemPriceInfos[index];
                    return (
                      <div key={field.id} className="d3-prc-item" role="row" data-bmq-pr-item={index}>
                        <label className="d3-prc-c-code">
                          <small>Mã SP</small>
                          <Input {...form.register(`items.${index}.product_code`)} placeholder="Mã" />
                        </label>
                        <label className="d3-prc-c-name">
                          <small>Tên sản phẩm</small>
                          <Input {...form.register(`items.${index}.product_name`)} placeholder="Tên sản phẩm" />
                          {item?.suggested_standard_cost_code && item?.canonical_cost_item_name && (
                            <span className="d3-prc-hint">
                              <b>Mã chuẩn</b> {item.standard_cost_code_type ? `${item.standard_cost_code_type} · ` : ""}
                              {item.suggested_standard_cost_code} — {item.canonical_cost_item_name}
                              {item.cost_category_code ? ` · ${item.cost_category_code}` : ""}
                            </span>
                          )}
                        </label>
                        <label className="d3-prc-c-qty">
                          <small>SL</small>
                          <Input type="number" step="0.01" inputMode="decimal" {...form.register(`items.${index}.quantity`, { valueAsNumber: true })} />
                        </label>
                        <label className="d3-prc-c-unit">
                          <small>ĐVT</small>
                          <Input {...form.register(`items.${index}.unit`)} placeholder="kg" />
                        </label>
                        <label className="d3-prc-c-price">
                          <small>Đơn giá</small>
                          <Input type="number" inputMode="numeric" {...form.register(`items.${index}.unit_price`, { valueAsNumber: true })} />
                        </label>
                        <div className="d3-prc-c-total">
                          <small>Thành tiền</small>
                          <b>{formatCurrency(lineTotal)}</b>
                        </div>
                        <button type="button" className="d3-cs-x d3-prc-c-del" aria-label={`Bỏ dòng ${index + 1}`} onClick={() => remove(index)}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                        {(isLoadingPrices || priceInfo) && (
                          <div className="d3-prc-c-info">
                            {isLoadingPrices ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : priceInfo ? (
                              <>
                                {priceInfo.lastPrice ? (
                                  <span>
                                    Giá cũ {formatCurrency(priceInfo.lastPrice)}
                                    {priceInfo.priceChangePercent !== null && (
                                      <Badge variant={priceInfo.priceChangePercent > 0 ? "destructive" : "secondary"} className="ml-1 px-1 text-xs">
                                        {priceInfo.priceChangePercent > 0 ? <TrendingUp className="mr-0.5 h-3 w-3" /> : <TrendingDown className="mr-0.5 h-3 w-3" />}
                                        {Math.abs(priceInfo.priceChangePercent).toFixed(1)}%
                                      </Badge>
                                    )}
                                  </span>
                                ) : (
                                  <span>Chưa có giá cũ</span>
                                )}
                                {priceInfo.inventoryExists ? (
                                  <Badge variant="outline" className="px-1 text-xs">
                                    <Package className="mr-0.5 h-3 w-3" />
                                    Tồn: {priceInfo.currentQuantity}
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="px-1 text-xs">
                                    <AlertTriangle className="mr-0.5 h-3 w-3" />
                                    Mới
                                  </Badge>
                                )}
                              </>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                className="d3-prc-wide h-11 gap-2"
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
                <Plus className="h-4 w-4" />
                Thêm sản phẩm
              </Button>
              {form.formState.errors.items?.message && (
                <p className="text-sm text-destructive">{form.formState.errors.items.message}</p>
              )}
            </section>

            {/* Tổng & ghi chú */}
            <section className="d3-prc-card" aria-label="Tổng tiền">
              <h3>Tổng tiền</h3>
              <dl className="d3-prc-sum">
                <div>
                  <dt>Tạm tính</dt>
                  <dd>{formatCurrency(subtotal)}</dd>
                </div>
                <div>
                  <dt>VAT</dt>
                  <dd>
                    <FormField
                      control={form.control}
                      name="vat_amount"
                      render={({ field }) => (
                        <Input
                          type="number"
                          inputMode="numeric"
                          aria-label="VAT"
                          {...field}
                          onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                          className="w-36 text-right"
                        />
                      )}
                    />
                  </dd>
                </div>
                <div className="is-total">
                  <dt>Tổng cộng</dt>
                  <dd>{formatCurrency(total)}</dd>
                </div>
              </dl>

              {/* Chi không nhập kho: VAT, thuế, dịch vụ, phí. Not offered for PO / receipt-linked requests. */}
              {!prefillData?.poId && !form.watch("goods_receipt_id") && (
                <div className="d3-prc-noreceipt" data-bmq-no-receipt-create>
                  <FormField
                    control={form.control}
                    name="no_receipt"
                    render={({ field }) => (
                      <FormItem className="flex items-start gap-3 space-y-0">
                        <FormControl>
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 accent-primary"
                            checked={!!field.value}
                            onChange={(e) => field.onChange(e.target.checked)}
                            data-bmq-no-receipt-toggle
                          />
                        </FormControl>
                        <div className="space-y-0.5">
                          <FormLabel className="cursor-pointer">Chi không nhập kho</FormLabel>
                          <p className="d3-prc-hint">VAT, thuế, dịch vụ, phí… Không có giao hàng hay hóa đơn nhập kho; phiếu hoàn tất khi đã trả.</p>
                        </div>
                      </FormItem>
                    )}
                  />
                  {form.watch("no_receipt") && (
                    <FormField
                      control={form.control}
                      name="no_receipt_reason"
                      render={({ field }) => (
                        <FormItem>
                          <FormControl>
                            <Input placeholder="Lý do, ví dụ: Thuế VAT HĐ317" {...field} data-bmq-no-receipt-reason />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  )}
                </div>
              )}

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="d3-prc-field">
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea placeholder="Ghi chú thêm..." rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            {/* Actions */}
            <div className="d3-ub-foot d3-prc-foot">
              <p>
                <b>{fields.length}</b> dòng · <b>{formatCurrency(total)}</b>
              </p>
              <div className="d3-prc-acts">
                <Button type="button" variant="outline" className="h-11" onClick={() => setOpen(false)}>
                  Hủy
                </Button>
                <Button type="submit" className="d3-ub-go" disabled={createPaymentRequest.isPending} data-bmq-pr-submit>
                  {createPaymentRequest.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Đang tạo...
                    </>
                  ) : (
                    "Tạo đề nghị"
                  )}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
