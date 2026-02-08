import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Phone, Mail, Package, Pencil, Save, X, FileText, CreditCard, Banknote, Clock, FileUp, ExternalLink } from "lucide-react";
import { Supplier } from "@/hooks/useSuppliers";
import { db } from "@/lib/supabase-helpers";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

const categories = ["Flour", "Sugar", "Dairy", "Chocolate", "Nuts", "Yeast", "Eggs", "Packaging", "General"];

interface SupplierDetailsDialogProps {
  supplier: Supplier | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SupplierDetailsDialog({ supplier, open, onOpenChange }: SupplierDetailsDialogProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<"bank_transfer" | "cash">("bank_transfer");
  const [paymentTermsDays, setPaymentTermsDays] = useState(0);
  const [contractUrl, setContractUrl] = useState<string | null>(null);
  const [contractFile, setContractFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  // Reset form when supplier changes or dialog opens
  useEffect(() => {
    if (supplier && open) {
      setName(supplier.name || "");
      setCategory(supplier.category || "");
      setDescription(supplier.description || "");
      setPhone(supplier.phone || "");
      setEmail(supplier.email || "");
      setBankAccountName((supplier as any).bank_account_name || "");
      setDefaultPaymentMethod(supplier.default_payment_method || "bank_transfer");
      setPaymentTermsDays(supplier.payment_terms_days || 0);
      setContractUrl(supplier.contract_url || null);
      setContractFile(null);
      setIsEditing(false);
    }
  }, [supplier, open]);

  // Reset editing state when dialog closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isEditing) {
      if (supplier) {
        setName(supplier.name || "");
        setCategory(supplier.category || "");
        setDescription(supplier.description || "");
        setPhone(supplier.phone || "");
        setEmail(supplier.email || "");
        setBankAccountName((supplier as any).bank_account_name || "");
        setDefaultPaymentMethod(supplier.default_payment_method || "bank_transfer");
        setPaymentTermsDays(supplier.payment_terms_days || 0);
        setContractUrl(supplier.contract_url || null);
        setContractFile(null);
      }
      setIsEditing(false);
    }
    onOpenChange(newOpen);
  };

  if (!supplier) return null;

  const handleSave = async () => {
    if (!name.trim()) return;
    
    setLoading(true);
    try {
      // Upload new contract file if exists
      let newContractUrl = contractUrl;
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
          newContractUrl = signedUrlData?.signedUrl || null;
        }
      }

      const { error } = await db
        .from("suppliers")
        .update({ 
          name: name.trim(),
          category: category || null,
          description: description || null,
          phone: phone || null, 
          email: email || null,
          bank_account_name: bankAccountName || null,
          default_payment_method: defaultPaymentMethod,
          payment_terms_days: paymentTermsDays || null,
          contract_url: newContractUrl,
        })
        .eq("id", supplier.id);

