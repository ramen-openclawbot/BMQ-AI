#!/usr/bin/env python3
"""Focused static contracts for the BMQ VNAgent Universal Protocol chat."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WIDGET = (ROOT / "src/components/agent/GlobalAgentChatWidget.tsx").read_text()
PROTOCOL = (ROOT / "src/lib/vnagentProtocol.ts").read_text()
TAILWIND = (ROOT / "tailwind.config.ts").read_text()


def require(source: str, marker: str, message: str) -> None:
    assert marker in source, message


def forbid(source: str, marker: str, message: str) -> None:
    assert marker not in source, message


def test_owner_and_server_auth_contract() -> None:
    require(WIDGET, "authzLoaded && isOwner", "chat must be hidden until local owner authorization is loaded")
    require(WIDGET, "`${API_URL}/v1/auth/bmq`", "chat must exchange the Supabase session at the BMQ auth endpoint")
    require(WIDGET, "Authorization: `Bearer ${session.access_token}`", "BMQ auth must use the Supabase access token")
    require(WIDGET, "if (!enabled) return null", "non-owners must not see or use the widget")
    forbid(WIDGET, "localStorage.setItem(\"vna_token\"", "the exchanged VNAgent bearer must stay out of durable browser storage")


def test_universal_protocol_and_resume_contract() -> None:
    require(PROTOCOL, 'type: "user_message"', "normal messages must use Universal Protocol user_message frames")
    require(WIDGET, 'type: "hello"', "websocket must start with a Universal Protocol hello frame")
    require(WIDGET, "resume: { sessionId: resumeSessionId, lastSeq: lastSeqRef.current }", "hello must resume from the last durable sequence without coupling websocket lifetime to React session state")
    require(WIDGET, "/messages", "choosing a conversation must restore durable server history")
    require(WIDGET, 'storageKey(user.id, "session")', "the selected active conversation must persist per signed-in owner")
    require(WIDGET, "socket.send(JSON.stringify(outgoing))", "all submitted text must be sent to VNAgent")
    forbid(WIDGET, "lower.includes(\"tóm tắt\")", "local fallback intent responses must not intercept messages")
    forbid(WIDGET, "invokePaymentAgentSearch", "payment-search handlers must not intercept normal chat messages")


def test_recent_session_picker_replaces_automatic_resume() -> None:
    require(WIDGET, 'fetch(`${API_URL}/v1/sessions`', "bootstrap must load the owner session list")
    require(WIDGET, ".slice(0, 3)", "the picker must show at most three recent conversations")
    require(WIDGET, 'data-vnagent-session-picker="recent-3"', "the recent-session picker needs a stable behavior marker")
    require(WIDGET, "Tiếp tục cuộc trò chuyện", "the picker must offer continuing a recent conversation")
    require(WIDGET, "Tạo cuộc trò chuyện mới", "the picker must offer a fresh conversation")
    require(WIDGET, "const continueSession = useCallback", "continuing must explicitly load the chosen history")
    require(WIDGET, "const startNewConversation = useCallback", "starting fresh must explicitly clear the active session")
    forbid(WIDGET, "const restoredSessionId = localStorage.getItem", "bootstrap must not automatically reopen the last conversation")


def test_first_message_keeps_the_authenticated_socket_open() -> None:
    require(WIDGET, "const sessionIdRef = useRef<string | null>(null)", "the active session id must be readable without reconnecting the websocket")
    require(WIDGET, "sessionIdRef.current = created.id", "new session identity must update synchronously before the first send")
    require(WIDGET, "const socket = wsRef.current;\n      if (!socket || socket.readyState !== WebSocket.OPEN)", "the first send must re-read and validate the live socket after session creation")
    forbid(WIDGET, "[enabled, rememberFrame, sessionId, vnagentToken]", "creating the first session must not tear down the authenticated websocket")


def test_quick_actions_are_initial_state_only() -> None:
    require(WIDGET, "const showQuickActions = !sessionChoiceRequired && !sessionId && visibleTimeline.length === 0 && !streamedText && !isResponding", "quick actions must wait for the session choice and disappear once a conversation starts")
    require(WIDGET, "{showQuickActions && (", "quick actions must use the initial-state guard")


def test_vnagent_brand_and_address_contract() -> None:
    require(WIDGET, 'data-vnagent-branding="owner-chat-v1"', "the owner chat surface must carry a stable VNAgent branding marker")
    require(WIDGET, 'data-vnagent-ui="chat-v2-clean"', "the BMQ widget must carry the clean chat UI marker")
    require(WIDGET, 'SheetTitle className="text-[17px]', "the visible chat title must identify VNAgent")
    require(WIDGET, 'aria-label={text("Mở VNAgent")}', "the chat launcher must identify VNAgent")
    require(WIDGET, 'Dạ thưa anh Tâm, VNAgent đã nhận diện', "the initial greeting must use the approved VNAgent address")
    require(WIDGET, 'aria-label={text("VNAgent — Trợ lý AI của BMQ")}', "the header must expose the VNAgent identity accessibly")
    require(WIDGET, "VNAgent đang xử lý…", "the thinking state must identify VNAgent")
    require(WIDGET, 'placeholder={text("Hỏi bất cứ điều gì")}', "the composer must match chat.vnagent.ai")
    require(WIDGET, 'bg-[#6d4aff]', "owner messages and send action must use the VNAgent violet accent")
    require(WIDGET, 'bg-[#f7f8fa] p-0 text-[#171a21]', "the chat surface must use the clean light VNAgent canvas")
    forbid(WIDGET, 'item.role === "agent" ? "VNAgent"', "chat.vnagent.ai parity hides repeated assistant labels inside the transcript")
    for legacy_copy in ['>AI Agent</SheetTitle>', 'Vui lòng nhập yêu cầu để AI Agent hỗ trợ.', '>Agent</div>', ' />Agent đang xử lý…', 'cho AI Agent...']:
        forbid(WIDGET, legacy_copy, f"legacy generic agent copy must be removed: {legacy_copy}")


def test_chat_launcher_uses_the_vnagent_mark_with_motion() -> None:
    require(WIDGET, 'data-vnagent-launcher="logo-motion-v1"', "the launcher must carry a stable marker for the VNAgent logo treatment")
    require(WIDGET, 'function VnagentMark({ className = "h-9 w-11 shrink-0" }', "the shared VNAgent mark must keep its default size for the chat header")
    require(WIDGET, 'aria-label="Logo VNAgent"', "the VNAgent mark must keep its accessible label")
    require(WIDGET, '!open && "animate-vnagent-throb motion-reduce:animate-none"', "the launcher mark must animate only while the sheet is closed and honour reduced motion")
    require(TAILWIND, '"vnagent-throb": "vnagent-throb 3s ease-in-out infinite"', "the throb animation must be declared in the shared Tailwind config")
    require(TAILWIND, '"vnagent-throb": {', "the throb keyframes must live in the shared Tailwind config")
    forbid(WIDGET, "MessageCircle", "the launcher must use the VNAgent mark instead of the generic chat icon")


def test_hidden_page_context_contract() -> None:
    require(WIDGET, "buildCurrentPageContext(location.pathname, location.search, routeContext)", "every send must capture the current route")
    require(PROTOCOL, "content: { text: args.text },\n    context: args.currentPage,", "page context must use the adapter's direct PageContext envelope")
    forbid(PROTOCOL, 'source: "bmq-web"', "the protocol context must not add fields rejected by the strict adapter schema")
    forbid(PROTOCOL, "currentPage: args.currentPage", "the protocol context must not wrap PageContext in an unsupported currentPage object")
    for field in ["pathname", "searchParams", "route", "documentIdentifiers", "filters"]:
        require(PROTOCOL, field, f"page context must include {field}")
    require(PROTOCOL, "SENSITIVE_KEY.test(rawKey)", "sensitive query keys must be excluded")
    assert not re.search(r"document\.(?:body|documentElement|querySelector|innerHTML)", WIDGET + PROTOCOL), "context must never scrape DOM content"


def test_tool_events_remain_durable_but_are_hidden_from_chat_ui() -> None:
    for event_type in ["agent_tool", "agent_message_done", "error"]:
        require(PROTOCOL, f'frame.type === "{event_type}"', f"history reducer must understand {event_type}")
    for status in ['"running"', '"done"', '"error"']:
        require(PROTOCOL, status, f"tool lifecycle must expose {status}")
    require(WIDGET, 'timeline.filter((item) => item.kind !== "tool")', "tool calls must be removed from the visible chat timeline")
    forbid(WIDGET, "function ToolCallRow", "the chat UI must not include a tool-call renderer")
    forbid(WIDGET, "<details", "tool payloads must not be expandable in the chat UI")
    require(PROTOCOL, 'frame.status === "done" || frame.status === "error"', "tool status updates must preserve done/error")
    require(PROTOCOL, 'frame.type === "agent_tool" && frame.id === next.id', "later tool frames must replace the running frame")
    require(PROTOCOL, '"[redacted]"', "sensitive detail values must be redacted")
    require(PROTOCOL, "sanitizeToolDetails(frame)", "tool frames must be sanitized before rendering")


def test_bmq_identity_and_growing_composer() -> None:
    require(PROTOCOL, 'app: { id: "bmq-ai", name: "BMQ AI", origin: "https://ai.banhmique.vn" }', "each page snapshot identifies the BMQ host app")
    require(WIDGET, 'data-vnagent-composer="autogrow-v1"', "preserve growing composer marker")
    require(WIDGET, 'ref={attachComposer}', "resize must run when the sheet mounts")
    require(WIDGET, '[draft, resizeComposer]', "resize must run for typing and clearing")
    require(WIDGET, 'overflow-clip', "outer padding must not scroll with caret")
    require(WIDGET, 'py-3 transition focus-within:', "keep equal fixed vertical padding")
    forbid(WIDGET, 'max-h-[120px]', "do not restore fixed clipped input")
    forbid(WIDGET, 'absolute bottom-3 right-3', "word count must not overlay text")


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"PASS {len(tests)} VNAgent chat contract tests")
