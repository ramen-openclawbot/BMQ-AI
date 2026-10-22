import assert from "node:assert/strict";
import test from "node:test";

import {
  factorFromRead,
  jevVerdictText,
  khoReviewErrorText,
  reviewReasonText,
  suggestedFactor,
  unitMismatchText,
  type KhoReviewLineRead,
} from "./kho-review.ts";

test("reviewReasonText labels every reason", () => {
  assert.equal(reviewReasonText("no_docs"), "Chưa có phiếu mua");
  assert.equal(reviewReasonText("negative"), "Đang âm");
  assert.equal(reviewReasonText("no_docs_negative"), "Chưa có phiếu mua, đang âm");
});

test("jevVerdictText shows the same-item probability and the other verdicts", () => {
  assert.equal(jevVerdictText("same_item", 0.92), "Jev: đúng món 92%");
  assert.equal(jevVerdictText("same_item", 0.8), "Jev: đúng món 80%");
  assert.equal(jevVerdictText("same_item", 0.805), "Jev: đúng món 81%");
  assert.equal(jevVerdictText("same_item", null), "Jev: đúng món");
  assert.equal(jevVerdictText("different", 0.1), "Jev: khác loại");
  assert.equal(jevVerdictText("unsure", 0.5), "Jev: chưa chắc");
  assert.equal(jevVerdictText(null, 0.9), null);
  assert.equal(jevVerdictText(undefined, null), null);
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

function readFixture(overrides: Partial<KhoReviewLineRead> = {}): KhoReviewLineRead {
  return {
    ok: true,
    found: true,
    doc_unit: "hộp",
    doc_quantity: 7,
    doc_unit_price: 120000,
    pack_count: 100,
    pack_unit: "cái",
    evidence_text: "Bao tay y tế đen size M 7 hộp",
    unit_mismatch: true,
    ocr_engine: "indra",
    ocr_fallback_reason: null,
    cached: false,
    ...overrides,
  };
}

test("unitMismatchText shows the printed quantity/unit against the stored unit", () => {
  assert.equal(
    unitMismatchText(readFixture(), "kg"),
    "Phiếu ghi 7 hộp, dữ liệu đang là kg",
  );
  assert.equal(
    unitMismatchText(readFixture({ doc_quantity: 7.5 }), "kg"),
    "Phiếu ghi 7,5 hộp, dữ liệu đang là kg",
  );
  assert.equal(
    unitMismatchText(readFixture({ doc_unit: "Hôp" }), "hộp"),
    null,
  );
  assert.equal(unitMismatchText(readFixture({ found: false }), "kg"), null);
  assert.equal(unitMismatchText(readFixture(), null), null);
});

test("factorFromRead uses pack content only when it lands on the item unit", () => {
  assert.equal(factorFromRead(readFixture(), "cái"), 100);
  assert.equal(factorFromRead(readFixture(), "Cái"), 100);
  assert.equal(factorFromRead(readFixture(), "kg"), null);
  assert.equal(factorFromRead(readFixture({ pack_unit: null, pack_count: null }), "cái"), null);
  assert.equal(factorFromRead(readFixture({ found: false }), "cái"), null);
  assert.equal(factorFromRead(readFixture(), null), null);
});

test("khoReviewErrorText maps the read/fix codes", () => {
  assert.equal(khoReviewErrorText({ message: "no_image" }), "Dòng phiếu này chưa có ảnh để đọc.");
  assert.equal(
    khoReviewErrorText({ message: "ocr_failed" }),
    "Chưa đọc được ảnh phiếu. Anh/chị thử lại giúp.",
  );
  assert.equal(
    khoReviewErrorText({ message: "not_on_document" }),
    "Không thấy dòng hàng này trên phiếu.",
  );
  assert.equal(
    khoReviewErrorText({ message: "not_found" }),
    "Không tìm thấy dòng phiếu nhập.",
  );
  assert.equal(
    khoReviewErrorText({ message: "unknown_unit" }),
    "Đơn vị mới không hợp lệ.",
  );
  assert.equal(
    khoReviewErrorText({ message: "line_posted" }),
    "Dòng phiếu đã ghi sổ kho, không sửa được đơn vị.",
  );
  assert.equal(
    khoReviewErrorText({ message: "line_linked" }),
    "Dòng phiếu đã liên kết mặt hàng, không sửa được đơn vị.",
  );
  assert.equal(
    khoReviewErrorText({ message: "fix_not_found" }),
    "Không tìm thấy lần sửa đơn vị.",
  );
});
