#!/usr/bin/env python3
"""Regression guards for the approved Zalo-inspired BMQ ordering agent flow."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/DealerPortal.tsx"


class DealerAgentExperienceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = PORTAL.read_text(encoding="utf-8")

    def test_authenticated_dealer_lands_on_agent_inbox(self) -> None:
        self.assertIn('useState("messages")', self.source)
        self.assertIn('data-dealer-agent-screen="inbox"', self.source)
        self.assertIn('data-dealer-agent-row="order"', self.source)
        self.assertIn('onClick={() => setActiveNav("order")}', self.source)
        self.assertIn("BMQ Agent", self.source)
        self.assertIn("Hôm nay mình đặt món gì ạ?", self.source)

    def test_inbox_is_a_simple_message_list(self) -> None:
        self.assertIn("Tin nhắn", self.source)
        self.assertIn("Tìm kiếm BMQ Agent", self.source)
        self.assertIn("BMQ Theo dõi đơn", self.source)
        self.assertIn("BMQ Chăm sóc khách hàng", self.source)
        self.assertIn('data-dealer-agent-nav="messages-orders-account"', self.source)
        self.assertIn("Đơn hàng", self.source)
        self.assertIn("Tài khoản", self.source)

    def test_login_uses_phone_otp_agent_entry(self) -> None:
        self.assertIn('data-dealer-agent-screen="login"', self.source)
        self.assertIn("Đặt món cùng BMQ Agent", self.source)
        self.assertIn("Nhập số điện thoại của anh", self.source)
        self.assertIn("Gửi mã OTP Zalo", self.source)
        self.assertIn("Thông tin của anh được BMQ bảo mật", self.source)

    def test_chat_has_dedicated_agent_header_and_back_action(self) -> None:
        self.assertIn('data-dealer-agent-screen="chat"', self.source)
        self.assertIn('aria-label="Quay lại danh sách tin nhắn"', self.source)
        self.assertIn('setActiveNav("messages")', self.source)
        self.assertIn("Đang trực tuyến", self.source)
        self.assertIn("Nhắn BMQ Agent…", self.source)

    def test_logout_resets_next_login_to_agent_inbox(self) -> None:
        logout_body = self.source.split("const handleLogoutDealer = () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn('setActiveNav("messages")', logout_body)

    def test_inbox_greeting_uses_the_authenticated_dealer_name(self) -> None:
        self.assertNotIn("Chào anh Minh", self.source)
        self.assertIn("Chào {dealerDisplayName}", self.source)


if __name__ == "__main__":
    unittest.main()
