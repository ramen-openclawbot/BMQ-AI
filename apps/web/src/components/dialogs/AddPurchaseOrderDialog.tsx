import { formatText } from "@/i18n/format";
import { purchaseOrderPurchasing } from "@/i18n/purchaseOrderPurchasing";
import { usePurchasingCopy } from "@/i18n/purchasingCopy";
import { useState, useRef, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format } from "date-fns";
import { CalendarIcon, Loader2, Plus, Trash2, Upload, Scan, ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useProductSKUs } from "@/hooks/useProductSKUs";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  generatePONumber,
  useCreatePurchaseOrder,
  useCreatePurchaseOrderItem,
} from "@/hooks/usePurchaseOrders";
import { ensureReceiptForPurchaseOrder } from "@/hooks/usePurchaseReceiptQueue";

import { callEdgeFunction } from "@/lib/fetch-with-timeout";

const poItemSchema = (pc: typeof purchaseOrderPurchasing.vi) => z.object({
  sku_id: z.string().optional(),
  product_name: z.string().min(1, pc.validation140),
  quantity: z.coerce.number().min(0.01, pc.validation141),
  unit: z.string().optional(),
  unit_price: z.coerce.number().min(0, pc.validation142),
  notes: z.string().optional(),
});

const purchaseOrderSchema = (pc: typeof purchaseOrderPurchasing.vi) => z.object({
  supplier_id: z.string().min(1, pc.validation143),
  order_date: z.date(),
  expected_date: z.date().optional(),
  vat_amount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
  items: z.array(poItemSchema(pc)).min(1, pc.validation144),
});

type PurchaseOrderFormData = z.infer<ReturnType<typeof purchaseOrderSchema>>;

interface ScannedPOData {
  po_number?: string;
  order_date?: string;
  expected_date?: string;
  supplier_name?: string;
  vat_amount?: number;
  total_amount?: number;
  items: Array<{
    product_code?: string;
    product_name: string;
    unit?: string;
    quantity: number;
    unit_price?: number;
    line_total?: number;
    notes?: string;
  }>;
  notes?: string;
}

interface AddPurchaseOrderDialogProps {
  children?: React.ReactNode;
}

const MAX_PO_BATCH_FILES = 10;
const MAX_PO_FILE_SIZE_MB = 10;

