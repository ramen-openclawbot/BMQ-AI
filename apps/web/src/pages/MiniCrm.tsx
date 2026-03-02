import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Pencil, Save, X, Trash2 } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import ExcelJS from "exceljs";

const GROUP_OPTIONS = [
  { value: "banhmi_point", label: "Bán lẻ" },
  { value: "banhmi_agency", label: "Đại lý" },
  { value: "online", label: "Online" },
  { value: "b2b", label: "B2B" },
];

const GROUP_LABEL_MAP: Record<string, string> = GROUP_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {} as Record<string, string>);

const PRODUCT_GROUP_OPTIONS = [
  { value: "banhmi", label: "Bánh mì" },
  { value: "banhngot", label: "Bánh ngọt" },
];
const PRODUCT_GROUP_LABEL_MAP: Record<string, string> = PRODUCT_GROUP_OPTIONS.reduce((acc, item) => {
  acc[item.value] = item.label;
  return acc;
}, {} as Record<string, string>);


const extractPoNumberFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/\b(PO\d{6,})\b/i) || s.match(/PO\s*(\d{6,})/i);
  if (!m) return "";
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

const extractDeliveryDateFromSubject = (subject?: string) => {
  const s = String(subject || "");
  const m = s.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return "";
  return `${m[3]}-${m[2]}-${m[1]}`;
};

const calcSubtotalFromItems = (items: any[]) =>
  (Array.isArray(items) ? items : []).reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);

const formatVnd = (value: any) => `${Number(value || 0).toLocaleString("vi-VN")} ₫`;
const calcVatFromSubtotal = (subtotal: any, rate = 0.08) => Math.round(Number(subtotal || 0) * rate);
const calcSafeTotal = (subtotal: any, vat: any, fallback: any = 0) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  const byParts = s + v;
  if (byParts > 0) return byParts;
  return Number(fallback || 0);
};
const normalizeVatDisplay = (subtotal: any, vat: any) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  if (s <= 0) return 0;
  if (v <= 0) return calcVatFromSubtotal(s, 0.08);
  if (v > s * 0.3) return calcVatFromSubtotal(s, 0.08);
  return v;
};
const calcTotalFromRawPayload = (rawPayload: any) => {
  const meta = rawPayload?.parse_meta || {};
  const metaTotal = Number(meta?.total_amount || 0);
  if (metaTotal > 0) return metaTotal;
  const metaSubtotal = Number(meta?.subtotal || 0);
  const metaVat = Number(meta?.vat_amount || 0);
  if (metaSubtotal > 0) return metaSubtotal + metaVat;
  const items = Array.isArray(rawPayload?.parsed_items_preview) ? rawPayload.parsed_items_preview : [];
  return items.reduce((sum: number, it: any) => sum + Number(it?.line_total || 0), 0);
};


