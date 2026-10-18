from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bmq_merchant.config import Settings
from bmq_merchant.supabase import SupabaseClient

TEST_SUPABASE_URL = "https://test-project.supabase.co"
TEST_SERVICE_KEY = "service-role-test-key-not-real"
TEST_ANON_KEY = "anon-test-key-not-real"


@pytest.fixture
def settings() -> Settings:
    return Settings(
        service_role_key=TEST_SERVICE_KEY,
        supabase_url=TEST_SUPABASE_URL,
        anon_key=TEST_ANON_KEY,
    )


@pytest.fixture
def supabase(settings: Settings) -> SupabaseClient:
    return SupabaseClient(
        supabase_url=settings.supabase_url,
        service_role_key=settings.service_role_key,
        anon_key=settings.anon_key,
    )
