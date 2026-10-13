import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  buildDeliveryPayload,
  mapDispatchQueue,
  type BuildDeliveryPayloadInput,
  type DispatchQueueRow,
} from "@/lib/dispatch-delivery";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const DISPATCH_GAME_QUEUE_QUERY_KEY = "dispatch-game-queue";
export const DISPATCH_EVIDENCE_BUCKET = "dispatch-evidence";

export interface RecordDispatchDeliveryResult {
  dispatch_id: string;
  status: string;
  revenue_pending: boolean;
  evidence_count: number;
  delivered_line_count: number;
  revenue_line_count: number;
  shortfall_returned_qty: number;
  shortfall_written_off_qty: number;
}

/** Open dispatches (last 14 days) for the Kho 2D delivery gate. */
export function useDispatchGameQueue(enabled = true) {
  return useQuery({
    queryKey: [DISPATCH_GAME_QUEUE_QUERY_KEY],
    enabled,
    retry: false,
    queryFn: async (): Promise<DispatchQueueRow[]> => {
      const { data, error } = await supabase.rpc("get_dispatch_game_queue" as never);
      if (error) throw error;
      return mapDispatchQueue(data);
    },
  });
}

/** Record actual delivered quantities + photo paths; idempotent by requestId. */
export function useRecordDispatchDelivery() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BuildDeliveryPayloadInput): Promise<RecordDispatchDeliveryResult> => {
      const args = buildDeliveryPayload(input);
      const { data, error } = await supabase.rpc("record_dispatch_delivery" as never, args as never);
      if (error) throw error;
      const row = (data ?? {}) as Record<string, unknown>;
      return {
        dispatch_id: String(row.dispatch_id ?? input.dispatchId),
        status: String(row.status ?? ""),
        revenue_pending: row.revenue_pending === true,
        evidence_count: Number(row.evidence_count ?? 0),
        delivered_line_count: Number(row.delivered_line_count ?? 0),
        revenue_line_count: Number(row.revenue_line_count ?? 0),
        shortfall_returned_qty: Number(row.shortfall_returned_qty ?? 0),
        shortfall_written_off_qty: Number(row.shortfall_written_off_qty ?? 0),
      };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [DISPATCH_GAME_QUEUE_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
    },
  });
}

/** Phone photos are 3–6 MB: shrink to a 1600px JPEG before upload; fall back to the original file. */
export async function shrinkPhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    return blob ?? file;
  } catch {
    return file;
  }
}

/** Upload one evidence photo to the private bucket at an exact path. */
export async function uploadEvidencePhoto(path: string, file: File): Promise<void> {
  const blob = await shrinkPhoto(file);
  const { error } = await supabase.storage.from(DISPATCH_EVIDENCE_BUCKET).upload(path, blob, {
    upsert: false,
    contentType: blob.type || file.type || "image/jpeg",
  });
  // A retry of the same file reuses its path; an existing object is already the evidence.
  if (error && !/exists|duplicate/i.test(error.message)) throw error;
}
