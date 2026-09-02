import { ArrowLeft, Clock, Paperclip, ShieldAlert, UserRoundCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FacebookMessengerConversation, maskConversationFallback } from "@/hooks/useFacebookMessenger";

function formatRelativeTime(value?: string | null) {
  if (!value) return "Chưa có tin";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Không rõ thời gian";
  return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(date);
}

export function conversationName(conversation: FacebookMessengerConversation) {
  return conversation.customerDisplayName?.trim() || conversation.maskedCustomer?.trim() || maskConversationFallback(conversation.id);
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: FacebookMessengerConversation[];
  selectedId?: string | null;
  onSelect: (conversation: FacebookMessengerConversation) => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
        Chưa có hội thoại Facebook Messenger nào. Khi webhook đồng bộ, tin nhắn sẽ xuất hiện ở đây.
      </div>
    );
  }

  return (
    <div className="space-y-2" aria-label="Danh sách hội thoại Facebook Page">
      {conversations.map((conversation) => {
        const active = selectedId === conversation.id;
        const unread = conversation.unreadCount || 0;
        return (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation)}
            className={cn(
              "min-h-16 w-full rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-primary/40 hover:bg-accent/40 focus:outline-none focus:ring-2 focus:ring-primary/40",
              active && "border-primary bg-primary/5"
            )}
            aria-current={active ? "true" : undefined}
            aria-label={`Mở hội thoại ${conversationName(conversation)}`}
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
                {conversationName(conversation).slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{conversationName(conversation)}</span>
                  {unread > 0 && <Badge className="shrink-0 bg-blue-600">{unread}</Badge>}
                </div>
                <p className="line-clamp-2 break-words text-sm text-muted-foreground">
                  {conversation.lastMessagePreview || "Không có nội dung xem trước"}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatRelativeTime(conversation.lastMessageAt)}</span>
                  <span className="inline-flex items-center gap-1"><UserRoundCheck className="h-3 w-3" />{conversation.assignedTo || "Chưa phân công"}</span>
                  {(conversation.policyBadges || []).slice(0, 2).map((badge) => <Badge key={badge} variant="outline" className="text-[10px]">{badge}</Badge>)}
                  {conversation.replyWindowExpired && <Badge variant="destructive" className="text-[10px]">Hết cửa sổ trả lời</Badge>}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function MessageThread({ conversation, onBack }: { conversation: FacebookMessengerConversation | null; onBack: () => void }) {
  if (!conversation) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
        Chọn một hội thoại để xem chi tiết tin nhắn và trạng thái đối soát.
      </div>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card shadow-sm" aria-label={`Chi tiết hội thoại ${conversationName(conversation)}`}>
      <header className="flex min-w-0 items-center gap-3 border-b p-3 sm:p-4">
        <Button type="button" variant="ghost" size="sm" className="min-h-10 md:hidden" onClick={onBack} aria-label="Quay lại danh sách hội thoại">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{conversationName(conversation)}</h2>
          <p className="break-words text-xs text-muted-foreground">Đối soát: {conversation.manualReconciliationStatus || "Chưa có trạng thái"}</p>
        </div>
        {conversation.replyWindowExpired && <Badge variant="destructive" className="shrink-0">Hết hạn trả lời</Badge>}
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
        {(conversation.messages || []).length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa tải được tin nhắn cho hội thoại này.</div>
        ) : (
          conversation.messages?.map((message) => {
            const outbound = message.direction === "outbound";
            return (
              <article key={message.id} className={cn("flex", outbound ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[88%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%]", outbound ? "bg-blue-600 text-white" : "bg-muted text-foreground")}>
                  <p className="whitespace-pre-wrap break-words">{message.text || "[Tin nhắn không có văn bản]"}</p>
                  {(message.attachments || []).length > 0 && (
                    <div className="mt-2 space-y-1 rounded-lg border border-current/20 p-2 text-xs">
                      <div className="inline-flex items-center gap-1 font-medium"><Paperclip className="h-3 w-3" />Đính kèm metadata</div>
                      <p>Không tải URL đính kèm từ Facebook; chỉ hiển thị loại, tên và dung lượng nếu có.</p>
                      {message.attachments?.map((attachment, index) => (
                        <div key={attachment.id || index} className="break-words opacity-90">
                          {attachment.type || "file"} · {attachment.name || "không tên"} · {attachment.mimeType || "không rõ MIME"} · {attachment.sizeBytes ? `${attachment.sizeBytes} bytes` : "không rõ dung lượng"}
                        </div>
                      ))}
                    </div>
                  )}
                  <footer className={cn("mt-1 flex flex-wrap gap-2 text-[11px]", outbound ? "text-blue-50" : "text-muted-foreground")}>
                    <span>{formatRelativeTime(message.createdAt)}</span>
                    {outbound && <span>Nguồn echo: {message.echoSource || "server"}</span>}
                    {message.status && <span>{message.status}</span>}
                  </footer>
                </div>
              </article>
            );
          })
        )}
      </div>
      <div className="border-t bg-amber-50/60 p-3 text-xs text-amber-900">
        <span className="inline-flex items-start gap-2"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />Không optimistic sent state: tin nhắn chỉ xuất hiện sau khi server xác nhận và đồng bộ lại hộp thư.</span>
      </div>
    </section>
  );
}