      if (error) throw error;
      
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
      setContractUrl(newContractUrl);
      setContractFile(null);
      setIsEditing(false);
    } catch (error: any) {
      console.error("Error updating supplier:", error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setName(supplier.name || "");
    setCategory(supplier.category || "");
    setDescription(supplier.description || "");
    setPhone(supplier.phone || "");
    setEmail(supplier.email || "");
    setBankAccountName((supplier as any).bank_account_name || "");
    setDefaultPaymentMethod(supplier.default_payment_method || "bank_transfer");
    setPaymentTermsDays(supplier.payment_terms_days || 0);
    setContractUrl(supplier.contract_url || null);
    setContractFile(null);
    setIsEditing(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <span className="text-lg font-display font-bold text-primary">
                {(isEditing ? name : supplier.name).charAt(0) || "S"}
              </span>
            </div>
            <div>
              <span className="block">{isEditing ? "Edit Supplier" : supplier.name}</span>
              {!isEditing && <Badge variant="secondary" className="mt-1">{supplier.category}</Badge>}
            </div>
          </DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 pt-4">
          {isEditing ? (
            <>
              {/* Name */}
              <div className="space-y-2">
                <Label htmlFor="edit-name">Supplier Name</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Premium Flour Co."
                  required
                />
              </div>

              {/* Category */}
              <div className="space-y-2">
                <Label htmlFor="edit-category">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="edit-description">Description</Label>
                <Textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g., Main flour supplier for all bread products..."
                  rows={3}
                />
              </div>

              {/* Phone */}
              <div className="space-y-2">
                <Label htmlFor="edit-phone">Phone</Label>
                <Input
                  id="edit-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 234 567 8900"
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="contact@supplier.com"
                />
              </div>

              {/* Bank Account Name */}
              <div className="space-y-2">
                <Label htmlFor="edit-bank-account-name">Tên tài khoản ngân hàng</Label>
                <Input
                  id="edit-bank-account-name"
                  value={bankAccountName}
                  onChange={(e) => setBankAccountName(e.target.value)}
                  placeholder="Tên chủ tài khoản (nếu khác tên NCC)"
                />
                <p className="text-xs text-muted-foreground">
                  Dùng để khớp với UNC khi tên chuyển khoản khác tên NCC
                </p>
              </div>

              {/* Payment Method */}
              <div className="space-y-2">
                <Label>Phương thức thanh toán mặc định</Label>
                <RadioGroup
                  value={defaultPaymentMethod}
                  onValueChange={(v: "bank_transfer" | "cash") => setDefaultPaymentMethod(v)}
                  className="flex gap-4"
                >
                  <div className="flex items-center space-x-2 p-3 border rounded-lg flex-1 cursor-pointer hover:bg-muted/50">
                    <RadioGroupItem value="bank_transfer" id="edit_pm_unc" />
                    <Label htmlFor="edit_pm_unc" className="flex items-center gap-2 cursor-pointer flex-1">
                      <CreditCard className="h-4 w-4 text-blue-500" />
                      UNC
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 p-3 border rounded-lg flex-1 cursor-pointer hover:bg-muted/50">
                    <RadioGroupItem value="cash" id="edit_pm_cash" />
                    <Label htmlFor="edit_pm_cash" className="flex items-center gap-2 cursor-pointer flex-1">
                      <Banknote className="h-4 w-4 text-orange-500" />
                      Tiền mặt
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Payment Terms */}
              <div className="space-y-2">
                <Label htmlFor="edit_payment_terms">Công nợ (ngày)</Label>
                <Input
                  id="edit_payment_terms"
                  type="number"
                  min="0"
                  value={paymentTermsDays}
                  onChange={(e) => setPaymentTermsDays(parseInt(e.target.value) || 0)}
                  placeholder="VD: 30"
                />
              </div>

              {/* Contract Upload */}
              <div className="space-y-2">
                <Label>Hợp đồng (PDF)</Label>
                {contractUrl && !contractFile && (
                  <div className="flex items-center gap-2 p-2 bg-muted/50 rounded-lg mb-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <a 
                      href={contractUrl} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline flex-1 truncate"
                    >
                      Xem hợp đồng hiện tại
                    </a>
                  </div>
                )}
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
                      <span className="text-sm text-muted-foreground">
                        {contractUrl ? "Upload hợp đồng mới" : "Click để upload PDF"}
                      </span>
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
            </>
          ) : (
            <>
              {/* Description Display */}
              {supplier.description && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <FileText className="h-5 w-5 text-primary mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="font-medium">{supplier.description}</p>
                  </div>
                </div>
              )}

              {/* Bank Account Name Display */}
              {(supplier as any).bank_account_name && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <CreditCard className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-sm text-muted-foreground">Tên tài khoản NH</p>
                    <p className="font-medium">{(supplier as any).bank_account_name}</p>
                  </div>
                </div>
              )}

              {/* Payment Method Display */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                {supplier.default_payment_method === 'cash' ? (
                  <Banknote className="h-5 w-5 text-orange-500" />
                ) : (
                  <CreditCard className="h-5 w-5 text-blue-500" />
                )}
                <div>
                  <p className="text-sm text-muted-foreground">Thanh toán mặc định</p>
                  <p className="font-medium">
                    {supplier.default_payment_method === 'cash' ? 'Tiền mặt' : 'UNC (Chuyển khoản)'}
                  </p>
                </div>
              </div>

              {/* Payment Terms Display */}
              {(supplier.payment_terms_days ?? 0) > 0 && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <Clock className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-sm text-muted-foreground">Thời hạn công nợ</p>
                    <p className="font-medium">{supplier.payment_terms_days} ngày</p>
                  </div>
                </div>
              )}

              {/* Contract Display */}
              {supplier.contract_url && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <FileText className="h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground">Hợp đồng</p>
                    <a 
                      href={supplier.contract_url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="font-medium text-primary hover:underline flex items-center gap-1"
                    >
                      Xem hợp đồng PDF
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </div>
              )}

              {/* Phone Display */}
              {supplier.phone && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <Phone className="h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground">Phone</p>
                    <a href={`tel:${supplier.phone}`} className="font-medium text-primary hover:underline">
                      {supplier.phone}
                    </a>
                  </div>
                </div>
              )}

              {/* Email Display */}
              {supplier.email && (
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                  <Mail className="h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="text-sm text-muted-foreground">Email</p>
                    <a href={`mailto:${supplier.email}`} className="font-medium text-primary hover:underline">
                      {supplier.email}
                    </a>
                  </div>
                </div>
              )}

              {/* Payment Requests Count */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <Package className="h-5 w-5 text-primary" />
                <div>
                  <p className="text-sm text-muted-foreground">Payment Requests</p>
                  <p className="font-medium">{supplier.order_count} requests</p>
                </div>
              </div>

              {!supplier.phone && !supplier.email && !supplier.contract_url && (
                <p className="text-sm text-muted-foreground text-center py-2">
                  No contact information available
                </p>
              )}
            </>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2 pt-2">
            {isEditing ? (
              <>
                <Button onClick={handleSave} disabled={loading} className="flex-1">
                  <Save className="h-4 w-4 mr-2" />
                  {loading ? "Saving..." : "Save"}
                </Button>
                <Button variant="outline" onClick={handleCancel} disabled={loading}>
                  <X className="h-4 w-4 mr-2" />
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setIsEditing(true)} className="w-full">
                <Pencil className="h-4 w-4 mr-2" />
                Edit Supplier
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
