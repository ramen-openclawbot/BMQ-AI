#!/usr/bin/env python3
"""Focused static contracts for the BMQ VNAgent Universal Protocol chat."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
WIDGET = (ROOT / "src/components/agent/GlobalAgentChatWidget.tsx").read_text()
PROTOCOL = (ROOT / "src/lib/vnagentProtocol.ts").read_text()


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
    require(WIDGET, "/messages", "reload must restore durable server history")
    require(WIDGET, 'storageKey(user.id, "session")', "the active conversation must persist per signed-in owner")
    require(WIDGET, "socket.send(JSON.stringify(outgoing))", "all submitted text must be sent to VNAgent")
    forbid(WIDGET, "lower.includes(\"tóm tắt\")", "local fallback intent responses must not intercept messages")
    forbid(WIDGET, "invokePaymentAgentSearch", "payment-search handlers must not intercept normal chat messages")


def test_first_message_keeps_the_authenticated_socket_open() -> None:
    require(WIDGET, "const sessionIdRef = useRef<string | null>(null)", "the active session id must be readable without reconnecting the websocket")
    require(WIDGET, "sessionIdRef.current = created.id", "new session identity must update synchronously before the first send")
    require(WIDGET, "const socket = wsRef.current;\n      if (!socket || socket.readyState !== WebSocket.OPEN)", "the first send must re-read and validate the live socket after session creation")
    forbid(WIDGET, "[enabled, rememberFrame, sessionId, vnagentToken]", "creating the first session must not tear down the authenticated websocket")


def test_quick_actions_are_initial_state_only() -> None:
    require(WIDGET, "const showQuickActions = !sessionId && timeline.length === 0 && !streamedText && !isResponding", "quick actions must disappear once a conversation starts")
    require(WIDGET, "{showQuickActions && (", "quick actions must use the initial-state guard")


def test_hidden_page_context_contract() -> None:
    require(WIDGET, "buildCurrentPageContext(location.pathname, location.search, routeContext)", "every send must capture the current route")
    require(PROTOCOL, "content: { text: args.text },\n    context: args.currentPage,", "page context must use the adapter's direct PageContext envelope")
    forbid(PROTOCOL, 'source: "bmq-web"', "the protocol context must not add fields rejected by the strict adapter schema")
    forbid(PROTOCOL, "currentPage: args.currentPage", "the protocol context must not wrap PageContext in an unsupported currentPage object")
    for field in ["pathname", "searchParams", "route", "documentIdentifiers", "filters"]:
        require(PROTOCOL, field, f"page context must include {field}")
    require(PROTOCOL, "SENSITIVE_KEY.test(rawKey)", "sensitive query keys must be excluded")
    assert not re.search(r"document\.(?:body|documentElement|querySelector|innerHTML)", WIDGET + PROTOCOL), "context must never scrape DOM content"


def test_durable_sanitized_tool_contract() -> None:
    for event_type in ["agent_tool", "agent_message_done", "error"]:
        require(PROTOCOL, f'frame.type === "{event_type}"', f"history reducer must understand {event_type}")
    for status in ['"running"', '"done"', '"error"']:
        require(PROTOCOL, status, f"tool lifecycle must expose {status}")
    require(WIDGET, "<details", "tool details must be expandable")
    require(PROTOCOL, 'frame.status === "done" || frame.status === "error"', "tool status updates must preserve done/error")
    require(PROTOCOL, 'frame.type === "agent_tool" && frame.id === next.id', "later tool frames must replace the running frame")
    require(PROTOCOL, '"[redacted]"', "sensitive detail values must be redacted")
    require(PROTOCOL, "sanitizeToolDetails(frame)", "tool frames must be sanitized before rendering")


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"PASS {len(tests)} VNAgent chat contract tests")
