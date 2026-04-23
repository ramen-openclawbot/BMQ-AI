import json

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from .services import OcrExtractionError, decode_image_base64, extract_bank_slip


def _json_error(message: str, status: int = 400) -> JsonResponse:
    return JsonResponse({"success": False, "error": message}, status=status)


@csrf_exempt
@require_POST
def extract_bank_slip_amount(request):
    expected_api_key = getattr(settings, "BACKEND_OCR_API_KEY", "")
    if expected_api_key:
        received = request.headers.get("X-OCR-Api-Key", "")
        if received != expected_api_key:
            return _json_error("Unauthorized OCR request", status=401)

    try:
        payload = json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return _json_error("Invalid JSON payload", status=400)

    image_base64 = payload.get("imageBase64") or payload.get("image_base64")
    if not image_base64:
        return _json_error("imageBase64 is required", status=400)

    try:
        image_bytes = decode_image_base64(image_base64)
        data = extract_bank_slip(
            image_bytes=image_bytes,
            mime_type=payload.get("mimeType") or payload.get("mime_type"),
            slip_type=payload.get("slipType") or payload.get("slip_type"),
        )
    except OcrExtractionError as exc:
        return _json_error(str(exc), status=422)
    except Exception as exc:
        return _json_error(f"Unhandled OCR backend error: {exc}", status=500)

    return JsonResponse({"success": True, "data": data})
