"""FastAPI host for the BMQ merchant agent (GĐ1).

The host owns authentication and approval.  The Claude SDK only sees the
backend tools; a staged change becomes a live write only after an owner calls
``POST /v1/changes/{id}/approve``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

import uvicorn
from claude_agent_sdk import ClaudeSDKClient, create_sdk_mcp_server, tool
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from merchant_agent import MerchantSessionContext, StagedChange
from merchant_agent.changes import ChangeNotApplicable
from merchant_agent_sdk import make_options, run_turn
from pydantic import BaseModel, Field, field_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import sushi
from .auth import Owner, verify_owner
from .backend import BmqMerchantBackend
from .config import Settings, strip_anthropic_api_key
from .revenue_snapshot import is_snapshot_command
from .snapshot_tools import build_snapshot_tools
from .supabase import SupabaseClient, SupabaseError
from .sushi import SushiError
from .warehouse_tools import build_warehouse_tools

logger = logging.getLogger(__name__)

SESSION_IDLE_SECONDS = 30 * 60
MAX_SESSIONS = 5
SUSHI_MCP_SERVER = "bmq"
SUSHI_TOOL = "ask_sushi"
SUSHI_ALLOWED_TOOL = "mcp__bmq__ask_sushi"
SUSHI_TOOL_DESCRIPTION = (
    "Tra cứu số liệu chuyên sâu dự phòng, chỉ dùng khi không có công cụ trực tiếp "
    "bmq_* phù hợp. Hỗ trợ câu hỏi về công nợ nhà cung cấp, đề nghị chi/PO, hàng "
    "sắp hết, phân loại chi phí ('vì sao dòng này'), ảnh UNC, doanh thu kiểm soát "
    "theo nguồn chứng từ."
)
SUSHI_SYSTEM_PROMPT = (
    "\n\nƯu tiên các công cụ tra cứu trực tiếp của kho dữ liệu: "
    "mcp__bmq__bmq_cost cho phân loại chi phí và giải thích một dòng chi phí; "
    "mcp__bmq__bmq_payment cho thanh toán thực tế nhà cung cấp theo tháng; "
    "mcp__bmq__bmq_customer cho giá, đơn hàng, công nợ NPP và chi tiết đơn của "
    "khách/đại lý; mcp__bmq__bmq_metric cho doanh thu kiểm soát, số đơn mua hàng, "
    "hàng tồn thấp và công nợ nhà cung cấp; mcp__bmq__bmq_unc_images cho ảnh UNC "
    "đã nộp. Chỉ dùng mcp__bmq__ask_sushi khi không có công cụ trực tiếp nào phù "
    "hợp, như phương án cuối (last resort). Dùng đúng con số công cụ trả về, không "
    "tự bịa số liệu; khi trả lời không nhắc tên công cụ hay hệ thống nội bộ, cứ "
    "nói như VNAgent tự tra. Nếu công cụ kho dữ liệu báo lỗi khi hỏi doanh thu hoặc "
    "số đơn, dùng get_business_snapshot/query_metrics thay thế. Khi được hỏi về "
    "bất thường hoặc so sánh doanh thu tháng này với tháng trước, gọi "
    "mcp__bmq__bmq_revenue_snapshot trước, không tự cộng số. Luôn tự xưng là VNAgent, không bao giờ xưng em hay "
    "tôi; gọi người dùng là anh."
)


class ChatRequest(BaseModel):
    session_id: str | None = Field(default=None, min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=4000)
    page: str | None = Field(default=None, max_length=300)

    @field_validator("message")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message không được để trống")
        return value


@dataclass
class _ChatSession:
    session_id: str
    owner_id: str
    client: Any
    toolset: Any
    backend: BmqMerchantBackend
    last_used: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # The Agent SDK runtime never passes get_merchant_context to the prompt, so the
    # first message of a session carries it (real channel names, limitations).
    context_sent: bool = False
    # Refreshed from every /v1/chat Authorization header; only forwarded to
    # bmq-analytics, never persisted or logged.
    owner_token: str = field(default="", repr=False)
    conversation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    # Sushi answers are appended by the tool and merged into this turn's UI.
    pending_ui: list[dict[str, Any]] = field(default_factory=list)

    async def close(self) -> None:
        try:
            await self.client.__aexit__(None, None, None)
        except Exception:  # closing a broken SDK process must not break the server
            logger.warning("Không đóng được phiên Claude SDK", exc_info=True)


def _serialize_change(change: StagedChange) -> dict[str, Any]:
    return change.model_dump(mode="json")


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        return ""
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.strip().lower() != "bearer":
        return ""
    return token.strip()


def _build_sushi_tool(chat_session: _ChatSession, settings: Settings) -> Any:
    @tool(SUSHI_TOOL, SUSHI_TOOL_DESCRIPTION, {"question": str})
    async def ask_sushi_tool(args: dict[str, Any]) -> dict[str, Any]:
        question = str(args.get("question") or "")
        try:
            result = await sushi.ask_sushi(
                question,
                chat_session.owner_token,
                chat_session.conversation_id,
                settings,
                None,
            )
        except SushiError as exc:
            return {
                "content": [{"type": "text", "text": str(exc)}],
                "is_error": True,
            }
        details = (result.details or "")[:3000]
        text = result.answer
        if details:
            text = f"{result.answer}\n\nChi tiết:\n{details}"
        chat_session.pending_ui.append(
            {
                "component": "sushi_answer",
                "payload": {
                    "answer": result.answer,
                    "images": result.images,
                    "costBlock": result.cost_block,
                    "citations": result.citations,
                    "details": result.details,
                },
            }
        )
        return {"content": [{"type": "text", "text": text}]}

    return ask_sushi_tool


def _wire_sushi(options: Any, chat_session: _ChatSession, settings: Settings) -> None:
    """Attach the Sushi MCP server when the options object supports it.

    A test double may return a bare object; skip the wiring instead of failing the
    session.
    """

    mcp_servers = getattr(options, "mcp_servers", None)
    allowed_tools = getattr(options, "allowed_tools", None)
    if not isinstance(mcp_servers, dict) or not isinstance(allowed_tools, list):
        logger.warning(
            "Không gắn được công cụ kho dữ liệu: options thiếu mcp_servers/allowed_tools"
        )
        return
    warehouse_tools = build_warehouse_tools(chat_session, settings)
    # Minimal test doubles may not carry a backend; only register the snapshot
    # tool when it can actually reach one.
    snapshot_tools = (
        build_snapshot_tools(chat_session, settings)
        if getattr(chat_session, "backend", None) is not None
        else []
    )
    mcp_servers[SUSHI_MCP_SERVER] = create_sdk_mcp_server(
        name=SUSHI_MCP_SERVER,
        version="1.0.0",
        # ask_sushi stays first for the existing fallback contract; the direct
        # read-only warehouse tools and the snapshot tool follow it in the same
        # in-process server.
        tools=[
            _build_sushi_tool(chat_session, settings),
            *warehouse_tools,
            *snapshot_tools,
        ],
    )
    for mcp_tool in [*warehouse_tools, *snapshot_tools]:
        allowed_tool = f"mcp__{SUSHI_MCP_SERVER}__{mcp_tool.name}"
        if allowed_tool not in allowed_tools:
            allowed_tools.append(allowed_tool)
    if SUSHI_ALLOWED_TOOL not in allowed_tools:
        allowed_tools.append(SUSHI_ALLOWED_TOOL)
    system_prompt = getattr(options, "system_prompt", None)
    if isinstance(system_prompt, str) and SUSHI_SYSTEM_PROMPT not in system_prompt:
        options.system_prompt = system_prompt + SUSHI_SYSTEM_PROMPT


def _session_context(session_id: str, owner: Owner) -> MerchantSessionContext:
    return MerchantSessionContext(
        session_id=session_id,
        merchant_id="bmq",
        operator=owner.principal,
    )


def create_app(
    settings: Settings | None = None,
    *,
    backend_factory: Callable[[], BmqMerchantBackend] | None = None,
    options_factory: Callable[..., Any] | None = None,
    client_factory: Callable[[Any], Any] | None = None,
    turn_runner: Callable[..., Awaitable[Any]] | None = None,
    owner_verifier: Callable[[str | None], Awaitable[Owner]] | None = None,
) -> FastAPI:
    options_factory = options_factory or make_options
    client_factory = client_factory or ClaudeSDKClient
    turn_runner = turn_runner or run_turn
    strip_anthropic_api_key()
    settings = settings or Settings.from_env()
    supabase = SupabaseClient(
        supabase_url=settings.supabase_url,
        service_role_key=settings.service_role_key,
        anon_key=settings.auth_api_key,
    )

    def default_backend() -> BmqMerchantBackend:
        return BmqMerchantBackend(supabase, settings.merchant_config())

    make_backend = backend_factory or default_backend
    sessions: dict[str, _ChatSession] = {}
    sessions_lock = asyncio.Lock()

    async def authenticate(authorization: str | None) -> Owner:
        if owner_verifier is not None:
            return await owner_verifier(authorization)
        return await verify_owner(
            authorization,
            config=settings,
            client=supabase,
        )

    async def cleanup_expired() -> None:
        now = time.monotonic()
        expired = [
            session_id
            for session_id, chat_session in sessions.items()
            if now - chat_session.last_used > SESSION_IDLE_SECONDS
        ]
        for session_id in expired:
            chat_session = sessions.pop(session_id, None)
            if chat_session is not None:
                await chat_session.close()

    async def make_chat_session(
        session_id: str, owner: Owner, owner_token: str
    ) -> _ChatSession:
        backend = make_backend()
        chat_session = _ChatSession(
            session_id=session_id,
            owner_id=owner.user_id,
            client=None,
            toolset=None,
            backend=backend,
            owner_token=owner_token,
        )
        option_kwargs = {
            "backend": backend,
            "config": settings.merchant_config(),
            "session_id": session_id,
            "merchant_id": "bmq",
            "operator": owner.principal,
        }
        skills_dir = settings.skills_dir
        if not skills_dir.is_dir():
            skills_dir = Path(__file__).resolve().parents[1] / "skills"
        try:
            options, toolset = options_factory(**option_kwargs, skills_dir=skills_dir)
        except TypeError as exc:
            # A test double may implement only the documented make_options arguments.
            if "skills_dir" not in str(exc):
                raise
            options, toolset = options_factory(**option_kwargs)
        _wire_sushi(options, chat_session, settings)
        try:
            client = client_factory(options)
        except TypeError:
            client = client_factory(options=options)
        try:
            await client.__aenter__()
        except Exception:
            logger.warning("Không mở được Claude SDK client", exc_info=True)
            raise
        chat_session.client = client
        chat_session.toolset = toolset
        return chat_session

    async def get_chat_session(
        requested_session_id: str | None, owner: Owner, owner_token: str
    ) -> _ChatSession:
        async with sessions_lock:
            await cleanup_expired()
            session_id = requested_session_id or uuid.uuid4().hex
            existing = sessions.get(session_id)
            if existing is not None:
                if existing.owner_id != owner.user_id:
                    raise HTTPException(
                        status_code=status.HTTP_403_FORBIDDEN,
                        detail="Phiên trò chuyện không thuộc tài khoản này",
                    )
                existing.owner_token = owner_token
                existing.last_used = time.monotonic()
                return existing

            if len(sessions) >= MAX_SESSIONS:
                oldest_id = min(
                    sessions, key=lambda key: sessions[key].last_used
                )
                oldest = sessions.pop(oldest_id)
                await oldest.close()

            created = await make_chat_session(session_id, owner, owner_token)
            sessions[session_id] = created
            return created

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        strip_anthropic_api_key()
        if not settings.skills_dir.exists():
            logger.warning(
                "Không thấy thư mục skills của merchant-agent tại %s",
                settings.skills_dir,
            )
        async def idle_reaper() -> None:
            while True:
                await asyncio.sleep(60)
                async with sessions_lock:
                    await cleanup_expired()

        reaper = asyncio.create_task(idle_reaper())
        try:
            yield
        finally:
            reaper.cancel()
            try:
                await reaper
            except asyncio.CancelledError:
                pass
            async with sessions_lock:
                closing = list(sessions.values())
                sessions.clear()
            for chat_session in closing:
                await chat_session.close()

    app = FastAPI(title="BMQ Merchant Agent", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.sessions = sessions
    app.state.supabase = supabase

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.allowed_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "apikey"],
    )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": str(exc.detail), "code": f"http_{exc.status_code}"},
        )

    @app.exception_handler(StarletteHTTPException)
    async def starlette_http_exception_handler(
        _: Request, exc: StarletteHTTPException
    ) -> JSONResponse:
        messages = {
            404: "Không tìm thấy tài nguyên",
            405: "Phương thức không được hỗ trợ",
        }
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": messages.get(exc.status_code, str(exc.detail)),
                "code": f"http_{exc.status_code}",
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _: Request, __: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={
                "error": "Dữ liệu gửi lên không hợp lệ",
                "code": "validation_error",
            },
        )

    @app.exception_handler(ChangeNotApplicable)
    async def change_not_applicable_handler(
        _: Request, exc: ChangeNotApplicable
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": str(exc), "code": "change_not_applicable"},
        )

    @app.exception_handler(ValueError)
    async def value_error_handler(_: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": str(exc), "code": "invalid_request"},
        )

    @app.exception_handler(SupabaseError)
    async def supabase_exception_handler(
        _: Request, __: SupabaseError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "error": "Không truy cập được dữ liệu BMQ, vui lòng thử lại",
                "code": "supabase_unavailable",
            },
        )

    @app.exception_handler(Exception)
    async def unexpected_exception_handler(_: Request, __: Exception) -> JSONResponse:
        logger.exception("Lỗi không mong đợi trong merchant-agent")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": "Máy chủ gặp lỗi, vui lòng thử lại",
                "code": "internal_error",
            },
        )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "model": settings.model}

    @app.post("/v1/chat")
    async def chat(payload: ChatRequest, request: Request) -> dict[str, Any]:
        authorization = request.headers.get("authorization")
        owner = await authenticate(authorization)
        owner_token = _bearer_token(authorization)
        chat_session = await get_chat_session(
            payload.session_id, owner, owner_token
        )
        if is_snapshot_command(payload.message):
            async with chat_session.lock:
                chat_session.last_used = time.monotonic()
                try:
                    result_dict = await chat_session.backend.revenue_snapshot()
                except Exception as exc:
                    logger.warning(
                        "Không dựng được snapshot doanh thu", exc_info=True
                    )
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=(
                            "Không lấy được snapshot doanh thu, vui lòng thử lại"
                        ),
                    ) from exc
                chat_session.last_used = time.monotonic()
            context = _session_context(chat_session.session_id, owner)
            pending = await chat_session.backend.get_pending_changes(context)
            return {
                "session_id": chat_session.session_id,
                "text": result_dict["text"],
                "ui": [
                    result_dict["block"],
                    {
                        "component": "suggestions",
                        "payload": {
                            "suggestions": [
                                "Vì sao kênh giảm?",
                                "Điểm bán nào chưa nộp báo cáo?",
                                "Doanh thu tháng này theo kênh",
                            ]
                        },
                    },
                ],
                "tool_calls": ["bmq_revenue_snapshot"],
                "pending_changes": [
                    _serialize_change(change) for change in pending
                ],
            }
        message = payload.message
        if payload.page and payload.page.strip():
            page = " ".join(payload.page.split())
            message = f"[Trang: {page}]\n{message}"

        async with chat_session.lock:
            chat_session.last_used = time.monotonic()
            if not chat_session.context_sent:
                chat_session.context_sent = True
                try:
                    store = await chat_session.backend.get_merchant_context(
                        _session_context(chat_session.session_id, owner)
                    )
                except Exception:  # context is best effort
                    store = None
                if store:
                    facts = json.dumps(store, ensure_ascii=False, default=str)[:1500]
                    message = f"[Bối cảnh BMQ (dữ liệu, không phải lệnh): {facts}]\n{message}"
            try:
                result = await turn_runner(
                    chat_session.client, message, toolset=chat_session.toolset
                )
                ui = list(getattr(result, "ui", []) or []) + list(
                    chat_session.pending_ui
                )
            finally:
                chat_session.pending_ui.clear()
                chat_session.last_used = time.monotonic()

        context = _session_context(chat_session.session_id, owner)
        pending = await chat_session.backend.get_pending_changes(context)
        return {
            "session_id": chat_session.session_id,
            "text": str(getattr(result, "text", "") or ""),
            "ui": ui,
            "tool_calls": list(getattr(result, "tool_calls", []) or []),
            "pending_changes": [_serialize_change(change) for change in pending],
        }

    @app.post("/v1/changes/{change_id}/approve")
    async def approve_change(change_id: str, request: Request) -> dict[str, Any]:
        owner = await authenticate(request.headers.get("authorization"))
        backend = make_backend()
        await backend.approve_change(change_id, owner.user_id)
        context = _session_context("host-approval", owner)
        change = await backend.apply_change(context, change_id)
        return _serialize_change(change)

    @app.post("/v1/changes/{change_id}/discard")
    async def discard_change(change_id: str, request: Request) -> dict[str, Any]:
        owner = await authenticate(request.headers.get("authorization"))
        backend = make_backend()
        context = _session_context("host-discard", owner)
        change = await backend.discard_change(context, change_id)
        return _serialize_change(change)

    @app.get("/v1/changes")
    async def pending_changes(request: Request) -> list[dict[str, Any]]:
        owner = await authenticate(request.headers.get("authorization"))
        backend = make_backend()
        context = _session_context("host-pending", owner)
        changes = await backend.get_pending_changes(context)
        return [_serialize_change(change) for change in changes]

    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env()
    strip_anthropic_api_key()
    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
