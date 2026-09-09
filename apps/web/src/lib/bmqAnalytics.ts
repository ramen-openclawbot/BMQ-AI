import { z } from "zod";
export type AnalyticsCitation = { id: string; title: string; source: string; updated_at: string };
export type AnalyticsMessage = { id: string; role: "user" | "assistant"; text: string; citations?: AnalyticsCitation[] };
const analyticsResponse = z.object({
  answer: z.string().trim().min(1), requestId: z.string().min(1),
  provenance: z.object({ lane: z.string(), model: z.string().nullable(), queries: z.array(z.unknown()), citations: z.array(z.object({ id: z.string(), title: z.string(), source: z.string(), updated_at: z.string() })).optional(), elapsedMs: z.number().finite().nonnegative() }),
});
export function buildAnalyticsRequest(question: string, route: string, label: string, history: AnalyticsMessage[], filters: Record<string, string> = {}, language: "en" | "vi" = "vi") {
  return { language, question: question.trim(), page: { route, label, filters }, history: history.slice(-6).map(({ role, text }) => ({ role, text: text.slice(0, 2000) })) };
}
export function parseAnalyticsResponse(data: unknown, language: "en" | "vi" = "vi") {
  const result = analyticsResponse.safeParse(data);
  if (!result.success) throw new Error(language === "en" ? "Invalid BMQ response. Please retry." : "Phản hồi BMQ chưa hợp lệ. Vui lòng thử lại.");
  return { ...result.data, provenance: { ...result.data.provenance, citations: result.data.provenance.citations as AnalyticsCitation[] | undefined } };
}


export async function readAnalyticsError(error: unknown, language: "en" | "vi" = "vi"): Promise<string> {
  const fallback = language === "en" ? "Could not send your question to BMQ. Please retry." : "Chưa gửi được câu hỏi tới BMQ. Vui lòng thử lại.";
  if (!error || typeof error !== "object" || !("context" in error) || !(error.context instanceof Response)) return fallback;
  try {
    const body: unknown = await error.context.clone().json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      const message = body.error.replace(/\p{Cc}/gu, " ").trim().slice(0, 500);
      if (message) return message;
    }
  } catch { /* Invalid HTTP bodies must not hide the retry guidance. */ }
  return fallback;
}
