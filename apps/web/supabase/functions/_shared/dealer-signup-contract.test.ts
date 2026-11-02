import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "npm:pdf-lib@1.17.1";

import {
  buildDealerContractText,
  buildDealerSignupContractPdf,
  contractTerm,
  formatContractDate,
  type DealerContractInput,
} from "./dealer-signup-contract.ts";

const INPUT: DealerContractInput = {
  application_code: "DLM-20261102-AB12",
  contract_date: "2026-11-02",
  applicant_name: "Nguyễn Thị Hồng",
  business_name: "Hộ kinh doanh Bánh mì Hồng",
  cccd: "079123456789",
  cccd_valid_until: "2035-06-30",
  phone: "0909123456",
  email: "hong@example.test",
  address_text: "12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM",
};

const FONT_BASE = new URL("./fonts/", import.meta.url);

async function readFonts() {
  const [regular, bold] = await Promise.all([
    Deno.readFile(new URL("NotoSans-Regular.ttf", FONT_BASE)),
    Deno.readFile(new URL("NotoSans-Bold.ttf", FONT_BASE)),
  ]);
  return { regular, bold };
}

test("contract term runs from the sending date through the day before next year", () => {
  assert.deepEqual(contractTerm("2026-11-02"), { start: "2026-11-02", end: "2027-11-01" });
  assert.equal(formatContractDate("2026-11-02"), "02/11/2026");
});

test("contract text fills customer fields and keeps the reviewed terms", () => {
  const text = buildDealerContractText(INPUT);

  assert.ok(text.includes("HỢP ĐỒNG PHÂN PHỐI BÁNH MÌ QUE BMQ (ĐẠI LÝ MỞ 01 ĐIỂM)"));
  assert.ok(text.includes("Số: DLM-20261102-AB12/2026/BMQFOOD"));
  assert.ok(text.includes("được lập ngày 02/11/2026"));
  assert.ok(text.includes("Nguyễn Thị Hồng"));
  assert.ok(text.includes("Hộ kinh doanh Bánh mì Hồng"));
  assert.ok(text.includes("079123456789"));
  assert.ok(text.includes("30/06/2035"));
  assert.ok(text.includes("0909123456"));
  assert.ok(text.includes("hong@example.test"));
  assert.ok(text.includes("12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM"));
  assert.ok(text.includes("bán kính 1km"));
  assert.ok(text.includes("1 | <= 3.000 | - | 6,500"));
  assert.ok(text.includes("2 | <= 6.000 và không được ít hơn 3.000 | 500 | 6,000"));
  assert.ok(text.includes("3 | > 6.000 | 1,000 | 5,500"));
  assert.ok(text.includes("CÔNG TY CỔ PHẦN THỰC PHẨM BMQ"));
  assert.ok(text.includes("Vũ Trần Chí Tâm"));
  assert.ok(text.includes("Phí gia nhập: 0 VNĐ"));
  assert.ok(text.includes("Mức tối thiểu là 1,000,000 VNĐ"));
  assert.ok(!text.includes("order@bmq.vn"));
  assert.ok(!text.includes("500.000 đồng/lần"));
  assert.ok(text.includes("Bản dự thảo – có hiệu lực khi hai bên ký"));
  assert.ok(text.includes("từ ngày 02/11/2026 đến hết ngày 01/11/2027"));
  assert.ok(!text.includes("{application_code}"));
  assert.ok(!text.includes("undefined"));
});

test("generated PDF is valid and carries the application and customer metadata", async () => {
  const bytes = await buildDealerSignupContractPdf(INPUT, await readFonts());

  assert.ok(bytes.length > 5000, `PDF too small: ${bytes.length}`);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");

  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.ok((doc.getTitle() || "").includes(INPUT.application_code));
  const subject = doc.getSubject() || "";
  assert.ok(subject.includes(INPUT.applicant_name));
  assert.ok(subject.includes(INPUT.cccd));
  assert.ok(subject.includes(INPUT.phone));
  assert.ok(subject.includes(INPUT.address_text));
  assert.ok((doc.getKeywords() || "").includes("6,500"));
});

test("contract body matches the owner template file exactly", async () => {
  const fromFile = await Deno.readTextFile(
    new URL("../../../../../docs/dealer-signup/contract-template.txt", import.meta.url),
  );
  const filled = buildDealerContractText(INPUT);
  const placeholders = fromFile.match(/\{[a-z_]+\}/g) ?? [];
  assert.ok(placeholders.length >= 10);
  const skeleton = fromFile.split(/\{[a-z_]+\}/);
  let cursor = 0;
  for (const part of skeleton) {
    const found = filled.indexOf(part, cursor);
    assert.ok(found >= cursor, `template fragment missing: ${part.slice(0, 60)}`);
    cursor = found + part.length;
  }
});
