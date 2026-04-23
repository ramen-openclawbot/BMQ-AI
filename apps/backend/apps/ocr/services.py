from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass
from typing import Iterable

import numpy as np
from django.conf import settings
from PIL import Image

_AMOUNT_RE = re.compile(r"(?<!\d)(\d{1,3}(?:[.,]\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)(?!\d)")
_LABEL_KEYWORDS = (
    "số tiền",
    "so tien",
    "amount",
    "debit amount",
    "credit amount",
    "paid amount",
    "payment amount",
    "giá trị giao dịch",
    "gia tri giao dich",
    "số tiền ghi nợ",
    "so tien ghi no",
    "số tiền ghi có",
    "so tien ghi co",
)
_DISALLOWED_KEYWORDS = (
    "số tài khoản",
    "so tai khoan",
    "account number",
    "account no",
    "reference",
    "mã giao dịch",
    "ma giao dich",
    "transaction id",
    "transaction no",
    "otp",
    "balance",
    "số dư",
    "so du",
    "hotline",
    "phone",
    "ngày",
    "gio",
    "time",
    "date",
)
_APP_UI_DISALLOWED_KEYWORDS = (
    "choose files",
    "no files selected",
    "lưu khai báo",
    "luu khai bao",
    "duyệt & chốt ngày",
    "duyet & chot ngay",
    "tồn quỹ đầu ngày",
    "ton quy dau ngay",
    "ceo khai báo",
    "ceo khai bao",
    "bánh mì quê pháp",
    "banh mi que phap",
)
_CURRENCY_TOKEN_RE = re.compile(r"(?:\b(?:vnd|vnđ|dong)\b|(?<!\w)đ(?!\w))", re.IGNORECASE)

_OCR_ENGINE = None


@dataclass
class OCRLine:
    text: str
    confidence: float


class OcrExtractionError(RuntimeError):
    pass


def parse_amount_vn(value: object) -> int | None:
    if isinstance(value, (int, float)):
        return int(round(value)) if value and value > 0 else None

    raw = str(value or "").strip()
    if not raw:
        return None

    cleaned = re.sub(r"\s+", "", raw)
    cleaned = re.sub(r"[^0-9,.-]", "", cleaned)
    if not cleaned:
        return None

    comma_count = cleaned.count(",")
    dot_count = cleaned.count(".")
    normalized = cleaned

    if comma_count and dot_count:
        if cleaned.rfind(",") > cleaned.rfind("."):
            normalized = cleaned.replace(".", "")
            normalized = re.sub(r",(?=\d{2}$)", ".", normalized)
            normalized = normalized.replace(",", "")
        else:
            normalized = cleaned.replace(",", "")
    elif comma_count:
        parts = cleaned.split(",")
        tail = parts[-1] if parts else ""
        if len(parts) > 2 or (len(parts) > 1 and len(tail) == 3):
            normalized = cleaned.replace(",", "")
        elif len(tail) == 2:
            normalized = cleaned.replace(",", ".")
        else:
            normalized = cleaned.replace(",", "")
    elif dot_count:
        parts = cleaned.split(".")
        tail = parts[-1] if parts else ""
        if len(parts) > 2 or (len(parts) > 1 and len(tail) == 3):
            normalized = cleaned.replace(".", "")
        elif len(tail) != 2:
            normalized = cleaned.replace(".", "")

    try:
        parsed = float(normalized)
    except ValueError:
        return None

    return int(round(parsed)) if parsed > 0 else None


def decode_image_base64(image_base64: str) -> bytes:
    payload = image_base64.split(",", 1)[-1]
    return base64.b64decode(payload)


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _looks_disallowed(text: str) -> bool:
    lowered = text.lower()
    return any(keyword in lowered for keyword in _DISALLOWED_KEYWORDS)


def _label_score(text: str) -> float:
    lowered = text.lower()
    return 2.5 if any(keyword in lowered for keyword in _LABEL_KEYWORDS) else 0.0


def _currency_score(text: str) -> float:
    return 1.4 if _CURRENCY_TOKEN_RE.search(text or "") else 0.0


def _looks_app_ui(text: str) -> bool:
    lowered = text.lower()
    if any(keyword in lowered for keyword in _APP_UI_DISALLOWED_KEYWORDS):
        return True
    return bool(re.search(r"\bimg[_-]?\d{3,}\b", lowered))


