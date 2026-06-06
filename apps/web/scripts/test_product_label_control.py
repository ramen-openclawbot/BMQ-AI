from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_product_label_schema_and_scan_function_exist():
    migrations = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert "product_label_specs" in migrations
    assert "qa_label_checks" in migrations
    assert "shelf_life_days" in migrations
    assert "net_weight_value" in migrations
    assert "traceability_sheet_url" in migrations
    assert "barcode_value" in migrations
    assert "partner_product_code" in migrations
    assert "expected_barcode" in migrations
    assert "expected_partner_product_code" in migrations
    assert "extracted_barcode" in migrations
    fn = ROOT / "supabase/functions/scan-product-label/index.ts"
    assert fn.exists()
    text = fn.read_text(encoding="utf-8")
    assert "extract_product_label_data" in text
    assert "manufacturing_date" in text
    assert "expiry_date" in text
    assert "net_weight_value" in text
    assert "barcode" in text
    assert "partner_product_code" in text


def test_production_product_management_route_and_sidebar_exist():
    routes = read("src/components/AppRoutes.tsx")
    sidebar = read("src/components/layout/Sidebar.tsx")
    lang = read("src/contexts/LanguageContext.tsx")
    page = ROOT / "src/pages/ProductionProducts.tsx"
    assert page.exists()
    assert "@/pages/ProductionProducts" in routes
    assert 'path="/production/products"' in routes
    assert 'labelKey: "productionProducts"' in sidebar
    assert 'path: "/production/products"' in sidebar
    assert "productionProducts" in lang


def test_production_product_management_has_dedicated_permission_key():
    routes = read("src/components/AppRoutes.tsx")
    sidebar = read("src/components/layout/Sidebar.tsx")
    user_management = read("src/hooks/useUserManagement.ts")
    auth_context = read("src/contexts/AuthContext.tsx")
    migrations = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "supabase/migrations").glob("*.sql"))
    assert 'production_products: "Quản lý sản phẩm"' in routes
    assert 'path="/production/products" element={<ModuleRoute moduleKey="production_products"' in routes
    assert 'path: "/production/products", section: "production", moduleKey: "production_products"' in sidebar
    assert '{ key: "production_products", labelEn: "Product Management", labelVi: "Quản lý sản phẩm" }' in user_management
    assert '"production_q7","production_products","production_shifts"' in user_management
    assert '"production_q7", "production_products", "production_shifts"' in auth_context
    assert "module_key = 'production_products'" in migrations
    assert "module_key = 'production_q7'" in migrations


def test_production_product_management_uses_sku_dropdown():
    page = read("src/pages/ProductionProducts.tsx")
    assert "data-production-products-sku-dropdown" in page
    assert "SelectTrigger" in page
    assert "SelectContent" in page
    assert "handleSelectSkuId" in page
    assert "grid gap-3 md:grid-cols-2 xl:grid-cols-3" not in page


def test_product_label_fixed_partner_codes_are_managed_and_enforced():
    helper = read("src/lib/product-label-control.ts")
    page = read("src/pages/ProductionProducts.tsx")
    qa = read("src/pages/QAInspection.tsx")
    assert "barcode_value" in helper
    assert "partner_product_code" in helper
    assert "normalizeLabelIdentity" in helper
    assert "Mã SP theo đối tác" in page
    assert "data-product-label-ai-identity-fields" in page
    assert "data-product-label-save-button" in page
    assert "type=\"button\"" in page
    assert "Tự lấy từ tem mẫu" in page
    assert "placeholder=\"Ví dụ: 893...\"" not in page
    assert "placeholder=\"Ví dụ: SP001986\"" not in page
    assert "barcode_value,partner_product_code" in page
    assert "barcode_value" in qa
    assert "partner_product_code" in qa
    assert "expected_barcode" in qa
    assert "expected_partner_product_code" in qa
    assert "Sai mã vạch" in helper
    assert "Sai mã SP đối tác" in helper


def test_product_label_setup_does_not_render_standalone_barcode_value_box():
    page = read("src/pages/ProductionProducts.tsx")
    assert "Ảnh barcode mẫu" in page
    assert "data-product-label-template-upload" in page
    assert "data-product-label-barcode-value-box" not in page
    assert "<Label>Mã vạch</Label>" not in page
    assert "{draft.barcode_value || \"Chưa có\"}" not in page


