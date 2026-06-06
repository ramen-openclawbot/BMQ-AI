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
    fn = ROOT / "supabase/functions/scan-product-label/index.ts"
    assert fn.exists()
    text = fn.read_text(encoding="utf-8")
    assert "extract_product_label_data" in text
    assert "manufacturing_date" in text
    assert "expiry_date" in text
    assert "net_weight_value" in text


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
