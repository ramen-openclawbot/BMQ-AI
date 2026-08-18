import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/supabase-helpers";
import { supabase } from "@/integrations/supabase/client";
import { resolveImageUrl } from "@/lib/storage-url";
import {
  createInvoiceWithMaterialController,
  createProcurementLineWithMaterialResolution,
  getCurrentActorId,
  updateProcurementDocumentWithMaterialController,
} from "@/lib/material-controller-rpcs";

export interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  supplier_id: string | null;
  subtotal: number;
  vat_amount: number;
  total_amount: number;
  image_url: string | null;
  payment_slip_url: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  payment_request_id: string | null;
  purchase_order_id: string | null;
  goods_receipt_id: string | null;
  suppliers?: {
    id: string;
    name: string;
  } | null;
  purchase_orders?: {
    id: string;
    po_number: string;
  } | null;
  goods_receipts?: {
    id: string;
    receipt_number: string;
  } | null;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  product_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  inventory_item_id: string | null;
  notes: string | null;
  created_at: string;
  raw_product_name?: string | null;
  suggested_standard_cost_code?: string | null;
  confirmed_standard_cost_code?: string | null;
  standard_cost_code_type?: string | null;
  canonical_cost_item_name?: string | null;
  canonical_cost_item_source?: string | null;
  cost_category_code?: string | null;
  cost_product_line?: string | null;
  cost_allocation_rule?: string | null;
  cost_review_routing?: string | null;
  unit_conversion_note?: string | null;
  matched_finished_skus?: string[] | null;
  ocr_classification_json?: Record<string, unknown> | null;
}

export interface CreateInvoiceData {
  invoice_number: string;
  invoice_date: string;
  supplier_id?: string | null;
  subtotal?: number;
  vat_amount?: number;
  total_amount?: number;
  image_url?: string | null;
  payment_slip_url?: string | null;
  notes?: string | null;
  created_by?: string | null;
  payment_request_id?: string | null;
  purchase_order_id?: string | null;
  goods_receipt_id?: string | null;
}

export interface CreateInvoiceItemData {
  invoice_id: string;
  product_code?: string | null;
  product_name: string;
  unit?: string;
  quantity: number;
  unit_price: number;
  inventory_item_id?: string | null;
  notes?: string | null;
  raw_product_name?: string | null;
  suggested_standard_cost_code?: string | null;
  confirmed_standard_cost_code?: string | null;
  standard_cost_code_type?: string | null;
  canonical_cost_item_name?: string | null;
  canonical_cost_item_source?: string | null;
  cost_category_code?: string | null;
  cost_product_line?: string | null;
  cost_allocation_rule?: string | null;
  cost_review_routing?: string | null;
  unit_conversion_note?: string | null;
  matched_finished_skus?: string[] | null;
  ocr_classification_json?: Record<string, unknown> | null;
}

export interface CreateInvoiceWithItemsData {
  invoice: CreateInvoiceData;
  items: Omit<CreateInvoiceItemData, "invoice_id">[];
}

export function useInvoices() {
  return useQuery({
    queryKey: ["invoices"],
    queryFn: async () => {
      const { data, error } = await db
        .from("invoices")
        .select(`
          *,
          suppliers (id, name),
          purchase_orders (id, po_number),
          goods_receipts (id, receipt_number)
        `)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Invoice[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useInvoice(id: string | null) {
  return useQuery({
    queryKey: ["invoice", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await db
        .from("invoices")
        .select(`
          *,
          suppliers (id, name),
          purchase_orders (id, po_number),
          goods_receipts (id, receipt_number)
        `)
        .eq("id", id)
        .maybeSingle();

      if (error) throw error;
      return data as Invoice | null;
    },
    enabled: !!id,
  });
}

export function useInvoiceItems(invoiceId: string | null) {
  return useQuery({
    queryKey: ["invoice_items", invoiceId],
    queryFn: async () => {
      if (!invoiceId) return [];
      const { data, error } = await db
        .from("invoice_items")
        .select("*")
        .eq("invoice_id", invoiceId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return data as InvoiceItem[];
    },
    enabled: !!invoiceId,
  });
}

export function useCreateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (invoice: CreateInvoiceData) => {
      const { data, error } = await db
        .from("invoices")
        .insert(invoice)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (error: Error) => {
      console.error("Failed to create invoice:", error.message);
    },
  });
}

export function useUpdateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Invoice> & { id: string }) => {
      const { data, error } = await db
        .from("invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", variables.id] });
    },
    onError: (error: Error) => {
      console.error("Failed to update invoice:", error.message);
    },
  });
}

