import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  parseKfmDailyDeliveryReport,
  parseKfmDeliveryVsPo,
  parseKfmDispatchPhoto,
  type KfmDailyDeliveryReport,
  type KfmDeliveryRow,
  type KfmDeliveryVsPo,
  type KfmDispatchPhoto,
} from "@/lib/kfm-delivery";

const DISPATCH_PHOTO_BUCKET = "dispatch-report-photos";
const SIGNED_URL_SECONDS = 10 * 60;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

function normalizeReportDate(date: string): string {
  const day = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("invalid_date");
  }
  return day;
}

function fileExtension(file: File): string {
  const name = file.name ?? "";
  const dot = name.lastIndexOf(".");
  const fromName = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (/^[a-z0-9]{1,10}$/.test(fromName)) {
    return fromName === "jpeg" ? "jpg" : fromName;
  }
  return MIME_EXTENSIONS[(file.type ?? "").toLowerCase()] ?? "jpg";
}

export function useKfmDailyDeliveryReport(
  date: string | null | undefined,
) {
  return useQuery<KfmDailyDeliveryReport>({
    queryKey: ["kfm-daily-delivery-report", date],
    enabled: Boolean(date),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc(
        "kfm_daily_delivery_report",
        { p_date: date as string },
      );
      if (error) throw error;
      return parseKfmDailyDeliveryReport(data);
    },
    staleTime: 15000,
  });
}

export function useKfmDeliveryVsPo(
  from: string | null | undefined,
  to: string | null | undefined,
) {
  return useQuery<KfmDeliveryVsPo>({
    queryKey: ["kfm-delivery-vs-po", from, to],
    enabled: Boolean(from && to),
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("kfm_delivery_vs_po", {
        p_from: from as string,
        p_to: to as string,
      });
      if (error) throw error;
      return parseKfmDeliveryVsPo(data);
    },
    staleTime: 15000,
  });
}

export type SetKfmDeliveredQtyInput = {
  poNumber: string;
  deliveredQty: number;
  note?: string | null;
};

export function useSetKfmDeliveredQty() {
  const queryClient = useQueryClient();

  return useMutation<KfmDeliveryRow | null, Error, SetKfmDeliveredQtyInput>({
    mutationFn: async (input) => {
      const { data, error } = await (supabase as any).rpc(
        "kfm_set_po_delivered_qty",
        {
          p_po_number: input.poNumber,
          p_delivered_qty: input.deliveredQty,
          p_note: input.note ?? null,
        },
      );
      if (error) throw error;
      return parseKfmDeliveryVsPo({ rows: [data] }).rows[0] ?? null;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["kfm-daily-delivery-report"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["kfm-delivery-vs-po"],
        }),
      ]);
    },
  });
}

export type DispatchReportPhotoMeta = {
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
};

function optionalDimension(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export async function uploadDispatchReportPhoto(
  date: string,
  file: File,
  meta: DispatchReportPhotoMeta = {},
): Promise<KfmDispatchPhoto> {
  const day = normalizeReportDate(date);
  const storagePath = `${day}/${crypto.randomUUID()}.${fileExtension(file)}`;
  const bucket = supabase.storage.from(DISPATCH_PHOTO_BUCKET);

  const { error: uploadError } = await bucket.upload(storagePath, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error: rpcError } = await (supabase as any).rpc(
    "dispatch_report_photo_add",
    {
      p_date: day,
      p_storage_path: storagePath,
      p_size_bytes: optionalDimension(meta.sizeBytes),
      p_width: optionalDimension(meta.width),
      p_height: optionalDimension(meta.height),
    },
  );
  if (rpcError) {
    await bucket.remove([storagePath]);
    throw rpcError;
  }

  const photo = parseKfmDispatchPhoto(data);
  if (!photo) {
    await bucket.remove([storagePath]);
    throw new Error("invalid_photo_metadata");
  }
  return photo;
}

export async function removeDispatchReportPhoto(
  photo: Pick<KfmDispatchPhoto, "id" | "storagePath">,
): Promise<void> {
  const { error: rpcError } = await (supabase as any).rpc(
    "dispatch_report_photo_remove",
    { p_id: photo.id },
  );
  if (rpcError) throw rpcError;

  const { error: storageError } = await supabase.storage
    .from(DISPATCH_PHOTO_BUCKET)
    .remove([photo.storagePath]);
  if (storageError) throw storageError;
}

export async function getDispatchReportPhotoUrl(
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(DISPATCH_PHOTO_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (error) throw error;
  if (!data?.signedUrl) {
    throw new Error("signed_url_unavailable");
  }
  return data.signedUrl;
}

export type KfmSaveDispatchPhotoResult = {
  id: string;
  status: "done" | "failed" | "skipped";
  kind: string | null;
  mismatch: boolean | null;
};

export type KfmSaveDispatchReportResult = {
  saved: string[];
  results: KfmSaveDispatchPhotoResult[];
};

export type SaveDispatchReportInput = {
  date: string;
  photoIds: string[];
};

/**
 * Save the selected photos for one day and let the Edge Function classify the
 * saved images with Jev. The function receives only ids; the database decides
 * whether this caller may save, and Jev never sees the API key.
 */
export function useSaveDispatchReport() {
  const queryClient = useQueryClient();

  return useMutation<KfmSaveDispatchReportResult, Error, SaveDispatchReportInput>({
    mutationFn: async (input) => {
      const day = normalizeReportDate(input.date);
      if (!Array.isArray(input.photoIds) || input.photoIds.length === 0) {
        throw new Error("invalid_photo_ids");
      }
      if (input.photoIds.length > 10) {
        throw new Error("too_many_photos");
      }
      const { data, error } = await supabase.functions.invoke(
        "dispatch-report-jev",
        { body: { date: day, photo_ids: input.photoIds } },
      );
      if (error) throw error;
      const result = (data ?? {}) as Partial<KfmSaveDispatchReportResult>;
      return {
        saved: Array.isArray(result.saved) ? result.saved : [],
        results: Array.isArray(result.results) ? result.results : [],
      };
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: [
          "kfm-daily-delivery-report",
          normalizeReportDate(variables.date),
        ],
      });
    },
  });
}

export function useDispatchReportPhotos() {
  const queryClient = useQueryClient();

  return {
    uploadDispatchReportPhoto: async (
      date: string,
      file: File,
      meta: DispatchReportPhotoMeta = {},
    ) => {
      const photo = await uploadDispatchReportPhoto(date, file, meta);
      await queryClient.invalidateQueries({
        queryKey: [
          "kfm-daily-delivery-report",
          normalizeReportDate(date),
        ],
      });
      return photo;
    },
    removeDispatchReportPhoto: async (
      photo: Pick<KfmDispatchPhoto, "id" | "storagePath">,
    ) => {
      await removeDispatchReportPhoto(photo);
      await queryClient.invalidateQueries({
        queryKey: ["kfm-daily-delivery-report"],
      });
    },
    getDispatchReportPhotoUrl,
  };
}
