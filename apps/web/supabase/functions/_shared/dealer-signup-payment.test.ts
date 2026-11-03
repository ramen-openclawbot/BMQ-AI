import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_PAYMENT_ACCOUNT_NAME_KEY,
  DEALER_PAYMENT_ACCOUNT_NUMBER_KEY,
  DEALER_PAYMENT_AMOUNT_KEY,
  DEALER_PAYMENT_BANK_BIN_KEY,
  DEALER_PAYMENT_BANK_NAME_KEY,
  DEALER_PAYMENT_DEFAULT_AMOUNT_VND,
  DEALER_PAYMENT_TRANSFER_NOTE_KEY,
  buildDealerPaymentEmailBlock,
  buildDealerPaymentInfo,
  buildDealerTransferNote,
  buildDealerVietQrUrl,
  dealerPaymentSettingsFromRows,
  dealerPaymentSettingsToRows,
  formatDealerPaymentAmount,
  parseDealerPaymentAmount,
  validateDealerPaymentSettings,
  type DealerSignupPaymentSettings,
} from "./dealer-signup-payment.ts";

const SETTINGS: DealerSignupPaymentSettings = {
  bank_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
  bank_bin: "970407",
  account_number: "19001234567890",
  account_name: "HỘ KINH DOANH BÁNH MÌ BMQ",
  amount_vnd: 1_000_000,
  transfer_note_template: "BMQ {application_code}",
};

const ROWS = [
  { key: DEALER_PAYMENT_BANK_NAME_KEY, value: SETTINGS.bank_name },
  { key: DEALER_PAYMENT_BANK_BIN_KEY, value: SETTINGS.bank_bin },
  { key: DEALER_PAYMENT_ACCOUNT_NUMBER_KEY, value: SETTINGS.account_number },
  { key: DEALER_PAYMENT_ACCOUNT_NAME_KEY, value: SETTINGS.account_name },
  { key: DEALER_PAYMENT_AMOUNT_KEY, value: String(SETTINGS.amount_vnd) },
  { key: DEALER_PAYMENT_TRANSFER_NOTE_KEY, value: SETTINGS.transfer_note_template },
];

test("payment settings default to 1.000.000 VND and validate bank fields", () => {
  assert.equal(DEALER_PAYMENT_DEFAULT_AMOUNT_VND, 1_000_000);
  const defaults = validateDealerPaymentSettings({
    bank_name: SETTINGS.bank_name,
    bank_bin: SETTINGS.bank_bin,
    account_number: SETTINGS.account_number,
    account_name: SETTINGS.account_name,
  });
  assert.equal(defaults.ok, true);
  assert.equal(defaults.ok === true ? defaults.value.amount_vnd : 0, 1_000_000);
  assert.equal(
    defaults.ok === true ? defaults.value.transfer_note_template : "",
    "BMQ {application_code}",
  );

  assert.equal(validateDealerPaymentSettings({ ...SETTINGS, bank_bin: "12345" }).ok, false);
  assert.equal(validateDealerPaymentSettings({ ...SETTINGS, account_number: "12a" }).ok, false);
  assert.equal(validateDealerPaymentSettings({ ...SETTINGS, amount_vnd: 0 }).ok, false);
  assert.equal(validateDealerPaymentSettings({ ...SETTINGS, amount_vnd: -1 }).ok, false);
  assert.equal(
    validateDealerPaymentSettings({ ...SETTINGS, transfer_note_template: "BMQ" }).ok,
    false,
  );
  const dotted = validateDealerPaymentSettings({ ...SETTINGS, amount_vnd: "1.500.000" });
  assert.equal(dotted.ok, true);
  assert.equal(dotted.ok === true ? dotted.value.amount_vnd : 0, 1_500_000);
});

test("parse amount accepts dotted VND strings and rejects zero/non-numeric", () => {
  assert.equal(parseDealerPaymentAmount("1.000.000"), 1_000_000);
  assert.equal(parseDealerPaymentAmount(1500000), 1_500_000);
  assert.equal(parseDealerPaymentAmount("0"), null);
  assert.equal(parseDealerPaymentAmount("abc"), null);
  assert.equal(parseDealerPaymentAmount("abc123"), null);
  assert.equal(parseDealerPaymentAmount(""), null);
  assert.equal(parseDealerPaymentAmount("1.000.000 đ"), 1_000_000);
});

