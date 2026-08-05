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
        self.assertNotIn("BMQ Theo dõi đơn", self.source)
        self.assertIn("BMQ Chăm sóc khách hàng", self.source)
        self.assertIn('data-dealer-agent-nav="messages-orders-account"', self.source)
        self.assertIn("Đơn hàng", self.source)
        self.assertIn("Tài khoản", self.source)

    def test_login_uses_phone_otp_agent_entry(self) -> None:
        self.assertIn('data-dealer-agent-screen="login"', self.source)
        self.assertIn("Đặt món cùng BMQ Agent", self.source)
        self.assertIn("BMQ chuẩn bị đơn hàng cho Quý Khách Hàng ngay", self.source)
        self.assertIn("Nhập số điện thoại của Quý Khách Hàng", self.source)
        self.assertIn("Gửi mã OTP Zalo", self.source)
        self.assertIn("Thông tin của Quý Khách Hàng được BMQ bảo mật", self.source)

    def test_customer_facing_copy_is_gender_neutral(self) -> None:
        for outdated_copy in (
            "Anh/chị bấm tải lại",
            "Đã xác thực đại lý. Anh có thể",
            "Cảm ơn anh đã đặt hàng",
            "Anh kiểm tra",
            "Anh chưa có đơn",
            "Anh có thể nhắn",
            "Anh chỉ cần nhắn",
            "Anh chọn Xem mẫu",
            "cho anh ngay",
            "của anh",
            "Anh nhập số lượng",
            "Chào anh",
        ):
            self.assertNotIn(outdated_copy, self.source)

    def test_chat_has_dedicated_agent_header_and_back_action(self) -> None:
        self.assertIn('data-dealer-agent-screen="chat"', self.source)
        self.assertIn('aria-label="Quay lại danh sách tin nhắn"', self.source)
        self.assertIn('setActiveNav("messages")', self.source)
        chat_header = self.source.split('data-dealer-agent-screen="chat"', 1)[1].split("</header>", 1)[0]
        self.assertIn("Trợ lý đặt hàng", chat_header)
        self.assertNotIn("Đang trực tuyến", chat_header)
        self.assertNotIn("bg-emerald-500", chat_header)
        self.assertIn("Nhắn BMQ Agent…", self.source)

    def test_authenticated_secondary_screens_have_zalo_style_back_action(self) -> None:
        portal_header = self.source.split('data-dealer-secondary-header="true"', 1)[1].split("</header>", 1)[0]
        self.assertIn('data-dealer-agent-back="secondary-screen"', portal_header)
        self.assertIn('aria-label="Quay lại danh sách tin nhắn"', portal_header)
        self.assertIn('onClick={() => setActiveNav("messages")}', portal_header)
        self.assertLess(portal_header.index("data-dealer-agent-back"), portal_header.index('alt="BMQ"'))

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
        self.assertIn("Xác nhận đơn hàng", panel)
        self.assertIn("onClick={openOrderConfirmation}", panel)
        self.assertNotIn('data-stitch-dealer-order-bottom-bar="mobile"', panel)
        self.assertNotIn('data-stitch-dealer-order-bottom-bar="desktop"', panel)

    def test_order_preview_matches_approved_compact_product_design(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-order-preview-product="compact"', panel)
        self.assertIn('data-dealer-order-preview-product-image', panel)
        self.assertIn("product.imageUrl", panel)
        self.assertIn("{product.name}", panel)
        self.assertIn("{formatVnd(product.price)} / {unitLabel}", panel)
        self.assertIn("h-16 w-16", panel)
        self.assertIn('className="min-w-0 flex-1 max-w-sm rounded-[22px]', panel)
        self.assertNotIn('className="w-full max-w-sm rounded-[22px]', panel)
        self.assertIn('data-dealer-order-preview-total="quantity"', panel)
        self.assertIn('data-dealer-order-preview-total="amount"', panel)
        self.assertIn('data-dealer-chat-choice="confirm"', panel)
        self.assertIn('data-dealer-chat-choice="edit"', panel)
        self.assertIn('data-dealer-chat-choice="new-order"', panel)
        self.assertNotIn("Chạm để xem chi tiết", panel)

    def test_confirmation_intent_bypasses_order_parser_and_opens_review(self) -> None:
        self.assertIn("DEALER_CHAT_CONFIRMATION_INTENTS", self.source)
        self.assertIn('"ok"', self.source)
        self.assertIn('"dong y"', self.source)
        parse_body = self.source.split("const handleParseNppOrderText = () => {", 1)[1].split("\n  };", 1)[0]
        intent_index = parse_body.index("isDealerChatConfirmationIntent(submittedText)")
        processing_index = parse_body.index('setNppParseStatus("processing")')
        self.assertLess(intent_index, processing_index)
        self.assertIn("setNppConfirmOpen(true)", parse_body)
        self.assertIn("return", parse_body[intent_index:processing_index])

    def test_ready_order_uses_explicit_multiple_choice_actions(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-chat-choices="order-ready"', panel)
        self.assertIn('data-dealer-chat-choice="confirm"', panel)
        self.assertIn('data-dealer-chat-choice="edit"', panel)
        self.assertIn('data-dealer-chat-choice="new-order"', panel)
        self.assertIn("Xác nhận gửi", panel)
        self.assertIn("Chỉnh sửa", panel)
        self.assertIn("Đặt đơn khác", panel)

    def test_parser_failure_offers_recovery_choices(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-chat-choices="parse-recovery"', panel)
        self.assertIn("Nhập lại đơn", panel)
        self.assertIn("Xem mẫu", panel)

    def test_all_unmatched_parsed_lines_return_to_recovery_state(self) -> None:
        parse_body = self.source.split("const handleParseNppOrderText = () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("const matchedLineCount = parsedLines.length - unmatched.length", parse_body)
        unmatched_branch = parse_body.split("if (matchedLineCount === 0)", 1)[1].split('setNppParseStatus("success")', 1)[0]
        self.assertIn('setNppParseStatus("idle")', unmatched_branch)
        self.assertIn("return", unmatched_branch)

    def test_retail_dealer_order_opens_the_same_agent_chat(self) -> None:
        self.assertIn('if (activeNav === "order")', self.source)
        self.assertNotIn('if (activeNav === "order" && isNppMode)', self.source)
        self.assertIn("const retailDealerRoute", self.source)
        self.assertIn("const chatOrderRoutes", self.source)

    def test_retail_parser_accepts_quantity_exchange_and_makeup_without_name(self) -> None:
        parser = self.source.split("function parseRetailDealerChatOrderText", 1)[1].split("function PublicLandingSupport", 1)[0]
        self.assertIn("orderedQuantity", parser)
        self.assertIn("exchangeQuantity", parser)
        self.assertIn("makeupQuantity", parser)
        self.assertIn("physicalQuantity", parser)
        self.assertIn("return []", parser)
        self.assertNotIn("findDealerChatRoute", parser)

    def test_retail_parser_accepts_optional_dat_prefix_before_quantity(self) -> None:
        parser = self.source.split("function parseRetailDealerChatOrderText", 1)[1].split("function PublicLandingSupport", 1)[0]
        self.assertIn('const normalizedLine = rawLine.replace(/^(?:đặt|dat)\\s+/i, "");', parser)
        self.assertIn("normalizedLine.match", parser)
        self.assertIn("const note = normalizedLine", parser)

    def test_parse_handler_keeps_named_route_parser_for_npp_only(self) -> None:
        parse_body = self.source.split("const handleParseNppOrderText = () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("isNppMode", parse_body)
        self.assertIn("setDirectCatalogOrder(false)", parse_body)
        self.assertIn("parseDealerChatOrderText(submittedText, dealerRoutes)", parse_body)
        self.assertIn("parseRetailDealerChatOrderText(submittedText, retailDealerRoute)", parse_body)
        self.assertIn("Quý Khách Hàng chỉ cần nhắn số lượng", parse_body)

    def test_retail_direct_submit_records_exchange_makeup_without_child_route_id(self) -> None:
        submit_body = self.source.split("const confirmSubmitNppOrder = async () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("ordered_quantity", submit_body)
        self.assertIn("exchange_quantity", submit_body)
        self.assertIn("makeup_quantity", submit_body)
        self.assertIn("physical_quantity", submit_body)
        self.assertIn("...(isNppMode", submit_body)
        self.assertIn("route_customer_id", submit_body)
        self.assertIn("route_customer_name: dealerDisplayName", submit_body)

    def test_product_suggestions_show_the_full_active_catalog(self) -> None:
        self.assertIn("const productCarouselProducts = catalogProducts;", self.source)
        self.assertNotIn(".slice(0, 10)", self.source)

    def test_footer_credits_vnagent_design_and_development(self) -> None:
        self.assertIn("© 2026 Bánh Mì Que Pháp", self.source)
        self.assertIn("BMQ. All rights reserved. Powered by VNAgent.ai", self.source)
        self.assertNotIn("Thiết kế và Phát triển bởi VNAgent.ai", self.source)
        self.assertIn("data-dealer-login-footer", self.source)

    def test_product_suggestion_cards_have_uniform_single_line_layout(self) -> None:
        self.assertIn('data-dealer-product-suggestion="card"', self.source)
        self.assertIn("h-[154px]", self.source)
        self.assertIn("truncate text-sm font-bold", self.source)
        self.assertNotIn("line-clamp-2 text-sm font-bold", self.source)

    def test_product_suggestion_opens_detail_inside_chat_render_branch(self) -> None:
        chat_branch = self.source.split('if (activeNav === "order") {\n    return (', 1)[1].split("\n  return (", 1)[0]
        self.assertIn("<ProductDetailDialog", chat_branch)
        self.assertIn("onProductSuggestion={handleProductCta}", chat_branch)
        self.assertIn("data-dealer-product-detail", self.source)

    def test_chat_order_uses_the_product_selected_from_suggestions(self) -> None:
        self.assertIn("const chatProduct =", self.source)
        self.assertIn("product={chatProduct}", self.source)
        self.assertIn("setChatProductId(product.id)", self.source)
        self.assertIn("Đặt sản phẩm này", self.source)

    def test_bare_quantity_defaults_to_bmq_breadstick_without_catalog_order_fallback(self) -> None:
        self.assertIn('const DEFAULT_DEALER_CHAT_PRODUCT_SKU = "BMQ-001";', self.source)
        default_product = self.source.split("const nppProduct = useMemo(", 1)[1].split("const chatProduct = useMemo(", 1)[0]
        self.assertIn("product.skuCode?.trim().toUpperCase() === DEFAULT_DEALER_CHAT_PRODUCT_SKU", default_product)
        self.assertIn('normalizeDealerChatText(`${product.name} ${product.skuCode || ""}`).includes("banh mi que")', default_product)
        self.assertNotIn("catalogProducts[0]", default_product)
        chat_product = self.source.split("const chatProduct = useMemo(", 1)[1].split("const nppSelectedLines", 1)[0]
        self.assertIn("product.id === chatProductId", chat_product)
        self.assertIn("|| nppProduct", chat_product)

    def test_product_quantity_creates_chat_confirmation_for_any_authenticated_dealer(self) -> None:
        self.assertIn('activeNav === "order"', self.source)
        self.assertIn('setDirectCatalogOrder(true)', self.source)
        self.assertIn('setNppParseStatus("success")', self.source)
        self.assertIn("[retailDealerRoute.id]: nextQuantity", self.source)

    def test_product_quantity_placeholder_cannot_look_like_an_entered_value(self) -> None:
        self.assertNotIn('placeholder="VD: 100"', self.source)
        self.assertIn('placeholder="Nhập số lượng"', self.source)
        self.assertIn('placeholder:text-[#b99aa8]', self.source)

    def test_selected_product_uses_authenticated_dealer_location(self) -> None:
        self.assertIn("const directDealerOrder = !isNppMode || directCatalogOrder;", self.source)
        self.assertIn("directDealerOrder && retailDealerRoute ? [retailDealerRoute]", self.source)
        self.assertIn("isNppMode && !directCatalogOrder", self.source)
        self.assertNotIn("Anh nhập tên điểm và số lượng để em chuẩn bị đơn.", self.source)
        detail_component = self.source.split("function ProductDetailDialog", 1)[1].split("function NppQuickOrderPanel", 1)[0]
        self.assertIn('htmlFor="dealer-product-quantity"', detail_component)
        self.assertNotIn("!isNppMode ?", detail_component)

    def test_agent_avatar_has_no_online_badge_overlay(self) -> None:
        self.assertNotIn("absolute bottom-0 right-0", self.source)

    def test_order_preview_only_shows_large_quantity_and_amount_totals(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        preview = panel.split('data-dealer-order-preview-card="chat-attachment"', 1)[1].split("</button>", 1)[0]
        self.assertIn('data-dealer-order-preview-total="quantity"', preview)
        self.assertIn('data-dealer-order-preview-total="amount"', preview)
        self.assertIn("Tổng số lượng", preview)
        self.assertIn("Tổng tiền", preview)
        self.assertIn("{totalItems} {unitLabel}", preview)
        self.assertIn("{formatVnd(cartTotal)}", preview)
        self.assertIn("text-2xl", preview)
        self.assertNotIn("điểm giao", preview)
        self.assertNotIn("selectedRoutes.slice", preview)
        self.assertNotIn("selectedRouteCount", preview)
        self.assertNotIn("linear-gradient", preview)

    def test_npp_submit_uses_chat_success_bubble_not_success_dialog(self) -> None:
        submit_body = self.source.split("const confirmSubmitNppOrder = async () => {", 1)[1].split("\n  };", 1)[0]
        self.assertIn("chatNative: true", submit_body)
        chat_branch = self.source.split('if (activeNav === "order")', 1)[1].split("\n  return (", 1)[0]
        self.assertNotIn("orderMessage ? <div", chat_branch)
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn('data-dealer-chat-message="success"', panel)
        self.assertIn("Đã nhận đơn thành công", panel)
        self.assertIn('data-dealer-chat-message="error"', panel)

    def test_order_submit_ctas_open_final_confirmation_before_sending(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        self.assertIn("const openOrderConfirmation", panel)
        self.assertEqual(panel.count("onClick={openOrderConfirmation}"), 2)
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

    def test_submit_error_is_visible_inside_open_confirmation(self) -> None:
        modal = self.source.split('<Dialog open={detailOpen}', 1)[1].split("</Dialog>", 1)[0]
        self.assertIn('data-dealer-order-confirmation-error', modal)
        self.assertIn("{errorMessage}", modal)
        self.assertIn('aria-live="assertive"', modal)

    def test_hallmark_studied_dna_is_stamped_on_visible_agent_states(self) -> None:
        self.assertEqual(self.source.count('data-hallmark-dna="dealer-conversational-catalogue"'), 3)
        self.assertIn('data-hallmark-login="branded-rounded"', self.source)
        self.assertIn('data-hallmark-chat="bottom-clustered"', self.source)
        self.assertIn('data-hallmark-preview="single-layer"', self.source)

    def test_login_restores_centered_brand_and_rounded_cards(self) -> None:
        login = self.source.split('data-dealer-agent-screen="login"', 1)[1].split("if (isCatalogRestoring)", 1)[0]
        self.assertIn('data-hallmark-login="branded-rounded"', login)
        self.assertIn("sm:justify-center", login)
        self.assertIn('className="text-center"', login)
        self.assertIn('alt="BMQ" className="mx-auto h-16', login)
        self.assertIn("Hôm nay mình dùng món gì ạ?", login)
        self.assertIn("rounded-[24px]", login)
        self.assertIn("rounded-[28px]", login)
        self.assertIn("items-center justify-center gap-2", login)
        self.assertIn("text-xs sm:text-base", login)
        self.assertNotIn("border-y border-[var(--dealer-rule)]", login)

    def test_customer_agent_surface_uses_one_icon_voice_without_emoji(self) -> None:
        self.assertNotIn("👋", self.source)
        self.assertIn("MessageCircle", self.source)

    def test_chat_clusters_catalogue_and_composer_without_midpage_void(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        catalogue = panel.split('data-hallmark-chat-actions="catalogue"', 1)[1].split('data-dealer-chat-scroll-anchor', 1)[0]
        composer = panel.split('data-hallmark-chat-composer="inline-sticky"', 1)[1].split("<Dialog open={detailOpen}", 1)[0]
        self.assertIn("mt-auto", catalogue)
        self.assertNotIn("mt-auto", composer)
        self.assertIn("whitespace-nowrap", composer)

    def test_order_preview_uses_divider_rows_instead_of_metric_cards(self) -> None:
        panel = self.source.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        preview = panel.split('data-hallmark-preview="single-layer"', 1)[1].split('data-dealer-chat-choices="order-ready"', 1)[0]
        self.assertIn('data-dealer-order-preview-totals="divider-rows"', preview)
        self.assertIn("divide-y", preview)
        self.assertNotIn("grid grid-cols-2", preview)
        self.assertNotIn("rounded-2xl bg-[#fff5f9]", preview)


if __name__ == "__main__":
    unittest.main()
