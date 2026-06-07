#!/usr/bin/env python3
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "src/pages/QAInspection.tsx"
text = source.read_text(encoding="utf-8")

required_markers = [
    "normalizeLabelIdentity",
    "labelSpecByProductName",
    "const getLabelSpecForItem =",
    "getLabelSpecForItem(item)",
    "SKU chưa có cấu hình tem nhãn cho sản phẩm này.",
]

missing = [marker for marker in required_markers if marker not in text]
assert not missing, f"QA label spec fallback missing markers: {missing}"

assert "const spec = item.sku_id ? labelSpecBySku.get(item.sku_id) : null;" not in text, (
    "QA scan must not rely only on production_order_items.sku_id because older/live production orders can have NULL sku_id."
)

assert "sku_id: spec?.sku_id || item.sku_id || null" in text, (
    "QA label audit rows should backfill sku_id from the matched product label spec when order item sku_id is missing."
)

print("QA label spec fallback regression checks passed")
