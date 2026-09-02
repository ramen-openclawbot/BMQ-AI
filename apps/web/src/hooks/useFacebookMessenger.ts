import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
  threadId?: string | null;
  customerDisplayName?: string | null;
  maskedCustomer?: string | null;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
  unreadCount?: number;
  assignedTo?: string | null;
  policyBadges?: string[];
  replyWindowExpired?: boolean;
  manualReconciliationStatus?: string | null;
  messages?: FacebookMessengerMessage[];
};

type InboxResponse = {
  enabled?: boolean;
  conversations?: FacebookMessengerConversation[];
  selectedConversation?: FacebookMessengerConversation | null;
  reconciliationStatus?: string | null;
};

async function invokeMessengerFunction<T>(name: "facebook-messenger-inbox" | "facebook-messenger-send", body: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");

  const { data, error } = await supabase.functions.invoke<T>(name, {
    body,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

  if (error) throw new Error(error.message || "Không thể kết nối hộp thư Facebook Page.");
  return data as T;
}

function makeAttemptId(conversationId: string) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `fb-msg-${conversationId}-${Date.now()}-${nonce}`;
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
      conversationId: selectedConversationId || null,
    }),
    staleTime: 30_000,
  });
}

export function useFacebookMessengerSend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ conversationId, threadId, text }: { conversationId: string; threadId?: string | null; text: string }) => {
      const boundedText = text.trim().slice(0, 2000);
      if (!boundedText) throw new Error("Nhập nội dung tin nhắn trước khi gửi.");
      const attemptId = makeAttemptId(conversationId);
      return invokeMessengerFunction("facebook-messenger-send", {
        conversationId,
        threadId: threadId || null,
        text: boundedText,
        idempotencyKey: attemptId,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["facebook-messenger-inbox"] });
    },
  });
}
