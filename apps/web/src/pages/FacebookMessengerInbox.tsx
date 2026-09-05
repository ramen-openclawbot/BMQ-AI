import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Link2, Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { ConversationList, MessageThread } from "@/components/facebook-messenger/FacebookMessengerPanels";
import { FacebookPageConnectUiError, useFacebookPageCandidateFinalize, useFacebookPageConnect, useFacebookPageConnectionStatus } from "@/hooks/useFacebookPageConnection";
import { FacebookMessengerConversation, FacebookMessengerUiError, getMessengerComposeIdempotencyKey, useFacebookMessengerInbox, useFacebookMessengerSend } from "@/hooks/useFacebookMessenger";
import { cn } from "@/lib/utils";

const MESSENGER_ERROR_MESSAGES = {
  session_expired: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  empty_message: "Nhập nội dung tin nhắn trước khi gửi.",
  request_failed: "Không thể hoàn tất thao tác Facebook Messenger. Vui lòng thử lại hoặc báo quản trị viên.",
} as const;

function mapMessengerErrorMessage(error: unknown) {
  if (error instanceof FacebookMessengerUiError) {
    return MESSENGER_ERROR_MESSAGES[error.code];
  }

  return MESSENGER_ERROR_MESSAGES.request_failed;
}

const RECONCILIATION_BLOCKING_STATUSES = new Set(["send_committed", "manual_reconciliation_required"]);
const FACEBOOK_CONNECT_ERRORS: Record<string, string> = {
  session_expired: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  unauthorized: "Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.",
  request_failed: "Không thể gọi dịch vụ kết nối Facebook Page. Vui lòng kiểm tra lại.",
  invalid_state: "Phiên kết nối Facebook không hợp lệ. Vui lòng bắt đầu lại.",
  invalid_or_expired_state: "Phiên kết nối Facebook đã hết hạn. Vui lòng bắt đầu lại.",
  page_not_authorized: "Tài khoản Facebook chưa cấp quyền cho Page đã chọn.",
  no_eligible_pages: "Không tìm thấy Facebook Page đủ quyền Messenger.",
  service_not_configured: "Server chưa cấu hình đủ biến môi trường OAuth Facebook.",
  token_exchange_failed: "Không thể đổi mã OAuth với Facebook. Vui lòng thử lại.",
  subscription_failed: "Không thể đăng ký webhook cho Facebook Page đã chọn.",
  page_lookup_failed: "Không thể đọc danh sách Facebook Page được cấp quyền.",
  page_selection_unavailable: "Không thể lưu danh sách Page cần chọn. Vui lòng bắt đầu lại.",
  provider_exchange_failed: "Không thể hoàn tất kết nối Facebook. Vui lòng thử lại.",
  provider_storage_failed: "Không thể lưu kết nối Facebook Page ở server.",
  candidate_not_found: "Lựa chọn Facebook Page đã hết hạn. Vui lòng bắt đầu lại.",
  forbidden: "Bạn cần quyền chỉnh sửa module Facebook Page để kết nối.",
  state_mismatch: "Phiên kết nối Facebook không khớp. Vui lòng bắt đầu lại.",
  missing_code: "Facebook không trả về mã xác thực. Vui lòng thử lại.",
};

function mapFacebookConnectErrorMessage(error: unknown) {
  const code = typeof error === "string" ? error : error instanceof FacebookPageConnectUiError ? error.code : "";
  return FACEBOOK_CONNECT_ERRORS[code] || "Kết nối Facebook Page thất bại. Vui lòng thử lại hoặc báo quản trị viên.";
}

function getReconciliationStatus(conversation: FacebookMessengerConversation | null, pageStatus?: string | null) {
  return conversation?.manualReconciliationStatus || conversation?.reconciliationStatus || pageStatus || null;
}

