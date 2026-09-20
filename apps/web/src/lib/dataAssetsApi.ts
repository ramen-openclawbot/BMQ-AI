// Thin client for the owner-only vnagent-data-admin edge function.

import type { ZodType } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { readAnalyticsError } from "@/lib/bmqAnalytics";
import { errorResponseSchema, isUncertainMutationStatus, type Language } from "@/lib/dataAssets";

export const DATA_ADMIN_FUNCTION = "vnagent-data-admin";

/** Classified request failure so callers can tell a definitive rejection from an uncertain outcome. */
export class DataAdminRequestError extends Error {
  readonly code: string;
  readonly status: number;
  /** True when the server may or may not have applied a mutation. */
  readonly uncertain: boolean;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "DataAdminRequestError";
    this.code = code;
    this.status = status;
    this.uncertain = isUncertainMutationStatus(status);
  }
}

function invalidResponse(language: Language): string {
  return language === "en"
    ? "The data admin returned an invalid response. Please retry."
    : "Phản hồi từ trang quản trị dữ liệu chưa hợp lệ. Vui lòng thử lại.";
}

function statusOf(error: unknown): number {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) return context.status;
  if (context && typeof context === "object" && typeof (context as { status?: unknown }).status === "number") {
    return (context as { status: number }).status;
  }
  // No HTTP response at all: a network/transport failure is uncertain.
  return 0;
}

/** Invoke the data admin and validate the response shape before trusting it. */
export async function invokeDataAdmin<T>(body: Record<string, unknown>, schema: ZodType<T>, language: Language): Promise<T> {
  let response: { data: unknown; error: unknown };
  try {
    response = await supabase.functions.invoke(DATA_ADMIN_FUNCTION, {
      body: { ...body, language },
      headers: { "Accept-Language": language },
    });
  } catch (caught) {
    // The request never produced an HTTP status: the mutation outcome is unknown.
    throw new DataAdminRequestError(caught instanceof Error ? caught.message : "network", "network", 0);
  }
  const { data, error } = response;
  if (error) {
    const status = statusOf(error);
    const message = await readAnalyticsError(error, language);
    const failure = errorResponseSchema.safeParse(data);
    throw new DataAdminRequestError(message, failure.success ? failure.data.code : "request_failed", status);
  }
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  const failure = errorResponseSchema.safeParse(data);
  if (failure.success) throw new DataAdminRequestError(failure.data.error, failure.data.code, 400);
  throw new DataAdminRequestError(invalidResponse(language), "invalid_response", 502);
}
