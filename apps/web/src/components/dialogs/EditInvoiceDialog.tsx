import { useEffect, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { useSuppliers } from "@/hooks/useSuppliers";
import {
  useInvoice,
  useInvoiceItems,
  useUpdateInvoice,
  useCreateInvoiceItem,
  useUpdateInvoiceItem,
  useDeleteInvoiceItem,
} from "@/hooks/useInvoices";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { Plus, Trash2, Upload, Loader2, Image } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const invoiceItemSchema = z.object({
  id: z.string().optional(),
  product_code: z.string().optional(),
  product_name: z.string().min(1, "Product name is required"),
  unit: z.string().default("kg"),
  quantity: z.coerce.number().min(0, "Quantity must be positive"),
  unit_price: z.coerce.number().min(0, "Price must be positive"),
  isNew: z.boolean().optional(),
  isDeleted: z.boolean().optional(),
});

const invoiceSchema = z.object({
  invoice_number: z.string().min(1, "Invoice number is required"),
  invoice_date: z.string().min(1, "Invoice date is required"),
  supplier_id: z.string().optional(),
  vat_amount: z.coerce.number().default(0),
  notes: z.string().optional(),
  items: z.array(invoiceItemSchema),
});

type InvoiceFormData = z.infer<typeof invoiceSchema>;

interface EditInvoiceDialogProps {
  invoiceId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditInvoiceDialog({
  invoiceId,
  open,
  onOpenChange,
}: EditInvoiceDialogProps) {
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [newImageFile, setNewImageFile] = useState<File | null>(null);
  
  const { data: invoice, isLoading: invoiceLoading } = useInvoice(invoiceId);
  const { data: invoiceItems, isLoading: itemsLoading } = useInvoiceItems(invoiceId);
  const { data: suppliers } = useSuppliers();
  
  const updateInvoice = useUpdateInvoice();
  const createInvoiceItem = useCreateInvoiceItem();
  const updateInvoiceItem = useUpdateInvoiceItem();
  const deleteInvoiceItem = useDeleteInvoiceItem();

  const form = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      invoice_number: "",
      invoice_date: "",
      supplier_id: "",
      vat_amount: 0,
      notes: "",
      items: [],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  // Load invoice data into form when it changes
  useEffect(() => {
    if (invoice && invoiceItems) {
      form.reset({
        invoice_number: invoice.invoice_number,
        invoice_date: invoice.invoice_date,
        supplier_id: invoice.supplier_id || "",
        vat_amount: invoice.vat_amount || 0,
        notes: invoice.notes || "",
        items: invoiceItems.map((item) => ({
          id: item.id,
          product_code: item.product_code || "",
          product_name: item.product_name,
          unit: item.unit || "kg",
          quantity: item.quantity,
          unit_price: item.unit_price,
          isNew: false,
          isDeleted: false,
        })),
      });
      setImageUrl(invoice.image_url);
      setNewImageFile(null);
    }
  }, [invoice, invoiceItems, form]);

  const watchItems = form.watch("items");
  const activeItems = watchItems.filter((item) => !item.isDeleted);
  const subtotal = activeItems.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
  const vatAmount = form.watch("vat_amount") || 0;
  const totalAmount = subtotal + vatAmount;

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const previewUrl = URL.createObjectURL(file);
    setImageUrl(previewUrl);
    setNewImageFile(file);
  };

  const handleRemoveItem = (index: number) => {
    const item = watchItems[index];
    if (item.id && !item.isNew) {
      // Mark existing item for deletion
      form.setValue(`items.${index}.isDeleted`, true);
    } else {
      // Remove new item directly
      remove(index);
    }
  };

  const onSubmit = async (data: InvoiceFormData) => {
    if (!invoiceId) return;

    try {
      setUploading(true);

      // Upload new image if exists
      let uploadedImageUrl: string | null = imageUrl;
      if (newImageFile) {
        const fileExt = newImageFile.name.split(".").pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from("invoices")
          .upload(fileName, newImageFile);

        if (uploadError) {
          throw new Error(`Failed to upload image: ${uploadError.message}`);
        }

        const { data: signedData } = await supabase.storage
          .from("invoices")
          .createSignedUrl(fileName, 60 * 60 * 24 * 365);
        
        uploadedImageUrl = signedData?.signedUrl || null;
      }

      // Update invoice
      await updateInvoice.mutateAsync({
        id: invoiceId,
        invoice_number: data.invoice_number,
        invoice_date: data.invoice_date,
        supplier_id: data.supplier_id || null,
        subtotal,
        vat_amount: vatAmount,
        total_amount: totalAmount,
        image_url: uploadedImageUrl,
        notes: data.notes || null,
      });

      // Handle invoice items
      for (const item of data.items) {
        if (item.isDeleted && item.id) {
          // Delete existing items marked for deletion
          await deleteInvoiceItem.mutateAsync({
            id: item.id,
            invoice_id: invoiceId,
          });
        } else if (item.isNew && !item.isDeleted) {
          // Create new items
          await createInvoiceItem.mutateAsync({
            invoice_id: invoiceId,
            product_code: item.product_code || null,
            product_name: item.product_name,
            unit: item.unit,
            quantity: item.quantity,
            unit_price: item.unit_price,
          });
        } else if (item.id && !item.isDeleted) {
          // Update existing items
          await updateInvoiceItem.mutateAsync({
            id: item.id,
            invoice_id: invoiceId,
            product_code: item.product_code || null,
            product_name: item.product_name,
            unit: item.unit,
            quantity: item.quantity,
            unit_price: item.unit_price,
          });
        }
      }

      toast.success("Đã cập nhật hóa đơn thành công");
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating invoice:", error);
      const errorMessage = error instanceof Error ? error.message : "Lỗi không xác định";
      if (errorMessage.includes("row-level security") || errorMessage.includes("permission")) {
        toast.error("Bạn không có quyền cập nhật hóa đơn");
      } else {
        toast.error("Không thể cập nhật hóa đơn. Vui lòng thử lại.");
      }
    } finally {
      setUploading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("vi-VN").format(amount);
  };

  const isLoading = invoiceLoading || itemsLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Invoice</DialogTitle>
        </DialogHeader>
        
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              {/* Image Section */}
              <div className="border-2 border-dashed border-border rounded-lg p-6">
                <div className="flex flex-col items-center gap-4">
                  {imageUrl ? (
                    <div className="relative">
                      <img
                        src={imageUrl}
                        alt="Invoice preview"
                        className="max-h-48 rounded-lg object-contain"
                      />
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        className="absolute -top-2 -right-2"
                        onClick={() => {
                          setImageUrl(null);
                          setNewImageFile(null);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="text-center">
                      <Image className="mx-auto h-12 w-12 text-muted-foreground" />
                      <p className="mt-2 text-sm text-muted-foreground">
                        No image attached
                      </p>
                    </div>
                  )}
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="max-w-xs"
                  />
                </div>
              </div>

              {/* Invoice Details */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="invoice_number"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Invoice Number *</FormLabel>
                      <FormControl>
                        <Input {...field} />
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
                        isNew: true,
                        isDeleted: false,
                      })
                    }
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Item
                  </Button>
                </div>

                <div className="space-y-3">
                  {fields.map((field, index) => {
                    const item = watchItems[index];
                    if (item?.isDeleted) return null;
                    
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
                            (item?.quantity || 0) * (item?.unit_price || 0)
                          )}
                        </div>

                        <div className="col-span-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveItem(index)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={uploading || updateInvoice.isPending}>
                  {(uploading || updateInvoice.isPending) && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Save Changes
                </Button>
              </div>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
