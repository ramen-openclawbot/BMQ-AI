import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCreateProductSKU } from "@/hooks/useProductSKUs";

const skuSchema = z.object({
  sku_code: z.string().min(1, "Mã SKU là bắt buộc"),
  product_name: z.string().min(1, "Tên sản phẩm là bắt buộc"),
  unit: z.string().optional(),
  unit_price: z.coerce.number().min(0).optional(),
  supplier_id: z.string().optional(),
  category: z.string().optional(),
  notes: z.string().optional(),
});

type SKUFormData = z.infer<typeof skuSchema>;

const units = ["kg", "g", "con", "thùng", "chai", "lon", "gói", "hộp", "lít", "ml", "cái"];
const categories = ["Nguyên liệu", "Bao bì", "Phụ gia", "Gia vị", "Khác"];

export function AddSKUDialog() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const { language } = useLanguage();
  const { data: suppliers } = useSuppliers();
  const createSKU = useCreateProductSKU();

  const form = useForm<SKUFormData>({
    resolver: zodResolver(skuSchema),
    defaultValues: {
      sku_code: "",
      product_name: "",
      unit: "kg",
      unit_price: 0,
      supplier_id: "",
      category: "",
      notes: "",
    },
  });

  const onSubmit = async (data: SKUFormData) => {
    // PROTOTYPE MODE: No login required
    try {
      await createSKU.mutateAsync({
        sku_code: data.sku_code,
        product_name: data.product_name,
        unit: data.unit || "kg",
        unit_price: data.unit_price || 0,
        supplier_id: data.supplier_id && data.supplier_id.length > 0 ? data.supplier_id : null,
        category: data.category && data.category.length > 0 ? data.category : null,
        notes: data.notes && data.notes.length > 0 ? data.notes : null,
        created_by: user?.id || null,
      });

      form.reset();
      setOpen(false);
    } catch (error) {
      // Error is already handled by the mutation's onError
      console.error("Failed to create SKU:", error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          {language === "vi" ? "Thêm SKU" : "Add SKU"}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{language === "vi" ? "Thêm mã SKU mới" : "Add New SKU"}</DialogTitle>
          <DialogDescription>
            {language === "vi"
              ? "Tạo mã sản phẩm để quản lý giá và theo dõi hóa đơn"
              : "Create a product code to manage prices and track invoices"}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="sku_code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{language === "vi" ? "Mã SKU *" : "SKU Code *"}</FormLabel>
                    <FormControl>
                      <Input placeholder="VD: NL-BOT-001" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{language === "vi" ? "Danh mục" : "Category"}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={language === "vi" ? "Chọn danh mục" : "Select category"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {categories.map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="product_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{language === "vi" ? "Tên sản phẩm *" : "Product Name *"}</FormLabel>
                  <FormControl>
                    <Input placeholder={language === "vi" ? "VD: Bột mì đa dụng" : "E.g. All-purpose flour"} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="unit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{language === "vi" ? "Đơn vị" : "Unit"}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {units.map((unit) => (
                          <SelectItem key={unit} value={unit}>
                            {unit}
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
                name="unit_price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{language === "vi" ? "Đơn giá (VND)" : "Unit Price (VND)"}</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="supplier_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{language === "vi" ? "Nhà cung cấp" : "Supplier"}</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder={language === "vi" ? "Chọn nhà cung cấp" : "Select supplier"} />
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
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{language === "vi" ? "Ghi chú" : "Notes"}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={language === "vi" ? "Ghi chú thêm..." : "Additional notes..."} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {language === "vi" ? "Hủy" : "Cancel"}
              </Button>
              <Button type="submit" disabled={createSKU.isPending}>
                {createSKU.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {language === "vi" ? "Đang lưu..." : "Saving..."}
                  </>
                ) : (
                  language === "vi" ? "Lưu" : "Save"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