export default function FacebookMessengerInbox() {
  const { canEditModule } = useAuth();
  const { t } = useLanguage();
  const canEdit = canEditModule("facebook_messenger");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [connectNotice, setConnectNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [safeError, setSafeError] = useState<string | null>(null);
  const connectLockRef = useRef(false);
  const finalizeLockRef = useRef(false);
  const submitLockRef = useRef(false);
  const composeIdempotencyRef = useRef<{ conversationId: string; draft: string; key: string } | null>(null);
  const pageConnection = useFacebookPageConnectionStatus();
  const connectionReady = pageConnection.data?.connected === true && !pageConnection.isError;
  const pendingCandidates = pageConnection.data?.pendingPageCandidates || [];
  const inboxEnabled = connectionReady && pendingCandidates.length === 0;
  const inbox = useFacebookMessengerInbox(selectedId, { enabled: inboxEnabled });
  const sendMessage = useFacebookMessengerSend();
  const connectPage = useFacebookPageConnect();
  const finalizeCandidate = useFacebookPageCandidateFinalize();
  const isSending = sendMessage.isPending;
  const connectionChecking = pageConnection.isLoading || pageConnection.isFetching;
  const inboxListSettling = inbox.isLoading || (inbox.isFetching && !inbox.data);

  const conversations = useMemo(() => inbox.data?.conversations || [], [inbox.data?.conversations]);
  const selectedConversation = useMemo(() => {
    return inbox.data?.selectedConversation || conversations.find((item) => item.id === selectedId) || null;
  }, [conversations, inbox.data?.selectedConversation, selectedId]);

  const reconciliationStatus = getReconciliationStatus(selectedConversation, inbox.data?.reconciliationStatus);
  const reconciliationBlocked = Boolean(
    (selectedConversation && selectedConversation.replyBlocked) ||
    (reconciliationStatus && RECONCILIATION_BLOCKING_STATUSES.has(reconciliationStatus))
  );
  const featureDisabled = inbox.data?.enabled === false;

  const composerDisabled = featureDisabled || !canEdit || !selectedConversation || selectedConversation.replyWindowExpired || reconciliationBlocked || isSending;
  const disabledReason = !selectedConversation
    ? "Chọn hội thoại trước khi trả lời."
    : featureDisabled
      ? "Tính năng Facebook Messenger chưa được bật. Vui lòng hoàn tất thiết lập server trước khi trả lời khách."
      : !canEdit
        ? "Bạn chỉ có quyền xem module Facebook Page."
        : selectedConversation.replyWindowExpired
          ? "Cửa sổ trả lời Messenger đã hết hạn."
          : reconciliationBlocked
            ? "Trạng thái đối soát chưa an toàn để gửi trả lời. Vui lòng chờ server xác nhận hoặc xử lý đối soát thủ công."
            : isSending
              ? "Đang gửi tin nhắn, vui lòng chờ."
              : "";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get("facebook_connect");
    const error = params.get("facebook_connect_error");
    if (success === "success") {
      const pageName = params.get("facebook_page") || "Facebook Page";
      setConnectNotice({ type: "success", message: `Đã kết nối ${pageName}. Không lưu token trong trình duyệt.` });
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    } else if (success === "select_page") {
      setConnectNotice({ type: "success", message: "Chọn Facebook Page cần kết nối từ danh sách bên dưới. Không lưu token trong trình duyệt." });
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    } else if (error) {
      setConnectNotice({ type: "error", message: mapFacebookConnectErrorMessage(error) });
      window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.hash}`);
    }
  }, []);

  const handleSelect = (conversation: FacebookMessengerConversation) => {
    setSelectedId(conversation.id);
    setMobileDetailOpen(true);
    composeIdempotencyRef.current = null;
    setSafeError(null);
  };

  const getComposeIdempotencyKey = (conversationId: string, draft: string) => {
    const normalizedDraft = draft.trim().slice(0, 2000);
    const result = getMessengerComposeIdempotencyKey(composeIdempotencyRef.current, conversationId, normalizedDraft);
    composeIdempotencyRef.current = result.state;
    return result.key;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitLockRef.current || isSending) return;
    if (composerDisabled || !selectedConversation) return;
    submitLockRef.current = true;
    setSafeError(null);
    try {
      const idempotencyKey = getComposeIdempotencyKey(selectedConversation.id, messageText);
      await sendMessage.mutateAsync({
        conversationId: selectedConversation.id,
        text: messageText,
        idempotencyKey,
      });
      setMessageText("");
      composeIdempotencyRef.current = null;
    } catch (error) {
      setSafeError(mapMessengerErrorMessage(error));
    } finally {
      submitLockRef.current = false;
    }
  };

  const handleConnectPage = async () => {
    if (!canEdit || connectLockRef.current || connectPage.isPending) return;
    connectLockRef.current = true;
    setConnectNotice(null);
    try {
      const data = await connectPage.mutateAsync();
      if (data.authUrl) window.location.href = data.authUrl;
    } catch (error) {
      setConnectNotice({ type: "error", message: mapFacebookConnectErrorMessage(error) });
    } finally {
      connectLockRef.current = false;
    }
  };

  const handleFinalizeCandidate = async (candidateId: string) => {
    if (!canEdit || finalizeLockRef.current || finalizeCandidate.isPending) return;
    finalizeLockRef.current = true;
    setConnectNotice(null);
    try {
      const data = await finalizeCandidate.mutateAsync({ candidateId });
      setConnectNotice({ type: "success", message: `Đã kết nối ${data.pageName || "Facebook Page"}. Không lưu token trong trình duyệt.` });
    } catch (error) {
      setConnectNotice({ type: "error", message: mapFacebookConnectErrorMessage(error) });
    } finally {
      finalizeLockRef.current = false;
    }
  };

  if (pendingCandidates.length > 0) {
    return (
      <main data-facebook-messenger-responsive="320-390-1440" data-facebook-page-connection-fix="cors-retry-fix-v1" className="min-h-[calc(100vh-4rem)] overflow-x-hidden bg-background p-3 sm:p-4 lg:p-6">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
          <section data-facebook-connect-panel="true" className="min-w-0 rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label="facebook-connect-panel">
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="min-w-0 break-words text-xl font-semibold text-foreground">Chọn Facebook Page</h1>
                  <Badge variant="outline">Đã ủy quyền</Badge>
                </div>
                <p className="break-words text-sm text-muted-foreground">
                  Chọn Page cần liên kết. Page đang kết nối chỉ được thay thế sau khi lựa chọn này hoàn tất thành công.
                </p>
                {connectNotice && (
                  <p className={cn("break-words text-sm", connectNotice.type === "success" ? "text-emerald-700" : "text-destructive")}>
                    {connectNotice.message}
                  </p>
                )}
              </div>
              <div className="grid min-w-0 gap-2">
                {pendingCandidates.map((candidate) => (
                  <Button
                    key={candidate.candidateId}
                    type="button"
                    variant="outline"
                    className="min-h-11 justify-start"
                    disabled={!canEdit || finalizeCandidate.isPending}
                    onClick={() => handleFinalizeCandidate(candidate.candidateId)}
                  >
                    <span className="min-w-0 truncate">{candidate.pageName} •••{candidate.pageIdSuffix}</span>
                  </Button>
                ))}
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (!connectionReady) {
    return (
      <main data-facebook-messenger-responsive="320-390-1440" data-facebook-page-connection-fix="cors-retry-fix-v1" className="min-h-[calc(100vh-4rem)] overflow-x-hidden bg-background p-3 sm:p-4 lg:p-6">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-4">
          <section data-facebook-connect-panel="true" className="min-w-0 rounded-xl border bg-card p-4 shadow-sm sm:p-5" aria-label="facebook-connect-panel">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="min-w-0 space-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h1 className="min-w-0 break-words text-xl font-semibold text-foreground">
                    {connectionChecking
                      ? "Đang kiểm tra kết nối Facebook Page"
                      : pageConnection.isError
                        ? "Không thể kiểm tra kết nối Facebook Page"
                        : "Chưa kết nối Facebook Page"}
                  </h1>
                  <Badge variant="outline">
                    {connectionChecking ? "Đang kiểm tra" : pageConnection.isError ? "Lỗi kiểm tra" : "Chưa kết nối"}
                  </Badge>
                </div>
                <p className="break-words text-sm text-muted-foreground">
                  Kết nối bằng Facebook Login for Business để server nhận Page credentials. Gửi Messenger, forward email và AI vẫn mặc định tắt sau khi kết nối.
                </p>
                {connectNotice && (
                  <p className={cn("break-words text-sm", connectNotice.type === "success" ? "text-emerald-700" : "text-destructive")}>
                    {connectNotice.message}
                  </p>
                )}
                {pageConnection.isError && (
                  <p className="break-words text-sm text-destructive">{mapFacebookConnectErrorMessage(pageConnection.error)}</p>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                {pageConnection.isError ? (
                  <Button type="button" variant="outline" onClick={() => pageConnection.refetch()} disabled={connectionChecking} className="min-h-11 shrink-0">
                    <RefreshCw className={cn("mr-2 h-4 w-4", connectionChecking && "animate-spin")} />
                    Kiểm tra lại
                  </Button>
                ) : (
                  <Button type="button" onClick={handleConnectPage} disabled={!canEdit || connectionChecking || connectPage.isPending} className="min-h-11 shrink-0">
                    {connectionChecking || connectPage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
                    {connectionChecking ? "Đang kiểm tra" : "Kết nối Facebook Page"}
                  </Button>
                )}
                {!canEdit && <p className="break-words text-sm text-muted-foreground">Bạn cần quyền chỉnh sửa module Facebook Page để kết nối.</p>}
              </div>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main data-facebook-messenger-responsive="320-390-1440" data-facebook-page-connection-fix="cors-retry-fix-v1" className="min-h-[calc(100vh-4rem)] overflow-x-hidden bg-background p-3 sm:p-4 lg:p-6">
      <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4">
        <header className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{t.facebookPageManagement}</h1>
            <Badge variant={featureDisabled ? "destructive" : "secondary"}>
              {featureDisabled ? "Chưa bật gửi" : "Messenger inbox"}
            </Badge>
          </div>
          <p className="max-w-3xl break-words text-sm text-muted-foreground">
            Xem hội thoại Messenger, trạng thái phân công, cửa sổ chính sách và gửi trả lời qua Edge Function đã xác thực. UI không nhận Page/PSID/provider status từ người dùng. Không tải URL đính kèm từ Facebook.
          </p>
        </header>

        {(inbox.isLoading || inbox.isFetching) && (
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
              {safeError || mapMessengerErrorMessage(inbox.error)}
            </AlertDescription>
          </Alert>
        )}

        {featureDisabled && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Tính năng gửi Facebook Messenger đang tắt</AlertTitle>
            <AlertDescription>Kết nối Page đã hoàn tất, nhưng gửi/forward/AI vẫn mặc định tắt cho tới khi operator bật riêng trên server.</AlertDescription>
          </Alert>
        )}

        <section data-facebook-connect-panel="true" className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4" aria-label="facebook-connect-panel">
          <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Kết nối Facebook Page</h2>
                <Badge variant="secondary">Đã kết nối</Badge>
              </div>
              <p className="break-words text-sm text-muted-foreground">
                Page: {pageConnection.data?.pageName || "Facebook Page"}{pageConnection.data?.pageIdSuffix ? ` •••${pageConnection.data.pageIdSuffix}` : ""}
              </p>
              {connectNotice && (
                <p className={cn("break-words text-sm", connectNotice.type === "success" ? "text-emerald-700" : "text-destructive")}>
                  {connectNotice.message}
                </p>
              )}
            </div>

            <Button type="button" onClick={handleConnectPage} disabled={!canEdit || connectPage.isPending} variant="outline" className="min-h-11 shrink-0">
              {connectPage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              Kết nối Facebook Page
            </Button>
          </div>
        </section>

        <section className="grid min-w-0 gap-4 lg:min-h-[680px] lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]" aria-label="Facebook Messenger inbox">
          <aside className={cn("min-w-0 space-y-3", mobileDetailOpen && "hidden md:block")}>
            <p className="md:hidden rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Chọn một hội thoại để mở chi tiết trên màn hình nhỏ.</p>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">Hội thoại</h2>
                <p className="text-xs text-muted-foreground">{inboxListSettling ? "Đang tải luồng hội thoại" : `${conversations.length} luồng đang hiển thị`}</p>
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
                onChange={(event) => {
                  composeIdempotencyRef.current = null;
                  setMessageText(event.target.value.slice(0, 2000));
                }}
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
