#!/usr/bin/env python3
"""Static contract for grouped warehouse sidebar navigation."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDEBAR = (ROOT / "src/components/layout/Sidebar.tsx").read_text()
LANGUAGE = (ROOT / "src/contexts/LanguageContext.tsx").read_text()

EXPECTED_GROUP = '''  {
    icon: Package,
    labelKey: "inventory",
    section: "operations",
    children: [
      { icon: Package, labelKey: "inventoryOverview", path: "/inventory", section: "operations", moduleKey: "inventory" },
      { icon: Boxes, labelKey: "tanTaoWarehouse", path: "/warehouse/tan-tao", section: "operations", moduleKey: "inventory" },
      { icon: CookingPot, labelKey: "kitchenInventory", path: "/kitchen-inventory", section: "operations", moduleKey: "kitchen_inventory" },
      { icon: PackageCheck, labelKey: "goodsReceipts", path: "/goods-receipts", section: "operations", moduleKey: "goods_receipts" },
      { icon: Truck, labelKey: "warehouseDispatch", path: "/warehouse/dispatch", section: "operations", moduleKey: "inventory" },
      { icon: BarChart4, labelKey: "stockReport", path: "/warehouse/stock-report", section: "operations", moduleKey: "inventory" },
    ],
  },'''

assert EXPECTED_GROUP in SIDEBAR, "All warehouse pages must live under one non-clickable Kho hàng parent"
assert 'inventoryOverview: string;' in LANGUAGE
assert 'inventoryOverview: "Inventory Overview"' in LANGUAGE
assert 'inventoryOverview: "Tổng quan kho"' in LANGUAGE

assert 'onClick={() => collapsed && setCollapsed(false)}' in SIDEBAR
assert 'const groupActive = item.children ? item.children.some(isChildActive) : false;' in SIDEBAR
assert 'data-sidebar-active={collapsed && groupActive ? "true" : undefined}' in SIDEBAR

for route in (
    "/inventory",
    "/warehouse/tan-tao",
    "/kitchen-inventory",
    "/goods-receipts",
    "/warehouse/dispatch",
    "/warehouse/stock-report",
):
    assert SIDEBAR.count(f'path: "{route}"') == 1, f"{route} must appear exactly once in sidebar"

assert '{ icon: Barcode, labelKey: "skuCosts", path: "/sku-costs"' in SIDEBAR
assert '{ icon: Boxes, labelKey: "materialMaster", path: "/material-master"' in SIDEBAR
print("warehouse sidebar group contract passed")
