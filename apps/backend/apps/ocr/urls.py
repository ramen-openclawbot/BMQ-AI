from django.urls import path

from .views import extract_bank_slip_amount

app_name = "ocr"

urlpatterns = [
    path("bank-slip/extract-amount/", extract_bank_slip_amount, name="extract-bank-slip-amount"),
]
