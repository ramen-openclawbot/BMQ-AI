import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { useSuppliers } from "@/hooks/useSuppliers";
import { useCreateInvoice, useCreateInvoiceItem } from "@/hooks/useInvoices";
import { usePaymentRequests, usePaymentRequestItems } from "@/hooks/usePaymentRequests";
import { supabase } from "@/integrations/supabase/client";
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
  }>;
}

const invoiceItemSchema = z.object({
  product_code: z.string().optional(),
  product_name: z.string().min(1, "Product name is required"),
  unit: z.string().default("kg"),
  quantity: z.coerce.number().min(0, "Quantity must be positive"),
  unit_price: z.coerce.number().min(0, "Price must be positive"),
});

const invoiceSchema = z.object({
  invoice_number: z.string().min(1, "Invoice number is required"),
  invoice_date: z.string().min(1, "Invoice date is required"),
  supplier_id: z.string().optional(),
  payment_request_id: z.string().optional(),
  vat_amount: z.coerce.number().default(0),
  notes: z.string().optional(),
  items: z.array(invoiceItemSchema).min(1, "At least one item is required"),
});

type InvoiceFormData = z.infer<typeof invoiceSchema>;

export function AddInvoiceDialog() {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [paymentSlipFile, setPaymentSlipFile] = useState<File | null>(null);
  const [paymentSlipPreview, setPaymentSlipPreview] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const { user } = useAuth();
  const { data: suppliers } = useSuppliers();
  const { data: paymentRequests } = usePaymentRequests();
  const { data: requestItems } = usePaymentRequestItems(selectedRequestId);
  const createInvoice = useCreateInvoice();
  const createInvoiceItem = useCreateInvoiceItem();
  const queryClient = useQueryClient();

  // Filter to only show approved requests without invoices
  const availableRequests = paymentRequests?.filter(
    (pr) => pr.status === "approved" && !pr.invoice_created
  ) || [];

  const form = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
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
        const requestVatRaw = Number((selectedRequest as any).vat_amount ?? 0) || 0;
        const subtotalFromItems = requestItems.reduce(
          (sum, item) => sum + (Number(item.line_total) || (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)),
          0,
        );
        const totalFromRequest = Number((selectedRequest as any).total_amount ?? 0) || 0;
        const inferredVat = Math.max(0, totalFromRequest - subtotalFromItems);
        const finalVat = requestVatRaw > 0 ? requestVatRaw : inferredVat;
        form.setValue("vat_amount", finalVat);
        
        // Set items from request items
        const newItems = requestItems.map((item) => ({
          product_code: item.product_code || "",
          product_name: item.product_name,
          unit: item.unit || "kg",
          quantity: Number(item.quantity) || 0,
          unit_price: Number(item.unit_price) || 0,
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
  const vatAmount = form.watch("vat_amount") || 0;
  const totalAmount = subtotal + vatAmount;

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
        }));
        form.setValue("items", newItems);
      }
    } catch (error) {
      console.error("Error scanning invoice:", error);
    } finally {
      setScanning(false);
    }
  };

  const onSubmit = async (data: InvoiceFormData) => {
    // PROTOTYPE MODE: No login required
    try {
      setUploading(true);

      // Upload invoice image if exists
      let uploadedImageUrl: string | null = null;
      if (imageFile) {
        const fileExt = imageFile.name.split(".").pop();
        const fileName = `invoice-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, imageFile);

        if (uploadError) {
          throw new Error(`Failed to upload image: ${uploadError.message}`);
        }

        // Get signed URL for the uploaded image (4 hours expiry)
        const { data: signedData } = await supabase.storage
          .from("invoices")
          .createSignedUrl(fileName, 60 * 60 * 4); // 4 hours
        
        uploadedImageUrl = signedData?.signedUrl || null;
      }

      // Upload payment slip image if exists
      let uploadedPaymentSlipUrl: string | null = null;
      if (paymentSlipFile) {
        const fileExt = paymentSlipFile.name.split(".").pop();
        const fileName = `slip-${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, paymentSlipFile);

        if (uploadError) {
          throw new Error(`Failed to upload payment slip: ${uploadError.message}`);
        }

        // Get signed URL for the uploaded payment slip (4 hours expiry)
        const { data: signedData } = await supabase.storage
          .from("invoices")
          .createSignedUrl(fileName, 60 * 60 * 4); // 4 hours
        
        uploadedPaymentSlipUrl = signedData?.signedUrl || null;
      }

      // Create invoice with optional payment_request_id and payment_slip_url
      const invoice = await createInvoice.mutateAsync({
        invoice_number: data.invoice_number,
        invoice_date: data.invoice_date,
        supplier_id: data.supplier_id || null,
        subtotal,
        vat_amount: vatAmount,
        total_amount: totalAmount,
        image_url: uploadedImageUrl,
        payment_slip_url: uploadedPaymentSlipUrl,
        notes: data.notes || null,
        created_by: user?.id || null,
        payment_request_id: data.payment_request_id || null,
      });

      // If linked to payment request, update the request
      if (data.payment_request_id) {
        await supabase
          .from("payment_requests")
          .update({
            invoice_id: invoice.id,
            invoice_created: true,
          })
          .eq("id", data.payment_request_id);
        
        // Invalidate payment request queries
        queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
        queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
      }

      // Create invoice items and update/create inventory (only for physical items)
      const { isPhysicalItem } = await import("@/lib/inventory-utils");
      
      for (const item of data.items) {
        let inventoryItemId: string | null = null;

        // Only sync to inventory if it's a physical item (not fees/services)
        if (isPhysicalItem(item.product_name)) {
          // Check if inventory item exists by name (case-insensitive match)
          const { data: existingItems } = await supabase
            .from("inventory_items")
            .select("id, quantity")
            .ilike("name", item.product_name)
            .limit(1);

          if (existingItems && existingItems.length > 0) {
            // Update existing inventory quantity
            const existing = existingItems[0];
            inventoryItemId = existing.id;
            await supabase
              .from("inventory_items")
              .update({ 
                quantity: (existing.quantity || 0) + item.quantity 
              })
              .eq("id", existing.id);
          } else {
            // Create new inventory item
            const { data: newItem } = await supabase
              .from("inventory_items")
              .insert({
                name: item.product_name,
                quantity: item.quantity,
                unit: item.unit || "kg",
                category: "Từ hóa đơn",
                supplier_id: data.supplier_id || null,
                created_by: user?.id || null,
              })
              .select("id")
              .single();
            
            inventoryItemId = newItem?.id || null;
          }
        }

        // Create invoice item (always, regardless of physical/service)
        await createInvoiceItem.mutateAsync({
          invoice_id: invoice.id,
          product_code: item.product_code || null,
          product_name: item.product_name,
          unit: item.unit,
          quantity: item.quantity,
          unit_price: item.unit_price,
          inventory_item_id: inventoryItemId,
        });
      }

      toast.success("Đã tạo hóa đơn thành công");
      form.reset();
      setImageUrl(null);
      setImageFile(null);
      setPaymentSlipFile(null);
      setPaymentSlipPreview(null);
      setSelectedRequestId(null);
      setOpen(false);
    } catch (error) {
      console.error("Error creating invoice:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error("Bạn không có quyền tạo hóa đơn");
      } else {
        toast.error("Không thể tạo hóa đơn. Vui lòng thử lại.");
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
          Add Invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Invoice</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Image Upload Section - Two columns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Invoice Image */}
              <div className="border-2 border-dashed border-border rounded-lg p-4">
                <div className="flex flex-col items-center gap-3">
                  <p className="text-sm font-medium">📄 Ảnh hóa đơn</p>
                  {imageUrl ? (
                    <div className="relative">
                      <img
                        src={imageUrl}
                        alt="Invoice preview"
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
                        Upload hóa đơn để scan hoặc lưu trữ
                      </p>
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
                        {scanning ? "Đang scan..." : "Scan hóa đơn"}
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
                    Ảnh UNC / Chứng từ TT
                  </p>
                  {paymentSlipPreview ? (
                    <div className="relative">
                      <img
                        src={paymentSlipPreview}
                        alt="Payment slip preview"
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
                        Tùy chọn: Upload ảnh UNC để lưu trữ
                      </p>
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
                  <span className="font-medium text-sm">Link đề nghị chi (tùy chọn)</span>
                </div>
                <Select 
                  onValueChange={handlePaymentRequestChange} 
                  value={selectedRequestId || "none"}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chọn đề nghị chi để link" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Không link</SelectItem>
                    {availableRequests.map((pr) => (
                      <SelectItem key={pr.id} value={pr.id}>
                        {pr.request_number} - {pr.title} ({formatCurrency(pr.total_amount || 0)} VND)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedRequestId && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Sẽ tự động điền thông tin từ đề nghị chi đã chọn
                  </p>
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
                    <FormLabel>Invoice Number *</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., INV-001" {...field} />
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
                    <FormLabel>Invoice Date *</FormLabel>
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
                    <FormLabel>Supplier</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select supplier" />
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
                    <FormLabel>VAT Amount (VND)</FormLabel>
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
                <h3 className="font-semibold">Invoice Items</h3>
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
                  Add Item
                </Button>
              </div>

              <div className="space-y-3">
                {fields.map((field, index) => (
                  <div
                    key={field.id}
                    className="grid grid-cols-12 gap-2 items-end p-3 bg-muted/50 rounded-lg"
                  >
                    <FormField
                      control={form.control}
                      name={`items.${index}.product_code`}
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="text-xs">Code</FormLabel>
                          <FormControl>
                            <Input placeholder="Code" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.product_name`}
                      render={({ field }) => (
                        <FormItem className="col-span-3">
                          <FormLabel className="text-xs">Product Name *</FormLabel>
                          <FormControl>
                            <Input placeholder="Product name" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name={`items.${index}.unit`}
                      render={({ field }) => (
                        <FormItem className="col-span-1">
                          <FormLabel className="text-xs">Unit</FormLabel>
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
                          <FormLabel className="text-xs">Quantity</FormLabel>
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
                          <FormLabel className="text-xs">Unit Price</FormLabel>
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
                ))}
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>Subtotal:</span>
                  <span className="font-medium">{formatCurrency(subtotal)} VND</span>
                </div>
                <div className="flex justify-between">
                  <span>VAT:</span>
                  <span className="font-medium">{formatCurrency(vatAmount)} VND</span>
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-2">
                  <span>Total:</span>
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
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Additional notes..." {...field} />
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
                Cancel
              </Button>
              <Button type="submit" disabled={uploading || createInvoice.isPending}>
                {(uploading || createInvoice.isPending) && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Create Invoice
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
