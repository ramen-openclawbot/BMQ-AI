import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentKind,
  isSalaryAttachmentMime,
  salaryAttachmentErrorText,
  resolveSalaryAttachmentMime,
  validateSalaryAttachmentFiles,
  MAX_BYTES,
  MAX_COUNT,
  SALARY_ATTACHMENT_MIME_TYPES,
  type SalaryAttachmentErrorCode,
} from "./salary-attachments.ts";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("accepts an image, PDF, xls and xlsx", () => {
  const result = validateSalaryAttachmentFiles([
    { name: "anh.jpg", type: "image/jpeg", size: 1024 },
    { name: "phieu.pdf", type: "application/pdf", size: 2048 },
    { name: "bang.xls", type: "application/vnd.ms-excel", size: 4096 },
    { name: "bang.xlsx", type: XLSX_MIME, size: 8192 },
  ]);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.accepted.map((file) => file.mime),
    ["image/jpeg", "application/pdf", "application/vnd.ms-excel", XLSX_MIME],
  );
});

test("resolves xlsx by extension when the type is empty or octet-stream", () => {
  assert.equal(resolveSalaryAttachmentMime("bang.xlsx", ""), XLSX_MIME);
  assert.equal(
    resolveSalaryAttachmentMime("bang.xlsx", "application/octet-stream"),
    XLSX_MIME,
  );

  const result = validateSalaryAttachmentFiles([
    { name: "bang.xlsx", type: "", size: 1024 },
    { name: "bang.xlsx", type: "application/octet-stream", size: 1024 },
  ]);
  assert.equal(result.valid, true);
  assert.equal(result.accepted.length, 2);
  assert.ok(result.accepted.every((file) => file.mime === XLSX_MIME));
});

test("resolves the remaining extensions and kinds", () => {
  assert.equal(resolveSalaryAttachmentMime("a.jpeg", ""), "image/jpeg");
  assert.equal(resolveSalaryAttachmentMime("a.PNG", ""), "image/png");
  assert.equal(resolveSalaryAttachmentMime("a.webp", ""), "image/webp");
  assert.equal(resolveSalaryAttachmentMime("a.heic", ""), "image/heic");
  assert.equal(resolveSalaryAttachmentMime("a.pdf", ""), "application/pdf");
  assert.equal(resolveSalaryAttachmentMime("a.xls", ""), "application/vnd.ms-excel");
  assert.equal(resolveSalaryAttachmentMime("a.unknown", ""), null);

  assert.equal(attachmentKind("image/png"), "image");
  assert.equal(attachmentKind("application/pdf"), "pdf");
  assert.equal(attachmentKind("application/vnd.ms-excel"), "excel");
  assert.equal(attachmentKind(XLSX_MIME), "excel");
  assert.equal(attachmentKind("application/zip"), null);
});

test("rejects .doc and .zip", () => {
  const result = validateSalaryAttachmentFiles([
    { name: "hopdong.doc", type: "application/msword", size: 1024 },
    { name: "nén.zip", type: "application/zip", size: 1024 },
  ]);

  assert.equal(result.valid, false);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every((error) => error.code === "unsupported_type"));
  assert.ok(result.errors.every((error) => error.message === "Chỉ nhận ảnh, PDF hoặc Excel"));
});

test("rejects empty and oversize files", () => {
  const empty = validateSalaryAttachmentFiles([
    { name: "anh.jpg", type: "image/jpeg", size: 0 },
  ]);
  assert.equal(empty.valid, false);
  assert.equal(empty.errors[0].code, "empty_file");

  const oversize = validateSalaryAttachmentFiles([
    { name: "to.pdf", type: "application/pdf", size: MAX_BYTES + 1 },
  ]);
  assert.equal(oversize.valid, false);
  assert.equal(oversize.errors[0].code, "file_too_large");
  assert.equal(oversize.errors[0].message, "File lớn hơn 10 MB");

  const boundary = validateSalaryAttachmentFiles([
    { name: "dung-luong.pdf", type: "application/pdf", size: MAX_BYTES },
  ]);
  assert.equal(boundary.valid, true);

  const none = validateSalaryAttachmentFiles([]);
  assert.equal(none.valid, true);
  assert.deepEqual(none.accepted, []);
});

test("honours the 20-document limit with existing attachments", () => {
  const files = Array.from({ length: 5 }, (_, index) => ({
    name: `anh-${index}.png`,
    type: "image/png",
    size: 1024,
  }));

  // 18 already stored -> only 2 slots remain.
  const result = validateSalaryAttachmentFiles(files, MAX_COUNT - 2);
  assert.equal(result.valid, false);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((error) => error.code === "too_many_attachments"));
  assert.ok(result.errors.every((error) => error.message === "Tối đa 20 chứng từ mỗi phiếu"));

  const full = validateSalaryAttachmentFiles(files, MAX_COUNT);
  assert.equal(full.accepted.length, 0);
  assert.equal(full.errors.length, files.length);
});

test("every allowed mime is recognised and unknown mime is not", () => {
  for (const mime of SALARY_ATTACHMENT_MIME_TYPES) {
    assert.equal(isSalaryAttachmentMime(mime), true, `${mime} should be allowed`);
  }
  assert.equal(isSalaryAttachmentMime("application/zip"), false);
  assert.equal(isSalaryAttachmentMime(""), false);
});

test("error text covers every edge code", () => {
  const expected: Record<SalaryAttachmentErrorCode, string> = {
    insufficient_privilege: "Không có quyền thực hiện thao tác này.",
    payout_not_found: "Không tìm thấy phiếu lương.",
    attachment_not_found: "Không tìm thấy chứng từ.",
    payout_completed: "Phiếu lương đã hoàn tất, không thể thay đổi chứng từ.",
    unsupported_type: "Chỉ nhận ảnh, PDF hoặc Excel",
    file_too_large: "File lớn hơn 10 MB",
    too_many_attachments: "Tối đa 20 chứng từ mỗi phiếu",
    upload_failed: "Không tải được chứng từ. Vui lòng thử lại.",
    attachment_delete_failed: "Không xoá được chứng từ. Vui lòng thử lại.",
    attachment_lookup_failed: "Không đọc được chứng từ. Vui lòng thử lại.",
    payout_lookup_failed: "Không đọc được phiếu lương. Vui lòng thử lại.",
    signed_url_failed: "Không tạo được liên kết tải chứng từ.",
  };

  for (const [code, message] of Object.entries(expected)) {
    assert.equal(salaryAttachmentErrorText(code), message, `${code} should map to its message`);
  }

  // Unknown / missing codes fall back to a generic message, never empty.
  assert.ok(salaryAttachmentErrorText("does_not_exist").length > 0);
  assert.ok(salaryAttachmentErrorText(null).length > 0);
  assert.equal(salaryAttachmentErrorText("does_not_exist"), salaryAttachmentErrorText(null));
});
