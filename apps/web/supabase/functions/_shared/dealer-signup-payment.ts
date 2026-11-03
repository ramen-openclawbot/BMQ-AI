/**
 * Dealer signup bank-transfer settings.
 *
 * Pure helpers only: no network, database or Gmail access, so the settings
 * validation, transfer-note template, VietQR link and email block can be
 * unit-tested. Secrets never belong in this module.
 */

export const DEALER_PAYMENT_BANK_NAME_KEY = "dealer_signup_payment_bank_name";
export const DEALER_PAYMENT_BANK_BIN_KEY = "dealer_signup_payment_bank_bin";
export const DEALER_PAYMENT_ACCOUNT_NUMBER_KEY = "dealer_signup_payment_account_number";
export const DEALER_PAYMENT_ACCOUNT_NAME_KEY = "dealer_signup_payment_account_name";
export const DEALER_PAYMENT_AMOUNT_KEY = "dealer_signup_payment_amount_vnd";
export const DEALER_PAYMENT_TRANSFER_NOTE_KEY = "dealer_signup_payment_transfer_note_template";

export const DEALER_PAYMENT_SETTING_KEYS = [
  DEALER_PAYMENT_BANK_NAME_KEY,
  DEALER_PAYMENT_BANK_BIN_KEY,
  DEALER_PAYMENT_ACCOUNT_NUMBER_KEY,
  DEALER_PAYMENT_ACCOUNT_NAME_KEY,
  DEALER_PAYMENT_AMOUNT_KEY,
  DEALER_PAYMENT_TRANSFER_NOTE_KEY,
] as const;

export const DEALER_PAYMENT_DEFAULT_AMOUNT_VND = 1_000_000;
export const DEALER_PAYMENT_DEFAULT_TRANSFER_NOTE_TEMPLATE = "BMQ {application_code}";
export const DEALER_PAYMENT_MAX_AMOUNT_VND = 1_000_000_000;
export const DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER = "{application_code}";

export type DealerSignupPaymentSettings = {
  bank_name: string;
  bank_bin: string;
  account_number: string;
  account_name: string;
  amount_vnd: number;
  transfer_note_template: string;
};

export type DealerSignupPaymentInfo = {
  bank_name: string;
  bank_bin: string;
  account_number: string;
  account_name: string;
  amount_vnd: number;
  transfer_note: string;
  qr_url: string;
};

export type DealerPaymentSettingsValidation =
  | { ok: true; value: DealerSignupPaymentSettings }
  | { ok: false; code: string; error: string };