export default function MiniCrm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const location = useLocation();
  const isSalesPoPage = location.pathname === "/sales-po-inbox";

  const [customerName, setCustomerName] = useState("");
  const [customerGroup, setCustomerGroup] = useState("banhmi_point");
  const [productGroup, setProductGroup] = useState("banhmi");
  const [emailsInput, setEmailsInput] = useState("");
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null);
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editCustomerGroup, setEditCustomerGroup] = useState("banhmi_point");
  const [editProductGroup, setEditProductGroup] = useState("banhmi");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editEmailsInput, setEditEmailsInput] = useState("");
  const [editOriginalEmailsInput, setEditOriginalEmailsInput] = useState("");
  const [editFeedback, setEditFeedback] = useState<string>("");
  const [templateFileName, setTemplateFileName] = useState<string>("");
  const [templatePreview, setTemplatePreview] = useState<any | null>(null);
  const [pendingTemplateFileName, setPendingTemplateFileName] = useState<string>("");
  const [pendingTemplatePreview, setPendingTemplatePreview] = useState<any | null>(null);
  const [templateConfirmOpen, setTemplateConfirmOpen] = useState<boolean>(false);
  const [templateReviewDraft, setTemplateReviewDraft] = useState<any | null>(null);
  const [templateReviewTouched, setTemplateReviewTouched] = useState<boolean>(false);
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const [poSummaryDraft, setPoSummaryDraft] = useState<any>({});
  const [postRevenueStatus, setPostRevenueStatus] = useState<string>("");
  const [poDateFrom, setPoDateFrom] = useState<string>("");
  const [poDateTo, setPoDateTo] = useState<string>("");
  const [syncDate, setSyncDate] = useState<string>(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = `${now.getMonth() + 1}`.padStart(2, "0");
    const d = `${now.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${d}`;
  });
  const [syncDebug, setSyncDebug] = useState<any | null>(null);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("idle");
  const [syncError, setSyncError] = useState<string>("");
  const [previewItems, setPreviewItems] = useState<any[]>([]);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [selectedPreviewIds, setSelectedPreviewIds] = useState<string[]>([]);
  const [confirmTemplateRead, setConfirmTemplateRead] = useState<boolean>(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [viewCustomer, setViewCustomer] = useState<any | null>(null);
  const [setupContractFile, setSetupContractFile] = useState<File | null>(null);
  const [setupPriceRows, setSetupPriceRows] = useState<Array<{ skuId: string; price: string }>>([{ skuId: "", price: "" }]);
  const [editContractFile, setEditContractFile] = useState<File | null>(null);
  const [editPriceRows, setEditPriceRows] = useState<Array<{ skuId: string; price: string }>>([{ skuId: "", price: "" }]);

  const { data: gmailConnectedEmail } = useQuery({
    queryKey: ["gmail-connected-email"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "google_gmail_connected_email")
        .maybeSingle();
      if (error) throw error;
      return data?.value || null;
    },
  });

  const { data: customers = [] } = useQuery({
    queryKey: ["mini-crm-customers"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customers")
        .select("*, mini_crm_customer_emails(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: finishedSkus = [] } = useQuery({
    queryKey: ["finished-skus"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("product_skus")
        .select("id, sku_code, product_name, sku_type, category")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []).filter((s: any) => String(s.sku_type || "").toLowerCase() === "finished_good" || String(s.category || "").toLowerCase().includes("thành phẩm"));
    },
    enabled: !isSalesPoPage,
  });

  const { data: customerContracts = [] } = useQuery({
    queryKey: ["mini-crm-customer-contracts"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customer_contracts")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: customerPriceList = [] } = useQuery({
    queryKey: ["mini-crm-customer-price-list"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customer_price_list")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: poTemplates = [] } = useQuery({
    queryKey: ["mini-crm-po-templates"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_po_templates")
        .select("*")
        .eq("is_active", true)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !isSalesPoPage,
  });

  const { data: poInbox = [] } = useQuery({
    queryKey: ["customer-po-inbox"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("*, mini_crm_customers(customer_name)")
        .order("received_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
  });

  const startEditCustomer = (c: any) => {
    setEditFeedback("");
    setEditingCustomerId(c.id);
    setEditCustomerName(c.customer_name || "");
    setEditCustomerGroup(c.customer_group || "banhmi_point");
    setEditProductGroup(c.product_group || "banhmi");
    setEditIsActive(Boolean(c.is_active));
    const emails = (c.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ");
    setEditEmailsInput(emails);
    setEditOriginalEmailsInput(emails);
    setTemplateFileName("");
    setTemplatePreview(null);
    setPendingTemplateFileName("");
    setPendingTemplatePreview(null);
    setTemplateConfirmOpen(false);
    setEditContractFile(null);
    const currentPrices = customerPriceList.filter((x: any) => x.customer_id === c.id);
    setEditPriceRows(currentPrices.length ? currentPrices.map((p: any) => ({ skuId: p.sku_id, price: String(Number(p.price_vnd_per_unit || 0)) })) : [{ skuId: "", price: "" }]);
  };

  const cancelEditCustomer = () => {
    setEditFeedback("");
    setEditingCustomerId(null);
    setEditCustomerName("");
    setEditCustomerGroup("banhmi_point");
    setEditProductGroup("banhmi");
    setEditIsActive(true);
    setEditEmailsInput("");
    setEditOriginalEmailsInput("");
    setTemplateFileName("");
    setTemplatePreview(null);
    setPendingTemplateFileName("");
    setPendingTemplatePreview(null);
    setTemplateConfirmOpen(false);
    setTemplateReviewDraft(null);
    setEditContractFile(null);
    setEditPriceRows([{ skuId: "", price: "" }]);
  };

  const getNextTemplateVersion = async (customerId: string) => {
    const { data, error } = await (supabase as any)
      .from("mini_crm_po_templates")
      .select("version_no")
      .eq("customer_id", customerId)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return Number(data?.version_no || 0) + 1;
  };

  const summarizeTemplateDiff = (beforeSnap: any, afterSnap: any) => {
    const beforeItems = Array.isArray(beforeSnap?.items) ? beforeSnap.items : [];
    const afterItems = Array.isArray(afterSnap?.items) ? afterSnap.items : [];
    const changedItemCount = afterItems.reduce((acc: number, it: any, idx: number) => {
      const b = beforeItems[idx] || {};
      const changed = String(b.product || "") !== String(it.product || "") || String(b.qty ?? "") !== String(it.qty ?? "") || String(b.unitPrice ?? "") !== String(it.unitPrice ?? "") || String(b.lineTotal ?? "") !== String(it.lineTotal ?? "");
      return acc + (changed ? 1 : 0);
    }, 0);
    const changedDate = String(beforeSnap?.orderDate || "") !== String(afterSnap?.orderDate || "");
    const changedTotals = String(beforeSnap?.subtotal ?? "") !== String(afterSnap?.subtotal ?? "") || String(beforeSnap?.vat ?? "") !== String(afterSnap?.vat ?? "") || String(beforeSnap?.total ?? "") !== String(afterSnap?.total ?? "");
    return `date:${changedDate ? "changed" : "same"}; items_changed:${changedItemCount}; totals:${changedTotals ? "changed" : "same"}`;
  };

  const addCustomerMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = customerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");

      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({
          customer_name: trimmedName,
          customer_group: customerGroup,
          product_group: productGroup,
        })
        .select("id")
        .single();

      if (createError) throw createError;

      const emails = Array.from(new Set(
        emailsInput
          .split(/[;,\n]+/)
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      ));

      if (emails.length) {
        const { error: emailError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(emails.map((email, idx) => ({ customer_id: created.id, email, is_primary: idx === 0 })));
        if (emailError) throw emailError;
      }
    },
    onSuccess: async () => {
      setCustomerName("");
      setProductGroup("banhmi");
      setEmailsInput("");
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      toast({ title: "Thêm khách hàng thành công", description: "Mini-CRM đã cập nhật." });
    },
    onError: (e: any) => {
      const msg = e?.message || "Không thể thêm khách hàng";
      toast({ title: "Thêm khách hàng thất bại", description: msg, variant: "destructive" });
    },
  });

  const setupCustomerMutation = useMutation({
    mutationFn: async () => {
      const trimmedName = customerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");

      const { data: created, error: createError } = await (supabase as any)
        .from("mini_crm_customers")
        .insert({ customer_name: trimmedName, customer_group: customerGroup, product_group: productGroup })
        .select("id")
        .single();
      if (createError) throw createError;

      const customerId = created.id;
      const emails = Array.from(new Set(
        emailsInput.split(/[;,\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      ));
      if (emails.length) {
        const { error: emailError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .insert(emails.map((email, idx) => ({ customer_id: customerId, email, is_primary: idx === 0 })));
        if (emailError) throw emailError;
      }

      if (setupContractFile) {
        const filePath = `${customerId}/${Date.now()}-${setupContractFile.name}`;
        const { error: uploadError } = await (supabase as any).storage.from("customer-contracts").upload(filePath, setupContractFile, { upsert: false, contentType: setupContractFile.type || "application/pdf" });
        if (uploadError) throw uploadError;
        const { data: pub } = (supabase as any).storage.from("customer-contracts").getPublicUrl(filePath);
        const { error: contractError } = await (supabase as any)
          .from("mini_crm_customer_contracts")
          .insert({ customer_id: customerId, file_name: setupContractFile.name, file_url: pub?.publicUrl || filePath, file_size: setupContractFile.size, mime_type: setupContractFile.type || "application/pdf", is_active: true });
        if (contractError) throw contractError;
      }

      const validRows = setupPriceRows
        .map((r) => ({ sku_id: r.skuId, price_vnd_per_unit: Number(String(r.price || "").replace(/[^0-9]/g, "")) }))
        .filter((r) => r.sku_id && Number.isFinite(r.price_vnd_per_unit) && r.price_vnd_per_unit > 0);
      if (validRows.length) {
        const { error: priceError } = await (supabase as any)
          .from("mini_crm_customer_price_list")
          .insert(validRows.map((r) => ({ customer_id: customerId, sku_id: r.sku_id, price_vnd_per_unit: r.price_vnd_per_unit, currency: "VND", is_active: true })));
        if (priceError) throw priceError;
      }

      if (templatePreview?.parserConfig) {
        const versionNo = await getNextTemplateVersion(customerId);
        const { error: tplError } = await (supabase as any)
          .from("mini_crm_po_templates")
          .insert({
            customer_id: customerId,
            template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`,
            file_name: templateFileName || "uploaded-template.xlsx",
            parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo },
            sample_preview: templatePreview.sampleRows || [],
            confirmation_snapshot: templatePreview?.confirmationView || {},
            parse_confidence: Number(templatePreview?.confidenceScore || 1),
            version_no: versionNo,
            is_active: true,
          });
        if (tplError) throw tplError;
      }
    },
    onSuccess: async () => {
      setSetupModalOpen(false);
      setCustomerName("");
      setCustomerGroup("banhmi_point");
      setProductGroup("banhmi");
      setEmailsInput("");
      setSetupContractFile(null);
      setSetupPriceRows([{ skuId: "", price: "" }]);
      setTemplateFileName("");
      setTemplatePreview(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-price-list"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] }),
      ]);
      toast({ title: "Thiết lập khách hàng thành công" });
    },
    onError: (e: any) => {
      toast({ title: "Thiết lập khách hàng thất bại", description: e?.message || "Không thể lưu thiết lập", variant: "destructive" });
    },
  });

  const updateCustomerMutation = useMutation({
    mutationFn: async () => {
      if (!editingCustomerId) throw new Error("Chưa chọn khách hàng để sửa");
      const trimmedName = editCustomerName.trim();
      if (!trimmedName) throw new Error("Vui lòng nhập tên khách hàng");

      const { data: updatedCustomer, error: updateError } = await (supabase as any)
        .from("mini_crm_customers")
        .update({
          customer_name: trimmedName,
          customer_group: editCustomerGroup,
          product_group: editProductGroup,
          is_active: editIsActive,
        })
        .eq("id", editingCustomerId)
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error(`Lỗi cập nhật thông tin khách hàng: ${updateError.message}`);
      }
      if (!updatedCustomer?.id) {
        throw new Error("Không cập nhật được khách hàng (có thể do quyền RLS hoặc bản ghi không tồn tại)");
      }

      const normalizeEmails = (raw: string) =>
        Array.from(new Set(
          String(raw || "")
            .split(/[;,\n]+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        ));

      const emails = normalizeEmails(editEmailsInput);
      const oldEmails = normalizeEmails(editOriginalEmailsInput);
      const emailChanged = JSON.stringify(emails) !== JSON.stringify(oldEmails);

      if (emailChanged) {
        const { error: deleteEmailsError } = await (supabase as any)
          .from("mini_crm_customer_emails")
          .delete()
          .eq("customer_id", editingCustomerId);

        if (deleteEmailsError) {
          throw new Error(`Lỗi cập nhật danh sách email (bước xoá email cũ): ${deleteEmailsError.message}`);
        }

        if (emails.length) {
          const { error: insertEmailsError } = await (supabase as any)
            .from("mini_crm_customer_emails")
            .insert(emails.map((email, idx) => ({ customer_id: editingCustomerId, email, is_primary: idx === 0 })));
          if (insertEmailsError) {
            throw new Error(`Lỗi cập nhật danh sách email (bước thêm email mới): ${insertEmailsError.message}`);
          }
        }
      }

      if (editContractFile) {
        const { error: deactivateContractError } = await (supabase as any)
          .from("mini_crm_customer_contracts")
          .update({ is_active: false })
          .eq("customer_id", editingCustomerId)
          .eq("is_active", true);
        if (deactivateContractError) throw deactivateContractError;

        const filePath = `${editingCustomerId}/${Date.now()}-${editContractFile.name}`;
        const { error: uploadError } = await (supabase as any).storage.from("customer-contracts").upload(filePath, editContractFile, { upsert: false, contentType: editContractFile.type || "application/pdf" });
        if (uploadError) throw uploadError;
        const { data: pub } = (supabase as any).storage.from("customer-contracts").getPublicUrl(filePath);
        const { error: contractInsertError } = await (supabase as any)
          .from("mini_crm_customer_contracts")
          .insert({ customer_id: editingCustomerId, file_name: editContractFile.name, file_url: pub?.publicUrl || filePath, file_size: editContractFile.size, mime_type: editContractFile.type || "application/pdf", is_active: true });
        if (contractInsertError) throw contractInsertError;
      }

      const validRows = editPriceRows
        .map((r) => ({ sku_id: r.skuId, price_vnd_per_unit: Number(String(r.price || "").replace(/[^0-9]/g, "")) }))
        .filter((r) => r.sku_id && Number.isFinite(r.price_vnd_per_unit) && r.price_vnd_per_unit > 0);

      const { error: deactivatePriceError } = await (supabase as any)
        .from("mini_crm_customer_price_list")
        .update({ is_active: false })
        .eq("customer_id", editingCustomerId)
        .eq("is_active", true);
      if (deactivatePriceError) throw deactivatePriceError;

      if (validRows.length) {
        const { error: priceInsertError } = await (supabase as any)
          .from("mini_crm_customer_price_list")
          .insert(validRows.map((r) => ({ customer_id: editingCustomerId, sku_id: r.sku_id, price_vnd_per_unit: r.price_vnd_per_unit, currency: "VND", is_active: true })));
        if (priceInsertError) throw priceInsertError;
      }

      if (templatePreview?.parserConfig) {
        const { error: deactivateTplError } = await (supabase as any)
          .from("mini_crm_po_templates")
          .update({ is_active: false })
          .eq("customer_id", editingCustomerId)
          .eq("is_active", true);
        if (deactivateTplError) throw deactivateTplError;

        const versionNo = await getNextTemplateVersion(editingCustomerId);
        const { error: tplInsertError } = await (supabase as any)
          .from("mini_crm_po_templates")
          .insert({ customer_id: editingCustomerId, template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`, file_name: templateFileName || "uploaded-template.xlsx", parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo }, sample_preview: templatePreview.sampleRows || [], confirmation_snapshot: templatePreview?.confirmationView || {}, parse_confidence: Number(templatePreview?.confidenceScore || 1), version_no: versionNo, is_active: true });
        if (tplInsertError) throw tplInsertError;
      }

      return { saved: true, emailCount: emails.length, emailChanged };
    },
    onSuccess: async (result: any) => {
      cancelEditCustomer();
      const msg = `Đã lưu thành công${result?.emailChanged ? ` (${result?.emailCount || 0} email)` : ""}.`;
      setEditFeedback(msg);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-price-list"] }),
        queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] }),
      ]);
      toast({ title: "Lưu thành công", description: msg });
    },
    onError: (e: any) => {
      const msg = e?.message || "Không thể cập nhật khách hàng";
      setEditFeedback(`Lưu thất bại: ${msg}`);
      toast({ title: "Lỗi lưu CRM", description: msg, variant: "destructive" });
    },
  });

  const deleteCustomerMutation = useMutation({
    mutationFn: async ({ customerId }: { customerId: string; customerName?: string }) => {
      const { error: deleteEmailError } = await (supabase as any)
        .from("mini_crm_customer_emails")
        .delete()
        .eq("customer_id", customerId);
      if (deleteEmailError) throw deleteEmailError;

      const { error: deleteCustomerError } = await (supabase as any)
        .from("mini_crm_customers")
        .delete()
        .eq("id", customerId);
      if (deleteCustomerError) throw deleteCustomerError;
    },
    onSuccess: async (_data, vars) => {
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-customers"] });
      toast({ title: "Xoá khách hàng thành công", description: vars?.customerName ? `Đã xoá ${vars.customerName}.` : undefined });
    },
    onError: (e: any) => {
      toast({ title: "Xoá khách hàng thất bại", description: e?.message || "Không thể xoá khách hàng", variant: "destructive" });
    },
  });

  const handleAnalyzeTemplateFile = async (file?: File | null) => {
    if (!file) return;
    const arrayBuffer = await file.arrayBuffer();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const worksheet = workbook.getWorksheet("NEW") || workbook.worksheets[0];
    if (!worksheet) throw new Error("Không đọc được sheet trong file mẫu");

    const row1 = worksheet.getRow(1).values as any[];
    const row2 = worksheet.getRow(2).values as any[];

    const normalizeHeader = (s: any) => String(s || "").replace(/\s+/g, " ").trim();
    const normalizeToken = (s: string) => normalizeHeader(s).toLowerCase().replace(/[^a-z0-9à-ỹ]/g, "");
    const isLikelyMetaHeader = (name: string) => {
      const t = normalizeToken(name);
      return ["stt", "no", "ngaydate", "ac", "amenity", "type", "fltno", "dep", "arr"].includes(t) || t.includes("tongcong") || t.includes("hotmealdat");
    };
    const toNumericQty = (raw: any) => {
      if (raw == null) return 0;
      if (raw instanceof Date) return 0;
      if (typeof raw === "object" && raw?.result != null) return toNumericQty(raw.result);
      if (typeof raw === "object" && raw?.formula) return toNumericQty(raw.result);
      const n = Number(String(raw).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const parseDateCell = (raw: any) => {
      if (!raw) return null;
      if (raw instanceof Date) return raw;
      if (typeof raw === "object" && raw?.result instanceof Date) return raw.result;
      const dt = new Date(raw);
      return Number.isNaN(dt.getTime()) ? null : dt;
    };

    const findHeaderRow = () => {
      for (let r = 1; r <= Math.min(6, worksheet.rowCount); r++) {
        const vals = worksheet.getRow(r).values as any[];
        const cols = vals.map((v, idx) => ({ idx, name: normalizeHeader(v) })).filter((c) => c.idx > 0 && c.name);
        const hasProduct = cols.some((c) => /(tên\s*sản\s*phẩm|ten\s*san\s*pham|product|item)/i.test(c.name));
        const hasQty = cols.some((c) => /(số\s*lượng|so\s*luong|qty|quantity)/i.test(c.name));
        if (hasProduct && hasQty) return { row: r, cols };
      }
      return null;
    };

    const detectedHeader = findHeaderRow();
    const headerRowNo = detectedHeader?.row || 2;
    const headerColumns = (detectedHeader?.cols || row2.map((v, idx) => ({ idx, name: normalizeHeader(v) })))
      .filter((c: any) => c.idx > 0 && c.name);

    const findHeaderIndex = (patterns: RegExp[]) => {
      const m = headerColumns.find((c: any) => patterns.some((p) => p.test(c.name)));
      return m?.idx || 0;
    };

    const productCol = findHeaderIndex([/(tên\s*sản\s*phẩm|ten\s*san\s*pham|product|item)/i]);
    const qtyCol = findHeaderIndex([/(số\s*lượng|so\s*luong|qty|quantity)/i]);
    const dateCol = findHeaderIndex([/(ngày\s*giao|ngày|date)/i]);
    const skuCol = findHeaderIndex([/(barcode|mã|ma|sku|code)/i]);
    const unitCol = findHeaderIndex([/(đơn\s*vị|don\s*vi|unit)/i]);
    const unitPriceCol = findHeaderIndex([/(đơn\s*giá|don\s*gia|unit\s*price|price)/i]);

    const sampleRows = [] as any[];
    const lineItems = [] as any[];

    const isRowItemMode = Boolean(productCol && qtyCol);

    if (isRowItemMode) {
      const dataStartRow = headerRowNo + 1;
      for (let r = dataStartRow; r <= worksheet.rowCount; r++) {
        const firstCellText = String(worksheet.getCell(r, 1).value || "").toUpperCase();
        if (firstCellText.includes("TỔNG CỘNG")) continue;
        const product = String(worksheet.getCell(r, productCol).value || "").trim();
        const qty = toNumericQty(worksheet.getCell(r, qtyCol).value);
        if (!product || qty <= 0) continue;
        const dateObj = parseDateCell(dateCol ? worksheet.getCell(r, dateCol).value : null);
        const date = dateObj ? dateObj.toISOString().slice(0, 10) : "";
        sampleRows.push({ row: r, date, rowQtyTotal: qty });
        lineItems.push({
          date,
          product,
          sourceColumnName: String(headerColumns.find((c: any) => c.idx === productCol)?.name || "Tên sản phẩm"),
          qty,
          sku: skuCol ? String(worksheet.getCell(r, skuCol).value || "").trim() : "",
          unit: unitCol ? String(worksheet.getCell(r, unitCol).value || "").trim() : "",
          unitPrice: unitPriceCol ? toNumericQty(worksheet.getCell(r, unitPriceCol).value) : null,
          lineTotal: null,
        });
      }
    }

    const quantityColumns = isRowItemMode ? [] : headerColumns
      .filter((c: any) => !isLikelyMetaHeader(c.name))
      .map((c: any) => {
        let maxQty = 0;
        for (let r = 3; r <= worksheet.rowCount; r++) {
          const q = toNumericQty(worksheet.getCell(r, c.idx).value);
          if (q > maxQty) maxQty = q;
        }
        return { columnIndex: c.idx, columnName: c.name, sampleQty: maxQty };
      })
      .filter((c: any) => c.sampleQty > 0);

    if (!isRowItemMode) {
      for (let r = 3; r <= worksheet.rowCount; r++) {
        const firstCellText = String(worksheet.getCell(r, 1).value || "").toUpperCase();
        if (firstCellText.includes("TỔNG CỘNG")) continue;
        const dateObj = parseDateCell(worksheet.getCell(r, 2).value);
        if (!dateObj) continue;
        const rowQtyTotal = quantityColumns.reduce((sum: number, q: any) => sum + toNumericQty(worksheet.getCell(r, q.columnIndex).value), 0);
        if (rowQtyTotal <= 0) continue;
        const date = dateObj.toISOString().slice(0, 10);
        sampleRows.push({ row: r, date, rowQtyTotal });
        for (const q of quantityColumns) {
          const qty = toNumericQty(worksheet.getCell(r, q.columnIndex).value);
          if (qty > 0) lineItems.push({ date, product: q.columnName, sourceColumnName: q.columnName, qty, unitPrice: null, lineTotal: null });
        }
      }
    }

    const parserConfig = {
      sheetName: worksheet.name,
      headerRow: headerRowNo,
      productCodeRow: 1,
      dateColumnName: "Ngày/Date",
      rowItemMode: isRowItemMode,
      rowItemColumns: isRowItemMode ? {
        productNameColumnIndex: productCol,
        qtyColumnIndex: qtyCol,
        dateColumnIndex: dateCol,
        skuColumnIndex: skuCol,
        unitColumnIndex: unitCol,
        unitPriceColumnIndex: unitPriceCol,
      } : null,
      quantityColumns,
      headerColumns: headerColumns.slice(0, 60),
    };

    const datedRows = sampleRows.filter((s: any) => String(s?.date || "").trim());
    const confirmationView = {
      orderDate: datedRows.length ? `${datedRows[0].date} → ${datedRows[datedRows.length - 1].date}` : "",
      items: lineItems,
      subtotal: null,
      vat: null,
      total: null,
      hasNoMoneyInPo: true,
    };

    const confidenceScore = (() => {
      const hasDate = Boolean(String(confirmationView.orderDate || "").trim());
      const itemCount = (confirmationView.items || []).filter((it: any) => String(it?.product || "").trim()).length;
      const qtyCount = (confirmationView.items || []).filter((it: any) => Number(it?.qty || 0) > 0).length;
      let score = 0;
      if (hasDate) score += 0.35;
      if (itemCount > 0) score += 0.35;
      if (qtyCount > 0) score += 0.3;
      return Number(score.toFixed(2));
    })();

    setPendingTemplateFileName(file.name);
    setPendingTemplatePreview({ parserConfig, sampleRows, confirmationView, confidenceScore });
    setTemplateConfirmOpen(true);
  };

  const saveTemplateMutation = useMutation({
    mutationFn: async (customerId: string) => {
      if (!customerId) throw new Error("Vui lòng chọn khách hàng");
      if (!templatePreview?.parserConfig) throw new Error("Vui lòng upload và phân tích file mẫu trước");

      const { error: disableError } = await (supabase as any)
        .from("mini_crm_po_templates")
        .update({ is_active: false })
        .eq("customer_id", customerId)
        .eq("is_active", true);
      if (disableError) throw disableError;

      const versionNo = await getNextTemplateVersion(customerId);
      const { error: insertError } = await (supabase as any)
        .from("mini_crm_po_templates")
        .insert({
          customer_id: customerId,
          template_name: `Template v${versionNo} - ${new Date().toLocaleString("vi-VN")}`,
          file_name: templateFileName || "uploaded-template.xlsx",
          parser_config: { ...(templatePreview.parserConfig || {}), version_no: versionNo },
          sample_preview: templatePreview.sampleRows || [],
          confirmation_snapshot: templatePreview?.confirmationView || {},
          parse_confidence: Number(templatePreview?.confidenceScore || 1),
          version_no: versionNo,
          is_active: true,
        });
      if (insertError) throw insertError;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] });
      setTemplateFileName("");
      setTemplatePreview(null);
      toast({ title: "Lưu mẫu PO thành công", description: "Đã lưu format để scan cho lần sau." });
    },
    onError: (e: any) => {
      toast({ title: "Lưu mẫu PO thất bại", description: e?.message || "Không thể lưu mẫu PO", variant: "destructive" });
    },
  });

  const buildGmailQuery = () => {
    const getDayRangeEpochSeconds = (dateStr?: string) => {
      if (!dateStr) return null;
      const from = new Date(`${dateStr}T00:00:00`);
      const to = new Date(`${dateStr}T23:59:59`);
      return {
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(to.getTime() / 1000),
      };
    };

    const dayRange = getDayRangeEpochSeconds(syncDate);
    const dateQuery = dayRange
      ? `after:${dayRange.from} before:${dayRange.to}`
      : "newer_than:30d";

    return `in:anywhere deliveredto:po@bmq.vn ${dateQuery}`.trim();
  };

  const callPoGmailSync = async (payload: any, stepLabel: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new Error(`[${stepLabel}] Phiên đăng nhập hết hạn (không có access token). Vui lòng đăng xuất và đăng nhập lại.`);
    }

    const { error: userError } = await supabase.auth.getUser();
    if (userError) {
      throw new Error(`[${stepLabel}] Phiên đăng nhập không hợp lệ (${userError.message}). Vui lòng đăng xuất và đăng nhập lại.`);
    }

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-gmail-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    });

    const rawText = await response.text();
    let result: any = {};
    try {
      result = rawText ? JSON.parse(rawText) : {};
    } catch {
      result = { raw: rawText };
    }

    if (!response.ok) {
      const msg = result?.error || result?.message || result?.raw || rawText || "Unknown error";
      if (response.status === 401 && /invalid jwt/i.test(String(msg))) {
        throw new Error(`[${stepLabel}] HTTP 401 - Phiên đăng nhập đã hết hạn/không hợp lệ (Invalid JWT). Vui lòng đăng xuất và đăng nhập lại.`);
      }
      throw new Error(`[${stepLabel}] HTTP ${response.status} - ${msg}`);
    }

    return result;
  };

  const syncGmailMutation = useMutation({
    mutationFn: async () => {
      setSyncDebug(null);
      setSyncError("");
      setSyncStatus("syncing");

      const query = buildGmailQuery();
      const result = await callPoGmailSync({ mode: "preview", maxResults: 100, query, includeOnlyCrm: true }, "preview");
      return { ...result, query };
    },
    onSuccess: (result: any) => {
      setSyncDebug(result);
      const items = Array.isArray(result?.previews) ? result.previews : [];
      setPreviewItems(items);
      setSelectedPreviewId(items[0]?.messageId || null);
      setSelectedPreviewIds([]);
      setConfirmTemplateRead(false);
      setSyncStatus("preview_success");
    },
    onError: (e: any) => {
      setSyncStatus("error");
      setSyncError(e?.message || "Không thể đồng bộ Gmail");
    },
  });

  const importPoMutation = useMutation({
    mutationFn: async (scope: "all" | "selected" = "all") => {
      const query = buildGmailQuery();
      const allIds = previewItems.map((x: any) => x.messageId).filter(Boolean);
      const messageIds = scope === "selected" ? selectedPreviewIds : allIds;
      if (scope === "selected" && messageIds.length === 0) {
        throw new Error("Vui lòng chọn ít nhất 1 PO để nhập.");
      }

      const targetItems = scope === "selected"
        ? previewItems.filter((x: any) => messageIds.includes(x.messageId))
        : previewItems;
      const hasTemplateMatched = targetItems.some((x: any) => Boolean(x?.template?.id));
      if (hasTemplateMatched && !confirmTemplateRead) {
        throw new Error("Vui lòng xác nhận đã kiểm tra PO theo mẫu trước khi nhập.");
      }

      return await callPoGmailSync({ mode: "import", maxResults: 100, query, messageIds, includeOnlyCrm: true }, "import");
    },
    onSuccess: async (result: any) => {
      setSyncDebug(result);
      setSyncStatus("import_success");
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.refetchQueries({ queryKey: ["customer-po-inbox"], type: "active" });
      toast({ title: "Đã nhập PO vào hệ thống", description: `Đã nhập ${result?.synced || 0} PO.` });
      setSyncModalOpen(false);
    },
    onError: (e: any) => {
      setSyncStatus("error");
      setSyncError(e?.message || "Import PO thất bại");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "approved" | "rejected" }) => {
      const { error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ match_status: status, reviewed_at: new Date().toISOString(), review_note: status === "approved" ? "Manual approved" : "Manual rejected" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã cập nhật duyệt", description: "Trạng thái PO inbox đã đổi." });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi", description: e?.message || "Không thể cập nhật trạng thái", variant: "destructive" });
    },
  });

  const filteredPoInbox = useMemo(() => {
    const fromMs = poDateFrom ? new Date(`${poDateFrom}T00:00:00`).getTime() : null;
    const toMs = poDateTo ? new Date(`${poDateTo}T23:59:59`).getTime() : null;
    return poInbox.filter((row: any) => {
      const t = new Date(row?.received_at || 0).getTime();
      if (!Number.isFinite(t)) return false;
      if (fromMs && t < fromMs) return false;
      if (toMs && t > toMs) return false;
      return true;
    });
  }, [poInbox, poDateFrom, poDateTo]);

  const statusCounts = useMemo(() => {
    return filteredPoInbox.reduce(
      (acc: Record<string, number>, row: any) => {
        const key = row.match_status || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {}
    );
  }, [filteredPoInbox]);

  const selectedPo = useMemo(() => poInbox.find((r: any) => r.id === selectedPoId) || null, [poInbox, selectedPoId]);
  const selectedPreview = useMemo(() => previewItems.find((r: any) => r.messageId === selectedPreviewId) || null, [previewItems, selectedPreviewId]);

  useEffect(() => {
    if (!templateConfirmOpen || !pendingTemplatePreview?.confirmationView) return;
    setTemplateReviewDraft(JSON.parse(JSON.stringify(pendingTemplatePreview.confirmationView)));
    setTemplateReviewTouched(false);
  }, [templateConfirmOpen, pendingTemplatePreview]);

  useEffect(() => {
    if (!selectedPo) return;
    setPostRevenueStatus("");
    const items = Array.isArray(selectedPo.production_items)
      ? selectedPo.production_items
      : Array.isArray(selectedPo?.raw_payload?.parsed_items_preview)
        ? selectedPo.raw_payload.parsed_items_preview
        : [];
    const subtotal = Number(selectedPo.subtotal_amount || selectedPo?.raw_payload?.parse_meta?.subtotal || calcSubtotalFromItems(items) || 0);
    const vat = normalizeVatDisplay(
      subtotal,
      selectedPo.vat_amount || selectedPo?.raw_payload?.parse_meta?.vat_amount || 0
    );
    const total = Number((subtotal > 0 ? subtotal + vat : 0) || selectedPo.total_amount || selectedPo?.raw_payload?.parse_meta?.total_amount || 0);
    setPoSummaryDraft({
      po_number: selectedPo.po_number || extractPoNumberFromSubject(selectedPo.email_subject) || "",
      delivery_date: selectedPo.delivery_date || extractDeliveryDateFromSubject(selectedPo.email_subject) || "",
      subtotal_amount: subtotal || "",
      vat_amount: vat,
      total_amount: total || "",
      production_items: items,
    });
  }, [selectedPo]);

  const parseAttachmentMutation = useMutation({
    mutationFn: async (inboxId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Phiên đăng nhập hết hạn");
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-parse-inbox-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ inboxId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || "Parse attachment thất bại");
      return result;
    },
    onSuccess: async (result: any) => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      if (Array.isArray(result?.parsed?.items)) {
        const parsedItems = result.parsed.items;
        const subtotal = Number(result?.parsed?.subtotal || calcSubtotalFromItems(parsedItems) || 0);
        const vat = normalizeVatDisplay(subtotal, result?.parsed?.vat || 0);
        const total = subtotal + vat;
        setPoSummaryDraft((s: any) => ({
          ...s,
          po_number: s?.po_number || extractPoNumberFromSubject(selectedPo?.email_subject),
          delivery_date: s?.delivery_date || extractDeliveryDateFromSubject(selectedPo?.email_subject),
          production_items: parsedItems,
          subtotal_amount: subtotal || s?.subtotal_amount,
          vat_amount: vat,
          total_amount: total,
        }));
      }
      toast({ title: "Đã parse file đính kèm", description: `${result?.parsed?.itemCount || 0} dòng sản phẩm` });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi parse file", description: e?.message || "Không parse được", variant: "destructive" });
    },
  });

  const savePoSummaryMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPoId) throw new Error("Chưa chọn PO");
      const safeTotal = calcSafeTotal(poSummaryDraft.subtotal_amount, poSummaryDraft.vat_amount, poSummaryDraft.total_amount);
      const payload = {
        delivery_date: poSummaryDraft.delivery_date || null,
        subtotal_amount: Number(poSummaryDraft.subtotal_amount || 0) || null,
        vat_amount: Number(poSummaryDraft.vat_amount || 0) || null,
        total_amount: Number(safeTotal || 0) || null,
        production_items: poSummaryDraft.production_items || [],
        raw_payload: {
          ...(selectedPo?.raw_payload || {}),
          po_number: poSummaryDraft.po_number || extractPoNumberFromSubject(selectedPo?.email_subject) || null,
        },
      };
      const { error } = await (supabase as any).from("customer_po_inbox").update(payload).eq("id", selectedPoId);
      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      toast({ title: "Đã lưu tóm tắt PO" });
    },
    onError: (e: any) => {
      toast({ title: "Lỗi lưu PO", description: e?.message || "Không lưu được", variant: "destructive" });
    },
  });

  const postRevenueMutation = useMutation({
    onMutate: () => {
      setPostRevenueStatus("Đang đẩy dữ liệu sang Kiểm soát doanh thu...");
      toast({ title: "Đang đẩy sang kiểm soát doanh thu..." });
    },
    mutationFn: async (id: string) => {
      const nowIso = new Date().toISOString();
      const { data: row, error: rowErr } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,email_subject,total_amount,revenue_channel,raw_payload")
        .eq("id", id)
        .single();
      if (rowErr || !row) throw rowErr || new Error("Không tìm thấy PO để đẩy doanh thu");

      const postedSubtotal = Number(poSummaryDraft?.subtotal_amount || row?.subtotal_amount || 0);
      const postedVat = Number(poSummaryDraft?.vat_amount || row?.vat_amount || 0);
      const postedTotal = Number(
        calcSafeTotal(postedSubtotal, postedVat, poSummaryDraft?.total_amount) ||
        row?.total_amount ||
        calcTotalFromRawPayload(row?.raw_payload || {}) ||
        0
      );

      const nextRawPayload = {
        ...(row.raw_payload || {}),
        revenue_post: {
          posted: true,
          posted_at: nowIso,
          posted_by: "mini-crm-ui",
          amount: postedTotal,
          subtotal: postedSubtotal,
          vat: postedVat,
          total: postedTotal,
        },
      };

      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .update({ raw_payload: nextRawPayload, match_status: "approved" })
        .eq("id", id)
        .select("id,email_subject,total_amount,revenue_channel,raw_payload")
        .single();
      if (error) throw error;
      if (!data?.raw_payload?.revenue_post?.posted) throw new Error("Đẩy doanh thu chưa được ghi nhận trong raw_payload.revenue_post");
      return {
        ...data,
        posted_to_revenue_at: data?.raw_payload?.revenue_post?.posted_at || nowIso,
      };
    },
    onSuccess: async (row: any) => {
      const poCode = extractPoNumberFromSubject(row?.email_subject) || row?.id;
      setPostRevenueStatus(`✅ Đã đẩy thành công PO ${poCode} lúc ${new Date(row?.posted_to_revenue_at || Date.now()).toLocaleString("vi-VN")}`);
      await queryClient.invalidateQueries({ queryKey: ["customer-po-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["finance-posted-po"] });
      const postedDisplay = Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || row?.total_amount || 0);
      toast({
        title: "✅ Đã đẩy sang kiểm soát doanh thu",
        description: `${extractPoNumberFromSubject(row?.email_subject) || row?.id} • ${postedDisplay.toLocaleString("vi-VN")} ₫ • ${row?.revenue_channel || "(chưa có kênh)"}`,
      });
    },
    onError: (e: any) => {
      setPostRevenueStatus(`❌ Đẩy thất bại: ${e?.message || "Không thể cập nhật"}`);
      toast({ title: "Lỗi đẩy doanh thu", description: e?.message || "Không thể cập nhật", variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-display font-bold">{isSalesPoPage ? "PO (Bán hàng)" : "CRM"}</h1>
          <p className="text-muted-foreground">
            {isSalesPoPage
              ? "Duyệt tay PO từ hộp thư po@bmq.vn và đẩy doanh thu."
              : "Quản lý thông tin khách hàng và map email nhận diện."}
          </p>
          {isSalesPoPage && <p className="text-xs text-muted-foreground mt-1">Kết nối Gmail PO được cấu hình trong Settings.</p>}
        </div>
        {isSalesPoPage && (
          <div className="flex flex-col gap-2 items-end">
            {gmailConnectedEmail ? <Badge>{gmailConnectedEmail}</Badge> : <Badge variant="secondary">Chưa kết nối Gmail PO</Badge>}
            <div className="flex items-center gap-2">
              <Input type="date" value={syncDate} onChange={(e) => setSyncDate(e.target.value)} className="w-[150px] h-9" />
              <Button onClick={() => { setSyncModalOpen(true); syncGmailMutation.mutate(); }} disabled={syncGmailMutation.isPending || !gmailConnectedEmail}>
                {syncGmailMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Sync PO
              </Button>
            </div>
          </div>
        )}
      </div>

      {isSalesPoPage && (
        <Dialog open={syncModalOpen} onOpenChange={setSyncModalOpen}>
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle>Sync PO từ Gmail</DialogTitle>
              <DialogDescription>Đồng bộ để xem trước, chỉ nhập vào hệ thống khi bấm "Nhập PO vào hệ thống".</DialogDescription>
            </DialogHeader>

            <div className="text-xs rounded-md border bg-muted/30 p-3 space-y-1">
              <div><b>Trạng thái:</b> {syncStatus === "syncing" ? "Đang sync..." : syncStatus === "preview_success" ? "Đã lấy preview" : syncStatus === "import_success" ? "Đã nhập thành công" : syncStatus === "error" ? "Lỗi" : "Sẵn sàng"}</div>
              <div>Mailbox: {syncDebug?.mailbox || "-"}</div>
              <div>Query: <span className="font-mono">{syncDebug?.query || "-"}</span></div>
              <div>Matched (Gmail): {syncDebug?.resultSizeEstimate || 0} • Fetched: {syncDebug?.fetched || 0} • Synced: {syncDebug?.synced || 0}</div>
              <div>Loại do ngoài CRM: {syncDebug?.debug?.skippedNotInCrm || 0}</div>
              {!!(syncDebug?.debug?.skippedNotInCrmSamples?.length) && (
                <div className="text-muted-foreground">Mẫu email bị loại: {syncDebug.debug.skippedNotInCrmSamples.join(", ")}</div>
              )}
              {syncError && <div className="text-destructive">Lỗi: {syncError}</div>}
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <div className="border rounded-md max-h-80 overflow-auto">
                {(previewItems || []).map((item: any) => {
                  const isChecked = selectedPreviewIds.includes(item.messageId);
                  return (
                    <button
                      key={item.messageId}
                      type="button"
                      onClick={() => setSelectedPreviewId(item.messageId)}
                      className={`w-full text-left p-3 border-b hover:bg-muted/40 ${selectedPreviewId === item.messageId ? "bg-muted" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelectedPreviewIds((prev) => checked
                              ? Array.from(new Set([...prev, item.messageId]))
                              : prev.filter((id) => id !== item.messageId)
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-muted-foreground">{new Date(item.receivedAt).toLocaleString("vi-VN")}</div>
                          <div className="font-medium text-sm line-clamp-1">{item.subject}</div>
                          <div className="text-xs line-clamp-1">{item.fromEmail}</div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {previewItems.length === 0 && <div className="p-3 text-sm text-muted-foreground">Không lấy được nội dung PO.</div>}
              </div>

              <div className="border rounded-md p-3 text-sm space-y-2">
                {selectedPreview ? (
                  <>
                    <div><b>From:</b> {selectedPreview.fromEmail}</div>
                    <div><b>Subject:</b> {selectedPreview.subject}</div>
                    <div><b>Snippet:</b> {selectedPreview.snippet || "(trống)"}</div>
                    <div><b>Attachments:</b> {(selectedPreview.attachmentNames || []).join(", ") || "Không có"}</div>
                    <div className="pt-2 border-t mt-2 space-y-1">
                      <div><b>Mẫu PO:</b> {selectedPreview?.template?.name || "Chưa có mẫu riêng"}</div>
                      {selectedPreview?.template?.fileName && <div><b>File mẫu:</b> {selectedPreview.template.fileName}</div>}
                      {selectedPreview?.template?.updatedAt && <div><b>Cập nhật:</b> {new Date(selectedPreview.template.updatedAt).toLocaleString("vi-VN")}</div>}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground">Chọn một PO để xem chi tiết.</div>
                )}
              </div>
            </div>

            <div className="flex justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                Đã chọn: <b>{selectedPreviewIds.length}</b> / {previewItems.length}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedPreviewIds(previewItems.map((x: any) => x.messageId).filter(Boolean))}
                  disabled={previewItems.length === 0}
                >
                  Chọn tất cả
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedPreviewIds([])}
                  disabled={selectedPreviewIds.length === 0}
                >
                  Bỏ chọn
                </Button>
              </div>

              <div className="flex justify-end gap-2 items-center flex-wrap">
                <label className="inline-flex items-center gap-2 text-xs text-muted-foreground mr-2">
                  <input type="checkbox" checked={confirmTemplateRead} onChange={(e) => setConfirmTemplateRead(e.target.checked)} />
                  Đã kiểm tra PO theo mẫu và xác nhận đúng
                </label>
                <Button variant="outline" onClick={() => setSyncModalOpen(false)}>Huỷ</Button>
                <Button
                  variant="secondary"
                  onClick={() => importPoMutation.mutate("selected")}
                  disabled={importPoMutation.isPending || selectedPreviewIds.length === 0 || syncStatus === "syncing"}
                >
                  {importPoMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Nhập PO đã chọn
                </Button>
                <Button onClick={() => importPoMutation.mutate("all")} disabled={importPoMutation.isPending || previewItems.length === 0 || syncStatus === "syncing"}>
                  {importPoMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Nhập tất cả PO
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {isSalesPoPage && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Tổng PO inbox (đang lọc)</div><div className="text-xl font-semibold">{filteredPoInbox.length}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Pending approval</div><div className="text-xl font-semibold">{statusCounts.pending_approval || 0}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Approved</div><div className="text-xl font-semibold">{statusCounts.approved || 0}</div></CardContent></Card>
          <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Unmatched</div><div className="text-xl font-semibold">{statusCounts.unmatched || 0}</div></CardContent></Card>
        </div>
      )}

      {!isSalesPoPage && (
      <> 
      <div className="flex justify-end">
        <Button onClick={() => setSetupModalOpen(true)}>Thiết lập khách hàng</Button>
      </div>

      <Dialog open={setupModalOpen} onOpenChange={setSetupModalOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thiết lập khách hàng</DialogTitle>
            <DialogDescription>Tạo mới khách hàng, upload hợp đồng, thiết lập giá bán SKU và mẫu PO.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Tên khách hàng</Label>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Ví dụ: Đại lý Hòa Bình" />
            </div>
            <div className="space-y-2">
              <Label>Nhóm khách hàng</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={customerGroup} onChange={(e) => setCustomerGroup(e.target.value)}>
                {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Nhóm sản phẩm</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={productGroup} onChange={(e) => setProductGroup(e.target.value)}>
                {PRODUCT_GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Email nhận diện (phân tách dấu phẩy)</Label>
              <Input value={emailsInput} onChange={(e) => setEmailsInput(e.target.value)} placeholder="buyer@agency.com, order@agency.com" />
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Upload hợp đồng (PDF)</Label>
              <Input type="file" accept="application/pdf,.pdf" onChange={(e) => setSetupContractFile(e.target.files?.[0] || null)} />
              {setupContractFile && <div className="text-xs text-muted-foreground">{setupContractFile.name}</div>}
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Giá bán theo SKU thành phẩm</Label>
              <div className="space-y-2">
                {setupPriceRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2">
                    <select className="col-span-7 h-10 rounded-md border border-input bg-background px-3 text-sm" value={row.skuId} onChange={(e) => setSetupPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, skuId: e.target.value } : r))}>
                      <option value="">-- Chọn SKU thành phẩm --</option>
                      {finishedSkus.map((s: any) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}
                    </select>
                    <Input className="col-span-4" value={row.price} onChange={(e) => setSetupPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))} placeholder="VND/cái" />
                    <Button type="button" variant="outline" className="col-span-1" onClick={() => setSetupPriceRows((prev) => prev.filter((_, i) => i !== idx))} disabled={setupPriceRows.length === 1}>-</Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" onClick={() => setSetupPriceRows((prev) => [...prev, { skuId: "", price: "" }])}>+ Thêm sản phẩm</Button>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Upload form mẫu PO (.xlsx)</Label>
              <Input
                type="file"
                accept=".xlsx"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    await handleAnalyzeTemplateFile(f);
                  } catch (err: any) {
                    toast({ title: "Đọc file mẫu thất bại", description: err?.message || "Không thể đọc file", variant: "destructive" });
                  }
                }}
              />
              {templateFileName && <div className="text-xs text-muted-foreground">Đã xác nhận: {templateFileName}</div>}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSetupModalOpen(false)}>Huỷ</Button>
            <Button onClick={() => setupCustomerMutation.mutate()} disabled={setupCustomerMutation.isPending}>
              {setupCustomerMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Lưu thiết lập khách hàng
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Danh sách khách hàng</CardTitle>
        </CardHeader>
        <CardContent>
          {editFeedback && (
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-sm ${
                editFeedback.startsWith("Lưu thất bại")
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : editFeedback.startsWith("Đã lưu")
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border bg-muted/40 text-muted-foreground"
              }`}
            >
              {editFeedback}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>Nhóm</TableHead>
                <TableHead>Nhóm sản phẩm</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c: any) => {
                return (
                  <TableRow key={c.id}>
                    <TableCell>{c.customer_name}</TableCell>
                    <TableCell>{GROUP_LABEL_MAP[c.customer_group] || c.customer_group}</TableCell>
                    <TableCell>{PRODUCT_GROUP_LABEL_MAP[c.product_group] || c.product_group || "-"}</TableCell>
                    <TableCell>{(c.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ") || "-"}</TableCell>
                    <TableCell>{c.is_active ? <Badge>Active</Badge> : <Badge variant="secondary">Tạm ngưng</Badge>}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setViewCustomer(c)}>Xem</Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (confirm(`Xoá khách hàng ${c.customer_name}?`)) deleteCustomerMutation.mutate({ customerId: c.id, customerName: c.customer_name });
                          }}
                          disabled={deleteCustomerMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 mr-1" />Xoá
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      </>
      )}

      {isSalesPoPage && (
      <>
      <Card>
        <CardHeader>
          <CardTitle>PO Inbox (manual approval bắt buộc)</CardTitle>
          <CardDescription>PO đọc từ email po@bmq.vn sẽ nằm ở đây trước khi duyệt tay.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <div className="space-y-1">
              <Label>Từ ngày</Label>
              <Input type="date" value={poDateFrom} onChange={(e) => setPoDateFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Đến ngày</Label>
              <Input type="date" value={poDateTo} onChange={(e) => setPoDateTo(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPoDateFrom("");
                  setPoDateTo("");
                }}
              >
                Bỏ lọc ngày
              </Button>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Matched Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPoInbox.map((row: any) => (
                <TableRow key={row.id}>
                  <TableCell>{new Date(row.received_at).toLocaleString("vi-VN")}</TableCell>
                  <TableCell>{row.from_email}</TableCell>
                  <TableCell>{row.email_subject || "(no subject)"}</TableCell>
                  <TableCell>{row.mini_crm_customers?.customer_name || "Chưa match"}</TableCell>
                  <TableCell><Badge variant={row.match_status === "approved" ? "default" : "secondary"}>{row.match_status}</Badge></TableCell>
                  <TableCell className="space-x-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setSelectedPoId(row.id);
                        setPoSummaryDraft({
                          po_number: row.po_number || "",
                          delivery_date: row.delivery_date || "",
                          subtotal_amount: row.subtotal_amount || "",
                          vat_amount: row.vat_amount || "",
                          total_amount: row.total_amount || "",
                          production_items: Array.isArray(row.production_items) ? row.production_items : [],
                        });
                      }}
                    >
                      Xem nhanh
                    </Button>
                    <Button size="sm" onClick={() => reviewMutation.mutate({ id: row.id, status: "approved" })} disabled={reviewMutation.isPending || row.match_status === "approved"}>Approve</Button>
                    <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: row.id, status: "rejected" })} disabled={reviewMutation.isPending || row.match_status === "rejected"}>Reject</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isSalesPoPage && (
        <Dialog
          open={Boolean(selectedPo)}
          onOpenChange={(open) => {
            if (!open) setSelectedPoId(null);
          }}
        >
          <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
            {selectedPo && (
              <>
                <DialogHeader>
                  <DialogTitle>PO Quick View: {poSummaryDraft.po_number || selectedPo.po_number || selectedPo.email_subject}</DialogTitle>
                  <DialogDescription>Giao diện xem nhanh cho Kế toán và Quản lí sản xuất (không cần mở email).</DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div className="text-sm text-muted-foreground">
                    <div><b>From:</b> {selectedPo.from_email}</div>
                    <div><b>Subject:</b> {selectedPo.email_subject}</div>
                    <div><b>Nội dung nhanh:</b> {selectedPo.body_preview || "(trống)"}</div>
                    <div><b>Attachments:</b> {(selectedPo.attachment_names || []).join(", ") || "Không có"}</div>
                  </div>

                  <Tabs defaultValue="accounting" className="w-full">
                    <TabsList>
                      <TabsTrigger value="accounting">Kế toán</TabsTrigger>
                      <TabsTrigger value="production">QL Sản xuất</TabsTrigger>
                    </TabsList>

                    <TabsContent value="accounting" className="space-y-3 pt-3">
                      <div className="grid gap-3 md:grid-cols-2">
                        <div>
                          <Label>PO Number</Label>
                          <Input value={poSummaryDraft.po_number || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, po_number: e.target.value }))} />
                        </div>
                        <div>
                          <Label>Ngày giao</Label>
                          <Input type="date" value={poSummaryDraft.delivery_date || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, delivery_date: e.target.value }))} />
                        </div>
                        <div>
                          <Label>Tạm tính</Label>
                          <Input type="number" value={poSummaryDraft.subtotal_amount || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, subtotal_amount: e.target.value }))} />
                          <div className="text-xs text-muted-foreground mt-1">{formatVnd(poSummaryDraft.subtotal_amount)}</div>
                        </div>
                        <div>
                          <Label>VAT</Label>
                          <Input type="number" value={poSummaryDraft.vat_amount || ""} onChange={(e) => setPoSummaryDraft((s: any) => ({ ...s, vat_amount: e.target.value }))} />
                          <div className="text-xs text-muted-foreground mt-1">{formatVnd(poSummaryDraft.vat_amount)}</div>
                        </div>
                        <div>
                          <Label>Tổng tiền đơn hàng</Label>
                          <Input
                            type="number"
                            value={calcSafeTotal(poSummaryDraft.subtotal_amount, poSummaryDraft.vat_amount, poSummaryDraft.total_amount) || ""}
                            readOnly
                          />
                          <div className="text-xs text-muted-foreground mt-1">{formatVnd(calcSafeTotal(poSummaryDraft.subtotal_amount, poSummaryDraft.vat_amount, poSummaryDraft.total_amount))}</div>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="production" className="space-y-3 pt-3">
                      <div className="flex items-center justify-between">
                        <Label>Danh sách sản phẩm cho quản lí sản xuất</Label>
                        <div className="text-xs text-muted-foreground">
                          Tổng dòng: {Array.isArray(poSummaryDraft.production_items) ? poSummaryDraft.production_items.length : 0}
                        </div>
                      </div>

                      <div className="rounded-md border overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>SKU</TableHead>
                              <TableHead>Tên sản phẩm</TableHead>
                              <TableHead>ĐVT</TableHead>
                              <TableHead className="text-right">SL</TableHead>
                              <TableHead className="text-right">Đơn giá</TableHead>
                              <TableHead className="text-right">Thành tiền</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(Array.isArray(poSummaryDraft.production_items) ? poSummaryDraft.production_items : []).map((item: any, idx: number) => (
                              <TableRow key={`${item?.sku || "row"}-${idx}`}>
                                <TableCell>{item?.sku || "-"}</TableCell>
                                <TableCell>{item?.product_name || item?.name || "-"}</TableCell>
                                <TableCell>{item?.unit || "-"}</TableCell>
                                <TableCell className="text-right">{Number(item?.qty || item?.quantity || 0).toLocaleString("vi-VN")}</TableCell>
                                <TableCell className="text-right">{formatVnd(item?.unit_price || 0)}</TableCell>
                                <TableCell className="text-right">{formatVnd(item?.line_total || 0)}</TableCell>
                              </TableRow>
                            ))}
                            {(!Array.isArray(poSummaryDraft.production_items) || poSummaryDraft.production_items.length === 0) && (
                              <TableRow>
                                <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                                  Chưa có dữ liệu sản phẩm. Bấm "Parse từ file đính kèm" để lấy tự động.
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    </TabsContent>
                  </Tabs>

                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => parseAttachmentMutation.mutate(selectedPo.id)} disabled={parseAttachmentMutation.isPending}>
                      {parseAttachmentMutation.isPending ? "Đang parse..." : "Parse từ file đính kèm"}
                    </Button>
                    <Button onClick={() => savePoSummaryMutation.mutate()} disabled={savePoSummaryMutation.isPending}>Lưu tóm tắt PO</Button>
                    <Button variant="outline" onClick={() => postRevenueMutation.mutate(selectedPo.id)} disabled={postRevenueMutation.isPending}>
                      {postRevenueMutation.isPending ? "Đang đẩy..." : "Đẩy sang kiểm soát doanh thu"}
                    </Button>
                  </div>
                  {postRevenueStatus && (
                    <div className="text-sm rounded-md border px-3 py-2 bg-muted/40">
                      {postRevenueStatus}
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
      </>
      )}

      <Dialog open={Boolean(viewCustomer)} onOpenChange={(open) => !open && setViewCustomer(null)}>
        <DialogContent className="max-w-3xl">
          {viewCustomer && (
            <>
              <DialogHeader>
                <DialogTitle>Xem khách hàng: {viewCustomer.customer_name}</DialogTitle>
              </DialogHeader>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => {
                    startEditCustomer(viewCustomer);
                    setViewCustomer(null);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-1" />Sửa khách hàng
                </Button>
              </div>
              <div className="space-y-3 text-sm">
                <div><b>Nhóm:</b> {GROUP_LABEL_MAP[viewCustomer.customer_group] || viewCustomer.customer_group}</div>
                <div><b>Nhóm sản phẩm:</b> {PRODUCT_GROUP_LABEL_MAP[viewCustomer.product_group] || viewCustomer.product_group || "-"}</div>
                <div><b>Trạng thái:</b> {viewCustomer.is_active ? "Active" : "Tạm ngưng"}</div>
                <div><b>Email:</b> {(viewCustomer.mini_crm_customer_emails || []).map((e: any) => e.email).join(", ") || "-"}</div>
                <div><b>Hợp đồng:</b> {(customerContracts.find((x: any) => x.customer_id === viewCustomer.id)?.file_name) || "Chưa có"}</div>
                <div>
                  <b>Bảng giá:</b>
                  <ul className="list-disc pl-5">
                    {customerPriceList.filter((x: any) => x.customer_id === viewCustomer.id).length === 0 && <li>Chưa có</li>}
                    {customerPriceList.filter((x: any) => x.customer_id === viewCustomer.id).map((p: any) => {
                      const sku = finishedSkus.find((s: any) => s.id === p.sku_id);
                      return <li key={p.id}>{sku?.product_name || p.sku_id}: {Number(p.price_vnd_per_unit || 0).toLocaleString("vi-VN")} đ/cái</li>;
                    })}
                  </ul>
                </div>
                <div><b>Mẫu PO active:</b> {(() => { const t = poTemplates.find((x: any) => x.customer_id === viewCustomer.id); return t ? `${t.file_name || t.template_name} (v${t.version_no || 1})` : "Chưa có"; })()}</div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editingCustomerId)} onOpenChange={(open) => !open && cancelEditCustomer()}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sửa khách hàng</DialogTitle>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Tên khách hàng</Label>
              <Input value={editCustomerName} onChange={(e) => setEditCustomerName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Nhóm khách hàng</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editCustomerGroup} onChange={(e) => setEditCustomerGroup(e.target.value)}>
                {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Nhóm sản phẩm</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editProductGroup} onChange={(e) => setEditProductGroup(e.target.value)}>
                {PRODUCT_GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Email nhận diện</Label>
              <Input value={editEmailsInput} onChange={(e) => setEditEmailsInput(e.target.value)} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Trạng thái</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={editIsActive ? "active" : "paused"} onChange={(e) => setEditIsActive(e.target.value === "active")}>
                <option value="active">Active</option>
                <option value="paused">Tạm ngưng</option>
              </select>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Hợp đồng (PDF)</Label>
              <div className="text-xs">Active: {(customerContracts.find((x: any) => x.customer_id === editingCustomerId)?.file_name) || "Chưa có"}</div>
              <div className="flex gap-2">
                <Input type="file" accept="application/pdf,.pdf" onChange={(e) => setEditContractFile(e.target.files?.[0] || null)} />
                <Button type="button" variant="outline" onClick={async () => {
                  await (supabase as any).from("mini_crm_customer_contracts").update({ is_active: false }).eq("customer_id", editingCustomerId).eq("is_active", true);
                  await queryClient.invalidateQueries({ queryKey: ["mini-crm-customer-contracts"] });
                  toast({ title: "Đã xoá hợp đồng active" });
                }}>Xoá HĐ</Button>
              </div>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Giá bán SKU</Label>
              {editPriceRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 mb-2">
                  <select className="col-span-7 h-10 rounded-md border border-input bg-background px-3 text-sm" value={row.skuId} onChange={(e) => setEditPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, skuId: e.target.value } : r))}>
                    <option value="">-- Chọn SKU --</option>
                    {finishedSkus.map((s: any) => <option key={s.id} value={s.id}>{s.sku_code} - {s.product_name}</option>)}
                  </select>
                  <Input className="col-span-4" value={row.price} onChange={(e) => setEditPriceRows((prev) => prev.map((r, i) => i === idx ? { ...r, price: e.target.value } : r))} placeholder="VND/cái" />
                  <Button type="button" variant="outline" className="col-span-1" onClick={() => setEditPriceRows((prev) => prev.filter((_, i) => i !== idx))} disabled={editPriceRows.length === 1}>-</Button>
                </div>
              ))}
              <Button type="button" variant="outline" onClick={() => setEditPriceRows((prev) => [...prev, { skuId: "", price: "" }])}>+ Thêm SKU</Button>
            </div>

            <div className="space-y-2 md:col-span-2 rounded-md border p-3">
              <Label>Mẫu PO (.xlsx)</Label>
              <div className="text-xs">Active: {(poTemplates.find((t: any) => t.customer_id === editingCustomerId)?.file_name) || "Chưa có"}</div>
              <div className="flex gap-2">
                <Input type="file" accept=".xlsx" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try { await handleAnalyzeTemplateFile(f); } catch (err: any) { toast({ title: "Đọc file mẫu thất bại", description: err?.message || "Không thể đọc file", variant: "destructive" }); }
                }} />
                <Button type="button" variant="outline" onClick={async () => {
                  await (supabase as any).from("mini_crm_po_templates").update({ is_active: false }).eq("customer_id", editingCustomerId).eq("is_active", true);
                  await queryClient.invalidateQueries({ queryKey: ["mini-crm-po-templates"] });
                  toast({ title: "Đã xoá mẫu PO active" });
                }}>Xoá mẫu</Button>
              </div>
              {templateFileName && <div className="text-xs text-muted-foreground">Đã xác nhận mẫu mới: {templateFileName}</div>}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={cancelEditCustomer}>Huỷ</Button>
            <Button onClick={async () => { setEditFeedback("Đang lưu..."); await updateCustomerMutation.mutateAsync(); }} disabled={updateCustomerMutation.isPending}>
              {updateCustomerMutation.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}Lưu thay đổi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={templateConfirmOpen} onOpenChange={setTemplateConfirmOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Xác nhận mẫu PO trước khi lưu</DialogTitle>
            <DialogDescription>
              Hệ thống đã đọc file mẫu. Anh kiểm tra nội dung parse trước khi xác nhận lưu format.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-sm">
            <div><b>File:</b> {pendingTemplateFileName || "-"}</div>
            <div><b>Sheet:</b> {pendingTemplatePreview?.parserConfig?.sheetName || "-"}</div>
            <div><b>Header row:</b> {pendingTemplatePreview?.parserConfig?.headerRow || "-"}</div>
            <div className={`text-xs rounded px-2 py-1 ${Number(pendingTemplatePreview?.confidenceScore || 0) >= 0.9 ? "bg-emerald-500/10 text-emerald-700" : "bg-amber-500/10 text-amber-700"}`}>
              Độ tin cậy parse: {Math.round(Number(pendingTemplatePreview?.confidenceScore || 0) * 100)}%
              {Number(pendingTemplatePreview?.confidenceScore || 0) < 0.9 ? " — Parse thấp, cần chỉnh tay trước khi xác nhận." : ""}
            </div>

            <Tabs defaultValue="parsed" className="w-full">
              <TabsList>
                <TabsTrigger value="parsed">Dữ liệu parse</TabsTrigger>
                <TabsTrigger value="totals">Tổng tiền</TabsTrigger>
              </TabsList>

              <TabsContent value="parsed" className="space-y-2">
                <div>
                  <Label>Ngày đặt hàng</Label>
                  <Input
                    value={templateReviewDraft?.orderDate || ""}
                    onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), orderDate: e.target.value })); }}
                    placeholder="YYYY-MM-DD hoặc theo mẫu PO"
                  />
                </div>
                <div className="rounded border max-h-64 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ngày</TableHead>
                        <TableHead>Sản phẩm</TableHead>
                        <TableHead>Số lượng</TableHead>
                        <TableHead>Đơn giá</TableHead>
                        <TableHead>Thành tiền</TableHead>
                        <TableHead className="w-[70px]">Xoá</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(templateReviewDraft?.items || []).map((it: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell><Input value={it.date || ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, date: e.target.value } : x) })); }} placeholder="YYYY-MM-DD" /></TableCell>
                          <TableCell><Input value={it.product || ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, product: e.target.value } : x) })); }} /></TableCell>
                          <TableCell><Input value={it.qty ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, qty: e.target.value } : x) })); }} /></TableCell>
                          <TableCell><Input value={it.unitPrice ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, unitPrice: e.target.value } : x) })); }} placeholder="tuỳ chọn" /></TableCell>
                          <TableCell><Input value={it.lineTotal ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).map((x: any, i: number) => i === idx ? { ...x, lineTotal: e.target.value } : x) })); }} placeholder="tuỳ chọn" /></TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setTemplateReviewTouched(true);
                                setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), items: (prev?.items || []).filter((_x: any, i: number) => i !== idx) }));
                              }}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              <TabsContent value="totals" className="space-y-2">
                <div className="grid md:grid-cols-3 gap-2">
                  <div><Label>Tạm tính</Label><Input value={templateReviewDraft?.subtotal ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), subtotal: e.target.value })); }} /></div>
                  <div><Label>VAT</Label><Input value={templateReviewDraft?.vat ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), vat: e.target.value })); }} /></div>
                  <div><Label>Thành tiền</Label><Input value={templateReviewDraft?.total ?? ""} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), total: e.target.value })); }} /></div>
                </div>
                <label className="inline-flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={Boolean(templateReviewDraft?.hasNoMoneyInPo)} onChange={(e) => { setTemplateReviewTouched(true); setTemplateReviewDraft((prev: any) => ({ ...(prev || {}), hasNoMoneyInPo: e.target.checked })); }} />
                  PO này chỉ có số lượng, chưa có thông tin tiền
                </label>
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setTemplateConfirmOpen(false)}>Huỷ</Button>
            <Button
              onClick={async () => {
                const hasOrderDate = Boolean(String(templateReviewDraft?.orderDate || "").trim());
                const validItems = (templateReviewDraft?.items || []).filter((it: any) => String(it?.date || "").trim() && String(it?.product || "").trim() && Number(String(it?.qty || 0).replace(/[^0-9.-]/g, "")) > 0);
                if (!hasOrderDate || validItems.length === 0) {
                  toast({ title: "Thiếu dữ liệu bắt buộc", description: "Cần xác nhận dải ngày và ít nhất 1 dòng hợp lệ (ngày + sản phẩm + số lượng > 0)", variant: "destructive" });
                  return;
                }

                const confidence = Number(pendingTemplatePreview?.confidenceScore || 0);
                if (confidence < 0.9 && !templateReviewTouched) {
                  toast({ title: "Parse độ tin cậy thấp", description: "Vui lòng chỉnh tay ít nhất 1 trường trước khi xác nhận lưu mẫu", variant: "destructive" });
                  return;
                }

                const selectedSourceColumns = Array.from(new Set(validItems.map((it: any) => String(it?.sourceColumnName || "").trim()).filter(Boolean)));
                const baseParserConfig = pendingTemplatePreview?.parserConfig || {};
                const baseQuantityCols = Array.isArray(baseParserConfig?.quantityColumns) ? baseParserConfig.quantityColumns : [];
                const filteredQuantityCols = selectedSourceColumns.length
                  ? baseQuantityCols.filter((q: any) => selectedSourceColumns.includes(String(q?.columnName || "").trim()))
                  : baseQuantityCols;

                const mergedPreview = {
                  ...(pendingTemplatePreview || {}),
                  parserConfig: {
                    ...baseParserConfig,
                    quantityColumns: filteredQuantityCols,
                    productNameOverrides: Object.fromEntries(
                      validItems
                        .filter((it: any) => String(it?.sourceColumnName || "").trim())
                        .map((it: any) => [String(it.sourceColumnName), String(it.product || it.sourceColumnName)])
                    ),
                  },
                  confirmationView: { ...(templateReviewDraft || {}) },
                  sampleRows: validItems,
                  confidenceScore: confidence < 0.9 && templateReviewTouched ? 0.95 : confidence,
                };

                const beforeSnap = pendingTemplatePreview?.confirmationView || {};
                const afterSnap = templateReviewDraft || {};
                const hasChanged = JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap);
                if (hasChanged) {
                  const diffSummary = summarizeTemplateDiff(beforeSnap, afterSnap);
                  try {
                    await (supabase as any).from("mini_crm_po_template_learning_logs").insert({
                      customer_id: editingCustomerId || null,
                      source_file_name: pendingTemplateFileName || null,
                      source_confidence: Number(pendingTemplatePreview?.confidenceScore || 0),
                      before_snapshot: beforeSnap,
                      after_snapshot: afterSnap,
                      diff_summary: diffSummary,
                    });
                  } catch (e) {
                    console.warn("Cannot write learning log", e);
                  }
                }

                setTemplateFileName(pendingTemplateFileName);
                setTemplatePreview(mergedPreview);
                setTemplateConfirmOpen(false);
                toast({ title: "Đã xác nhận mẫu PO", description: hasChanged ? "Đã lưu correction để cải thiện parse lần sau." : "Anh có thể bấm Lưu mẫu PO để lưu format." });
              }}
            >
              Xác nhận nội dung parse
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
