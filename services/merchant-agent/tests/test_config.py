from __future__ import annotations

import pytest

from bmq_merchant.config import ConfigError, Settings


def test_analysis_model_defaults_to_main_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
    monkeypatch.setenv("MERCHANT_MODEL", "claude-test-main")
    monkeypatch.delenv("MERCHANT_ANALYSIS_MODEL", raising=False)

    settings = Settings.from_env()

    assert settings.model == "claude-test-main"
    assert settings.analysis_model == "claude-test-main"
    assert settings.merchant_config().brand_name == "Bánh Mì Que BMQ"


def test_brand_voice_uses_bmq_agent_in_both_languages() -> None:
    settings = Settings(service_role_key="test-service-key")

    config = settings.merchant_config()

    assert config.assistant_name == "BMQ Agent"
    assert "BMQ Agent" in config.brand_voice
    assert "tiếng Anh" in config.brand_voice
    assert "VNAgent" not in config.brand_voice


def test_service_role_key_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    with pytest.raises(ConfigError):
        Settings.from_env()
