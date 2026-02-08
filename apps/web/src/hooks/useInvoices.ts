import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/supabase-helpers";
import { supabase } from "@/integrations/supabase/client";

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
  suppliers?: {
    id: string;
    name: string;
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
}

export function useInvoices() {
  return useQuery({
    queryKey: ["invoices"],
    queryFn: async () => {
      const { data, error } = await db
        .from("invoices")
        .select(`
          *,
          suppliers (id, name)
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
          suppliers (id, name)
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
      const { data, error } = await db
        .from("invoice_items")
        .insert(item)
        .select()
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

export function useUpdateInvoiceItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, invoice_id, ...updates }: Partial<InvoiceItem> & { id: string; invoice_id: string }) => {
      const { data, error } = await db
        .from("invoice_items")
        .update(updates)
        .eq("id", id)
        .select()
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
    mutationFn: async ({ id, invoice_id }: { id: string; invoice_id: string }) => {
      const { error } = await db.from("invoice_items").delete().eq("id", id);
      if (error) throw error;
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
  const filePath = `${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from("invoices")
    .upload(filePath, file);

  if (uploadError) throw uploadError;

  const { data } = await supabase.storage
    .from("invoices")
    .createSignedUrl(filePath, 60 * 60 * 4);
  return data?.signedUrl || "";
}

export async function getInvoiceImageUrl(path: string): Promise<string> {
  const { data } = await supabase.storage
    .from("invoices")
    .createSignedUrl(path, 3600);
  
  return data?.signedUrl || "";
}
