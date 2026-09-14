/** KFM intake is portal-only. Historical email evidence remains readable. */
export const KFM_EMAIL_RETIRED = {
  success: false,
  error: "kfm_email_source_retired",
  message: "PO KFM đã chuyển sang portal. Hãy dùng Kiểm tra PO tại Xưởng Q7.",
} as const;

type SourceIdentity = {
  from_email?: unknown;
  customer_code?: unknown;
  customer_name?: unknown;
  revenue_channel?: unknown;
  raw_payload?: any;
  mini_crm_customers?: any;
};

export function isKfmPoIdentity(row: SourceIdentity): boolean {
  const email = String(row.from_email || "").trim().toLowerCase();
  const customer = row.mini_crm_customers || {};
  const code = String(row.customer_code || customer.customer_code || "").trim().toLowerCase();
  const name = String(row.customer_name || customer.customer_name || "").trim().toLowerCase();
  return /@(?:[a-z0-9-]+\.)?kingfoodmart\.com>?$/.test(email)
    || code === "b2b-kfm"
    || /king\s*food|\bkfm\b/.test(name)
    || ["wholesale_kfm", "cake_kingfoodmart"].includes(String(row.revenue_channel || ""))
    || row.raw_payload?.po_automation?.rule === "kingfood_po_automation";
}

export function isKfmPortalPo(row: SourceIdentity): boolean {
  return row.raw_payload?.source === "kfm_portal";
}

/** Finance may continue processing already-approved historical evidence only. */
export function shouldSkipKfmEmailAutomation(row: SourceIdentity & { match_status?: unknown }): boolean {
  return isKfmPoIdentity(row) && !isKfmPortalPo(row) && row.match_status !== "approved";
}
