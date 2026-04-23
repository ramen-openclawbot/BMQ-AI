import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import {
  getFinanceOcrBackendErrorMessage,
  getFinanceOcrBackendWarningMessage,
} from "@/lib/finance-ocr.js";
import { optimizeSlipImageForOcr } from "@/lib/slip-image";

// ========== Type Definitions ==========

export interface ScanProgress {
  currentFile: string;
  processedCount: number;
  totalCount: number;
  skippedCount: number;
  successCount: number;
}

export interface ScanResult {
  success: boolean;
  processedCount: number;
  successCount: number;
  skippedCount: number;
  errors: string[];
  summary: string;
}

// ========== Constants ==========

const BATCH_SIZE = 5;
const TIMEOUT_MS = 45000;

// ========== Utility Functions ==========

// fetchWithTimeout is imported from @/lib/fetch-with-timeout

const extractSlipAmountFromBase64 = async (
  imageBase64: string,
  mimeType: string,
  slipType: "qtm" | "unc"
): Promise<{ amount: number; confidence?: number; warningMessage?: string | null }> => {
  const { data: { session } } = await supabase.auth.getSession();

  const optimized = await optimizeSlipImageForOcr(imageBase64, mimeType, false);

  const response = await fetchWithTimeout(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/finance-extract-slip-amount`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({
        imageBase64: optimized.imageBase64,
        mimeType: optimized.mimeType,
        slipType,
      }),
    },
    TIMEOUT_MS
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(getFinanceOcrBackendErrorMessage(result, false));
  }

  return {
    ...(result.data as { amount: number; confidence?: number }),
    warningMessage: getFinanceOcrBackendWarningMessage(result?.meta, false),
  };
};

const downloadBase64File = async (
  f: any,
  session: any,
  folderUrl: string
): Promise<string | null> => {
  const resp = await fetchWithTimeout(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({
        mode: "download_file",
        folderUrl,
        fileId: f.id,
        fileName: f.name,
        mimeType: f.mimeType || "image/jpeg",
      }),
    },
    TIMEOUT_MS
  );

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.file || null;
};

const getRootFolderUrl = async (): Promise<string> => {
  const envUrl = import.meta.env.VITE_GOOGLE_DRIVE_RECEIPTS_FOLDER;
  if (envUrl) return envUrl;

  try {
    const { data, error } = await (supabase as any)
      .from("app_settings")
      .select("value")
      .eq("key", "google_drive_receipts_folder")
      .single();

    if (error || !data?.value) {
      throw new Error("Root folder URL not configured");
    }

    return data.value;
  } catch (err) {
    throw new Error(`Failed to get root folder URL: ${err instanceof Error ? err.message : "Unknown error"}`);
  }
};

// ========== Hook Implementation ==========

export const useFolderScan = () => {
  const [isScanning, setIsScanning] = useState(false);
  const [reconcileProgress, setReconcileProgress] = useState<ScanProgress>({
    currentFile: "",
    processedCount: 0,
    totalCount: 0,
    skippedCount: 0,
    successCount: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const processBatch = useCallback(
    async (
      files: any[],
      folderUrl: string,
      session: any,
      signal: AbortSignal,
      warnings: string[]
    ): Promise<{ successCount: number; skippedCount: number; results: (any | null)[] }> => {
      const results: (any | null)[] = [];
      let successCount = 0;
      let skippedCount = 0;

      for (const file of files) {
        if (signal.aborted) break;

        try {
          setReconcileProgress((prev) => ({
            ...prev,
            currentFile: file.name,
          }));

          // Download file as base64
          const base64 = await downloadBase64File(file, session, folderUrl);
          if (!base64) {
            results.push(null);
            skippedCount++;
            continue;
          }

          // Determine slip type from file name
          const fileName = file.name.toLowerCase();
          const slipType: "qtm" | "unc" = fileName.includes("qtm") ? "qtm" : "unc";

          // Extract amount from image
          const extracted = await extractSlipAmountFromBase64(base64, file.mimeType || "image/jpeg", slipType);
          if (extracted.warningMessage && !warnings.includes(extracted.warningMessage)) {
            warnings.push(extracted.warningMessage);
          }

          // Prepare record for database
          const record = {
            file_id: file.id,
            file_name: file.name,
            folder_url: folderUrl,
            extracted_amount: extracted.amount,
            confidence: extracted.confidence || 0,
            slip_type: slipType,
            processed_at: new Date().toISOString(),
          };

          // Upsert to drive_file_index
          await (supabase as any)
            .from("drive_file_index")
            .upsert(record, { onConflict: "file_id" });

          results.push(record);
          successCount++;
        } catch (err) {
          console.error(`Error processing ${file.name}:`, err);
          results.push(null);
          skippedCount++;
        }

        setReconcileProgress((prev) => ({
          ...prev,
          processedCount: prev.processedCount + 1,
        }));
      }

      return { successCount, skippedCount, results };
    },
    []
  );

  const scanFolder = useCallback(
    async (slipType?: "qtm" | "unc"): Promise<ScanResult> => {
      if (isScanning) {
        return {
          success: false,
          processedCount: 0,
          successCount: 0,
          skippedCount: 0,
          errors: ["Scan already in progress"],
          summary: "Scan already in progress",
        };
      }

      setIsScanning(true);
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      const errors: string[] = [];
      const warnings: string[] = [];
      let processedCount = 0;
      let successCount = 0;
      let skippedCount = 0;

      try {
        // Get session
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          throw new Error("Not authenticated");
        }

        // Get root folder URL
        const folderUrl = await getRootFolderUrl();

        // Fetch list of files from drive
        const listResp = await fetchWithTimeout(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scan-drive-folder`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              mode: "list_files",
              folderUrl,
            }),
          },
          TIMEOUT_MS
        );

        if (!listResp.ok) {
          const err = await listResp.json().catch(() => ({}));
          throw new Error(err?.error || "Failed to list files");
        }

        const listData = await listResp.json();
        let files = listData.files || [];

        // Filter by slip type if specified
        if (slipType) {
          const slipTypeKeyword = slipType.toLowerCase();
          files = files.filter((f: any) => f.name.toLowerCase().includes(slipTypeKeyword));
        }

        if (files.length === 0) {
          return {
            success: true,
            processedCount: 0,
            successCount: 0,
            skippedCount: 0,
            errors: [],
            summary: "No files found to process",
          };
        }

        // Update progress totals
        setReconcileProgress((prev) => ({
          ...prev,
          totalCount: files.length,
        }));

        // Process files in batches
        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          if (signal.aborted) {
            errors.push("Scan cancelled by user");
            break;
          }

          const batch = files.slice(i, i + BATCH_SIZE);
          const { successCount: batchSuccess, skippedCount: batchSkipped, results } = await processBatch(
            batch,
            folderUrl,
            session,
            signal,
            warnings,
          );

          successCount += batchSuccess;
          skippedCount += batchSkipped;
          processedCount += batch.length;

          // Optionally upsert all successful records to ceo_daily_closing_declarations
          const validResults = results.filter((r) => r !== null);
          if (validResults.length > 0) {
            try {
              await (supabase as any)
                .from("ceo_daily_closing_declarations")
                .upsert(validResults, { onConflict: "file_id" });
            } catch (err) {
              console.error("Error upserting to ceo_daily_closing_declarations:", err);
              errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: Database upsert failed`);
            }
          }
        }

        const warningSummary = warnings.length > 0
          ? ` Warning: ${warnings.join(" | ")}`
          : "";
        return {
          success: errors.length === 0,
          processedCount,
          successCount,
          skippedCount,
          errors,
          summary: `Processed ${processedCount} files: ${successCount} successful, ${skippedCount} skipped${warningSummary}`,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        errors.push(errorMsg);
        return {
          success: false,
          processedCount,
          successCount,
          skippedCount,
          errors,
          summary: `Scan failed: ${errorMsg}`,
        };
      } finally {
        setIsScanning(false);
        abortControllerRef.current = null;
      }
    },
    [isScanning, processBatch]
  );

  const cancelScan = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  return {
    isScanning,
    progress: reconcileProgress,
    scanFolder,
    cancelScan,
  };
};