def test_product_label_save_button_is_not_covered_by_mobile_agent_chat():
    page = read("src/pages/ProductionProducts.tsx")
    agent = read("src/components/agent/GlobalAgentChatWidget.tsx")
    assert "data-product-label-save-button" in page
    assert "type=\"button\"" in page
    assert "isProductionProductsMobileContext" in agent
    assert 'location.pathname.startsWith("/production/products")' in agent
    assert "shouldLiftMobileChatButton = isRevenueMobileContext || isSkuCostsMobileContext || isPurchaseOrdersMobileContext || isProductionProductsMobileContext" in agent


def test_product_label_save_shows_inline_success_confirmation():
    page = read("src/pages/ProductionProducts.tsx")
    assert "saveSuccessAt" in page
    assert "data-product-label-save-success" in page
    assert "Đã lưu thành công" in page
    assert "setSaveSuccessAt(new Date())" in page
    assert "setSaveSuccessAt(null)" in page


def test_template_scan_overwrites_identity_from_ai_without_manual_expected_values():
    page = read("src/pages/ProductionProducts.tsx")
    assert "barcode_value: undefined" in page
    assert "partner_product_code: undefined" in page
    assert "barcode_value: extracted?.barcode || \"\"" in page
    assert "partner_product_code: extracted?.partner_product_code || extracted?.product_code || \"\"" in page
    assert "current.barcode_value || extracted?.barcode" not in page
    assert "current.partner_product_code || extracted?.partner_product_code" not in page


def test_production_product_management_shows_selected_sku_image():
    page = read("src/pages/ProductionProducts.tsx")
    assert "image_url" in page
    assert 'select("id,sku_code,product_name,unit,category,sku_type,image_url")' in page
    assert 'data-production-products-sku-image="selected-sku"' in page
    assert "selectedSku.image_url" in page
    assert "Chưa có ảnh" in page


def test_product_label_template_upload_and_barcode_crop_reference():
    migrations = "\n".join(p.read_text(encoding="utf-8") for p in (ROOT / "supabase/migrations").glob("*.sql"))
    page = read("src/pages/ProductionProducts.tsx")
    qa = read("src/pages/QAInspection.tsx")
    fn = read("supabase/functions/scan-product-label/index.ts")
    helper = read("src/lib/product-label-control.ts")
    assert "label-template-images" in migrations
    assert "label_template_image_url" in migrations
    assert "barcode_crop_image_url" in migrations
    assert "barcode_crop_bbox" in migrations
    assert "expected_barcode_crop_image_url" in migrations
    assert "extracted_barcode_crop_image_url" in migrations
    assert "data-product-label-template-upload" in page
    assert "handleTemplateFileChange" in page
    assert "barcode_crop_image_url" in page
    assert "barcode_crop_bbox" in page
    assert "cropImageByBox" in page
    assert "barcode_bbox" in fn
    assert "barcode_crop_confidence" in fn
    assert "detect the barcode bounding box" in fn
    assert "barcode_crop_image_url" in helper
    assert "extracted_barcode_crop_image_url" in qa
    assert "Ảnh barcode mẫu" in qa
    assert "Ảnh barcode vừa quét" in qa


def test_label_date_math_and_qa_block_markers():
    helper = read("src/lib/product-label-control.ts")
    qa = read("src/pages/QAInspection.tsx")
    assert "expectedLabelDates" in helper
    assert "addDaysUtc" in helper
    assert "shelfLifeDays - 1" in helper
    assert "expectedNsx" in helper
    assert "expectedHsd" in helper
    assert "data-label-control=\"per-sku-label-scan\"" in qa
    assert "scan-product-label" in qa
    assert "allLabelChecksPassed" in qa
    assert "Không cho nhập kho" in qa
    assert "qa_label_checks" in qa


def test_label_expected_date_example_documented():
    helper = read("src/lib/product-label-control.ts")
    assert "06/06/2026" in helper
    assert "07/06/2026" in helper
    assert "09/06/2026" in helper
