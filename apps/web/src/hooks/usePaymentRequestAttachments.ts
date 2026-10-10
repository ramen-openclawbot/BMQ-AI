import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { resolveImageUrl } from "@/lib/storage-url";

/** Supporting documents bucket/path convention mirrors uploadPaymentRequestImage. */
export const PAYMENT_REQUEST_ATTACHMENTS_BUCKET = "invoices";

export interface PaymentRequestAttachment {
  id: string;
  payment_request_id: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface PaymentRequestAttachmentWithUrl extends PaymentRequestAttachment {
  url: string | null;
}

const attachmentsFolder = (requestId: string) =>
  `payment-requests/attachments/${requestId}`;

/**
 * Uploads every file to the invoices bucket under
 * payment-requests/attachments/<request_id>/ and inserts one row per file.
 */
export async function uploadPaymentRequestAttachments(
  requestId: string,
  files: File[],
): Promise<PaymentRequestAttachment[]> {
  if (!requestId) throw new Error("missing_request_id");
  const safeFiles = Array.from(files || []);
  if (safeFiles.length === 0) return [];

  const pathByFile = new Map<File, string>();
  for (const file of safeFiles) {
    const fileExt = (file.name.split(".").pop() || "bin").toLowerCase();
    const objectPath = `${attachmentsFolder(requestId)}/${crypto.randomUUID()}.${fileExt}`;
    const { error } = await supabase.storage
      .from(PAYMENT_REQUEST_ATTACHMENTS_BUCKET)
      .upload(objectPath, file);
    if (error) throw error;
    pathByFile.set(file, objectPath);
  }

  const { data, error } = await supabase
    .from("payment_request_attachments")
    .insert(safeFiles.map((file) => ({
      payment_request_id: requestId,
      storage_path: pathByFile.get(file) as string,
      file_name: file.name || null,
      mime_type: file.type || null,
    })))
    .select();
  if (error) throw error;
  return (data || []) as PaymentRequestAttachment[];
}

export async function listPaymentRequestAttachments(
  requestId: string,
): Promise<PaymentRequestAttachmentWithUrl[]> {
  const { data, error } = await supabase
    .from("payment_request_attachments")
    .select("*")
    .eq("payment_request_id", requestId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const rows = (data || []) as PaymentRequestAttachment[];
  return Promise.all(rows.map(async (row) => ({
    ...row,
    url: await resolveImageUrl(row.storage_path, { preferredBucket: PAYMENT_REQUEST_ATTACHMENTS_BUCKET }),
  })));
}

/** Data-only hook: list attachments with signed URLs and upload many files. */
export function usePaymentRequestAttachments(requestId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["payment-request-attachments", requestId],
    enabled: !!requestId,
    staleTime: 30000,
    queryFn: () => (requestId
      ? listPaymentRequestAttachments(requestId)
      : Promise.resolve([] as PaymentRequestAttachmentWithUrl[])),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => uploadPaymentRequestAttachments(requestId as string, files),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-request-attachments", requestId] });
      queryClient.invalidateQueries({ queryKey: ["cash-settlement", requestId] });
    },
    onError: (error) => {
      console.error("[usePaymentRequestAttachments] Upload failed", error);
    },
  });

  return {
    attachments: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    upload,
  };
}
