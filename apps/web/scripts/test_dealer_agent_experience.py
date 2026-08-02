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

    def test_chat_turn_renders_customer_bubble_then_agent_processing_state(self) -> None:
        self.assertIn('const [nppLastSentOrderText, setNppLastSentOrderText] = useState("")', self.source)
        parse_body = self.source.split("const handleParseNppOrderText = () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("const submittedText = nppOrderText.trim()", parse_body)
        self.assertIn("setNppLastSentOrderText(submittedText)", parse_body)
        self.assertIn('setNppOrderText("")', parse_body)
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-chat-message="customer"', panel)
        self.assertIn("BMQ Agent đang xử lý", panel)
        self.assertIn('data-dealer-chat-status="processing"', panel)
        self.assertIn("scrollIntoView", panel)
        self.assertIn("data-dealer-chat-scroll-anchor", panel)

    def test_agent_returns_clickable_order_preview_inside_chat(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-order-preview-card="chat-attachment"', panel)
        self.assertIn("Bản xác nhận đơn hàng", panel)
        self.assertIn("Chạm để xem chi tiết", panel)
        self.assertIn("onClick={openOrderConfirmation}", panel)
        self.assertNotIn('data-stitch-dealer-order-bottom-bar="mobile"', panel)
        self.assertNotIn('data-stitch-dealer-order-bottom-bar="desktop"', panel)

    def test_npp_submit_uses_chat_success_bubble_not_success_dialog(self) -> None:
        submit_body = self.source.split("const confirmSubmitNppOrder = async () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("chatNative: true", submit_body)
        chat_branch = self.source.split('if (activeNav === "order" && isNppMode)', 1)[1].split("\n  return (", 1)[0]
        self.assertNotIn("orderMessage ? <div", chat_branch)
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-chat-message="success"', panel)
        self.assertIn("Đã nhận đơn thành công", panel)
        self.assertIn('data-dealer-chat-message="error"', panel)

    def test_order_submit_ctas_open_final_confirmation_before_sending(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn("const openOrderConfirmation", panel)
        self.assertEqual(panel.count("onClick={openOrderConfirmation}"), 1)
        self.assertEqual(panel.count("onClick={onSubmit}"), 1)
        pre_confirmation = panel.split('<Dialog open={detailOpen}', 1)[0]
        confirmation = panel.split('<Dialog open={detailOpen}', 1)[1]
        self.assertNotIn("onClick={onSubmit}", pre_confirmation)
        self.assertIn("onClick={onSubmit}", confirmation)
        self.assertIn("Xác nhận & gửi đơn", panel)

    def test_final_confirmation_is_read_only_until_customer_edits(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-order-confirmation-mode={isEditingOrder ? "edit" : "review"}', panel)
        self.assertIn("Chỉnh sửa đơn", panel)
        self.assertIn("Lưu thay đổi", panel)
        self.assertIn("isEditingOrder ? (", panel)
        self.assertIn("<MiniQuantityField", panel)

    def test_final_confirmation_uses_bmq_pink_theme_not_legacy_amber(self) -> None:
        modal = self.source.split('<Dialog open={detailOpen}', 1)[1].split("</Dialog>", 1)[0]
        self.assertNotIn("amber", modal)
        self.assertIn("#d94f8a", modal)
        self.assertIn("#fff5f9", modal)


if __name__ == "__main__":
    unittest.main()
