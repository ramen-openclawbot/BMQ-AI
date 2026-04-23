import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { getFinanceOcrBackendErrorMessage, getFinanceOcrBackendWarningMessage } from "@/lib/finance-ocr.js";
import { normalizeUploadImage, optimizeSlipImageForOcr } from "@/lib/slip-image";

/**
 * Extract result shape from finance-extract-slip-amount edge function.
 */
export interface ExtractResult {
  amount: number;
  confidence?: number;
  transfer_date?: string;
  reference?: string;
  amount_raw?: string;
}

/**
 * Declaration form state shape — all the data needed for a daily declaration.
 */
export interface DeclarationFormState {
  uncTotalDeclared: number;
  cashFundTopupAmount: number;
  qtmOpeningBalance: number;
  qtmSpentFromFolder: number;
  qtmClosingBalance: number;
  notes: string;
  ceoDeclarationLocked: boolean;
  closeDecision: "reject" | "conditional" | "approve";
  closeApprovalLocked: boolean;
  closeReason: string;
  qtmLowConfidenceCount: number;
  reconciliationAuditLogs: Array<{
    at: string;
    actor: string;
    action: string;
    detail?: string | null;
  }>;
}

/**
 * Pending extraction state — store uploaded images and extracted data until save.
 */
export interface PendingExtractionsState {
  qtmImagesBase64: string[];
  uncImagesBase64: string[];
  qtmExtractedList: ExtractResult[];
  uncExtractedList: ExtractResult[];
}

/**
 * Declaration images — loaded lazily from extraction_meta.
 */
export interface DeclarationImages {
  qtmImages: string[];
  uncImages: string[];
}

/**
 * Hook for managing daily CEO declaration form state and operations.
 *
 * Responsibilities:
 * - Load declaration data for a given closing date
 * - Track pending extractions (images + extract results) before save
 * - Save declaration with auto-merge of pending extractions into extraction_meta
 * - Auto-save after processSlipUpload with silent: true
 * - Save reconciliation workflow metadata (lock status, audit logs)
 * - Extract amounts from uploaded slip images via edge function
 *
 * @param closingDate The date for the declaration (ISO string or Date)
 * @returns Object with all form state, loaders, and mutations
 */
