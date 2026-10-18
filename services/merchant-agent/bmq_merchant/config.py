"""Environment-backed settings for the BMQ merchant agent.

Secrets are read from the environment only.  They are never included in log
messages, exception text, or health responses.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

from merchant_agent import MerchantAgentConfig

logger = logging.getLogger(__name__)

DEFAULT_SUPABASE_URL = "https://cxntbdvfsikwmitapony.supabase.co"
DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_REFERENCE_SKILLS = Path(
    "/Volumes/Samsung SSD 9100 PRO 1TB Media/VNAgent/research/"
    "commerce-agents-20261018/merchant-agent/skills"
)


class ConfigError(RuntimeError):
    """A required runtime setting is missing or invalid."""


def _env_text(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None else value.strip()


def _env_int(name: str, default: int) -> int:
    raw = _env_text(name, str(default))
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} phải là số nguyên") from exc


def strip_anthropic_api_key(environ: dict[str, str] | None = None) -> bool:
    """Remove ``ANTHROPIC_API_KEY`` so the Claude Agent SDK uses Claude Code login.

    The SDK reads credentials from the process environment.  A stale API key in
    the server environment would silently take precedence over the locally
    authenticated Claude Code login, so it is removed at startup.  Only the fact
    that a key was removed is logged; the value is never read into a message.
    """

    target = os.environ if environ is None else environ
    if "ANTHROPIC_API_KEY" not in target:
        return False
    del target["ANTHROPIC_API_KEY"]
    logger.warning(
        "Đã xóa ANTHROPIC_API_KEY khỏi môi trường để dùng phiên đăng nhập Claude Code"
    )
    return True


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime configuration; construct directly in tests, from_env in production."""

    service_role_key: str = field(repr=False)
    supabase_url: str = DEFAULT_SUPABASE_URL
    anon_key: str = field(default="", repr=False)
    model: str = DEFAULT_MODEL
    analysis_model: str = DEFAULT_MODEL
    host: str = "127.0.0.1"
    port: int = 8767
    allowed_origin: str = "https://ai.banhmique.vn"
    skills_dir: Path = DEFAULT_REFERENCE_SKILLS

    def __post_init__(self) -> None:
        if not self.service_role_key:
            raise ConfigError("SUPABASE_SERVICE_ROLE_KEY là bắt buộc")
        if not self.supabase_url:
            raise ConfigError("SUPABASE_URL là bắt buộc")
        if not self.analysis_model:
            object.__setattr__(self, "analysis_model", self.model)
        if not 1 <= self.port <= 65535:
            raise ConfigError("PORT phải trong khoảng 1..65535")
        object.__setattr__(self, "supabase_url", self.supabase_url.rstrip("/"))

    @property
    def auth_api_key(self) -> str:
        """The anon key when present, otherwise the service key for auth calls."""

        return self.anon_key or self.service_role_key

    def merchant_config(self) -> MerchantAgentConfig:
        """The reference-repo config with BMQ's model and Vietnamese brand voice."""

        return MerchantAgentConfig(
            brand_name="Bánh Mì Que BMQ",
            assistant_name="VNAgent",
            brand_voice=(
                "ngắn gọn, nêu số liệu cụ thể, trả lời bằng tiếng Việt; luôn tự xưng là VNAgent (không xưng em hay tôi) và gọi người dùng là anh; "
                "không dùng thuật ngữ kỹ thuật tiếng Anh (staging, tool, session) mà nói 'bản nháp chờ duyệt', 'đăng nhập lại'; "
                "không bao giờ nhắc tên công cụ, model hay hệ thống nội bộ (Sushi, Claude, Haiku, "
                "OpenAI, Supabase, MCP, bmq-analytics) trong câu trả lời"
            ),
            model=self.model,
            analysis_model=self.analysis_model,
            # The analysis delegate runs as a background subagent on the Agent SDK and
            # the request/response chat ended turns with "I'll report back"; keep it off.
            enable_analysis=os.environ.get("MERCHANT_ENABLE_ANALYSIS", "").strip().lower() in {"1", "true", "yes"},
            analysis_sql_only=True,
            # GĐ1 can only apply price and promotion/campaign changes; hide the stage
            # tools whose changes could never be applied.
            enable_inventory=False,
            enable_listing_edits=False,
            analysis_use_code_execution=False,
            max_analysis_rows=200,
            max_campaign_budget=100_000_000_000,
        )

    @classmethod
    def from_env(cls) -> "Settings":
        service_role_key = _env_text("SUPABASE_SERVICE_ROLE_KEY")
        if not service_role_key:
            raise ConfigError("SUPABASE_SERVICE_ROLE_KEY là bắt buộc")
        skills_raw = _env_text("MERCHANT_SKILLS_DIR") or str(
            DEFAULT_REFERENCE_SKILLS
        )
        model = _env_text("MERCHANT_MODEL") or DEFAULT_MODEL
        return cls(
            service_role_key=service_role_key,
            supabase_url=_env_text("SUPABASE_URL") or DEFAULT_SUPABASE_URL,
            anon_key=_env_text("SUPABASE_ANON_KEY"),
            model=model,
            analysis_model=_env_text("MERCHANT_ANALYSIS_MODEL") or model,
            host=_env_text("HOST") or "127.0.0.1",
            port=_env_int("PORT", 8767),
            allowed_origin=_env_text("ALLOWED_ORIGIN") or "https://ai.banhmique.vn",
            skills_dir=Path(skills_raw),
        )