export type DealerPaymentEmailBlock = {
  details: Array<[string, string]>;
  text: string[];
  html: string[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Parse a positive VND amount, accepting "1.000.000" style input. */
export function parseDealerPaymentAmount(value: unknown): number | null {
  const raw = text(value);
  if (raw.startsWith("-")) return null;
  if (!/^[\d.,\sđĐ]+$/.test(raw)) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const amount = Number(digits);
  if (!Number.isInteger(amount)) return null;
  if (amount <= 0 || amount > DEALER_PAYMENT_MAX_AMOUNT_VND) return null;
  return amount;
}

export function isValidDealerBankBin(value: unknown): boolean {
  return /^\d{6}$/.test(text(value));
}

export function isValidDealerAccountNumber(value: unknown): boolean {
  return /^\d{4,32}$/.test(text(value));
}

export function formatDealerPaymentAmount(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(Math.trunc(amount))} đ`;
}

export function validateDealerPaymentSettings(input: unknown): DealerPaymentSettingsValidation {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  const bankName = text(raw.bank_name ?? raw.bankName);
  if (bankName.length < 2 || bankName.length > 120) {
    return {
      ok: false,
      code: "invalid_bank_name",
      error: "Tên ngân hàng phải từ 2 đến 120 ký tự.",
    };
  }

  const bankBin = text(raw.bank_bin ?? raw.bankBin);
  if (!isValidDealerBankBin(bankBin)) {
    return {
      ok: false,
      code: "invalid_bank_bin",
      error: "Mã BIN VietQR phải gồm đúng 6 chữ số.",
    };
  }

  const accountNumber = text(raw.account_number ?? raw.accountNumber);
  if (!isValidDealerAccountNumber(accountNumber)) {
    return {
      ok: false,
      code: "invalid_account_number",
      error: "Số tài khoản phải gồm 4 đến 32 chữ số.",
    };
  }

  const accountName = text(raw.account_name ?? raw.accountName);
  if (accountName.length < 2 || accountName.length > 160) {
    return {
      ok: false,
      code: "invalid_account_name",
      error: "Chủ tài khoản phải từ 2 đến 160 ký tự.",
    };
  }

  const rawAmount = raw.amount_vnd ?? raw.amountVnd ?? raw.amount;
  const amountMissing = rawAmount === undefined || rawAmount === null || text(rawAmount) === "";
  const amount = amountMissing
    ? DEALER_PAYMENT_DEFAULT_AMOUNT_VND
    : parseDealerPaymentAmount(rawAmount);
  if (amount === null) {
    return {
      ok: false,
      code: "invalid_amount",
      error: "Số tiền chuyển khoản phải lớn hơn 0.",
    };
  }

  const transferNoteTemplate =
    text(raw.transfer_note_template ?? raw.transferNoteTemplate) ||
    DEALER_PAYMENT_DEFAULT_TRANSFER_NOTE_TEMPLATE;
  if (transferNoteTemplate.length > 200) {
    return {
      ok: false,
      code: "invalid_transfer_note_template",
      error: "Mẫu nội dung chuyển khoản tối đa 200 ký tự.",
    };
  }
  if (!transferNoteTemplate.includes(DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER)) {
    return {
      ok: false,
      code: "invalid_transfer_note_template",
      error: `Mẫu nội dung chuyển khoản phải chứa ${DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER}.`,
    };
  }

  return {
    ok: true,
    value: {
      bank_name: bankName,
      bank_bin: bankBin,
      account_number: accountNumber,
      account_name: accountName,
      amount_vnd: amount,
      transfer_note_template: transferNoteTemplate,
    },
  };
}

/**
 * Build settings from `app_settings` rows. Missing or malformed core bank
 * details return null so callers never display a partial/wrong account.
 */
export function dealerPaymentSettingsFromRows(
  rows: Array<{ key?: unknown; value?: unknown }> | null | undefined,
): DealerSignupPaymentSettings | null {
  const map = new Map<string, string>();
  for (const row of rows || []) {
    const key = text(row?.key);
    if (!key) continue;
    map.set(key, text(row?.value));
  }

  const bankName = map.get(DEALER_PAYMENT_BANK_NAME_KEY) || "";
  const bankBin = map.get(DEALER_PAYMENT_BANK_BIN_KEY) || "";
  const accountNumber = map.get(DEALER_PAYMENT_ACCOUNT_NUMBER_KEY) || "";
  const accountName = map.get(DEALER_PAYMENT_ACCOUNT_NAME_KEY) || "";
  if (!bankName || !accountName) return null;
  if (!isValidDealerBankBin(bankBin) || !isValidDealerAccountNumber(accountNumber)) return null;

  const amountRaw = map.get(DEALER_PAYMENT_AMOUNT_KEY) || "";
  const amount = amountRaw ? parseDealerPaymentAmount(amountRaw) : DEALER_PAYMENT_DEFAULT_AMOUNT_VND;
  if (amount === null) return null;

  const template = map.get(DEALER_PAYMENT_TRANSFER_NOTE_KEY) ||
    DEALER_PAYMENT_DEFAULT_TRANSFER_NOTE_TEMPLATE;
  if (!template.includes(DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER)) return null;

  const validated = validateDealerPaymentSettings({
    bank_name: bankName,
    bank_bin: bankBin,
    account_number: accountNumber,
    account_name: accountName,
    amount_vnd: amount,
    transfer_note_template: template,
  });
  return validated.ok ? validated.value : null;
}

export function dealerPaymentSettingsToRows(
  settings: DealerSignupPaymentSettings,
): Array<{ key: string; value: string }> {
  return [
    { key: DEALER_PAYMENT_BANK_NAME_KEY, value: settings.bank_name },
    { key: DEALER_PAYMENT_BANK_BIN_KEY, value: settings.bank_bin },
    { key: DEALER_PAYMENT_ACCOUNT_NUMBER_KEY, value: settings.account_number },
    { key: DEALER_PAYMENT_ACCOUNT_NAME_KEY, value: settings.account_name },
    { key: DEALER_PAYMENT_AMOUNT_KEY, value: String(settings.amount_vnd) },
    { key: DEALER_PAYMENT_TRANSFER_NOTE_KEY, value: settings.transfer_note_template },
  ];
}

/** Fill the application code into the configured transfer-note template. */
export function buildDealerTransferNote(
  template: string,
  applicationCode: string,
): string {
  const code = text(applicationCode);
  const rawTemplate = text(template) || DEALER_PAYMENT_DEFAULT_TRANSFER_NOTE_TEMPLATE;
  const withCode = rawTemplate.includes(DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER)
    ? rawTemplate
    : `${rawTemplate} ${code}`;
  return withCode.split(DEALER_PAYMENT_TRANSFER_CODE_PLACEHOLDER).join(code).trim();
}

/** img.vietqr.io compact2 QR with amount, addInfo and encoded account name. */
export function buildDealerVietQrUrl(
  settings: DealerSignupPaymentSettings,
  applicationCode: string,
): string {
  const transferNote = buildDealerTransferNote(settings.transfer_note_template, applicationCode);
  const query = [
    `amount=${encodeURIComponent(String(settings.amount_vnd))}`,
    `addInfo=${encodeURIComponent(transferNote)}`,
    `accountName=${encodeURIComponent(settings.account_name)}`,
  ].join("&");
  return `https://img.vietqr.io/image/${settings.bank_bin}-${settings.account_number}-compact2.png?${query}`;
}

export function buildDealerPaymentInfo(
  settings: DealerSignupPaymentSettings | null,
  applicationCode: string,
): DealerSignupPaymentInfo | null {
  if (!settings || !text(applicationCode)) return null;
  return {
    bank_name: settings.bank_name,
    bank_bin: settings.bank_bin,
    account_number: settings.account_number,
    account_name: settings.account_name,
    amount_vnd: settings.amount_vnd,
    transfer_note: buildDealerTransferNote(settings.transfer_note_template, applicationCode),
    qr_url: buildDealerVietQrUrl(settings, applicationCode),
  };
}

/**
 * Bank-transfer details plus a QR block for an email. Returns null when the
 * settings are not configured so callers omit the section entirely.
 */
export function buildDealerPaymentEmailBlock(
  info: DealerSignupPaymentInfo | null,
): DealerPaymentEmailBlock | null {
  if (!info) return null;

  return {
    details: [
      ["Ngân hàng", `${info.bank_name} (BIN ${info.bank_bin})`],
      ["Số tài khoản", info.account_number],
      ["Chủ tài khoản", info.account_name],
      ["Số tiền", formatDealerPaymentAmount(info.amount_vnd)],
      ["Nội dung chuyển khoản", info.transfer_note],
    ],
    text: [
      "Thông tin chuyển khoản:",
      `Mã QR chuyển khoản: ${info.qr_url}`,
    ],
    html: [
      `<p style="margin:16px 0 8px;font-weight:bold">Quét mã QR để chuyển khoản:</p>`,
      `<p style="margin:0 0 12px"><img src="${escapeHtml(info.qr_url)}" alt="Mã QR chuyển khoản BMQ" style="max-width:220px;height:auto;border:1px solid #e5e7eb"/></p>`,
    ],
  };
}
