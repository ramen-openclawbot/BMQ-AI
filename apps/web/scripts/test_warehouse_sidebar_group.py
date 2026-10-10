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
      { icon: Package, labelKey: "inventoryOverview", path: "/inventory", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
      { icon: ClipboardList, labelKey: "stockLedger", path: "/warehouse/stock-ledger", section: "operations", moduleKey: "inventory" },
      { icon: Boxes, labelKey: "tanTaoWarehouse", path: "/warehouse/tan-tao", section: "operations", moduleKey: "inventory" },
      { icon: CookingPot, labelKey: "kitchenInventory", path: "/kitchen-inventory", section: "operations", moduleKey: "kitchen_inventory", hiddenFromMenu: true },
      { icon: PackageCheck, labelKey: "goodsReceipts", path: "/goods-receipts", section: "operations", moduleKey: "goods_receipts" },
      { icon: Truck, labelKey: "warehouseDispatch", path: "/warehouse/dispatch", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
      { icon: BarChart4, labelKey: "stockReport", path: "/warehouse/stock-report", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
    ],
  },'''

assert EXPECTED_GROUP in SIDEBAR, "All warehouse pages must live under one non-clickable Kho hàng parent"
assert 'inventoryOverview: string;' in LANGUAGE
assert 'inventoryOverview: "Inventory Overview"' in LANGUAGE
assert 'inventoryOverview: "Tổng quan kho"' in LANGUAGE

# Demo 3 shell: the group parent is a plain label in the app drawer (never a link),
# and the top navigation's "Kho" zone lists the same pages.
NAVIGATION = (ROOT / "src/components/layout/navigation.ts").read_text()
assert '<div className="d3-drawer-group-label">' in SIDEBAR
assert 'data-sidebar-active={childActive ? "true" : undefined}' in SIDEBAR
warehouse_zone = NAVIGATION.split('id: "warehouse"', 1)[1].split("prefixes:", 1)[0]
for route in ("/warehouse/stock-ledger", "/warehouse/tan-tao", "/goods-receipts", "/purchase-orders"):
    assert f'"{route}"' in warehouse_zone, f"{route} must be in the Kho zone"

# 2026-10-10: pages with no entries in 30 days are hidden from the menus but stay routable.
for route in ("/inventory", "/kitchen-inventory", "/warehouse/dispatch", "/warehouse/stock-report", "/low-stock"):
    assert f'"{route}"' not in warehouse_zone, f"{route} must be hidden from the Kho zone"
production_zone = NAVIGATION.split('id: "production"', 1)[1].split("prefixes:", 1)[0]
assert '"/production/q7/inventory"' not in production_zone
assert '{ icon: AlertTriangle, labelKey: "lowStock", path: "/low-stock", section: "operations", moduleKey: "low_stock", hiddenFromMenu: true }' in SIDEBAR
assert ".filter((item) => !item.hiddenFromMenu)" in SIDEBAR
assert "!child.hiddenFromMenu && canViewItem(child)" in SIDEBAR

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
assert warehouse_zone.index('"/warehouse/stock-ledger"') < warehouse_zone.index('"/warehouse/tan-tao"'), "Sổ tồn NVL leads the Kho zone"
assert 'stockLedger: "Sổ tồn NVL"' in LANGUAGE
print("warehouse sidebar group contract passed")