export function useDeleteInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("invoices").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (error: Error) => {
      console.error("Failed to delete invoice:", error.message);
    },
  });
}


export function useCreateInvoiceItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: CreateInvoiceItemData) => {
      const { raw_product_name: _rawProductName, canonical_material_id: _canonicalMaterialId, material_resolution_status: _materialResolutionStatus, material_resolution_request_id: _materialResolutionRequestId, ...safeItem } = item as CreateInvoiceItemData & Record<string, unknown>;
      void _rawProductName; void _canonicalMaterialId; void _materialResolutionStatus; void _materialResolutionRequestId;
      const actorId = await getCurrentActorId();
      const result = await createProcurementLineWithMaterialResolution({
        sourceTable: "invoice_items",
        sourceType: "invoice",
        parentId: safeItem.invoice_id,
        item: { ...safeItem, raw_product_name: String(_rawProductName || safeItem.product_name || "") },
        actorId,
      });
      const { data, error } = await db
        .from("invoice_items")
        .select("*")
        .eq("id", result.line_id)
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["invoice_items", variables.invoice_id] });
    },
    onError: (error: Error) => {
      console.error("Failed to add item:", error.message);
    },
  });
}

export function useCreateInvoiceWithItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invoice, items }: CreateInvoiceWithItemsData) => {
      const actorId = await getCurrentActorId();
      return createInvoiceWithMaterialController({
        invoice: invoice as Record<string, unknown>,
        items: items.map((item) => item as Record<string, unknown>),
        actorId,
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice", data.invoice_id] });
      queryClient.invalidateQueries({ queryKey: ["invoice_items", data.invoice_id] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error: Error) => {
      console.error("Failed to create invoice with items:", error.message);
    },
  });
}

export function useUpdateInvoiceItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, invoice_id, ...updates }: Partial<InvoiceItem> & { id: string; invoice_id: string }) => {
      const actorId = await getCurrentActorId();
      await updateProcurementDocumentWithMaterialController({
        sourceType: "invoice",
        parentId: invoice_id,
        parentPatch: {},
        lines: [{
          id,
          quantity: updates.quantity,
          unit_price: updates.unit_price,
          line_total: updates.line_total,
          notes: updates.notes,
        }],
        actorId,
      });
      const { data, error } = await db
        .from("invoice_items")
        .select("*")
        .eq("id", id)
        .single();

      if (error) throw error;
      return { ...data, invoice_id };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoice_items", data.invoice_id] });
    },
    onError: (error: Error) => {
      console.error("Failed to update item:", error.message);
    },
  });
}

export function useDeleteInvoiceItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ invoice_id }: { id: string; invoice_id: string }) => {
      throw new Error("Không thể xoá dòng hóa đơn lịch sử. Vui lòng hủy hóa đơn và tạo chứng từ mới nếu cần đổi danh tính hàng hóa.");
      return { invoice_id };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoice_items", data.invoice_id] });
    },
    onError: (error: Error) => {
      console.error("Failed to delete item:", error.message);
    },
  });
}

export async function uploadInvoiceImage(file: File): Promise<string> {
  const fileExt = file.name.split(".").pop();
  const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(fileName, file);

  if (uploadError) throw uploadError;

  // Store storage object path; UI will resolve to signed URL when rendering.
  return fileName;
}

export async function getInvoiceImageUrl(path: string): Promise<string> {
  const resolved = await resolveImageUrl(path, { preferredBucket: "invoices" });
  return resolved || "";
}
