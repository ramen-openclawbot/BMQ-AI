import assert from "node:assert/strict";
import test from "node:test";

import {
  khoReviewErrorText,
  reviewReasonText,
  suggestedFactor,
} from "./kho-review.ts";

test("reviewReasonText labels every reason", () => {
  assert.equal(reviewReasonText("no_docs"), "Chưa có phiếu mua");
  assert.equal(reviewReasonText("negative"), "Đang âm");
  assert.equal(reviewReasonText("no_docs_negative"), "Chưa có phiếu mua, đang âm");
});

test("suggestedFactor follows the standard measure table", () => {
  assert.equal(suggestedFactor("kg", "g"), 1000);
  assert.equal(suggestedFactor("g", "g"), 1);
  assert.equal(suggestedFactor("l", "ml"), 1000);
  assert.equal(suggestedFactor("ml", "ml"), 1);
});

test("suggestedFactor handles case, surrounding spaces and count units", () => {
  assert.equal(suggestedFactor(" KG ", "G"), 1000);
  assert.equal(suggestedFactor("Bao", "bao"), 1);
  assert.equal(suggestedFactor("hộp", "hộp"), 1);
});

test("suggestedFactor returns null when it must not guess", () => {
  assert.equal(suggestedFactor("g", "kg"), null);
  assert.equal(suggestedFactor("kg", "ml"), null);
  assert.equal(suggestedFactor("bao", "g"), null);
  assert.equal(suggestedFactor(null, "g"), null);
  assert.equal(suggestedFactor("kg", ""), null);
  assert.equal(suggestedFactor(undefined, undefined), null);
});

test("khoReviewErrorText maps every server error", () => {
  assert.equal(
    khoReviewErrorText({ message: "kho_review_forbidden" }),
    "Anh/chị không có quyền rà soát nhập kho.",
  );
  assert.equal(
    khoReviewErrorText({ message: "invalid_factor" }),
    "Hệ số quy đổi phải lớn hơn 0.",
  );
  assert.equal(
    khoReviewErrorText({ message: "goods_receipt_item_not_found" }),
    "Không tìm thấy dòng phiếu nhập.",
  );
  assert.equal(
    khoReviewErrorText({ message: "item_not_found" }),
    "Không tìm thấy mặt hàng.",
  );
  assert.equal(
    khoReviewErrorText({ message: "item_wrong_kho" }),
    "Mặt hàng không thuộc kho của phiếu này.",
  );
  assert.equal(
    khoReviewErrorText({ message: "invalid_class" }),
    "Nhóm hàng không hợp lệ.",
  );
});

test("khoReviewErrorText reads a string error and joins details", () => {
  assert.equal(khoReviewErrorText("invalid_factor"), "Hệ số quy đổi phải lớn hơn 0.");
  assert.equal(
    khoReviewErrorText({ message: "rpc failed", details: "item_wrong_kho" }),
    "Mặt hàng không thuộc kho của phiếu này.",
  );
});

test("khoReviewErrorText falls back to the generic sentence", () => {
  assert.equal(
    khoReviewErrorText({ message: "something_unexpected" }),
    "Có lỗi xảy ra, anh/chị thử lại giúp.",
  );
  assert.equal(khoReviewErrorText(null), "Có lỗi xảy ra, anh/chị thử lại giúp.");
  assert.equal(khoReviewErrorText({}), "Có lỗi xảy ra, anh/chị thử lại giúp.");
});
