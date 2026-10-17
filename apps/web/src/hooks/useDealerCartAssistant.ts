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

/**
 * Calls the dealer-cart-assistant edge function with the dealer session token.
 * No UI is wired yet; the portal chat will consume send/reply/proposal later.
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
  ): Promise<DealerCartAssistantResponse | null> => {
    if (!dealerToken) {
      setError("Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.");
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await callEdgeFunction<DealerCartAssistantResponse>("dealer-cart-assistant", {
        dealer_token: dealerToken,
        message,
        history: options.history || [],
        cart,
        ...(options.mode ? { mode: options.mode } : {}),
      });

      if (result.error || !result.data?.success) {
        const quota = isAiQuotaError({ code: result.code, error: result.error });
        setError(quota ? AI_QUOTA_MESSAGE : (result.error || "Không gọi được trợ lý giỏ hàng."));
        setReply("");
        setProposal(null);
        setWarnings([]);
        return null;
      }

      const data = result.data;
      setReply(data.reply || "");
      setProposal(data.proposal || null);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      return data;
    } catch (err) {
      setError(isAiQuotaError(err) ? AI_QUOTA_MESSAGE : (err instanceof Error ? err.message : "Không gọi được trợ lý giỏ hàng."));
      return null;
    } finally {
      setLoading(false);
    }
  }, [dealerToken]);

  return { send, reply, proposal, warnings, loading, error };
}