export function useDeclarationForm(closingDate: Date | string) {
  const queryClient = useQueryClient();
  const dateKey = typeof closingDate === "string" ? closingDate : closingDate.toISOString().split("T")[0];

  // ─────────────────────────────────────────────────────────────────────────
  // Local form state
  // ─────────────────────────────────────────────────────────────────────────
  const [formState, setFormState] = useState<DeclarationFormState>({
    uncTotalDeclared: 0,
    cashFundTopupAmount: 0,
    qtmOpeningBalance: 0,
    qtmSpentFromFolder: 0,
    qtmClosingBalance: 0,
    notes: "",
    ceoDeclarationLocked: false,
    closeDecision: "reject",
    closeApprovalLocked: false,
    closeReason: "",
    qtmLowConfidenceCount: 0,
    reconciliationAuditLogs: [],
  });

  const [pendingExtractions, setPendingExtractions] = useState<PendingExtractionsState>({
    qtmImagesBase64: [],
    uncImagesBase64: [],
    qtmExtractedList: [],
    uncExtractedList: [],
  });

  const [isSaving, setIsSaving] = useState(false);
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch declaration data
  // ─────────────────────────────────────────────────────────────────────────
  const { data: declaration, isLoading: declLoading, isFetching: declFetching } = useQuery({
    queryKey: ["daily-declaration", dateKey],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select(
          "closing_date,unc_total_declared,unc_extracted_amount,cash_fund_topup_amount,qtm_extracted_amount,notes,extraction_meta"
        )
        .eq("closing_date", dateKey)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lazy-load images (only when explicitly requested)
  // ─────────────────────────────────────────────────────────────────────────
  const [imagesRequested, setImagesRequested] = useState(false);

  const { data: declarationImages } = useQuery({
    queryKey: ["daily-declaration-images", dateKey],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("qtm_slip_image_base64,unc_slip_image_base64,extraction_meta")
        .eq("closing_date", dateKey)
        .maybeSingle();

      if (error) throw error;
      if (!data) return { qtmImages: [] as string[], uncImages: [] as string[] };

      const qtmImages: string[] = Array.isArray(data.extraction_meta?.qtm_images)
        ? data.extraction_meta.qtm_images
        : data.qtm_slip_image_base64
          ? [data.qtm_slip_image_base64]
          : [];

      const uncImages: string[] = Array.isArray(data.extraction_meta?.unc_images)
        ? data.extraction_meta.unc_images
        : data.unc_slip_image_base64
          ? [data.unc_slip_image_base64]
          : [];

      return { qtmImages, uncImages };
    },
    enabled: imagesRequested,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize form state from loaded declaration
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Guard against transient empty state while query is loading/refetching
    if (declaration === undefined || declLoading || declFetching) return;

    if (declaration) {
      const meta = declaration.extraction_meta || {};
      setFormState({
        uncTotalDeclared: Number(declaration.unc_extracted_amount ?? declaration.unc_total_declared ?? 0),
        cashFundTopupAmount: Number(declaration.qtm_extracted_amount ?? declaration.cash_fund_topup_amount ?? 0),
        qtmOpeningBalance: Number(meta.qtm_opening_balance ?? 0),
        qtmSpentFromFolder: Number(meta.qtm_spent_from_folder ?? 0),
        qtmClosingBalance: Number(meta.qtm_closing_balance ?? 0),
        notes: String(declaration.notes ?? ""),
        ceoDeclarationLocked: Boolean(meta.ceo_declaration_locked),
        closeDecision: (meta.close_decision as any) ?? "reject",
        closeApprovalLocked: Boolean(meta.close_approval_locked),
        closeReason: String(meta.close_reason ?? ""),
        qtmLowConfidenceCount: Number(meta.qtm_low_confidence_count ?? 0),
        reconciliationAuditLogs: Array.isArray(meta.reconciliation_audit_logs)
          ? meta.reconciliation_audit_logs
          : [],
      });
    } else {
      // Reset to defaults for new declaration
      setFormState({
        uncTotalDeclared: 0,
        cashFundTopupAmount: 0,
        qtmOpeningBalance: 0,
        qtmSpentFromFolder: 0,
        qtmClosingBalance: 0,
        notes: "",
        ceoDeclarationLocked: false,
        closeDecision: "reject",
        closeApprovalLocked: false,
        closeReason: "",
        qtmLowConfidenceCount: 0,
        reconciliationAuditLogs: [],
      });
    }

    // Clear pending extractions when date changes
    setPendingExtractions({
      qtmImagesBase64: [],
      uncImagesBase64: [],
      qtmExtractedList: [],
      uncExtractedList: [],
    });
    setImagesRequested(false);
  }, [declaration, declLoading, declFetching]);

  // ─────────────────────────────────────────────────────────────────────────
  // Update individual form fields
  // ─────────────────────────────────────────────────────────────────────────
  const updateFormField = <K extends keyof DeclarationFormState>(
    field: K,
    value: DeclarationFormState[K]
  ) => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  const updateAuditLogs = (logs: Array<{ at: string; actor: string; action: string; detail?: string | null }>) => {
    setFormState((prev) => ({ ...prev, reconciliationAuditLogs: logs }));
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Extract amount from slip image via edge function
  // ─────────────────────────────────────────────────────────────────────────
  const extractSlipAmountFromBase64 = async (
    imageBase64: string,
    mimeType: string,
    slipType: "qtm" | "unc"
  ): Promise<ExtractResult> => {
    const { data: { session } } = await supabase.auth.getSession();

    const callExtract = async (aggressive: boolean): Promise<ExtractResult> => {
      const optimized = await optimizeSlipImageForOcr(imageBase64, mimeType, aggressive);
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
        45000
      );

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(getFinanceOcrBackendErrorMessage(result, true));
      }

      const warning = getFinanceOcrBackendWarningMessage(result?.meta, true);
      if (warning) {
        setExtractionError(warning);
      }

      return result.data as ExtractResult;
    };

    try {
      return await callExtract(false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      const isTimeout =
        msg.includes("AbortError") ||
        msg.toLowerCase().includes("aborted") ||
        msg.toLowerCase().includes("timeout");

      if (!isTimeout) throw error;

      // Retry with stronger compression
      try {
        return await callExtract(true);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError || "");
        const stillTimeout =
          retryMsg.includes("AbortError") ||
          retryMsg.toLowerCase().includes("aborted") ||
          retryMsg.toLowerCase().includes("timeout");

        if (stillTimeout) {
          throw new Error(getFinanceOcrBackendErrorMessage({ code: "OCR_BACKEND_TIMEOUT" }, true));
        }

        throw retryError;
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Process slip upload: extract from files, add to pending state
  // ─────────────────────────────────────────────────────────────────────────
  const processSlipUpload = async (
    slipType: "qtm" | "unc",
    files: File[]
  ): Promise<{ success: boolean; totalAmount: number; count: number }> => {
    if (!files.length) return { success: true, totalAmount: 0, count: 0 };

    setExtractionError(null);

    try {
      const batchResults: Array<{
        imageBase64: string;
        extracted: ExtractResult;
        file: File;
      }> = [];

      for (const file of files) {
        const normalized = await normalizeUploadImage(file);
        const extracted = await extractSlipAmountFromBase64(
          normalized.imageBase64,
          normalized.mimeType,
          slipType
        );
        batchResults.push({ imageBase64: normalized.imageBase64, extracted, file });
      }

      const batchSum = batchResults.reduce((sum, r) => sum + Number(r.extracted?.amount || 0), 0);
      const batchImages = batchResults.map((r) => r.imageBase64);
      const batchExtracted = batchResults.map((r) => r.extracted);

      // Add to pending state
      setPendingExtractions((prev) => {
        if (slipType === "qtm") {
          return {
            ...prev,
            qtmImagesBase64: [...prev.qtmImagesBase64, ...batchImages],
            qtmExtractedList: [...prev.qtmExtractedList, ...batchExtracted],
          };
        } else {
          return {
            ...prev,
            uncImagesBase64: [...prev.uncImagesBase64, ...batchImages],
            uncExtractedList: [...prev.uncExtractedList, ...batchExtracted],
          };
        }
      });

      // Update form total
      updateFormField(
        slipType === "qtm" ? "cashFundTopupAmount" : "uncTotalDeclared",
        (formState[slipType === "qtm" ? "cashFundTopupAmount" : "uncTotalDeclared"] || 0) + batchSum
      );

      // Auto-save with silent: true
      await saveDeclaration(true);

      return { success: true, totalAmount: batchSum, count: batchResults.length };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      setExtractionError(msg);
      return { success: false, totalAmount: 0, count: 0 };
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Save declaration with pending extractions merged into extraction_meta
  // ─────────────────────────────────────────────────────────────────────────
  const saveDeclaration = async (silent = false): Promise<boolean> => {
    setIsSaving(true);
    try {
      // Fetch latest to avoid clobbering concurrent edits
      const { data: latestDecl } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .select("*")
        .eq("closing_date", dateKey)
        .maybeSingle();

      const sourceDecl = latestDecl || declaration;

      // Merge existing and pending images
      const existingQtmImages = Array.isArray(sourceDecl?.extraction_meta?.qtm_images)
        ? sourceDecl.extraction_meta.qtm_images
        : sourceDecl?.qtm_slip_image_base64
          ? [sourceDecl.qtm_slip_image_base64]
          : [];

      const existingUncImages = Array.isArray(sourceDecl?.extraction_meta?.unc_images)
        ? sourceDecl.extraction_meta.unc_images
        : sourceDecl?.unc_slip_image_base64
          ? [sourceDecl.unc_slip_image_base64]
          : [];

      const finalQtmImages = [...existingQtmImages, ...pendingExtractions.qtmImagesBase64];
      const finalUncImages = [...existingUncImages, ...pendingExtractions.uncImagesBase64];

      const payload = {
        closing_date: dateKey,
        unc_total_declared: Number(formState.uncTotalDeclared || 0),
        unc_extracted_amount: Number(formState.uncTotalDeclared || 0),
        cash_fund_topup_amount: Number(formState.cashFundTopupAmount || 0),
        qtm_extracted_amount: Number(formState.cashFundTopupAmount || 0),
        // Keep legacy columns for backward compatibility
        qtm_slip_image_base64: finalQtmImages[0] || null,
        unc_slip_image_base64: finalUncImages[0] || null,
        notes: formState.notes || null,
        extraction_meta: {
          ...(sourceDecl?.extraction_meta || {}),
          qtm_images: finalQtmImages,
          unc_images: finalUncImages,
          qtm_items: [
            ...((sourceDecl?.extraction_meta?.qtm_items as any[]) || []),
            ...pendingExtractions.qtmExtractedList,
          ],
          unc_items: [
            ...((sourceDecl?.extraction_meta?.unc_items as any[]) || []),
            ...pendingExtractions.uncExtractedList,
          ],
          ceo_declaration_locked: formState.ceoDeclarationLocked,
          close_decision: formState.closeDecision,
          close_approval_locked: formState.closeApprovalLocked,
          close_reason: formState.closeReason || null,
          reconciliation_audit_logs: formState.reconciliationAuditLogs,
          qtm_opening_balance: Number(formState.qtmOpeningBalance || 0),
          qtm_spent_from_folder: Number(formState.qtmSpentFromFolder || 0),
          qtm_closing_balance: Number(formState.qtmClosingBalance || 0),
          qtm_low_confidence_count: Number(formState.qtmLowConfidenceCount || 0),
        },
      };

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(payload, { onConflict: "closing_date" });

      if (error) throw error;

      // Clear pending state
      setPendingExtractions({
        qtmImagesBase64: [],
        uncImagesBase64: [],
        qtmExtractedList: [],
        uncExtractedList: [],
      });

      // Refetch to sync local state
      queryClient.invalidateQueries({ queryKey: ["daily-declaration", dateKey] });

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      if (!silent) {
        setExtractionError(msg);
      }
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Save reconciliation workflow metadata (lock, audit logs)
  // ─────────────────────────────────────────────────────────────────────────
  const saveReconciliationWorkflowMeta = async (
    decisionOverride?: "reject" | "conditional" | "approve",
    lockOverride?: boolean,
    actionOverride?: string
  ): Promise<boolean> => {
    try {
      const decision = decisionOverride || formState.closeDecision;

      const nextLog = {
        at: new Date().toISOString(),
        actor: "CEO",
        action:
          actionOverride ||
          (decision === "reject"
            ? "reject_close"
            : decision === "conditional"
              ? "conditional_close"
              : "approve_close"),
        detail: formState.closeReason || null,
      };

      const mergedLogs = [...formState.reconciliationAuditLogs, nextLog];

      const { error } = await (supabase as any)
        .from("ceo_daily_closing_declarations")
        .upsert(
          {
            closing_date: dateKey,
            extraction_meta: {
              ...(declaration?.extraction_meta || {}),
              close_decision: decision,
              close_approval_locked:
                lockOverride ?? (decision === "approve" ? true : formState.closeApprovalLocked),
              close_reason: formState.closeReason || null,
              reconciliation_audit_logs: mergedLogs,
              ceo_declaration_locked: formState.ceoDeclarationLocked,
              qtm_opening_balance: Number(formState.qtmOpeningBalance || 0),
              qtm_spent_from_folder: Number(formState.qtmSpentFromFolder || 0),
              qtm_closing_balance: Number(formState.qtmClosingBalance || 0),
              qtm_low_confidence_count: Number(formState.qtmLowConfidenceCount || 0),
            },
          },
          { onConflict: "closing_date" }
        );

      if (error) throw error;

      updateAuditLogs(mergedLogs);
      updateFormField(
        "closeApprovalLocked",
        lockOverride ?? (decision === "approve" ? true : formState.closeApprovalLocked)
      );

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error || "");
      setExtractionError(msg);
      return false;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Request lazy image loading
  // ─────────────────────────────────────────────────────────────────────────
  const loadImages = () => {
    setImagesRequested(true);
  };

  return {
    // Form state
    formState,
    updateFormField,
    updateAuditLogs,

    // Pending extractions
    pendingExtractions,
    clearPendingExtractions: () =>
      setPendingExtractions({
        qtmImagesBase64: [],
        uncImagesBase64: [],
        qtmExtractedList: [],
        uncExtractedList: [],
      }),

    // Declaration data
    declaration,
    declarationImages: declarationImages || { qtmImages: [], uncImages: [] },
    loadImages,

    // Loaders
    isLoading: declLoading,
    isFetching: declFetching,
    isSaving,
    hasError: !!extractionError,
    errorMessage: extractionError,

    // Operations
    processSlipUpload,
    saveDeclaration,
    saveReconciliationWorkflowMeta,
  };
}
