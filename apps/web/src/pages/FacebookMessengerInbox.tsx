import { FormEvent, useMemo, useState } from "react";
import { AlertCircle, Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { ConversationList, MessageThread } from "@/components/facebook-messenger/FacebookMessengerPanels";
import { FacebookMessengerConversation, useFacebookMessengerInbox, useFacebookMessengerSend } from "@/hooks/useFacebookMessenger";
import { cn } from "@/lib/utils";

export default function FacebookMessengerInbox() {
  const { canEditModule } = useAuth();
  const canEdit = canEditModule("facebook_messenger");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [safeError, setSafeError] = useState<string | null>(null);
  const inbox = useFacebookMessengerInbox(selectedId);
  const sendMessage = useFacebookMessengerSend();
  const isSending = sendMessage.isPending;

  const conversations = useMemo(() => inbox.data?.conversations || [], [inbox.data?.conversations]);
  const selectedConversation = useMemo(() => {
    return inbox.data?.selectedConversation || conversations.find((item) => item.id === selectedId) || null;
  }, [conversations, inbox.data?.selectedConversation, selectedId]);

  const composerDisabled = !canEdit || !selectedConversation || selectedConversation.replyWindowExpired || isSending;
  const disabledReason = !selectedConversation
    ? "Chọn hội thoại trước khi trả lời."
    : !canEdit
      ? "Bạn chỉ có quyền xem module Facebook Page."
      : selectedConversation.replyWindowExpired
        ? "Cửa sổ trả lời Messenger đã hết hạn."
        : isSending
          ? "Đang gửi tin nhắn, vui lòng chờ."
          : "";

  const handleSelect = (conversation: FacebookMessengerConversation) => {
    setSelectedId(conversation.id);
    setMobileDetailOpen(true);
    setSafeError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSending) return;
    if (composerDisabled || !selectedConversation) return;
    setSafeError(null);
    try {
      await sendMessage.mutateAsync({
        conversationId: selectedConversation.id,
        threadId: selectedConversation.threadId || null,
        text: messageText,
      });
      setMessageText("");
    } catch (error) {
      setSafeError(error instanceof Error ? error.message : "Không gửi được tin nhắn. Vui lòng thử lại hoặc kiểm tra hàng đợi đối soát.");
    }
  };

  return (
    <main data-facebook-messenger-responsive="320-390-1440" className="min-h-[calc(100vh-4rem)] overflow-x-hidden bg-background p-3 sm:p-4 lg:p-6">
      <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4">
        <header className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight text-foreground sm:text-3xl">Quản lý Facebook Page</h1>
            <Badge variant={inbox.data?.enabled === false ? "destructive" : "secondary"}>
              {inbox.data?.enabled === false ? "Chưa bật tính năng" : "Messenger inbox"}
            </Badge>
          </div>
          <p className="max-w-3xl break-words text-sm text-muted-foreground">
            Xem hội thoại Messenger, trạng thái phân công, cửa sổ chính sách và gửi trả lời qua Edge Function đã xác thực. UI không nhận Page/PSID/provider status từ người dùng. Không tải URL đính kèm từ Facebook.
          </p>
        </header>

        {inbox.isLoading && (
          <Alert>
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertTitle>Đang tải hộp thư</AlertTitle>
            <AlertDescription>Đang gọi server function facebook-messenger-inbox bằng phiên đăng nhập hiện tại.</AlertDescription>
          </Alert>
        )}

        {(inbox.isError || safeError) && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Không thể đồng bộ hộp thư</AlertTitle>
            <AlertDescription className="break-words">
              {safeError || (inbox.error instanceof Error ? inbox.error.message : "Lỗi an toàn đã được ghi nhận. Vui lòng thử tải lại.")}
            </AlertDescription>
          </Alert>
        )}

        {inbox.data?.enabled === false && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Tính năng Facebook Messenger đang tắt</AlertTitle>
            <AlertDescription>Thiết lập Page token/webhook cần hoàn tất ở server trước khi nhân viên trả lời khách.</AlertDescription>
          </Alert>
        )}

        <section className="grid min-w-0 gap-4 lg:min-h-[680px] lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]" aria-label="Facebook Messenger inbox">
          <aside className={cn("min-w-0 space-y-3", mobileDetailOpen && "hidden md:block")}>
            <p className="md:hidden rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Chọn một hội thoại để mở chi tiết trên màn hình nhỏ.</p>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Hội thoại</h2>
                <p className="text-xs text-muted-foreground">{conversations.length} luồng đang hiển thị</p>
              </div>
              <Button type="button" variant="outline" size="sm" className="min-h-10 shrink-0" onClick={() => inbox.refetch()} disabled={inbox.isFetching} aria-label="Tải lại hội thoại Facebook">
                <RefreshCw className={cn("h-4 w-4", inbox.isFetching && "animate-spin")} />
              </Button>
            </div>
            <ConversationList conversations={conversations} selectedId={selectedId} onSelect={handleSelect} />
          </aside>

          <div className={cn("min-w-0 flex-col gap-3 md:flex", !mobileDetailOpen && "hidden md:flex")}>
            <MessageThread conversation={selectedConversation} onBack={() => setMobileDetailOpen(false)} />
            <form onSubmit={handleSubmit} className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4" aria-label="Soạn trả lời Messenger">
              <label htmlFor="facebook-messenger-composer" className="text-sm font-medium">Nội dung trả lời</label>
              <Textarea
                id="facebook-messenger-composer"
                value={messageText}
                onChange={(event) => setMessageText(event.target.value.slice(0, 2000))}
                disabled={composerDisabled}
                placeholder={disabledReason || "Nhập phản hồi Messenger..."}
                className="mt-2 min-h-24 resize-y break-words"
                aria-describedby="facebook-messenger-composer-help"
              />
              <div id="facebook-messenger-composer-help" className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 break-words">{disabledReason || "Tối đa 2.000 ký tự. Gửi qua server, không hiển thị optimistic state."}</span>
                <span>{messageText.trim().length}/2000</span>
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="submit" disabled={composerDisabled} className="min-h-11 min-w-28">
                  {isSending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {isSending ? "Đang gửi" : "Gửi"}
                </Button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
