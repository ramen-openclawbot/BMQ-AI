import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

import {
  buildDealerContractText,
  buildDealerSignupContractPdf,
  contractTerm,
  formatContractDate,
  wrapText,
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
  contract_address_text: "45 Nguyễn Trãi, Phường Bến Thành, Quận 1, TP.HCM",
};

const FONT_BASE = new URL("./fonts/", import.meta.url);

async function readFonts() {
  const [regular, bold] = await Promise.all([
    Deno.readFile(new URL("NotoSans-Regular-vi.ttf", FONT_BASE)),
    Deno.readFile(new URL("NotoSans-Bold-vi.ttf", FONT_BASE)),
  ]);
  return { regular, bold };
}

/** Embedded fonts for layout tests, plus the raw subset files. */
async function embedFonts() {
  const bytes = await readFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit as never);
  const regular = await doc.embedFont(bytes.regular, { subset: false });
  const bold = await doc.embedFont(bytes.bold, { subset: false });
  return { regular, bold, bytes };
}

/** The previous implementation, kept verbatim as the line-breaking reference. */
function referenceWrapText(
  text: string,
  font: { widthOfTextAtSize(text: string, size: number): number },
  size: number,
  maxWidth: number,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) lines.push(current);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    let chunk = "";
    for (const char of word) {
      if (font.widthOfTextAtSize(`${chunk}${char}`, size) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    current = chunk;
  }

  if (current) lines.push(current);
  return lines.length ? lines : [""];
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
  assert.ok(text.includes(`Địa chỉ: ${INPUT.contract_address_text}`));
  assert.ok(text.includes(`- ${INPUT.address_text} Là trong vòng phạm vi bán kính 1km.`));
  assert.ok(!text.includes(`Địa chỉ: ${INPUT.address_text}`));
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

test("Bên B falls back to the selling address when no contract address is set", () => {
  const { contract_address_text: _contractAddress, ...legacyInput } = INPUT;
  const text = buildDealerContractText(legacyInput);

  assert.ok(text.includes(`Địa chỉ: ${INPUT.address_text}`));
  assert.ok(text.includes(`- ${INPUT.address_text} Là trong vòng phạm vi bán kính 1km.`));
});

test("generated PDF is valid and carries the application and customer metadata", async () => {
  const started = performance.now();
  const bytes = await buildDealerSignupContractPdf(INPUT, await readFonts());
  const elapsed = performance.now() - started;
  console.log(`[dealer-signup-contract] PDF build time: ${elapsed.toFixed(1)} ms`);

  assert.ok(bytes.length > 5000, `PDF too small: ${bytes.length}`);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");

  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 1);
  assert.ok((doc.getTitle() || "").includes(INPUT.application_code));
  assert.ok((doc.getTitle() || "").includes("Hợp đồng"));
  const subject = doc.getSubject() || "";
  assert.ok(subject.includes(INPUT.applicant_name));
  assert.ok(subject.includes(INPUT.cccd));
  assert.ok(subject.includes(INPUT.phone));
  assert.ok(subject.includes(INPUT.address_text));
  assert.ok(subject.includes(String(INPUT.contract_address_text)));
  const keywords = doc.getKeywords() || "";
  assert.ok(keywords.includes("6,500"));
  assert.ok(keywords.includes("bán kính 1km"));
  assert.ok(keywords.includes(INPUT.business_name));
});

test("subset fonts cover every Vietnamese character used in the contract", async () => {
  const text = buildDealerContractText(INPUT);
  assert.ok(text.includes("Hợp đồng"));
  assert.ok(text.includes("Giá bán sỉ BMQ chưa bao gồm VAT 10%"));
  assert.ok(text.includes("Phí gia nhập: 0 VNĐ"));

  const bytes = await readFonts();
  assert.ok(bytes.regular.length < 200_000, `regular subset too large: ${bytes.regular.length}`);
  assert.ok(bytes.bold.length < 200_000, `bold subset too large: ${bytes.bold.length}`);

  // Include ₫ explicitly: the subset range must keep currency symbols even if
  // the current contract spells "VNĐ" instead.
  const required = [...new Set([...text, "₫"])]
    .map((char) => char.codePointAt(0))
    .filter((codePoint): codePoint is number => codePoint !== undefined && codePoint >= 0x20)
    .sort((a, b) => a - b);

  for (const [name, fontBytes] of [["regular", bytes.regular], ["bold", bytes.bold]] as const) {
    const font = fontkit.create(fontBytes);
    const missing = required.filter((codePoint) => !font.hasGlyphForCodePoint(codePoint));
    assert.deepEqual(
      missing.map((codePoint) => `U+${codePoint.toString(16).toUpperCase()}`),
      [],
      `${name} font is missing contract glyphs`,
    );
  }
});

test("wrapText produces exactly the reference lines for the full contract", async () => {
  const { regular, bold } = await embedFonts();
  const fullText = buildDealerContractText(INPUT);
  const lines = fullText.split("\n").map((line) => line.trimEnd());
  const contentWidth = 595.28 - 48 * 2;

  const cases = [
    { name: "centered title", font: bold, size: 13.5, width: contentWidth },
    { name: "centered subtitle", font: bold, size: 11, width: contentWidth },
    { name: "centered draft", font: bold, size: 10, width: contentWidth },
    { name: "draft note", font: regular, size: 9.5, width: contentWidth },
    { name: "heading", font: bold, size: 10, width: contentWidth },
    { name: "body", font: regular, size: 9.2, width: contentWidth },
    { name: "table cell", font: bold, size: 8.6, width: contentWidth / 4 - 8 },
  ];

  for (const testCase of cases) {
    lines.forEach((line, index) => {
      assert.deepEqual(
        wrapText(line, testCase.font, testCase.size, testCase.width),
        referenceWrapText(line, testCase.font, testCase.size, testCase.width),
        `${testCase.name} differs at line ${index}: ${line.slice(0, 60)}`,
      );
    });
  }
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
