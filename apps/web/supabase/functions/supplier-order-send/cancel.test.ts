import assert from "node:assert/strict";
import test from "node:test";

import { mapCancelError } from "./cancel.ts";

test("permission failures map to 403 forbidden", () => {
  assert.deepEqual(mapCancelError({ code: "42501", message: "insufficient_privilege" }), {
    status: 403,
    code: "forbidden",
  });
  assert.deepEqual(mapCancelError(new Error("insufficient_privilege")), {
    status: 403,
    code: "forbidden",
  });
});

test("reason failures map to 400", () => {
  assert.deepEqual(mapCancelError({ message: "cancel_reason_required" }), {
    status: 400,
    code: "cancel_reason_required",
  });
});

test("missing orders map to 404", () => {
  assert.deepEqual(mapCancelError({ code: "P0002", message: "order_not_found" }), {
    status: 404,
    code: "order_not_found",
  });
});

test("non-sent orders map to 409", () => {
  assert.deepEqual(mapCancelError({ message: "order_not_cancellable" }), {
    status: 409,
    code: "order_not_cancellable",
  });
});

test("the receipt guard maps to 409 with the Vietnamese message", () => {
  const error = {
    message:
      "po_cancel_has_receipt: Không hủy được PO PO-1: phiếu nhập PN-1 đã có hàng nhập kho. Xử lý phiếu nhập trước.",
  };
  assert.deepEqual(mapCancelError(error), {
    status: 409,
    code: "cancel_has_receipt",
    message:
      "Không hủy được PO PO-1: phiếu nhập PN-1 đã có hàng nhập kho. Xử lý phiếu nhập trước.",
  });
});

test("the payment guard maps to 409 with the Vietnamese message", () => {
  const error = {
    message:
      "po_cancel_has_payments: Không hủy được PO PO-2: phiếu chi PR-2 đã có tiền chi. Xử lý phiếu chi trước.",
  };
  assert.deepEqual(mapCancelError(error), {
    status: 409,
    code: "cancel_has_payments",
    message:
      "Không hủy được PO PO-2: phiếu chi PR-2 đã có tiền chi. Xử lý phiếu chi trước.",
  });
});

test("unknown failures map to 500 cancel_failed", () => {
  assert.deepEqual(mapCancelError(new Error("boom")), {
    status: 500,
    code: "cancel_failed",
  });
  assert.deepEqual(mapCancelError(null), { status: 500, code: "cancel_failed" });
});
