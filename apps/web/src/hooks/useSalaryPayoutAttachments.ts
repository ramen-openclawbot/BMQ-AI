/**
 * Mutations for salary payout supporting documents (chứng từ kèm theo).
 *
 * Everything goes through the salary-payout edge function with the service role
 * on the server side: 'attach', 'detach' and 'attachment_url'. The client never
 * touches the private 'salary-documents' bucket directly; it only receives
 * short-lived signed URLs. Zalo notices are never sent from these actions.
 *
 * Validation is shared with the pure src/lib/salary-attachments.ts module, and
 * every mutation invalidates the same react-query keys useSalaryPayout uses.
 */

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { SalaryPayoutClient, SalaryPayoutData } from "@/hooks/useSalaryPayout";
import {
  salaryAttachmentErrorText,
  validateSalaryAttachmentFiles,
  type SalaryPayoutAttachment,
} from "@/lib/salary-attachments";

const client = supabase as unknown as SalaryPayoutClient;

export interface SalaryAttachmentUploadInput {
  name: string;
  type: string;
  size: number;
  /** Base64 (optionally a data: URL) of the file content. */
  image_base64: string;
}

export interface SalaryAttachmentUploadResult {
  uploaded: SalaryPayoutAttachment[];
  failed: Array<{ fileName: string; message: string }>;
}

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown })?.message;
  return message === undefined ? String(error ?? "") : String(message);
};

/** Read the structured edge code from a functions.invoke error, if present. */
const attachmentErrorCode = async (error: unknown): Promise<string> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === "function") {
    try {
      const payload = await context.json() as { code?: string; error?: string };
      if (payload?.code || payload?.error) return String(payload.code || payload.error);
    } catch {
      // Fall through to the message heuristic.
    }
  }
  const message = messageOf(error);
  if (message.includes("insufficient_privilege")) return "insufficient_privilege";
  if (message.includes("payout_not_found")) return "payout_not_found";
  if (message.includes("attachment_not_found")) return "attachment_not_found";
  if (message.includes("payout_completed")) return "payout_completed";
  if (message.includes("unsupported_type")) return "unsupported_type";
  if (message.includes("file_too_large")) return "file_too_large";
  if (message.includes("too_many_attachments")) return "too_many_attachments";
  return "upload_failed";
};

export function useSalaryPayoutAttachments() {
  const queryClient = useQueryClient();

  /** Same keys useSalaryPayout owns, so the detail view refreshes. */
  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["salary-payout"] });
  }, [queryClient]);

  const uploadSalaryAttachments = useCallback(
    async (
      payoutId: string,
      files: SalaryAttachmentUploadInput[],
    ): Promise<SalaryAttachmentUploadResult> => {
      const safeFiles = Array.isArray(files) ? files : [];
      const uploaded: SalaryPayoutAttachment[] = [];
      const failed: Array<{ fileName: string; message: string }> = [];

      const cached = queryClient.getQueryData<SalaryPayoutData | null>(["salary-payout", payoutId]);
      const existingCount = cached?.attachments?.length ?? 0;

      const validation = validateSalaryAttachmentFiles(
        safeFiles.map((file) => ({ name: file.name, type: file.type, size: file.size })),
        existingCount,
      );
      for (const error of validation.errors) {
        failed.push({ fileName: error.fileName, message: error.message });
      }

      // Sequential: one 'attach' call per accepted file.
      for (const accepted of validation.accepted) {
        const source = safeFiles[accepted.index];
        if (!source) continue;
        try {
          const { data, error } = await client.functions.invoke("salary-payout", {
            body: {
              mode: "attach",
              payout_id: payoutId,
              image_base64: source.image_base64,
              mime_type: accepted.mime,
              file_name: accepted.name,
            },
          });
          if (error) throw error;
          const payload = data as { attachment?: SalaryPayoutAttachment };
          if (!payload?.attachment) throw new Error("upload_failed");
          uploaded.push(payload.attachment);
        } catch (error) {
          const code = await attachmentErrorCode(error);
          failed.push({ fileName: accepted.name, message: salaryAttachmentErrorText(code) });
        }
      }

      if (uploaded.length > 0 || failed.length > 0) invalidate();
      return { uploaded, failed };
    },
    [invalidate, queryClient],
  );

  const removeSalaryAttachment = useCallback(
    async (attachmentId: string) => {
      try {
        const { data, error } = await client.functions.invoke("salary-payout", {
          body: { mode: "detach", attachment_id: attachmentId },
        });
        if (error) throw error;
        const payload = data as { success?: boolean; id?: string; removed?: boolean };
        if (payload?.success !== true) throw new Error("attachment_delete_failed");
        invalidate();
        return payload;
      } catch (error) {
        const code = await attachmentErrorCode(error);
        throw new Error(salaryAttachmentErrorText(code));
      }
    },
    [invalidate],
  );

  const getSalaryAttachmentUrl = useCallback(async (attachmentId: string): Promise<string> => {
    const { data, error } = await client.functions.invoke("salary-payout", {
      body: { mode: "attachment_url", attachment_id: attachmentId },
    });
    if (error) throw error;
    const payload = data as { signed_url?: string };
    if (!payload?.signed_url) throw new Error(salaryAttachmentErrorText("signed_url_failed"));
    return payload.signed_url;
  }, []);

  return {
    uploadSalaryAttachments,
    removeSalaryAttachment,
    getSalaryAttachmentUrl,
  };
}
