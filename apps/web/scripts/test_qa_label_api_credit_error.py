#!/usr/bin/env python3
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "src/pages/QAInspection.tsx"
text = source.read_text(encoding="utf-8")

expected = "Hết API credit. Vui lòng liên hệ bộ phận quản trị."

assert expected in text, "QA label scan must show the approved Vietnamese API-credit message."
assert "const getLabelScanErrorMessage" in text, "QA label scan needs a dedicated error mapper."
assert "reason: getLabelScanErrorMessage(error)" in text, (
    "QA label scan failures must use the dedicated user-facing error mapper."
)
assert 'message.includes("Edge Function returned a non-2xx status code")' in text, (
    "The generic Supabase Edge Function failure must map to the API-credit message."
)

print("QA label API-credit error copy regression check passed")
