import { formatText } from "@/i18n/format";
import { invoicePurchasing } from "@/i18n/invoicePurchasing";
import { usePurchasingCopy } from "@/i18n/purchasingCopy";
import { useState, useEffect, useMemo } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { useSuppliers } from "@/hooks/useSuppliers";
import { useCreateInvoiceWithItems } from "@/hooks/useInvoices";
import { usePaymentRequests, usePaymentRequestItems } from "@/hooks/usePaymentRequests";
import { supabase } from "@/integrations/supabase/client";
import {
  createInvoiceFromPaymentRequestWithMaterialController,
  getCurrentActorId,
} from "@/lib/material-controller-rpcs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Upload, Loader2, Scan, Link, CreditCard } from "lucide-react";

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
    ocr_cost_classification?: InvoiceItemCostClassification | null;
  }>;
}

type InvoiceItemCostClassification = {
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

const invoiceItemSchema = (pc: typeof invoicePurchasing.vi) => z.object({
  product_code: z.string().optional(),
  product_name: z.string().min(1, pc.validation101),
  unit: z.string().default("kg"),
  quantity: z.coerce.number().min(0, pc.validation102),
  unit_price: z.coerce.number().min(0, pc.validation103),
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

const invoiceSchema = (pc: typeof invoicePurchasing.vi) => z.object({
  invoice_number: z.string().min(1, pc.validation104),
  invoice_date: z.string().min(1, pc.validation105),
  supplier_id: z.string().optional(),
  payment_request_id: z.string().optional(),
  vat_amount: z.coerce.number().default(0),
  notes: z.string().optional(),
  items: z.array(invoiceItemSchema(pc)).min(1, pc.validation106),
});

type InvoiceFormData = z.infer<ReturnType<typeof invoiceSchema>>;

export function AddInvoiceDialog() {
  const pc = usePurchasingCopy(invoicePurchasing);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [paymentSlipFile, setPaymentSlipFile] = useState<File | null>(null);
  const [paymentSlipPreview, setPaymentSlipPreview] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const { data: suppliers } = useSuppliers();
  const { data: paymentRequests } = usePaymentRequests();
  const { data: requestItems } = usePaymentRequestItems(selectedRequestId);
  const createInvoiceWithItems = useCreateInvoiceWithItems();
  const queryClient = useQueryClient();

  // Filter to only show approved requests without invoices
  const availableRequests = useMemo(() => paymentRequests?.filter(
    (pr) => pr.status === "approved" && !pr.invoice_created
  ) || [], [paymentRequests]);

  const form = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema(pc)),
    defaultValues: {
      invoice_number: "",
      invoice_date: new Date().toISOString().split("T")[0],
      supplier_id: "",
      payment_request_id: "",
      vat_amount: 0,
      notes: "",
      items: [
        {
          product_code: "",
          product_name: "",
          unit: "kg",
          quantity: 0,
          unit_price: 0,
        },
      ],
    },
  });

  useEffect(() => {
    if (Object.keys(form.formState.errors).length) void form.trigger();
  }, [pc, form]);

  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Auto-fill when payment request is selected
  useEffect(() => {
    if (selectedRequestId && requestItems && requestItems.length > 0) {
      const selectedRequest = availableRequests.find(r => r.id === selectedRequestId);
      
      if (selectedRequest) {
        // Set supplier
        if (selectedRequest.supplier_id) {
          form.setValue("supplier_id", selectedRequest.supplier_id);
        }
        
        // Set invoice number based on request number
        form.setValue("invoice_number", `INV-${selectedRequest.request_number}`);
        
        // Set VAT from payment request.
        // Fallback: older requests may have vat_amount=0; infer VAT from total_amount - subtotal(items)
        const requestVatRaw = Number(selectedRequest.vat_amount ?? 0) || 0;
        const subtotalFromItems = requestItems.reduce(
          (sum, item) => sum + (Number(item.line_total) || (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)),
          0,
        );
        const totalFromRequest = Number(selectedRequest.total_amount ?? 0) || 0;
        const inferredVat = Math.max(0, totalFromRequest - subtotalFromItems);
        const finalVat = requestVatRaw > 0 ? requestVatRaw : inferredVat;
        form.setValue("vat_amount", finalVat);
        
        // Set items from request items
        const newItems: InvoiceFormData["items"] = requestItems.map((item) => ({
          product_code: item.product_code || "",
          product_name: item.product_name,
          unit: item.unit || "kg",
          quantity: Number(item.quantity) || 0,
          unit_price: Number(item.unit_price) || 0,
          raw_product_name: item.raw_product_name || item.product_name,
          suggested_standard_cost_code: item.suggested_standard_cost_code || null,
          confirmed_standard_cost_code: item.confirmed_standard_cost_code || item.suggested_standard_cost_code || null,
          standard_cost_code_type: item.standard_cost_code_type === "NVL" || item.standard_cost_code_type === "OPEX" || item.standard_cost_code_type === "OTHER" ? item.standard_cost_code_type : null,
          canonical_cost_item_name: item.canonical_cost_item_name || null,
          canonical_cost_item_source: item.canonical_cost_item_source || null,
          cost_category_code: item.cost_category_code || null,
          cost_product_line: item.cost_product_line || null,
          cost_allocation_rule: item.cost_allocation_rule || null,
          cost_review_routing: item.cost_review_routing || "none",
          unit_conversion_note: item.unit_conversion_note || null,
          matched_finished_skus: Array.isArray(item.matched_finished_skus) ? item.matched_finished_skus.filter((sku): sku is string => typeof sku === "string") : null,
          ocr_classification_json: item.ocr_classification_json && typeof item.ocr_classification_json === "object" && !Array.isArray(item.ocr_classification_json) ? item.ocr_classification_json as Record<string, unknown> : null,
        }));
        
        replace(newItems);
      }
    }
  }, [selectedRequestId, requestItems, availableRequests, form, replace]);

  // Handle payment request selection change
  const handlePaymentRequestChange = (value: string) => {
    if (value === "none") {
      setSelectedRequestId(null);
      form.setValue("payment_request_id", "");
    } else {
      setSelectedRequestId(value);
      form.setValue("payment_request_id", value);
    }
  };

  const watchItems = form.watch("items");
  const subtotal = watchItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const watchedVatAmount = Number(form.watch("vat_amount"));
  const vatAmount = Number.isFinite(watchedVatAmount) ? watchedVatAmount : 0;
  const totalAmount = subtotal + vatAmount;
  const selectedRequest = useMemo(
    () => availableRequests.find((request) => request.id === selectedRequestId) || null,
    [availableRequests, selectedRequestId],
  );

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Preview locally first
    const previewUrl = URL.createObjectURL(file);
    setImageUrl(previewUrl);
    setImageFile(file);
  };

  const handleScanInvoice = async () => {
    if (!imageFile) {
      return;
    }

    try {
      setScanning(true);

      // Convert file to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          // Remove the data:image/xxx;base64, prefix
          const base64 = result.split(",")[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(imageFile);
      const imageBase64 = await base64Promise;

      // Get auth session for edge function call (optional fallback: apikey-only)
      const { data: { session } } = await supabase.auth.getSession();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "apikey": import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      };
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-invoice`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            imageBase64,
            mimeType: imageFile.type,
            documentType: "invoice",
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));

        if (response.status === 401) {
          toast.error(pc.yourSessionExpiredPleaseSignInAgainTo);
          return;
        }
        if (response.status === 402) {
          toast.error(pc.noAICreditsLeftForInvoiceScanning);
          return;
        }
        if (response.status === 429) {
          toast.error(pc.theSystemIsBusyPleaseTryAgainIn);
          return;
        }

        throw new Error(errorData.error || pc.scanFailed);
      }

      const result = await response.json();
      const extractedData = result.data as ExtractedInvoiceData;

      // Populate form with extracted data
      if (extractedData.invoice_number) {
        form.setValue("invoice_number", extractedData.invoice_number);
      }
      if (extractedData.invoice_date) {
        form.setValue("invoice_date", extractedData.invoice_date);
      }
      if (extractedData.vat_amount) {
        form.setValue("vat_amount", extractedData.vat_amount);
      }

      // Match supplier by name if found
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

      // Populate items
      if (extractedData.items && extractedData.items.length > 0) {
        // Clear existing items and add extracted ones
        const newItems = extractedData.items.map((item) => ({
          product_code: item.product_code || "",
          product_name: item.product_name || "",
          unit: item.unit || "kg",
          quantity: item.quantity || 0,
          unit_price: item.unit_price || 0,
          ...(item.ocr_cost_classification || {}),
        }));
        form.setValue("items", newItems);
      }

      toast.success(pc.invoiceScannedSuccessfully);
    } catch (error) {
      console.error("Error scanning invoice:", error);
      toast.error(error instanceof Error ? error.message : pc.unableToScanInvoice);
    } finally {
      setScanning(false);
    }
  };

  const onSubmit = async (data: InvoiceFormData) => {
    // PROTOTYPE MODE: No login required
    try {
      setUploading(true);

      const submittedSubtotal = data.items.reduce(
        (sum, item) => sum + item.quantity * item.unit_price,
        0,
      );
      const submittedVatAmount = data.vat_amount;
      const submittedTotalAmount = submittedSubtotal + submittedVatAmount;

      // Upload invoice image if exists (store storage path, not signed URL)
      let uploadedImageUrl: string | null = null;
      if (imageFile) {
        const fileExt = imageFile.name.split(".").pop();
        const fileName = `invoice-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, imageFile);

        if (uploadError) {
          throw new Error(formatText(pc.message90, { v0: uploadError.message }));
        }

        uploadedImageUrl = fileName;
      }

      // Upload payment slip image if exists (store storage path, not signed URL)
      let uploadedPaymentSlipUrl: string | null = null;
      if (paymentSlipFile) {
        const fileExt = paymentSlipFile.name.split(".").pop();
        const fileName = `payment-slips/slip-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, paymentSlipFile);

        if (uploadError) {
          throw new Error(formatText(pc.message91, { v0: uploadError.message }));
        }

        uploadedPaymentSlipUrl = fileName;
      }

      const invoiceResult = data.payment_request_id
        ? await createInvoiceFromPaymentRequestWithMaterialController({
            paymentRequestId: data.payment_request_id,
            invoiceNumber: data.invoice_number,
            invoiceDate: data.invoice_date,
            vatAmount: submittedVatAmount,
            notes: data.notes || null,
            paymentSlipUrl: uploadedPaymentSlipUrl,
            actorId: await getCurrentActorId(),
          })
        : await createInvoiceWithItems.mutateAsync({
            invoice: {
              invoice_number: data.invoice_number,
              invoice_date: data.invoice_date,
              supplier_id: data.supplier_id || null,
              subtotal: submittedSubtotal,
              vat_amount: submittedVatAmount,
              total_amount: submittedTotalAmount,
              image_url: uploadedImageUrl,
              payment_slip_url: uploadedPaymentSlipUrl,
              notes: data.notes || null,
            },
            items: data.items.map((item) => ({
              product_code: item.product_code || null,
              product_name: item.product_name,
              unit: item.unit,
              quantity: item.quantity,
              unit_price: item.unit_price,
              inventory_item_id: null,
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
            })),
          });

      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });

      toast.success(formatText(pc.message92, { v0: invoiceResult.items_count }));
      form.reset();
      setImageUrl(null);
      setImageFile(null);
      setPaymentSlipFile(null);
      setPaymentSlipPreview(null);
      setSelectedRequestId(null);
      setOpen(false);
    } catch (error) {
      console.error("Error creating invoice:", error);
      const errorMessage = error instanceof Error ? error.message : pc.unknownError;
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error(pc.youDoNotHavePermissionToCreateInvoices);
      } else {
        toast.error(pc.unableToCreateInvoicePleaseTryAgain);
      }
    } finally {
      setUploading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN").format(amount);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
           {pc.addInvoice} </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{pc.addNewInvoice}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Image Upload Section - Two columns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Invoice Image */}
              <div className="border-2 border-dashed border-border rounded-lg p-4">
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm font-medium">{pc.invoiceImage}</p>
                  {imageUrl ? (
                    <div className="relative">
                      <img
                        src={imageUrl}
                        alt={pc.invoicePreview}
                        className="max-h-32 rounded-lg object-contain"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2"
                        onClick={() => {
                          setImageUrl(null);
                          setImageFile(null);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
                      <p className="mt-1 text-xs text-muted-foreground">
                         {pc.uploadAnInvoiceToScanOrStore} </p>
                    </div>
                  )}
                  <div className="flex flex-col items-center gap-2 w-full">
                    <Input
                      type="file"
                      accept="image/*"
                      onChange={handleImageUpload}
                      className="text-xs"
                    />
                    {imageFile && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleScanInvoice}
                        disabled={scanning}
                        className="w-full"
                      >
                        {scanning ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Scan className="h-4 w-4 mr-2" />
                        )}
                        {scanning ? pc.scanning : pc.scanInvoice}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Payment Slip Image */}
              <div className="border-2 border-dashed border-border rounded-lg p-4">
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm font-medium flex items-center gap-1">
                    <CreditCard className="h-4 w-4" />
                     {pc.bankSlipPaymentDocumentImage} </p>
                  {paymentSlipPreview ? (
                    <div className="relative">
                      <img
                        src={paymentSlipPreview}
                        alt={pc.paymentSlipPreview}
                        className="max-h-32 rounded-lg object-contain"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2"
                        onClick={() => {
                          setPaymentSlipFile(null);
                          setPaymentSlipPreview(null);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center py-4">
                      <CreditCard className="mx-auto h-8 w-8 text-muted-foreground" />
                      <p className="mt-1 text-xs text-muted-foreground">
                         {pc.optionalUploadABankSlipImageForStorage} </p>
                    </div>
                  )}
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setPaymentSlipFile(file);
                        const previewUrl = URL.createObjectURL(file);
                        setPaymentSlipPreview(previewUrl);
                      }
                    }}
                    className="text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Link Payment Request */}
            {availableRequests.length > 0 && (
              <div className="p-4 bg-muted/30 rounded-lg border border-border">
                <div className="flex items-center gap-2 mb-3">
                  <Link className="h-4 w-4 text-primary" />
                  <span className="font-medium text-sm">{pc.linkPaymentRequestOptional}</span>
                </div>
                <Select 
                  onValueChange={handlePaymentRequestChange} 
                  value={selectedRequestId || "none"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={pc.selectPaymentRequestToLink} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{pc.noLink}</SelectItem>
                    {availableRequests.map((pr) => (
                      <SelectItem key={pr.id} value={pr.id}>
                        {pr.request_number} - {pr.title} ({formatCurrency(pr.total_amount || 0)} VND)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedRequestId && (
                  <p className="text-xs text-muted-foreground mt-2">
                     {pc.detailsWillBeFilledFromTheSelectedPayment} </p>
                )}
              </div>
            )}

            {/* Invoice Details */}
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="invoice_number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.invoiceNumber2}</FormLabel>
                    <FormControl>
                      <Input placeholder={pc.eGINV001} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="invoice_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.invoiceDate2}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
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
                name="vat_amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{pc.vATAmountVND}</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Invoice Items */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{pc.invoiceItems}</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({
                      product_code: "",
                      product_name: "",
                      unit: "kg",
                      quantity: 0,
                      unit_price: 0,
                    })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                   {pc.addItem} </Button>
              </div>

              <div className="space-y-3">
                {fields.map((field, index) => {
                  const item = watchItems[index];
                  return (
                  <div
                    key={field.id}
                    className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/50 rounded-lg"
                  >
                    <FormField
                      control={form.control}
                      name={`items.${index}.product_code`}
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="text-xs">{pc.code}</FormLabel>
                          <FormControl>
                            <Input placeholder={pc.code} {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.product_name`}
                      render={({ field }) => (
                        <FormItem className="col-span-3">
                          <FormLabel className="text-xs">{pc.productName2}</FormLabel>
                          <FormControl>
                            <Input placeholder={pc.productName3} {...field} />
                          </FormControl>
                          {item?.suggested_standard_cost_code && item?.canonical_cost_item_name && (
                            <div className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">{pc.standardCode}</span>{" "}
                              {item.standard_cost_code_type ? `${item.standard_cost_code_type} · ` : ""}
                              {item.suggested_standard_cost_code} — {item.canonical_cost_item_name}
                              {item.cost_category_code ? ` · ${item.cost_category_code}` : ""}
                            </div>
                          )}
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.unit`}
                      render={({ field }) => (
                        <FormItem className="col-span-1">
                          <FormLabel className="text-xs">{pc.unit2}</FormLabel>
                          <FormControl>
                            <Input placeholder="kg" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.quantity`}
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="text-xs">{pc.quantity}</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.001" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.unit_price`}
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="text-xs">{pc.unitPrice2}</FormLabel>
                          <FormControl>
                            <Input type="number" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <div className="col-span-1 text-right text-sm font-medium">
                      {formatCurrency(
                        (watchItems[index]?.quantity || 0) *
                          (watchItems[index]?.unit_price || 0)
                      )}
                    </div>

                    <div className="col-span-1">
                      {fields.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => remove(index)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>{pc.subtotal2}</span>
                  <span className="font-medium">{formatCurrency(subtotal)} VND</span>
                </div>
                <div className="flex justify-between">
                  <span>{pc.fieldVATLabel}</span>
                  <span className="font-medium">{formatCurrency(vatAmount)} VND</span>
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-2">
                  <span>{pc.total2}</span>
                  <span>{formatCurrency(totalAmount)} VND</span>
                </div>
              </div>
            </div>

            {/* Notes */}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{pc.notes2}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={pc.additionalNotes2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                 {pc.cancel2} </Button>
              <Button type="submit" disabled={uploading || createInvoiceWithItems.isPending}>
                {(uploading || createInvoiceWithItems.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                 {pc.createInvoice2} </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
