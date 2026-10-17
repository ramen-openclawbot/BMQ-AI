import { useCallback, useState } from "react";

import { AI_QUOTA_MESSAGE, isAiQuotaError } from "@/lib/ai-errors";
import type {
  DealerCartMode,
  DealerCartProposal,
} from "@/lib/dealer-cart-assistant";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";

export type DealerCartAssistantHistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

export type DealerCartAssistantSendOptions = {
  history?: DealerCartAssistantHistoryTurn[];
  mode?: DealerCartMode;
};

export type DealerCartAssistantResponse = {
  success?: boolean;
  reply?: string;
  proposal?: DealerCartProposal | null;
  warnings?: string[];
  error?: string;
  code?: string;
};

export type DealerCartAssistantResult =
  | { ok: true; data: DealerCartAssistantResponse }
  | { ok: false; error: string; sessionExpired: boolean };

const ASSISTANT_TIMEOUT_MS = 30000;

/**
 * Calls the dealer-cart-assistant edge function with the dealer session token.
 * The assistant only proposes lines; the dealer still taps to send the order.
 */
export function useDealerCartAssistant(dealerToken: string | null | undefined) {
  const [reply, setReply] = useState("");
  const [proposal, setProposal] = useState<DealerCartProposal | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (
    message: string,
    cart: Record<string, number>,
    options: DealerCartAssistantSendOptions = {},
  ): Promise<DealerCartAssistantResult> => {
    const fail = (text: string, sessionExpired = false): DealerCartAssistantResult => {
      setError(text);
      setReply("");
      setProposal(null);
      setWarnings([]);
      return { ok: false, error: text, sessionExpired };
    };

    if (!dealerToken) return fail("Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.", true);

    setLoading(true);
    setError(null);

    try {
      const result = await callEdgeFunction<DealerCartAssistantResponse>("dealer-cart-assistant", {
        dealer_token: dealerToken,
        message,
        history: options.history || [],
        cart,
        ...(options.mode ? { mode: options.mode } : {}),
      }, undefined, ASSISTANT_TIMEOUT_MS);

      if (result.isSessionExpired) return fail(result.error || "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.", true);
      if (result.error || !result.data?.success) {
        const quota = isAiQuotaError({ code: result.code, error: result.error });
        return fail(quota ? AI_QUOTA_MESSAGE : (result.error || result.data?.error || "Không gọi được trợ lý đặt hàng."));
      }

      const data = result.data;
      setReply(data.reply || "");
      setProposal(data.proposal || null);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      return { ok: true, data };
    } catch (err) {
      return fail(isAiQuotaError(err) ? AI_QUOTA_MESSAGE : (err instanceof Error ? err.message : "Không gọi được trợ lý đặt hàng."));
    } finally {
      setLoading(false);
    }
  }, [dealerToken]);

  return { send, reply, proposal, warnings, loading, error };
}
