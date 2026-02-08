import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Plus, CreditCard, Banknote, FileUp, X } from "lucide-react";
import { db } from "@/lib/supabase-helpers";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Label } from "@/components/ui/label";

const categories = ["Flour", "Sugar", "Dairy", "Chocolate", "Nuts", "Yeast", "Eggs", "Packaging", "General"];

// Helper to generate short code from name - exported for reuse
export function generateShortCode(name: string): string {
  if (!name) return "";
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].substring(0, 6).toUpperCase();
  }
  return words.map((w) => w[0]).join("").substring(0, 6).toUpperCase();
}

const supplierSchema = z.object({
  name: z.string().min(1, "Supplier name is required").max(255, "Name is too long"),
  short_code: z.string().max(10, "Short code max 10 characters").optional(),
  category: z.string().optional(),
  description: z.string().max(1000, "Description is too long").optional(),
  phone: z.string().max(20, "Phone number is too long").optional(),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
  bank_account_name: z.string().max(255, "Bank account name is too long").optional(),
  default_payment_method: z.enum(["bank_transfer", "cash"]),
  payment_terms_days: z.coerce.number().min(0, "Cannot be negative").max(365, "Max 365 days"),
});

type SupplierFormData = z.infer<typeof supplierSchema>;

export function AddSupplierDialog() {
  const [open, setOpen] = useState(false);
  const [contractFile, setContractFile] = useState<File | null>(null);
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const form = useForm<SupplierFormData>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: "",
      short_code: "",
      category: "",
      description: "",
      phone: "",
      email: "",
      bank_account_name: "",
      default_payment_method: "bank_transfer",
      payment_terms_days: 0,
    },
  });

  const watchedName = form.watch("name");
  const currentShortCode = form.watch("short_code");

  // Auto-generate short code when name changes and short_code is empty
  useEffect(() => {
    if (watchedName && !currentShortCode) {
      form.setValue("short_code", generateShortCode(watchedName));
    }
  }, [watchedName, currentShortCode, form]);

  const handleSubmit = async (data: SupplierFormData) => {
    try {
      const shortCode = data.short_code || generateShortCode(data.name);
      
      // Upload contract file if exists
      let contractUrl: string | null = null;
      if (contractFile) {
        const fileName = `${Date.now()}-${contractFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from("contracts")
          .upload(fileName, contractFile);
        
        if (uploadError) throw uploadError;
        
        if (uploadData?.path) {
          // Use signed URL for private bucket (4 hours expiry)
          const { data: signedUrlData } = await supabase.storage
            .from("contracts")
            .createSignedUrl(uploadData.path, 60 * 60 * 4); // 4 hours
          contractUrl = signedUrlData?.signedUrl || null;
        }
      }
      
      const { error } = await db.from("suppliers").insert({
        created_by: user?.id || null,
        name: data.name,
        short_code: shortCode,
        category: data.category || null,
        description: data.description || null,
        phone: data.phone || null,
        email: data.email || null,
        bank_account_name: data.bank_account_name || null,
        default_payment_method: data.default_payment_method,
        contract_url: contractUrl,
        payment_terms_days: data.payment_terms_days || null,
      });

      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      setOpen(false);
      form.reset();
      setContractFile(null);
    } catch (error: any) {
      console.error("Error adding supplier:", error.message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="btn-gradient px-4 py-2 rounded-lg font-medium flex items-center gap-2">
          <Plus className="h-4 w-4" />
          Add Supplier
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Supplier</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Supplier Name</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="e.g., Premium Flour Co." />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="short_code"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Short Code</FormLabel>
                    <FormControl>
                      <Input 
                        {...field} 
                        placeholder="e.g., PFC" 
                        maxLength={10}
                        className="font-mono uppercase"
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="category"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {categories.map((cat) => (
                        <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="e.g., Main flour supplier for all bread products..."
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input {...field} type="tel" placeholder="+1 234 567 8900" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="contact@supplier.com" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Bank Account Name */}
            <FormField
              control={form.control}
              name="bank_account_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên tài khoản ngân hàng</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Tên chủ tài khoản (nếu khác tên NCC)" />
                  </FormControl>
                  <FormDescription>
                    Dùng để khớp với UNC khi tên chuyển khoản khác tên NCC
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Payment Method */}
            <FormField
              control={form.control}
              name="default_payment_method"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phương thức thanh toán mặc định</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={field.value}
                      onValueChange={field.onChange}
                      className="flex gap-4"
                    >
                      <div className="flex items-center space-x-2 p-3 border rounded-lg flex-1 cursor-pointer hover:bg-muted/50">
                        <RadioGroupItem value="bank_transfer" id="pm_unc" />
                        <Label htmlFor="pm_unc" className="flex items-center gap-2 cursor-pointer flex-1">
                          <CreditCard className="h-4 w-4 text-blue-500" />
                          UNC (Chuyển khoản)
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2 p-3 border rounded-lg flex-1 cursor-pointer hover:bg-muted/50">
                        <RadioGroupItem value="cash" id="pm_cash" />
                        <Label htmlFor="pm_cash" className="flex items-center gap-2 cursor-pointer flex-1">
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

            {/* Payment Terms */}
            <FormField
              control={form.control}
              name="payment_terms_days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Công nợ (ngày)</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" min="0" max="365" placeholder="VD: 30" />
                  </FormControl>
                  <FormDescription>
                    Số ngày được nợ thanh toán sau khi nhận hàng
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Contract Upload */}
            <div className="space-y-2">
              <Label>Hợp đồng (PDF)</Label>
              <div className="border-2 border-dashed rounded-lg p-4">
                {contractFile ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm truncate flex-1">{contractFile.name}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setContractFile(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <label className="cursor-pointer block text-center">
                    <FileUp className="h-6 w-6 mx-auto mb-1 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Click để upload PDF</span>
                    <input
                      type="file"
                      accept=".pdf"
                      className="hidden"
                      onChange={(e) => setContractFile(e.target.files?.[0] || null)}
                    />
                  </label>
                )}
              </div>
            </div>

            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Adding..." : "Add Supplier"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
