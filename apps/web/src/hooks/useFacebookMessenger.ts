import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/supabase-helpers";

export type FacebookMessengerErrorCode = "session_expired" | "empty_message" | "request_failed";

export class FacebookMessengerUiError extends Error {
  code: FacebookMessengerErrorCode;

  constructor(code: FacebookMessengerErrorCode) {
    super(code);
    this.name = "FacebookMessengerUiError";
    this.code = code;
  }
}

export type FacebookMessengerAttachment = {
  id?: string;
  name?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  type?: string | null;
};

export type FacebookMessengerMessage = {
  id: string;
  direction: "inbound" | "outbound";
  text?: string | null;
  createdAt: string;
  echoSource?: string | null;
  status?: string | null;
  attachments?: FacebookMessengerAttachment[];
};

export type FacebookMessengerConversation = {
  id: string;
  customerDisplayName?: string | null;
  maskedCustomer?: string | null;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
  unreadCount?: number;
  assignedTo?: string | null;
  policyBadges?: string[];
  replyWindowExpired?: boolean;
  replyBlocked?: boolean;
  manualReconciliationStatus?: string | null;
  reconciliationStatus?: string | null;
  messages?: FacebookMessengerMessage[];
};

type InboxResponse = {
  enabled?: boolean;
  conversations?: FacebookMessengerConversation[];
  selectedConversation?: FacebookMessengerConversation | null;
  reconciliationStatus?: string | null;
};

async function invokeMessengerFunction<T>(name: "facebook-messenger-inbox" | "facebook-messenger-send", body: Record<string, unknown>): Promise<T> {
  let accessToken: string;

  try {
    accessToken = await getFreshAccessToken();
  } catch {
    throw new FacebookMessengerUiError("session_expired");
  }

  const { data, error } = await supabase.functions.invoke<T>(name, {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (error) throw new FacebookMessengerUiError("request_failed");
  return data as T;
}

export function maskConversationFallback(id: string) {
  const clean = String(id || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!clean) return "Khách Facebook ẩn danh";
  return `Khách Facebook •••${clean.slice(-4)}`;
}

export function useFacebookMessengerInbox(selectedConversationId?: string | null) {
  return useQuery({
    queryKey: ["facebook-messenger-inbox", selectedConversationId || null],
    queryFn: () => invokeMessengerFunction<InboxResponse>("facebook-messenger-inbox", {
      action: selectedConversationId ? "read" : "list",
      conversation_id: selectedConversationId || undefined,
    }),
    staleTime: 30_000,
  });
}

export function useFacebookMessengerSend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ conversationId, text, idempotencyKey }: { conversationId: string; text: string; idempotencyKey: string }) => {
      const boundedText = text.trim().slice(0, 2000);
      if (!boundedText) throw new FacebookMessengerUiError("empty_message");
      return invokeMessengerFunction("facebook-messenger-send", {
        conversation_id: conversationId,
        text: boundedText,
        idempotency_key: idempotencyKey,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["facebook-messenger-inbox"] });
    },
  });
}



export type MessengerComposeIdempotencyState = { conversationId: string; draft: string; key: string } | null;

export function getMessengerComposeIdempotencyKey(
  state: MessengerComposeIdempotencyState,
  conversationId: string,
  draft: string,
  nextKey: () => string = buildMessengerIdempotencyKey,
): { key: string; state: NonNullable<MessengerComposeIdempotencyState> } {
  const normalizedDraft = draft.trim().slice(0, 2000);
  if (state && state.conversationId === conversationId && state.draft === normalizedDraft) {
    return { key: state.key, state };
  }
  const key = nextKey();
  return { key, state: { conversationId, draft: normalizedDraft, key } };
}

export function buildMessengerIdempotencyKey() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random()}`.replace(/[^A-Za-z0-9]/g, "");
  return `ui:${random}`.slice(0, 128).padEnd(32, "0");
}