test("settings are read only when every required bank field is valid", () => {
  assert.deepEqual(dealerPaymentSettingsFromRows(ROWS), SETTINGS);
  assert.equal(
    dealerPaymentSettingsFromRows(ROWS.filter((row) => row.key !== DEALER_PAYMENT_BANK_BIN_KEY)),
    null,
  );
  assert.equal(
    dealerPaymentSettingsFromRows(
      ROWS.map((row) => row.key === DEALER_PAYMENT_ACCOUNT_NUMBER_KEY
        ? { ...row, value: "not-a-number" }
        : row),
    ),
    null,
  );
  assert.deepEqual(dealerPaymentSettingsToRows(SETTINGS), ROWS);
});

test("transfer note always contains the application code", () => {
  assert.equal(
    buildDealerTransferNote("BMQ {application_code}", "DLM-20261103-0001"),
    "BMQ DLM-20261103-0001",
  );
  assert.equal(
    buildDealerTransferNote("{application_code} thanh toan", "DLM-20261103-0002"),
    "DLM-20261103-0002 thanh toan",
  );
  // A template without the placeholder still appends the code.
  assert.equal(
    buildDealerTransferNote("BMQ", "DLM-20261103-0003"),
    "BMQ DLM-20261103-0003",
  );
  assert.equal(buildDealerTransferNote("", "DLM-20261103-0004"), "BMQ DLM-20261103-0004");
});

test("VietQR link uses compact2 with amount, addInfo and encoded account name", () => {
  const url = buildDealerVietQrUrl(SETTINGS, "DLM-20261103-0001");
  const parsed = new URL(url);

  assert.equal(parsed.origin + parsed.pathname, "https://img.vietqr.io/image/970407-19001234567890-compact2.png");
  assert.equal(parsed.searchParams.get("amount"), "1000000");
  assert.equal(parsed.searchParams.get("addInfo"), "BMQ DLM-20261103-0001");
  assert.equal(parsed.searchParams.get("accountName"), SETTINGS.account_name);
  assert.ok(url.includes("accountName=H%E1%BB%98%20KINH%20DOANH"));
});

test("payment_info is null until the settings are configured", () => {
  assert.equal(buildDealerPaymentInfo(null, "DLM-20261103-0001"), null);
  assert.equal(buildDealerPaymentInfo(SETTINGS, ""), null);

  const info = buildDealerPaymentInfo(SETTINGS, "DLM-20261103-0001");
  assert.ok(info);
  assert.equal(info?.amount_vnd, 1_000_000);
  assert.equal(info?.transfer_note, "BMQ DLM-20261103-0001");
  assert.match(String(info?.qr_url), /^https:\/\/img\.vietqr\.io\/image\/970407-/);
});

test("email block carries bank details, amount, transfer note and QR", () => {
  const info = buildDealerPaymentInfo(SETTINGS, "DLM-20261103-0001");
  const block = buildDealerPaymentEmailBlock(info);
  assert.ok(block);
  const labels = (block?.details ?? []).map(([label]) => label);
  assert.ok(labels.includes("Ngân hàng"));
  assert.ok(labels.includes("Số tài khoản"));
  assert.ok(labels.includes("Chủ tài khoản"));
  assert.ok(labels.includes("Số tiền"));
  assert.ok(labels.includes("Nội dung chuyển khoản"));
  assert.ok((block?.details ?? []).some(([, value]) => value.includes("19001234567890")));
  assert.ok((block?.details ?? []).some(([, value]) => value.includes("BMQ DLM-20261103-0001")));
  assert.ok((block?.text ?? []).some((line) => line.includes("img.vietqr.io")));
  assert.ok((block?.html ?? []).some((line) => line.includes("<img") && line.includes("img.vietqr.io")));
  assert.equal(formatDealerPaymentAmount(1_000_000), "1.000.000 đ");
  assert.equal(buildDealerPaymentEmailBlock(null), null);
});