export function AddPurchaseOrderDialog({ children }: AddPurchaseOrderDialogProps) {
  const pc = usePurchasingCopy(purchaseOrderPurchasing);
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannedImage, setScannedImage] = useState<string | null>(null);
  const [scannedData, setScannedData] = useState<ScannedPOData | null>(null);
  const [selectedImagePreviews, setSelectedImagePreviews] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { user } = useAuth();
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: suppliers } = useSuppliers();
  const { data: productSKUs } = useProductSKUs();
  const createPurchaseOrder = useCreatePurchaseOrder();
  const createPurchaseOrderItem = useCreatePurchaseOrderItem();

  const form = useForm<PurchaseOrderFormData>({
    resolver: zodResolver(purchaseOrderSchema(pc)),
    defaultValues: {
      supplier_id: "",
      order_date: new Date(),
      expected_date: undefined,
      vat_amount: 0,
      notes: "",
      items: [],
    },
  });

  useEffect(() => {
    if (Object.keys(form.formState.errors).length) void form.trigger();
  }, [pc, form]);

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const watchItems = form.watch("items");
  const watchSupplierId = form.watch("supplier_id");
  const watchVat = form.watch("vat_amount") || 0;

  // Filter SKUs by selected supplier
  const supplierSKUs = productSKUs?.filter(
    (sku) => !watchSupplierId || sku.supplier_id === watchSupplierId
  );

  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const total = subtotal + watchVat;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN", {
      style: "currency",
      currency: "VND",
    }).format(amount);
  };

  // Auto-fill item details when SKU selected
  const handleSKUSelect = (index: number, skuId: string) => {
    const sku = productSKUs?.find((s) => s.id === skuId);
    if (sku) {
      form.setValue(`items.${index}.sku_id`, skuId);
      form.setValue(`items.${index}.product_name`, sku.product_name);
      form.setValue(`items.${index}.unit`, sku.unit || "kg");
      form.setValue(`items.${index}.unit_price`, sku.unit_price || 0);
    }
  };

  const TOKEN_ERROR_MESSAGE = pc.tokenErrorContactYourSystemAdministrator;

  const getScanErrorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || "");
    const normalized = message.toLowerCase();
    const isTokenOrQuotaError =
      normalized.includes("rate limit") ||
      normalized.includes("rate_limit") ||
      normalized.includes("quota") ||
      normalized.includes("insufficient_quota") ||
      normalized.includes("token") ||
      normalized.includes("429") ||
      normalized.includes("too many requests");

    return isTokenOrQuotaError ? TOKEN_ERROR_MESSAGE : (message || pc.errorScanningImage);
  };

  const scanSinglePOFile = async (file: File, token: string): Promise<ScannedPOData> => {
    const base64 = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(",")[1]);
      reader.readAsDataURL(file);
    });

    const { data, error } = await callEdgeFunction<{ success: boolean; data: ScannedPOData; error?: string }>(
      "scan-purchase-order",
      { imageBase64: base64, mimeType: file.type },
      token,
      60000
    );

    if (error) throw new Error(error);
    if (!data?.success || !data?.data) throw new Error(pc.noValidScanDataReceived);
    return data.data;
  };

  const mergeScannedPOItems = (scans: ScannedPOData[]) => {
    const map = new Map<string, { product_name: string; quantity: number; unit: string; unit_price: number; notes: string }>();
    for (const scanned of scans) {
      for (const item of scanned.items || []) {
        const key = `${(item.product_name || "").trim().toLowerCase()}|${(item.unit || "kg").trim().toLowerCase()}`;
        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            product_name: item.product_name || "",
            quantity: Number(item.quantity || 0),
            unit: item.unit || "kg",
            unit_price: Number(item.unit_price || 0),
            notes: item.notes || "",
          });
        } else {
          existing.quantity += Number(item.quantity || 0);
          if (!existing.unit_price && item.unit_price) existing.unit_price = Number(item.unit_price || 0);
          map.set(key, existing);
        }
      }
    }

    return Array.from(map.values()).map((x) => ({ sku_id: "", ...x }));
  };

  // Handle image upload and scan (single or batch up to 10 images)
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    if (files.length > MAX_PO_BATCH_FILES) {
      toast.error(formatText(pc.message132, { v0: MAX_PO_BATCH_FILES }));
      event.currentTarget.value = "";
      return;
    }

    const invalid = files.find((f) => !f.type.startsWith("image/"));
    if (invalid) {
      toast.error(pc.pOScanningCurrentlySupportsImageFilesOnly);
      event.currentTarget.value = "";
      return;
    }

    const oversized = files.find((f) => f.size > MAX_PO_FILE_SIZE_MB * 1024 * 1024);
    if (oversized) {
      toast.error(formatText(pc.message133, { v0: oversized.name, v1: MAX_PO_FILE_SIZE_MB }));
      event.currentTarget.value = "";
      return;
    }

    setIsScanning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        toast.error(pc.yourSessionExpiredPleaseSignInAgain);
        return;
      }

      if (files.length === 1) {
        const f = files[0];
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(f);
        });
        setScannedImage(dataUrl);
        setSelectedImagePreviews([dataUrl]);

        const scanned = await scanSinglePOFile(f, token);
        setScannedData(scanned);

        if (scanned.supplier_name && suppliers) {
          const matchedSupplier = suppliers.find(
            (s) => s.name.toLowerCase().includes(scanned.supplier_name!.toLowerCase()) || scanned.supplier_name!.toLowerCase().includes(s.name.toLowerCase())
          );
          if (matchedSupplier) form.setValue("supplier_id", matchedSupplier.id);
        }
        if (scanned.order_date) { try { form.setValue("order_date", new Date(scanned.order_date)); } catch { /* ignore invalid scanned date */ } }
        if (scanned.expected_date) { try { form.setValue("expected_date", new Date(scanned.expected_date)); } catch { /* ignore invalid scanned date */ } }
        if (scanned.notes) form.setValue("notes", scanned.notes);
        if (scanned.vat_amount) form.setValue("vat_amount", scanned.vat_amount);
        if (scanned.items?.length) replace(scanned.items.map((item) => ({ sku_id: "", product_name: item.product_name || "", quantity: item.quantity || 1, unit: item.unit || "kg", unit_price: item.unit_price || 0, notes: item.notes || "" })));

        toast.success(pc.purchaseOrderScannedSuccessfully);
      } else {
        setScannedImage(null);
        setSelectedImagePreviews([]);
        const previewUrls = await Promise.all(files.map((f) => new Promise<string>((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(r.result as string); r.readAsDataURL(f); })));
        setSelectedImagePreviews(previewUrls.slice(0, 3));
        const scans: ScannedPOData[] = [];
        const scanErrors: unknown[] = [];
        for (const f of files) {
          try {
            const scanned = await scanSinglePOFile(f, token);
            scans.push(scanned);
          } catch (e) {
            scanErrors.push(e);
            console.error(`[po-scan] fail ${f.name}`, e);
          }
        }

        if (!scans.length) {
          const tokenOrQuotaError = scanErrors.find((scanError) => getScanErrorMessage(scanError) === TOKEN_ERROR_MESSAGE);
          throw tokenOrQuotaError ? new Error(TOKEN_ERROR_MESSAGE) : new Error(pc.noFilesInTheBatchCouldBeScanned);
        }

        setScannedData({ items: mergeScannedPOItems(scans), supplier_name: scans[0]?.supplier_name, vat_amount: scans.reduce((x, y) => x + Number(y.vat_amount || 0), 0), total_amount: scans.reduce((x, y) => x + Number(y.total_amount || 0), 0), notes: `Batch scan ${files.length} ảnh` });

        const mergedItems = mergeScannedPOItems(scans);
        replace(mergedItems);

        const supplierNames = scans.map((x) => x.supplier_name).filter(Boolean) as string[];
        const firstSupplier = supplierNames[0];
        if (firstSupplier && suppliers) {
          const matchedSupplier = suppliers.find((s) => s.name.toLowerCase().includes(firstSupplier.toLowerCase()) || firstSupplier.toLowerCase().includes(s.name.toLowerCase()));
          if (matchedSupplier) form.setValue("supplier_id", matchedSupplier.id);
        }

        toast.success(formatText(pc.message134, { v0: scans.length, v1: files.length }));
      }
    } catch (error) {
      console.error("[po-scan] error:", error);
      toast.error(getScanErrorMessage(error));
    } finally {
      setIsScanning(false);
      event.currentTarget.value = "";
    }
  };

  const handleRemoveImage = () => {
    setScannedImage(null);
    setSelectedImagePreviews([]);
    setScannedData(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const onSubmit = async (data: PurchaseOrderFormData) => {
    setIsSubmitting(true);
    try {
      const poNumber = await generatePONumber();

      // Upload image to storage if exists
      let imageUrl: string | null = null;
      if (scannedImage) {
        try {
          const base64Data = scannedImage.split(",")[1];
          const byteCharacters = atob(base64Data);
          const byteArray = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
          }

          const fileName = `${poNumber}-${Date.now()}.jpg`;
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from("purchase-orders")
            .upload(fileName, byteArray, {
              contentType: "image/jpeg",
              upsert: false,
            });

          if (!uploadError && uploadData) {
            // Save storage path instead of signed URL to avoid JWT expiration
            imageUrl = uploadData.path;
          } else if (uploadError) {
            console.warn("Image upload error:", uploadError);
          }
        } catch (uploadErr) {
          console.warn("Image upload failed:", uploadErr);
        }
      }

      const order = await createPurchaseOrder.mutateAsync({
        po_number: poNumber,
        supplier_id: data.supplier_id,
        order_date: format(data.order_date, "yyyy-MM-dd"),
        expected_date: data.expected_date ? format(data.expected_date, "yyyy-MM-dd") : null,
        total_amount: total,
        vat_amount: data.vat_amount || 0,
        notes: data.notes || null,
        image_url: imageUrl,
        created_by: user?.id || null,
        status: "draft",
      });

      // Create items
      for (const item of data.items) {
        await createPurchaseOrderItem.mutateAsync({
          purchase_order_id: order.id,
          sku_id: item.sku_id || null,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit || "kg",
          unit_price: item.unit_price,
          line_total: item.quantity * item.unit_price,
          notes: item.notes || null,
        });
      }

      // Staff PO creation immediately opens the operating flow:
      // - pending CEO payment request (duyệt chi)
      // - draft warehouse goods receipt queue (phiếu nhập kho)
      await ensureReceiptForPurchaseOrder(order.id);

      // Invalidate queries to refresh all linked operational queues immediately (like AddSupplierDialog)
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["draft-po-count"] });
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      
      toast.success(formatText(pc.message135, { v0: poNumber }));
      form.reset();
      setScannedImage(null);
      setSelectedImagePreviews([]);
      setScannedData(null);
      setOpen(false);
    } catch (error) {
      console.error("Error creating PO:", error);
      toast.error(pc.errorCreatingPurchaseOrder);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Reset state when dialog closes to prevent stale state on next open
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset scan-related state when closing
      setIsScanning(false);
      setScannedImage(null);
      setSelectedImagePreviews([]);
      setScannedData(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
    setOpen(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children || <Button><Plus className="h-4 w-4 mr-2" />{pc.createPOPurchasing}</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pc.createPurchaseOrder}</DialogTitle>
          <DialogDescription>
             {pc.createAPurchaseOrderForASupplierUpload} </DialogDescription>
        </DialogHeader>

        {/* Image Upload Section */}
        <div className="border-2 border-dashed rounded-lg p-4 mb-4">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleImageUpload}
            className="hidden"
            id="po-image-upload"
          />
          
          {!scannedData ? (
            <div className="flex flex-col items-center justify-center py-6">
              <ImageIcon className="h-12 w-12 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-3">
                 {pc.uploadSupplierOrderImagesToAutofillInformationUp} </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isScanning}
              >
                {isScanning ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                     {pc.scanning} </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                     {pc.selectImagesToScan110Images} </>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex gap-4">
              <div className="relative w-48 h-32 flex-shrink-0">
                <img
                  src={scannedImage || selectedImagePreviews[0]}
                  alt={pc.scannedPO}
                  className="w-full h-full object-cover rounded-lg"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute -top-2 -right-2 h-6 w-6"
                  onClick={handleRemoveImage}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex-1">
                {isScanning ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>{pc.analyzingImage}</span>
                  </div>
                ) : scannedData ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Scan className="h-4 w-4 text-green-500" />
                      <span className="text-sm font-medium text-green-600">{pc.scannedSuccessfully}</span>
                    </div>
                    {scannedData.supplier_name && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">{pc.supplier2}</span>{" "}
                        <Badge variant="outline">{scannedData.supplier_name}</Badge>
                      </p>
                    )}
                    {scannedData.po_number && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">{pc.pONumber}</span> {scannedData.po_number}
                      </p>
                    )}
                    <p className="text-sm">
                      <span className="text-muted-foreground">{pc.products}</span>{" "}
                      <Badge>{scannedData.items?.length || 0}  {pc.items}</Badge>
                    </p>
                    {selectedImagePreviews.length > 1 && (
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{pc.fieldBatch} {selectedImagePreviews.length}  {pc.images}</Badge>
                        <div className="flex gap-1">
                          {selectedImagePreviews.slice(0, 3).map((src, idx) => (
                            <img key={idx} src={src} alt={`preview-${idx}`} className="h-8 w-8 rounded object-cover border" />
                          ))}
                        </div>
                      </div>
                    )}
                    {scannedData.total_amount && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">{pc.total2}</span>{" "}
                        {formatCurrency(scannedData.total_amount)}
                      </p>
                    )}
                    {scannedData.vat_amount !== undefined && scannedData.vat_amount > 0 && (
                      <p className="text-sm">
                        <span className="text-muted-foreground">{pc.fieldVAT}</span>{" "}
                        {formatCurrency(scannedData.vat_amount)}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Supplier and Dates */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="supplier_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.supplier}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={pc.selectSupplier} />
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
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="order_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.orderDate2}</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? format(field.value, "dd/MM/yyyy") : pc.selectDate}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="expected_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.expectedDeliveryDate}</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                          >
                            {field.value ? format(field.value, "dd/MM/yyyy") : pc.selectDate}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={field.value}
                          onSelect={field.onChange}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Items Table */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{pc.productList2}</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({
                      sku_id: "",
                      product_name: "",
                      quantity: 1,
                      unit: "kg",
                      unit_price: 0,
                      notes: "",
                    })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                   {pc.addProduct} </Button>
              </div>

              {fields.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-48">{pc.selectSKU}</TableHead>
                      <TableHead>{pc.productName}</TableHead>
                      <TableHead className="w-24">{pc.qty}</TableHead>
                      <TableHead className="w-20">{pc.unit}</TableHead>
                      <TableHead className="w-32">{pc.unitPrice}</TableHead>
                      <TableHead className="w-32">{pc.lineTotal}</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, index) => {
                      const item = watchItems[index];
                      const lineTotal = (item?.quantity || 0) * (item?.unit_price || 0);

                      return (
                        <TableRow key={field.id}>
                          <TableCell>
                            <Select
                              value={item?.sku_id || "_none"}
                              onValueChange={(value) => {
                                if (value !== "_none") {
                                  handleSKUSelect(index, value);
                                }
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder={pc.selectSKU} />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_none">{pc.enterManually}</SelectItem>
                                {supplierSKUs?.map((sku) => (
                                  <SelectItem key={sku.id} value={sku.id}>
                                    {sku.sku_code} - {sku.product_name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Input
                              {...form.register(`items.${index}.product_name`)}
                              placeholder={pc.productName}
                              className="h-8"
                            />
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

            {/* VAT and Total */}
            <div className="flex justify-end border-t pt-4">
              <div className="space-y-2 text-right">
                <div>
                  <span className="text-muted-foreground mr-4">{pc.subtotal}</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <span className="text-muted-foreground">{pc.fieldVAT}</span>
                  <Input
                    type="number"
                    {...form.register("vat_amount", { valueAsNumber: true })}
                    className="w-32 h-8 text-right"
                    placeholder="0"
                  />
                  <span className="text-muted-foreground">đ</span>
                </div>
                <div>
                  <span className="text-muted-foreground mr-4">{pc.total}</span>
                  <span className="text-xl font-bold">{formatCurrency(total)}</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{pc.notes}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={pc.additionalNotes} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                     {pc.creating} </>
                ) : (
                  pc.createPurchaseOrder2
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
