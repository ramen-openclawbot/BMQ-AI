import base64
from unittest.mock import patch

from django.test import Client, SimpleTestCase, override_settings

from .services import OCRLine, choose_amount_candidate, parse_amount_vn

_ONE_PIXEL_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9l3sAAAAASUVORK5CYII="
)


class ParseAmountVNTests(SimpleTestCase):
    def test_parses_vietnamese_amount_format(self):
        self.assertEqual(parse_amount_vn("41.006.300,00"), 41006300)

    def test_parses_grouped_integer_amount(self):
        self.assertEqual(parse_amount_vn("2.700.000"), 2700000)


class ChooseAmountCandidateTests(SimpleTestCase):
    def test_prefers_amount_label_over_account_numbers(self):
        lines = [
            OCRLine(text="So tai khoan 19010000012345", confidence=0.99),
            OCRLine(text="So tien 41.006.300,00", confidence=0.93),
            OCRLine(text="Reference FT123456789", confidence=0.92),
        ]

        chosen = choose_amount_candidate(lines)

        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["amount_raw"], "41.006.300,00")
        self.assertEqual(chosen["amount"], 41006300)

    def test_uses_neighbor_label_when_amount_is_on_next_line(self):
        lines = [
            OCRLine(text="Debit Amount", confidence=0.88),
            OCRLine(text="18.450.000", confidence=0.9),
            OCRLine(text="Balance 25.000.000", confidence=0.86),
        ]

        chosen = choose_amount_candidate(lines)

        self.assertIsNotNone(chosen)
        self.assertEqual(chosen["amount_raw"], "18.450.000")
        self.assertEqual(chosen["amount"], 18450000)


@override_settings(BACKEND_OCR_API_KEY="secret-test-key")
class ExtractBankSlipAmountViewTests(SimpleTestCase):
    def setUp(self):
        self.client = Client()
        self.url = "/api/ocr/bank-slip/extract-amount/"

    def test_rejects_missing_api_key(self):
        response = self.client.post(
            self.url,
            data={"imageBase64": _ONE_PIXEL_PNG, "mimeType": "image/png", "slipType": "unc"},
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 401)

    @patch("apps.ocr.views.extract_bank_slip")
    def test_returns_backend_ocr_payload(self, mock_extract_bank_slip):
        mock_extract_bank_slip.return_value = {
            "provider": "paddleocr",
            "amount": 41006300,
            "amount_raw": "41.006.300,00",
            "confidence": 0.97,
            "transfer_date": None,
            "reference": None,
            "notes": "preview=So tien 41.006.300,00",
            "mime_type": "image/png",
        }

        response = self.client.post(
            self.url,
            data={"imageBase64": _ONE_PIXEL_PNG, "mimeType": "image/png", "slipType": "unc"},
            content_type="application/json",
            headers={"X-OCR-Api-Key": "secret-test-key"},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["data"]["provider"], "paddleocr")
        self.assertEqual(payload["data"]["amount"], 41006300)
        mock_extract_bank_slip.assert_called_once()
