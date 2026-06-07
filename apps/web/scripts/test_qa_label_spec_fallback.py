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

control_text = (Path(__file__).resolve().parents[1] / "src/lib/product-label-control.ts").read_text(encoding="utf-8")
assert "Sai barcode" not in control_text and "Sai mã vạch" not in control_text, (
    "QA label scan should validate only NSX, HSD, and configured net weight — not barcode."
)
assert "Sai mã SP đối tác" not in control_text and "Sai tên sản phẩm" not in control_text, (
    "QA label scan should not block QA pass on product/code OCR noise when date and weight are valid."
)

for marker in [
    "expected_barcode_image_url",
    "data-qa-barcode-crop-compare",
    "Ảnh barcode mẫu",
    "Ảnh barcode vừa quét",
    "Mã vạch",
    "Barcode {",
]:
    assert marker not in text, f"QA pass UI/payload still includes barcode marker: {marker}"

print("QA label spec fallback and no-barcode QA regression checks passed")