def choose_amount_candidate(lines: Iterable[OCRLine]) -> dict[str, object] | None:
    normalized_lines = [OCRLine(text=_clean_text(line.text), confidence=float(line.confidence or 0)) for line in lines if _clean_text(line.text)]
    if not normalized_lines:
        return None

    best: dict[str, object] | None = None
    for index, line in enumerate(normalized_lines):
        neighbor_texts = [line.text]
        if index > 0:
            neighbor_texts.append(normalized_lines[index - 1].text)
        if index + 1 < len(normalized_lines):
            neighbor_texts.append(normalized_lines[index + 1].text)
        neighborhood = " ".join(neighbor_texts)
        label_score = _label_score(neighborhood)
        currency_score = _currency_score(neighborhood)

        for match in _AMOUNT_RE.finditer(line.text):
            raw_amount = match.group(1)
            parsed_amount = parse_amount_vn(raw_amount)
            if not parsed_amount:
                continue

            score = line.confidence
            score += _label_score(line.text)
            score += label_score * 0.7
            score += _currency_score(line.text)
            score += currency_score * 0.4

            if _looks_disallowed(line.text):
                score -= 3.0
            if _looks_disallowed(neighborhood):
                score -= 1.0
            if _looks_app_ui(line.text):
                score -= 3.0
            if _looks_app_ui(neighborhood):
                score -= 1.5
            if label_score <= 0 and currency_score <= 0:
                score -= 1.2
            if parsed_amount < 1000:
                score -= 1.5

            candidate = {
                "amount": parsed_amount,
                "amount_raw": raw_amount,
                "confidence": round(max(0.05, min(0.99, score / 4.5)), 4),
                "line_text": line.text,
                "score": score,
            }
            if not best or candidate["score"] > best["score"]:
                best = candidate

    if best:
        if float(best.get("confidence") or 0) < 0.3:
            return None
        best.pop("score", None)
    return best


def get_paddle_ocr():
    global _OCR_ENGINE
    if _OCR_ENGINE is not None:
        return _OCR_ENGINE

    try:
        from paddleocr import PaddleOCR  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised indirectly in runtime
        raise OcrExtractionError(
            "PaddleOCR chưa được cài trên backend. Cần cài paddleocr + paddlepaddle-gpu phù hợp CUDA trước khi chạy OCR GPU."
        ) from exc

    _OCR_ENGINE = PaddleOCR(
        use_angle_cls=True,
        lang=getattr(settings, "PADDLEOCR_LANG", "en"),
        use_gpu=bool(getattr(settings, "PADDLEOCR_USE_GPU", False)),
        show_log=False,
    )
    return _OCR_ENGINE


def run_paddle_ocr(image_bytes: bytes) -> list[OCRLine]:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    max_side = int(getattr(settings, "PADDLEOCR_MAX_SIDE", 2200) or 2200)
    width, height = image.size
    longest = max(width, height)
    if longest > max_side:
        scale = max_side / float(longest)
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))))

    ocr = get_paddle_ocr()
    result = ocr.ocr(np.array(image), cls=True)

    lines: list[OCRLine] = []
    for page in result or []:
        for item in page or []:
            if not item or len(item) < 2:
                continue
            payload = item[1]
            if not payload or len(payload) < 2:
                continue
            text = str(payload[0] or "").strip()
            confidence = float(payload[1] or 0)
            if text:
                lines.append(OCRLine(text=text, confidence=confidence))
    return lines


def extract_bank_slip(image_bytes: bytes, mime_type: str | None = None, slip_type: str | None = None) -> dict[str, object]:
    lines = run_paddle_ocr(image_bytes)
    candidate = choose_amount_candidate(lines)
    if not candidate:
        preview = " | ".join(line.text for line in lines[:8])
        raise OcrExtractionError(f"PaddleOCR không tìm thấy số tiền phù hợp trên slip. Preview: {preview[:300]}")

    preview = " | ".join(line.text for line in lines[:8])
    return {
        "provider": "paddleocr",
        "amount": candidate["amount"],
        "amount_raw": candidate["amount_raw"],
        "confidence": candidate["confidence"],
        "transfer_date": None,
        "reference": None,
        "notes": f"slip_type={slip_type or 'unknown'}; preview={preview[:500]}",
        "mime_type": mime_type or "image/jpeg",
    }
