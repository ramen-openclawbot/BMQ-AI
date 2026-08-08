import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDealerOrderConfirmationTemplateData,
  buildVietGuysOrderConfirmationRequest,
  dealerOrderConfirmationFailureTransition,
  sendDealerOrderConfirmationZns,
} from "./dealer-order-confirmation.ts";

const ORDER = {
  customerName: "Đại lý BMQ Mẫu",
  orderNumber: "DOP-20260808-ABC12345",
  submittedAt: "2026-08-07T15:50:00.000Z",
  requestedDeliveryDate: "2026-08-08",
  orderedQuantity: 1380,
  exchangeQuantity: 47,
  makeupQuantity: 24,
  physicalQuantity: 1451,
  totalAmountVnd: 8_970_000,
};

test("formats approved transactional template variables in Vietnam time", () => {
  assert.deepEqual(buildDealerOrderConfirmationTemplateData(ORDER), {
    ten_khach_hang: "Đại lý BMQ Mẫu",
    ma_don_hang: "DOP-20260808-ABC12345",
    ngay_dat: "07/08/2026",
    ngay_giao: "08/08/2026",
    tong_so_luong: "1.380",
    tong_tien: "8.970.000 đ",
  });
});

test("confirmation quantity uses ordered quantity and excludes exchange and makeup", () => {
  const templateData = buildDealerOrderConfirmationTemplateData(ORDER);
  assert.equal(templateData.tong_so_luong, "1.380");
  assert.notEqual(templateData.tong_so_luong, "1.451");
});

test("builds a dedicated ZBS request without OTP or SMS failover", () => {
  const templateData = buildDealerOrderConfirmationTemplateData(ORDER);
  const request = buildVietGuysOrderConfirmationRequest({
    username: "bmq-user",
    phoneNormalized: "84900000000",
    trackingId: "dealer-order-DOP-20260808-ABC12345",
    oaId: "oa-id",
    templateId: "order-confirm-template-id",
    templateData,
  });

  assert.deepEqual(request, {
    username: "bmq-user",
    mobile: "84900000000",
    tracking_id: "dealer-order-DOP-20260808-ABC12345",
    zns: {
      oa_id: "oa-id",
      template_id: "order-confirm-template-id",
      template_data: templateData,
    },
  });
  assert.doesNotMatch(JSON.stringify(request), /otp|sms|failover/i);
});

test("sends through the dedicated template and accepts a successful provider response", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const result = await sendDealerOrderConfirmationZns({
    endpoint: "https://provider.example/zalo/v4/send",
    accessToken: "x",
    username: "bmq-user",
    phoneNormalized: "84900000000",
    trackingId: "dealer-order-123",
    oaId: "oa-id",
    templateId: "order-template-id",
    templateData: buildDealerOrderConfirmationTemplateData(ORDER),
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ error: 0, data: { message_id: "zns-msg-123" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(capturedUrl, "https://provider.example/zalo/v4/send");
  assert.equal(new Headers(capturedInit?.headers).get("Access-Token"), "x");
  assert.equal(result.messageId, "zns-msg-123");
  assert.equal(result.provider, "vietguys_zbs_order_confirmation");
});

test("maps pre-commit validation errors away from processing", () => {
  assert.deepEqual(
    dealerOrderConfirmationFailureTransition(false, new Error("Invalid requestedDeliveryDate")),
    {
      expectedStatus: "processing",
      nextStatus: "failed",
      lastError: "pre_send_validation_failed: Invalid requestedDeliveryDate",
    },
  );
});

test("maps post-commit ambiguity to manual reconciliation", () => {
  assert.deepEqual(
    dealerOrderConfirmationFailureTransition(true, new Error("provider response lost")),
    {
      expectedStatus: "send_committed",
      nextStatus: "send_committed",
      lastError: "manual_reconciliation_required: provider response lost",
    },
  );
});

test("rejects a provider-level error returned with HTTP 200", async () => {
  await assert.rejects(
    sendDealerOrderConfirmationZns({
      endpoint: "https://provider.example/zalo/v4/send",
      accessToken: "x",
      username: "bmq-user",
      phoneNormalized: "84900000000",
      trackingId: "dealer-order-123",
      oaId: "oa-id",
      templateId: "order-template-id",
      templateData: buildDealerOrderConfirmationTemplateData(ORDER),
      fetchImpl: async () => new Response(JSON.stringify({ error: 12, error_code: "TEMPLATE_DISABLED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }),
    /order confirmation send failed.*TEMPLATE_DISABLED/i,
  );
});
