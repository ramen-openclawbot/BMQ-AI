import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import * as XLSX from "npm:xlsx@0.18.5";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireCronSecret } from "../_shared/auth.ts";

type GmailMessage = {
  id: string;
  threadId: string;
};

type EmailCandidate = {
  customerId: string;
  customerName: string | null;
  revenueChannel: string | null;
  isNpp: boolean;
  suppliedByNppCustomerId: string | null;
};

const extractPoNumber = (subject: string) => {
  const m = subject.match(/PO\s*([0-9]{6,})/i) || subject.match(/\b(PO[0-9]{6,})\b/i);
  if (!m) return null;
  return m[1].toUpperCase().startsWith("PO") ? m[1].toUpperCase() : `PO${m[1]}`;
};

const extractDeliveryDate = (subject: string) => {
  const m = subject.match(/GIAO\s*NGÀY\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
};

const decodeBase64Url = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const base64 = normalized + padding;
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
};

const normalizeEmail = (value: string) => {
  const raw = String(value || "").trim().toLowerCase();
  const inBracket = raw.match(/<([^>]+)>/)?.[1] || raw;
  const candidate = inBracket.trim();
  const direct = candidate.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (direct) return direct.toLowerCase();
  const fallback = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  return (fallback || candidate).trim().toLowerCase();
};

const explodeEmails = (value: string): string[] => {
  return String(value || "")
    .split(/[;,\n]+/)
    .map((part) => normalizeEmail(part))
    .filter(Boolean);
};

const revenueChannelFromCustomerGroup = (group: string | null | undefined) => {
  switch (String(group || "").toLowerCase()) {
    case "online":
      return "online";
    case "banhmi_agency":
      return "agency";
    case "b2b":
      return "b2b";
    case "banhmi_point":
    default:
      return "retail";
  }
};

const dedupeCandidates = (candidates: EmailCandidate[]) => {
  const byId = new Map<string, EmailCandidate>();
  for (const candidate of candidates) {
    if (!candidate?.customerId) continue;
    byId.set(candidate.customerId, candidate);
  }
  return Array.from(byId.values());
};

const resolveEmailCandidates = (candidates: EmailCandidate[]) => {
  const deduped = dedupeCandidates(candidates);
  const activeRoots = deduped.filter((candidate) => !candidate.suppliedByNppCustomerId);
  const rootNpps = activeRoots.filter((candidate) => candidate.isNpp);

  if (rootNpps.length === 1) {
    const rootNpp = rootNpps[0];
    const sameNppDependents = deduped.filter(
      (candidate) => candidate.suppliedByNppCustomerId && candidate.suppliedByNppCustomerId === rootNpp.customerId,
    );
    const outsideRootGroup = deduped.filter(
      (candidate) => candidate.customerId !== rootNpp.customerId && candidate.suppliedByNppCustomerId !== rootNpp.customerId,
    );
    if (sameNppDependents.length > 0 && outsideRootGroup.length === 0) {
      return {
        match: rootNpp,
        candidates: deduped,
        resolution: "npp_parent",
      } as const;
    }
  }

  if (activeRoots.length === 1) {
    return {
      match: activeRoots[0],
      candidates: deduped,
      resolution: "single_root",
    } as const;
  }

  if (deduped.length === 1) {
    return {
      match: deduped[0],
      candidates: deduped,
      resolution: "single_candidate",
    } as const;
  }

  return {
    match: null,
    candidates: deduped,
    resolution: deduped.length > 1 ? "ambiguous" : "unmatched",
  } as const;
};

async function getGoogleAccessToken(supabaseAdmin: any): Promise<string> {
  const { data: gmailTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_gmail_refresh_token")
    .maybeSingle();

  // backward compatibility: fallback to old shared token key
  const { data: legacyTokenData } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "google_drive_refresh_token")
    .maybeSingle();

  const refreshToken = gmailTokenData?.value || legacyTokenData?.value;

  if (!refreshToken) {
    throw new Error("Chưa kết nối Gmail PO hoặc thiếu refresh token");
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Thiếu GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenResponse.ok) {
    const err = await tokenResponse.text();
    throw new Error(`Không thể refresh Google access token: ${err}`);
  }

  const tokens = await tokenResponse.json();
  return tokens.access_token;
}

async function gmailApi(accessToken: string, path: string) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${err}`);
  }
  return await res.json();
}


const KINGFOOD_AUTOMATION = {
  sender: "dathang@kingfoodmart.com",
  xlsxName: "Export-PO-Data.xlsx",
} as const;

const DAM_XESG_AUTOMATION = {
  sender: "damvovan33@gmail.com",
  rule: "dam_xesg_text_body",
  parser: "po-gmail-sync:dam-xesg-text-body:v1",
} as const;

const THUY_DIRECT_DEALER_AUTOMATION = {
  sender: "thuy@bmq.vn",
  rule: "thuy_direct_dealer_text",
  parser: "po-gmail-sync:thuy-direct-dealer-text:v1",
  unitPrice: 6500,
} as const;


const TONY_THANH_AUTOMATION = {
  sender: "tonythanh@hotmail.com",
  rule: "tony_thanh_npp_text",
  parser: "po-gmail-sync:tony-thanh-npp-text:v1",
  unitPrice: 6500,
  parentCustomerName: "Đại lý cấp 1 - Anh Thanh",
} as const;

const VIETJET_AUTOMATION = {
  senderDomain: "vietjetair.com",
  rule: "vietjet_cumulative_xlsx",
  parser: "po-gmail-sync:vietjet-cumulative-xlsx:v1",
  unitPrice: 25000,
  productCode: "40000294",
  productName: "Bánh mì",
} as const;

const COOPMART_AUTOMATION = {
  sender: "mai-hnp@saigonco-op.com.vn",
  senders: ["mai-hnp@saigonco-op.com.vn", "tram-nht@saigonco-op.com.vn"],
  rule: "coopmart_manual_trusted_ledger_only",
  parser: "po-gmail-sync:coopmart-guardrail:v1",
} as const;

const isCoopmartSenderEmail = (email: string) =>
  COOPMART_AUTOMATION.senders.includes(email as typeof COOPMART_AUTOMATION.senders[number]);

const THUY_DIRECT_DEALER_ALIASES = [
  { canonical: "ĐẠI LÝ BẠCH ĐẰNG", aliases: ["Bạch Đằng", "Bach Đằng", "Bach Dang"] },
  { canonical: "ĐẠI LÝ THÍCH QUẢNG ĐỨC", aliases: ["Thích Quảng Đức", "Thich Quang Duc"] },
  { canonical: "ĐẠI LÝ PHẠM PHÚ THỨ", aliases: ["Phạm Phú Thứ", "Pham Phu Thu"] },
  { canonical: "ĐẠI LÝ LẠC LONG QUÂN", aliases: ["Lạc Long Quân", "Lac Long Quan"] },
  { canonical: "ĐẠI LÝ LÊ VĂN LƯƠNG", aliases: ["Lê Văn Lương", "Le Van Luong"] },
  { canonical: "ĐẠI LÝ HỒNG LẠC", aliases: ["Hồng Lạc", "Hong Lac"] },
  { canonical: "ĐẠI LÝ TÂY HÒA", aliases: ["Tây Hoà", "Tây Hòa", "Tay Hoa"] },
  { canonical: "ĐẠI LÝ BÌNH CHÁNH 2", aliases: ["Bình Chánh", "Bình hánh", "Binh Chanh"] },
  { canonical: "ĐẠI LÝ 87 NGUYỄN SƠN", aliases: ["Nguyễn Sơn", "Nguyen Son"] },
  { canonical: "ĐẠI LÝ NGUYỄN TRÃI", aliases: ["Nguyễn Trãi", "Nguyen Trai"] },
  { canonical: "ĐẠI LÝ NGUYỄN TRỌNG TUYỂN", aliases: ["Nguyễn Trọng Tuyển", "Nguyen Trong Tuyen"] },
  { canonical: "ĐẠI LÝ PHÚ HÒA", aliases: ["Phú Hoà", "Phú Hòa", "Phu Hoa"] },
  { canonical: "ĐẠI LÝ 207 NGUYỄN VĂN ĐẬU", aliases: ["Nguyễn Văn Đậu", "Nguyen Van Dau"] },
  { canonical: "ĐẠI LÝ VÕ VĂN NGÂN", aliases: ["Võ Văn Ngân", "Vo Van Ngan"] },
  { canonical: "ĐẠI LÝ LONG AN", aliases: ["Long An"] },
  { canonical: "ĐẠI LÝ KINH DƯƠNG VƯƠNG", aliases: ["Kinh Dương Vương", "Kinh Duong Vuong"] },
  { canonical: "ĐẠI LÝ TÂN HÒA ĐÔNG - BÌNH TÂN", aliases: ["Tân Hoà Đông", "Tân Hòa Đông", "Tan Hoa Dong"] },
  { canonical: "ĐẠI LÝ HOÀNG ANH GIA LAI", aliases: ["HAGL", "Hoàng Anh Gia Lai", "Hoang Anh Gia Lai"] },
  { canonical: "ĐẠI LÝ VŨNG TÀU", aliases: ["Vũng Tàu", "Vung Tau"] },
  { canonical: "ĐẠI LÝ CÀ MAU", aliases: ["Cà Mau", "Ca Mau"] },
  { canonical: "ĐẠI LÝ LÊ ĐẠI HÀNH", aliases: ["Lê Đại Hành", "Le Dai Hanh"] },
  { canonical: "ĐẠI LÝ 25 PHÚ MỸ_Q7", aliases: ["Phú Mỹ", "Phu My"] },
  { canonical: "ĐẠI LÝ PJ's COFFEE", aliases: ["PJ", "PJ Coffee", "PJ's Coffee"] },
  { canonical: "ĐẠI LÝ CẦN THƠ", aliases: ["Cần Thơ", "Cân Thơ", "Can Tho"] },
  { canonical: "ĐẠI LÝ GÒ DẦU", aliases: ["Gò Dầu", "Go Dau"] },
] as const;

const DAM_XESG_ROUTE_ALIASES = [
  { canonical: "Bùi Viện", aliases: ["Bùi Viện", "Bui Vien"] },
  { canonical: "Bùi Hữu Nghĩa", aliases: ["Bùi Hữu Nghĩa", "Bui Huu Nghia"] },
  { canonical: "Bến Vân Đồn", aliases: ["Bến Vân Đồn", "Ben Van Don"] },
  { canonical: "Phạm Văn Chí", aliases: ["Phạm Văn Chí", "213 Phạm Văn Chí", "Pham Van Chi", "213 Pham Van Chi"] },
  { canonical: "Thống Nhất", aliases: ["Thống Nhất", "Thong Nhat"] },
  { canonical: "Lê Văn Quới", aliases: ["Lê Văn Quới", "Le Van Quoi"] },
] as const;


const TONY_THANH_ROUTE_ALIASES = [
  { canonical: "ĐẠI LÝ ĐỒNG VĂN CỐNG", aliases: ["ĐVC", "DVC", "Đồng Văn Cống", "Dong Van Cong"] },
  { canonical: "ĐẠI LÝ COOPMART RẠCH GIÁ", aliases: ["Rạch Giá", "Rach Gia", "CoopMart Rạch Giá"] },
  { canonical: "ĐẠI LÝ PHAN THIẾT", aliases: ["Phan Thiết", "Phan Thiet"] },
  { canonical: "ĐẠI LÝ QUANG TRUNG", aliases: ["Quang Trung"] },
  { canonical: "ĐẠI LÝ SATRA CỦ CHI", aliases: ["Satra Củ Chi", "Củ Chi", "Cu Chi"] },
  { canonical: "ĐẠI LÝ XTRA LINH TRUNG_DĨ AN", aliases: ["Linh Trung", "Dĩ An", "Di An", "Xtra Linh Trung"] },
  { canonical: "ĐẠI LÝ GO MỸ THO", aliases: ["Mỹ Tho", "My Tho", "Go Mỹ Tho"] },
  { canonical: "ĐẠI LÝ HÓC MÔN_COOPMART NAT", aliases: ["Coopmart NAT", "Hóc Môn", "Hoc Mon"] },
  { canonical: "ĐẠI LÝ TOP MARKET ÂU CƠ", aliases: ["Topsmarket Âu Cơ", "Top Market Âu Cơ", "Âu Cơ", "Au Co"] },
] as const;

const toNum = (v: any) => {
  const raw = String(v ?? "").trim();
  if (!raw) return 0;
  const s = raw.replace(/[^\d,.-]/g, "");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  const normalize = (input: string, decimalSep: "," | ".") => {
    const parts = input.split(decimalSep);
    if (parts.length === 1) return input.replace(/[,.]/g, "");
    const decimal = parts.pop() || "";
    const integer = parts.join("").replace(/[,.]/g, "");
    return `${integer}.${decimal}`;
  };
  let normalized = s;
  if (hasComma && hasDot) normalized = s.lastIndexOf(",") > s.lastIndexOf(".") ? normalize(s, ",") : normalize(s, ".");
  else if (hasComma) normalized = /,\d{1,2}$/.test(s) ? normalize(s, ",") : s.replace(/,/g, "");
  else if (hasDot) normalized = /\.\d{1,2}$/.test(s) ? normalize(s, ".") : s.replace(/\./g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const makeValidIsoDate = (year: number, month: number, day: number) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

const normalizeKingfoodSpreadsheetDate = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return makeValidIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Kingfood XLSX exports from SheetJS raw:false render Excel dates as MM/DD/YYYY.
  // Normalize before monthly filtering; keep the original spreadsheet text in `date`.
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3].length === 2 ? `20${us[3]}` : us[3]);
    return makeValidIsoDate(year, month, day);
  }

  const vn = raw.match(/^(\d{1,2})[.](\d{1,2})[.](\d{2}|\d{4})$/);
  if (vn) {
    const day = Number(vn[1]);
    const month = Number(vn[2]);
    const year = Number(vn[3].length === 2 ? `20${vn[3]}` : vn[3]);
    return makeValidIsoDate(year, month, day);
  }

  return null;
};

const decodeBase64UrlToBytes = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const raw = atob(normalized + padding);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const sanitizeVat = (subtotal: number, vat: number) => {
  const s = Number(subtotal || 0);
  const v = Number(vat || 0);
  if (s <= 0) return 0;
  if (v <= 0 || v > s * 0.3) return Math.round(s * 0.08);
  return v;
};

const sanitizeTotal = (subtotal: number, vat: number, total: number) => {
  const expected = Number(subtotal || 0) + Number(vat || 0);
  const t = Number(total || 0);
  if (expected <= 0) return t > 0 ? t : 0;
  if (t <= 0 || t > expected * 1.5 || t < expected * 0.5) return expected;
  return t;
};

function parseKingfoodXlsx(bytes: Uint8Array) {
  const workbook = XLSX.read(bytes, { type: "array" });
  let best = { sheetName: null as string | null, items: [] as any[], subtotal: 0, vat: 0, total: 0, totalQty: 0, itemCount: 0 };

  for (const sheetName of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    const items = rows
      .map((row) => {
        const sku = String(row?.[14] || "").trim();
        const productName = String(row?.[15] || "").trim();
        const qty = toNum(row?.[17] ?? row?.[18] ?? 0);
        const unitPrice = toNum(row?.[20]);
        const explicitLineTotal = toNum(row?.[31]);
        const rawDate = String(row?.[11] || "").trim();
        return {
          date: rawDate,
          service_date: normalizeKingfoodSpreadsheetDate(rawDate),
          product_name: productName,
          source_column_name: "row_item",
          sku,
          qty,
          unit: String(row?.[16] || "").trim(),
          unit_price: unitPrice,
          line_total: explicitLineTotal || qty * unitPrice,
          amount_includes_vat: true,
          amount_source: "kingfood_po_line_total_vat_included",
          vat_handling: "no_extra_multiplier",
        };
      })
      .filter((item) => /^SP\d+/i.test(item.sku) && item.product_name && item.qty > 0);

    const firstItemRow = rows.find((row) => /^SP\d+/i.test(String(row?.[14] || "").trim())) || [];
    const subtotal = toNum(firstItemRow?.[33]);
    const vat = toNum(firstItemRow?.[34]);
    const total = toNum(firstItemRow?.[35]);
    const totalQty = toNum(firstItemRow?.[37]);
    const itemCount = toNum(firstItemRow?.[38]);

    if (items.length > best.items.length) {
      best = { sheetName, items, subtotal, vat, total, totalQty, itemCount };
    }
  }

  const itemSubtotal = best.items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
  const itemQty = best.items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  const subtotal = best.subtotal > 0 ? best.subtotal : itemSubtotal;
  const vat = sanitizeVat(subtotal, best.vat);
  const total = sanitizeTotal(subtotal, vat, best.total);
  const subtotalDiff = Math.abs(itemSubtotal - subtotal);
  const qtyDiff = best.totalQty > 0 ? Math.abs(itemQty - best.totalQty) : 0;
  const itemCountDiff = best.itemCount > 0 ? Math.abs(best.items.length - best.itemCount) : 0;

  return {
    ...best,
    subtotal,
    vat,
    total,
    itemSubtotal,
    itemQty,
    subtotalDiff,
    qtyDiff,
    itemCountDiff,
    isValid: best.items.length > 0 && subtotalDiff <= 1 && qtyDiff <= 1 && itemCountDiff <= 0,
  };
}

const isKingfoodCancelSubject = (subject: string) => /THÔNG\s*BÁO\s*H[ỦUỶY]|HUY\s*DON|HỦY\s*ĐƠN|HUỶ\s*ĐƠN/i.test(subject || "");

const normalizeTextKey = (value: string) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();


const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const shiftIsoDate = (date: string, deltaDays: number) => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return isoDate(shifted);
};

const localDateFromTimestamp = (value?: string | null) => {
  const date = value ? new Date(value) : new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const excelSerialToIsoDate = (value: unknown) => {
  const numeric = typeof value === "number" ? value : toNum(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const ms = Math.round((numeric - 25569) * 86400 * 1000);
  return isoDate(new Date(ms));
};

const extractGmailTextPlainBody = (payload: any): string => {
  const chunks: string[] = [];
  const walk = (part: any) => {
    if (!part) return;
    const mimeType = String(part?.mimeType || "").toLowerCase();
    const data = part?.body?.data ? String(part.body.data) : "";
    if (mimeType === "text/plain" && data) {
      chunks.push(decodeBase64Url(data));
    }
    if (Array.isArray(part?.parts)) {
      for (const child of part.parts) walk(child);
    }
  };
  walk(payload);
  return chunks.join("\n").trim();
};

const parseThuyDirectDealerSubjectDate = (_subject: string, receivedAt: string) => {
  // User-confirmed 2026-05-09 rule: Thúy daily preorder service date is
  // the local email-sent date + 1 day. Typed dates in subject/body can be
  // staff typos and are retained only as diagnostic evidence.
  return shiftIsoDate(localDateFromTimestamp(receivedAt), 1);
};

const stripQuotedTextOrderBody = (body: string) => {
  const lines = String(body || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) continue;
    if (/^On .+ wrote:$/i.test(trimmed) || /^Vào .+ đã viết:$/i.test(trimmed)) break;
    if (/^From:\s/i.test(trimmed) || /^Sent:\s/i.test(trimmed) || /^--\s*$/.test(trimmed)) break;
    if (/^Best Regards/i.test(trimmed) || /^Hotline:/i.test(trimmed) || /^\[image:/i.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join("\n");
};

const findThuyDealerCustomer = (route: string, candidates: EmailCandidate[]) => {
  const routeKey = normalizeTextKey(route);
  const alias = THUY_DIRECT_DEALER_ALIASES.find((entry) => entry.aliases.some((value) => normalizeTextKey(value) === routeKey));
  const canonicalKey = alias ? normalizeTextKey(alias.canonical) : routeKey;
  const normalizeCustomerName = (name: string | null) => normalizeTextKey(String(name || "").replace(/^ĐẠI\s+LÝ\s+/i, ""));

  const direct = candidates.find((candidate) => normalizeTextKey(candidate.customerName || "") === canonicalKey);
  if (direct) return { customer: direct, canonicalName: direct.customerName || alias?.canonical || route, aliasApplied: Boolean(alias) };

  const byAliasCanonical = candidates.find((candidate) => normalizeTextKey(candidate.customerName || "") === normalizeTextKey(alias?.canonical || ""));
  if (byAliasCanonical) return { customer: byAliasCanonical, canonicalName: byAliasCanonical.customerName || alias?.canonical || route, aliasApplied: Boolean(alias) };

  const normalized = candidates.find((candidate) => normalizeCustomerName(candidate.customerName).includes(routeKey) || routeKey.includes(normalizeCustomerName(candidate.customerName)));
  if (normalized) return { customer: normalized, canonicalName: normalized.customerName || alias?.canonical || route, aliasApplied: Boolean(alias) };

  return { customer: null, canonicalName: alias?.canonical || route, aliasApplied: Boolean(alias) };
};

const parseThuyDirectDealerBodyLines = (
  body: string,
  meta: { messageId: string; subject: string; timestamp: string; serviceDate: string | null },
  candidates: EmailCandidate[],
) => {
  const lines = stripQuotedTextOrderBody(body).split("\n");
  const items: any[] = [];
  const needsReview: any[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^\d+\s*$/.test(line)) continue;
    const match = line.match(/^\s*(?:\d+[.)]\s*)?(.+?)\s+(\d+(?:[.,]\d+)?)\b(.*)$/i);
    if (!match) continue;

    const routeRaw = match[1].trim();
    const orderedQty = toNum(match[2]);
    const tail = String(match[3] || "");
    if (!routeRaw || !Number.isFinite(orderedQty) || orderedQty <= 0) continue;
    const exchangeQty = toNum(tail.match(/(?:^|\s)đổi\s+(\d+(?:[.,]\d+)?)/i)?.[1] || "0");
    const makeupQty = toNum(tail.match(/(?:^|\s)bù\s+(\d+(?:[.,]\d+)?)/i)?.[1] || tail.match(/(?:^|\s)bu\s+(\d+(?:[.,]\d+)?)/i)?.[1] || "0");
    const matched = findThuyDealerCustomer(routeRaw, candidates);
    const confidence = matched.customer ? 0.96 : 0.72;
    if (!matched.customer) needsReview.push({ raw_line: rawLine, route: routeRaw, reason: "No active CRM customer match for Thúy direct dealer route" });

    items.push({
      evidence_type: "thuy_direct_dealer_text_line",
      source_channel: "direct_company_dealer",
      service_date: meta.serviceDate,
      date: meta.serviceDate,
      route: routeRaw,
      customer_id: matched.customer?.customerId || null,
      customer_name: matched.canonicalName,
      revenue_channel: matched.customer?.revenueChannel || "agency",
      ordered_qty: orderedQty,
      qty: orderedQty,
      revenue_qty: orderedQty,
      exchange_qty: exchangeQty,
      makeup_qty: makeupQty,
      physical_qty: orderedQty + exchangeQty + makeupQty,
      unit_price: THUY_DIRECT_DEALER_AUTOMATION.unitPrice,
      line_total: orderedQty * THUY_DIRECT_DEALER_AUTOMATION.unitPrice,
      line_amount: orderedQty * THUY_DIRECT_DEALER_AUTOMATION.unitPrice,
      raw_line: rawLine,
      note: tail.trim() || null,
      alias_applied: matched.aliasApplied,
      confidence,
      source_column_name: "thuy_direct_dealer_text_body_line",
      gmail_message_id: meta.messageId,
      email_subject: meta.subject,
      received_at: meta.timestamp,
    });
  }

  return { items, needsReview };
};


const parseLooseSubjectDate = (subject: string, receivedAt: string) => {
  const match = String(subject || "").match(/(?:^|\b)(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?(?:\b|$)/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const receivedYear = new Date(receivedAt || Date.now()).getUTCFullYear();
  const explicitYear = match[3] ? Number(match[3]) : null;
  const year = explicitYear ? (explicitYear < 100 ? 2000 + explicitYear : explicitYear) : receivedYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const findCandidateByName = (candidates: EmailCandidate[], name: string) => {
  const key = normalizeTextKey(name);
  return candidates.find((candidate) => normalizeTextKey(candidate.customerName || "") === key) || null;
};

const findTonyRouteCustomer = (route: string, candidates: EmailCandidate[]) => {
  const routeKey = normalizeTextKey(route);
  const alias = TONY_THANH_ROUTE_ALIASES.find((entry) => entry.aliases.some((value) => normalizeTextKey(value) === routeKey));
  const canonicalName = alias?.canonical || route;
  const canonicalKey = normalizeTextKey(canonicalName);
  const child = candidates.find((candidate) => {
    const customerKey = normalizeTextKey(candidate.customerName || "");
    return customerKey === canonicalKey || customerKey.includes(routeKey) || routeKey.includes(customerKey);
  });
  return { customer: child || null, canonicalName, aliasApplied: Boolean(alias) };
};

const splitOrderTextLines = (body: string) => {
  const normalized = stripQuotedTextOrderBody(body)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/,\s*(?=[^,\n]+\s+\d)/g, "\n");
  const rawLines = normalized.split("\n");
  const merged: string[] = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line || /^\d+\s*$/.test(line)) continue;
    if (/^(?:đổi|doi|bù|bu)\s+\d+/i.test(line) && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${line}`;
      continue;
    }
    merged.push(line);
  }
  return merged;
};

const parseTonyThanhBodyLines = (
  body: string,
  meta: { messageId: string; subject: string; timestamp: string; poOrderDate: string | null; serviceDate: string | null },
  candidates: EmailCandidate[],
) => {
  const parent = findCandidateByName(candidates, TONY_THANH_AUTOMATION.parentCustomerName) || candidates.find((candidate) => candidate.isNpp) || null;
  const items: any[] = [];
  const needsReview: any[] = [];
  const subjectKey = normalizeTextKey(meta.subject);
  const isReplyOrUpdate = /\b(re|fw|fwd)\b|cap nhat|bo sung|update|them/.test(subjectKey);

  for (const rawLine of splitOrderTextLines(body)) {
    const match = rawLine.match(/^\s*(?:\d+[.)]\s*)?(.+?)\s+(\d+(?:[.,]\d+)?)\b(.*)$/i);
    if (!match) continue;
    const routeRaw = match[1].trim();
    const orderedQty = toNum(match[2]);
    const tail = String(match[3] || "");
    if (!routeRaw || !Number.isFinite(orderedQty) || orderedQty <= 0) continue;
    const exchangeQty = toNum(tail.match(/(?:^|\s)đổi\s+(\d+(?:[.,]\d+)?)/i)?.[1] || tail.match(/(?:^|\s)doi\s+(\d+(?:[.,]\d+)?)/i)?.[1] || "0");
    const makeupQty = toNum(tail.match(/(?:^|\s)bù\s+(\d+(?:[.,]\d+)?)/i)?.[1] || tail.match(/(?:^|\s)bu\s+(\d+(?:[.,]\d+)?)/i)?.[1] || "0");
    const matchedRoute = findTonyRouteCustomer(routeRaw, candidates);
    const reviewReasons = [
      !parent ? "Tony/Anh Thanh parent NPP customer not found" : null,
      !matchedRoute.customer ? "Tony route child customer not matched; keep alias evidence" : null,
      isReplyOrUpdate ? "Tony reply/update/supplement semantics require manual reconciliation" : null,
      /[+=]|\btồn\b/i.test(rawLine) ? "Ambiguous Tony line contains +, =, or tồn" : null,
    ].filter(Boolean);
    if (reviewReasons.length > 0) needsReview.push({ raw_line: rawLine, route: routeRaw, reasons: reviewReasons });

    items.push({
      evidence_type: "tony_thanh_npp_text_line",
      source_channel: "tony_thanh_npp",
      service_date: meta.serviceDate,
      date: meta.serviceDate,
      po_order_date: meta.poOrderDate,
      route: routeRaw,
      customer_id: parent?.customerId || null,
      parent_customer_id: parent?.customerId || null,
      parent_customer_name: parent?.customerName || TONY_THANH_AUTOMATION.parentCustomerName,
      route_customer_id: matchedRoute.customer?.customerId || null,
      route_customer_name: matchedRoute.canonicalName,
      customer_name: parent?.customerName || TONY_THANH_AUTOMATION.parentCustomerName,
      revenue_channel: parent?.revenueChannel || "agency",
      ordered_qty: orderedQty,
      qty: orderedQty,
      revenue_qty: orderedQty,
      exchange_qty: exchangeQty,
      makeup_qty: makeupQty,
      physical_qty: orderedQty + exchangeQty + makeupQty,
      unit_price: TONY_THANH_AUTOMATION.unitPrice,
      line_total: orderedQty * TONY_THANH_AUTOMATION.unitPrice,
      line_amount: orderedQty * TONY_THANH_AUTOMATION.unitPrice,
      raw_line: rawLine,
      note: tail.trim() || null,
      alias_applied: matchedRoute.aliasApplied,
      confidence: reviewReasons.length === 0 ? 0.94 : 0.7,
      source_column_name: "tony_thanh_text_body_line",
      gmail_message_id: meta.messageId,
      email_subject: meta.subject,
      received_at: meta.timestamp,
      needs_manual_review: reviewReasons.length > 0,
      review_reasons: reviewReasons,
    });
  }

  return { items, needsReview, parent };
};

const parseVietjetCumulativeXlsx = (bytes: Uint8Array, meta: { messageId: string; subject: string; timestamp: string; filename: string }) => {
  const workbook = XLSX.read(bytes, { type: "array", cellDates: false });
  const items: any[] = [];
  for (const sheetName of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: "" });
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      if (normalizeTextKey(String(row?.[0] || "")) !== normalizeTextKey("TỔNG CỘNG THEO NGÀY")) continue;
      const previous = rows[i - 1] || [];
      const serviceDate = excelSerialToIsoDate(previous?.[1] || row?.[1]);
      const qty = toNum(row?.[18]);
      if (!serviceDate || qty <= 0) continue;
      items.push({
        evidence_type: "vietjet_cumulative_xlsx_day_total",
        source_channel: "vietjet_cumulative_schedule",
        service_date: serviceDate,
        date: serviceDate,
        product_code: VIETJET_AUTOMATION.productCode,
        product_name: VIETJET_AUTOMATION.productName,
        qty,
        ordered_qty: qty,
        revenue_qty: qty,
        unit_price: VIETJET_AUTOMATION.unitPrice,
        line_total: qty * VIETJET_AUTOMATION.unitPrice,
        line_amount: qty * VIETJET_AUTOMATION.unitPrice,
        dedupe_key: `${serviceDate}:${VIETJET_AUTOMATION.productCode}`,
        dedupe_strategy: "keep_latest_gmail_timestamp_per_service_date_product",
        source_sheet: sheetName,
        source_filename: meta.filename,
        source_column_name: "vietjet_total_by_day_col_19_product_40000294",
        gmail_message_id: meta.messageId,
        email_subject: meta.subject,
        received_at: meta.timestamp,
        confidence: 0.92,
      });
    }
  }
  return items;
};

const parseDamXesgSubjectDate = (subject: string) => {
  const match = String(subject || "").match(/Đặt\s+bánh\s+điểm\s+bán\s+(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const stripQuotedDamXesgBody = (body: string) => {
  const lines = String(body || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^>/.test(trimmed)) continue;
    if (/^On .+ wrote:$/i.test(trimmed) || /^Vào .+ đã viết:$/i.test(trimmed)) break;
    if (/^--\s*$/.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join("\n");
};

const normalizeDamXesgRoute = (route: string) => {
  const key = normalizeTextKey(route);
  for (const entry of DAM_XESG_ROUTE_ALIASES) {
    if (entry.aliases.some((alias) => normalizeTextKey(alias) === key)) return entry.canonical;
  }
  return null;
};

const parseDamXesgBodyLines = (body: string, meta: { messageId: string; subject: string; timestamp: string }) => {
  const lines = stripQuotedDamXesgBody(body).split("\n");
  const items: any[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.+?)\s+(\d+)\s*(\*)?\s*$/);
    if (!match) continue;
    const route = normalizeDamXesgRoute(match[1]);
    if (!route) continue;
    const rawQty = match[2];
    const qty = Number(rawQty);
    if (!Number.isFinite(qty)) continue;

    items.push({
      route,
      qty,
      sent_qty: qty,
      sold_qty: null,
      accounting_qty_source: "trusted_ledger_sold_qty",
      inventory_note: "T4 reconciliation: 662 bánh inventory/unsold delta means sent_qty evidence must not be treated as sold_qty revenue.",
      raw_qty: rawQty,
      has_star: Boolean(match[3]),
      raw_line: rawLine,
      confidence: 0.98,
      source_column_name: "dam_xesg_text_body_line",
      gmail_message_id: meta.messageId,
      email_subject: meta.subject,
      received_at: meta.timestamp,
    });
  }

  return items;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // Enforce JWT authentication for manual users, or cron secret for the
    // 23:59 controlled revenue parser that must import fresh PO/email first.
    const authHeader = req.headers.get("Authorization");
    const hasCronSecret = Boolean(req.headers.get("x-cron-secret"));
    if (hasCronSecret) {
      const envKey = Deno.env.get("REVENUE_CRON_SECRET") ? "REVENUE_CRON_SECRET" : "PO_SYNC_CRON_SECRET";
      requireCronSecret(req, envKey, getCorsHeaders(req));
    } else if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    } else {
      const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(
        authHeader.replace("Bearer ", "")
      );
      if (authError || !authUser) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "preview").toLowerCase(); // preview | import
    const includeOnlyCrm = body?.includeOnlyCrm !== false;
    const maxResults = Math.min(Math.max(Number(body?.maxResults || 20), 1), 100);
    const query = String(body?.query || "in:anywhere deliveredto:po@bmq.vn newer_than:30d");
    if (hasCronSecret && (mode !== "import" || !includeOnlyCrm || !query.toLowerCase().includes("deliveredto:po@bmq.vn"))) {
      return new Response(JSON.stringify({ error: "Invalid cron Gmail sync request" }), {
        status: 400,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const importMessageIds = new Set<string>(Array.isArray(body?.messageIds) ? body.messageIds.map((x: any) => String(x)) : []);

    const accessToken = await getGoogleAccessToken(supabaseAdmin);

    const profile = await gmailApi(accessToken, "profile");
    const list = await gmailApi(accessToken, `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    const messages: GmailMessage[] = Array.isArray(list?.messages) ? list.messages : [];

    const { data: crmEmails } = await supabaseAdmin
      .from("mini_crm_customer_emails")
      .select("email, customer_id, mini_crm_customers(customer_name,customer_group,is_active,is_npp,supplied_by_npp_customer_id)");

    const emailMap = new Map<string, EmailCandidate[]>();
    for (const row of crmEmails || []) {
      const rawEmail = String((row as any).email || "");
      const expanded = explodeEmails(rawEmail);
      const customer = (row as any).mini_crm_customers || {};
      const isActive = Boolean(customer?.is_active);
      if (!isActive) continue;
      const candidate: EmailCandidate = {
        customerId: String((row as any).customer_id || ""),
        customerName: customer?.customer_name ? String(customer.customer_name) : null,
        revenueChannel: revenueChannelFromCustomerGroup(customer?.customer_group || null),
        isNpp: Boolean(customer?.is_npp),
        suppliedByNppCustomerId: customer?.supplied_by_npp_customer_id ? String(customer.supplied_by_npp_customer_id) : null,
      };
      if (!candidate.customerId) continue;
      for (const key of expanded) {
        const existing = emailMap.get(key) || [];
        existing.push(candidate);
        emailMap.set(key, existing);
      }
    }

    const activeCustomerIds = Array.from(
      new Set(Array.from(emailMap.values()).flat().map((v) => v.customerId).filter(Boolean)),
    );
    const { data: activeTemplates } = await supabaseAdmin
      .from("mini_crm_po_templates")
      .select("id, customer_id, template_name, file_name, parser_config, sample_preview, is_active, updated_at")
      .eq("is_active", true)
      .in("customer_id", activeCustomerIds.length ? activeCustomerIds : ["00000000-0000-0000-0000-000000000000"]);

    const templateMap = new Map<string, any>();
    for (const t of activeTemplates || []) {
      templateMap.set(String((t as any).customer_id), t);
    }

    let synced = 0;
    let matchedCount = 0;
    let unmatchedCount = 0;
    let ambiguousCount = 0;
    let nppResolvedCount = 0;
    let skippedInvalidFrom = 0;
    let upsertErrorCount = 0;
    let skippedNotInCrm = 0;
    const skippedNotInCrmSamples: string[] = [];
    const upsertErrors: Array<{ messageId: string; error: string }> = [];
    const previews: any[] = [];
    const stagedPayloads: any[] = [];

    for (const m of messages) {
      const detail = await gmailApi(accessToken, `messages/${m.id}?format=full`);
      const headers: Array<{ name: string; value: string }> = detail?.payload?.headers || [];

      const getHeader = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const from = getHeader("From");
      const subject = getHeader("Subject");
      const dateHeader = getHeader("Date");

      const fromEmail = normalizeEmail(from);
      if (!fromEmail || !fromEmail.includes("@")) {
        skippedInvalidFrom += 1;
        continue;
      }
      const fromName = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : null;

      const snippet = detail?.snippet || "";
      const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();
      const attachmentParts: Array<{ filename: string; mimeType: string; attachmentId: string | null }> = [];
      const attachmentNames: string[] = [];

      const walkParts = (parts: any[] = []) => {
        for (const p of parts) {
          if (p?.filename) {
            const filename = String(p.filename);
            attachmentNames.push(filename);
            attachmentParts.push({
              filename,
              mimeType: String(p?.mimeType || ""),
              attachmentId: p?.body?.attachmentId ? String(p.body.attachmentId) : null,
            });
          }
          if (Array.isArray(p?.parts)) walkParts(p.parts);
        }
      };
      walkParts(detail?.payload?.parts || []);

      const candidateMatches = emailMap.get(fromEmail) || [];
      const resolvedMatch = resolveEmailCandidates(candidateMatches);
      const match = resolvedMatch.match;
      if (match) {
        matchedCount += 1;
        if (resolvedMatch.resolution === "npp_parent") nppResolvedCount += 1;
      } else {
        unmatchedCount += 1;
        if (resolvedMatch.resolution === "ambiguous") ambiguousCount += 1;
      }

      const allowedUnmatchedSender =
        fromEmail === THUY_DIRECT_DEALER_AUTOMATION.sender ||
        fromEmail === TONY_THANH_AUTOMATION.sender ||
        fromEmail === DAM_XESG_AUTOMATION.sender ||
        isCoopmartSenderEmail(fromEmail) ||
        fromEmail.endsWith(`@${VIETJET_AUTOMATION.senderDomain}`);
      if (includeOnlyCrm && !match && !allowedUnmatchedSender) {
        skippedNotInCrm += 1;
        if (skippedNotInCrmSamples.length < 5) skippedNotInCrmSamples.push(fromEmail);
        continue;
      }

      const template = match?.customerId ? templateMap.get(match.customerId) : null;

      const isKingfoodSender = fromEmail === KINGFOOD_AUTOMATION.sender;
      const isDamXesgSender = fromEmail === DAM_XESG_AUTOMATION.sender;
      const isThuyDirectDealerSender = fromEmail === THUY_DIRECT_DEALER_AUTOMATION.sender;
      const isTonyThanhSender = fromEmail === TONY_THANH_AUTOMATION.sender;
      const isVietjetSender = fromEmail.endsWith(`@${VIETJET_AUTOMATION.senderDomain}`);
      const isCoopmartSender = isCoopmartSenderEmail(fromEmail);
      const xlsxFile = attachmentParts.find((a) => a.filename === KINGFOOD_AUTOMATION.xlsxName && a.attachmentId);
      const pdfFile = attachmentParts.find((a) => a.filename.toLowerCase().endsWith(".pdf"));
      const isCancelSignal = isKingfoodSender && isKingfoodCancelSubject(subject || "");

      let kingfoodAutomation: any = isKingfoodSender
        ? {
            rule: "kingfood_po_automation",
            sender: KINGFOOD_AUTOMATION.sender,
            automation_status: "needs_manual_review",
            reason: "Kingfood email does not match a supported attachment pattern",
            has_xlsx: Boolean(xlsxFile),
            has_pdf: Boolean(pdfFile),
            source_xlsx: xlsxFile?.filename || null,
            source_pdf: pdfFile?.filename || null,
          }
        : null;
      let parsedItems: any[] | null = null;
      let parsedSubtotal: number | null = null;
      let parsedVat: number | null = null;
      let parsedTotal: number | null = null;
      let damXesgAutomation: any = null;
      let damXesgServiceDate: string | null = null;
      let thuyDirectDealerAutomation: any = null;
      let thuyDirectDealerServiceDate: string | null = null;
      let tonyThanhAutomation: any = null;
      let tonyThanhServiceDate: string | null = null;
      let tonyThanhPoOrderDate: string | null = null;
      let vietjetAutomation: any = null;
      let coopmartAutomation: any = null;

      if (isCancelSignal && kingfoodAutomation) {
        kingfoodAutomation = {
          ...kingfoodAutomation,
          automation_status: "cancel_signal",
          reason: "Kingfood cancellation email; do not create a normal PO/revenue draft",
        };
      } else if (isKingfoodSender && xlsxFile?.attachmentId && kingfoodAutomation) {
        try {
          const attachment = await gmailApi(accessToken, `messages/${m.id}/attachments/${xlsxFile.attachmentId}`);
          const parsed = parseKingfoodXlsx(decodeBase64UrlToBytes(String(attachment?.data || "")));
          parsedItems = parsed.items;
          parsedSubtotal = parsed.subtotal || null;
          parsedVat = parsed.vat || 0;
          parsedTotal = parsed.total || parsed.subtotal || null;
          kingfoodAutomation = {
            ...kingfoodAutomation,
            automation_status: parsed.isValid ? "parsed_valid" : "parsed_needs_review",
            reason: parsed.isValid ? "Kingfood Export-PO-Data.xlsx parsed and totals validated" : "Kingfood XLSX parsed but totals/item count need review",
            source_sheet: parsed.sheetName,
            item_count: parsed.items.length,
            subtotal: parsed.subtotal,
            vat_amount: parsed.vat,
            total_amount: parsed.total,
            amount_includes_vat: true,
            amount_source: "kingfood_po_total_vat_included",
            vat_handling: "no_extra_multiplier",
            item_subtotal: parsed.itemSubtotal,
            item_qty: parsed.itemQty,
            subtotal_diff: parsed.subtotalDiff,
            qty_diff: parsed.qtyDiff,
            item_count_diff: parsed.itemCountDiff,
          };
        } catch (parseError) {
          kingfoodAutomation = {
            ...kingfoodAutomation,
            automation_status: "parse_failed_needs_review",
            reason: parseError instanceof Error ? parseError.message : "Kingfood XLSX parse failed",
          };
        }
      } else if (isKingfoodSender && pdfFile && kingfoodAutomation) {
        kingfoodAutomation = {
          ...kingfoodAutomation,
          automation_status: "pdf_only_needs_review",
          reason: "Kingfood email has PDF but no Export-PO-Data.xlsx; PDF parser/manual review required",
        };
      }

      if (isDamXesgSender) {
        damXesgServiceDate = parseDamXesgSubjectDate(subject || "");
        const textBody = extractGmailTextPlainBody(detail?.payload);
        const damItems = damXesgServiceDate
          ? parseDamXesgBodyLines(textBody, { messageId: m.id, subject: subject || "", timestamp: receivedAt })
          : [];
        const totalQty = damItems.reduce((sum, item) => sum + Number(item.qty || 0), 0);

        damXesgAutomation = {
          rule: DAM_XESG_AUTOMATION.rule,
          sender: DAM_XESG_AUTOMATION.sender,
          source: "gmail_text_plain_body",
          subject_pattern: "Đặt bánh điểm bán D/M/YYYY",
          service_date: damXesgServiceDate,
          item_count: damItems.length,
          total_qty: totalQty,
          automation_status: damXesgServiceDate && damItems.length > 0 ? "po_evidence_only" : "parse_failed_needs_review",
          reason: damXesgServiceDate && damItems.length > 0
            ? "Dam/XESG text body parsed as production/order evidence only; trusted ledger reconciliation decides accounting revenue when qty deltas exist"
            : "Dam/XESG sender matched but subject date or text body route quantities could not be parsed; manual review required",
          trusted_reconciliation_status: "trusted_source_used_qty_delta",
          trusted_ledger_required: true,
          evidence_only: true,
          inventory_reconciliation_note: "Preserve sent_qty/order evidence separately from sold_qty/accounting revenue; T4 Dam/XESG had 662 bánh inventory/unsold delta.",
          body_source_available: Boolean(textBody),
          route_aliases: DAM_XESG_ROUTE_ALIASES.map((entry) => ({ route: entry.canonical, aliases: entry.aliases })),
          lines: damItems.map((item) => ({
            raw_line: item.raw_line,
            gmail_message_id: item.gmail_message_id,
            subject: item.email_subject,
            timestamp: item.received_at,
            route: item.route,
            qty: item.qty,
            sent_qty: item.sent_qty,
            sold_qty: item.sold_qty,
            accounting_qty_source: item.accounting_qty_source,
            inventory_note: item.inventory_note,
            raw_qty: item.raw_qty,
            confidence: item.confidence,
          })),
        };

        if (damXesgServiceDate && damItems.length > 0) {
          parsedItems = damItems;
          parsedSubtotal = null;
          parsedVat = 0;
          parsedTotal = null;
        }
      }

      if (isThuyDirectDealerSender) {
        thuyDirectDealerServiceDate = parseThuyDirectDealerSubjectDate(subject || "", receivedAt);
        const textBody = extractGmailTextPlainBody(detail?.payload);
        const parsed = thuyDirectDealerServiceDate
          ? parseThuyDirectDealerBodyLines(textBody, { messageId: m.id, subject: subject || "", timestamp: receivedAt, serviceDate: thuyDirectDealerServiceDate }, candidateMatches)
          : { items: [], needsReview: [{ reason: "Subject date did not match Đặt bánh đại lý D.M" }] };
        const totalQty = parsed.items.reduce((sum, item) => sum + Number(item.revenue_qty || item.qty || 0), 0);
        const totalAmount = parsed.items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
        const unmatchedCount = parsed.needsReview.length;

        thuyDirectDealerAutomation = {
          rule: THUY_DIRECT_DEALER_AUTOMATION.rule,
          parser: THUY_DIRECT_DEALER_AUTOMATION.parser,
          sender: THUY_DIRECT_DEALER_AUTOMATION.sender,
          source: "gmail_text_plain_body",
          subject_pattern: "Đặt bánh đại lý D.M",
          service_date: thuyDirectDealerServiceDate,
          item_count: parsed.items.length,
          matched_line_count: parsed.items.length - unmatchedCount,
          unmatched_line_count: unmatchedCount,
          total_qty: totalQty,
          total_amount: totalAmount,
          unit_price: THUY_DIRECT_DEALER_AUTOMATION.unitPrice,
          automation_status: thuyDirectDealerServiceDate && parsed.items.length > 0 && unmatchedCount === 0 ? "line_level_manual_revenue_ready" : "parsed_needs_review",
          reason: thuyDirectDealerServiceDate && parsed.items.length > 0 && unmatchedCount === 0
            ? "Thúy direct-company dealer aggregation parsed into line-level customer revenue evidence; route customers are direct BMQ dealers, not NPP children"
            : "Thúy direct-company dealer email needs review because subject date, body lines, or CRM route mapping was incomplete",
          channel_scope: "direct_company_dealer_not_npp",
          revenue_posting_allowed: false,
          manual_revenue_management_required: true,
          double_count_guardrail: "Do not also count the same route/date from Tony/Dam/other alternate trace emails unless explicitly approved",
          body_source_available: Boolean(textBody),
          needs_review: parsed.needsReview,
          route_aliases: THUY_DIRECT_DEALER_ALIASES.map((entry) => ({ customer: entry.canonical, aliases: entry.aliases })),
          lines: parsed.items.map((item) => ({
            raw_line: item.raw_line,
            gmail_message_id: item.gmail_message_id,
            subject: item.email_subject,
            timestamp: item.received_at,
            service_date: item.service_date,
            route: item.route,
            customer_id: item.customer_id,
            customer_name: item.customer_name,
            ordered_qty: item.ordered_qty,
            exchange_qty: item.exchange_qty,
            makeup_qty: item.makeup_qty,
            physical_qty: item.physical_qty,
            unit_price: item.unit_price,
            line_total: item.line_total,
            confidence: item.confidence,
          })),
        };

        if (thuyDirectDealerServiceDate && parsed.items.length > 0) {
          parsedItems = parsed.items;
          parsedSubtotal = totalAmount;
          parsedVat = 0;
          parsedTotal = totalAmount;
        }
      }

      if (isTonyThanhSender) {
        tonyThanhPoOrderDate = parseLooseSubjectDate(subject || "", receivedAt);
        tonyThanhServiceDate = tonyThanhPoOrderDate ? shiftIsoDate(tonyThanhPoOrderDate, 1) : null;
        const textBody = extractGmailTextPlainBody(detail?.payload);
        const parsed = tonyThanhServiceDate
          ? parseTonyThanhBodyLines(textBody, { messageId: m.id, subject: subject || "", timestamp: receivedAt, poOrderDate: tonyThanhPoOrderDate, serviceDate: tonyThanhServiceDate }, resolvedMatch.candidates)
          : { items: [], needsReview: [{ reason: "Tony subject/order date could not be parsed" }], parent: null };
        const totalQty = parsed.items.reduce((sum, item) => sum + Number(item.revenue_qty || item.qty || 0), 0);
        const totalAmount = parsed.items.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
        const reviewCount = parsed.needsReview.length;

        tonyThanhAutomation = {
          rule: TONY_THANH_AUTOMATION.rule,
          parser: TONY_THANH_AUTOMATION.parser,
          sender: TONY_THANH_AUTOMATION.sender,
          source: "gmail_text_plain_body",
          service_date_rule: "ledger_date_equals_po_order_date_plus_1_day",
          po_order_date: tonyThanhPoOrderDate,
          service_date: tonyThanhServiceDate,
          item_count: parsed.items.length,
          total_qty: totalQty,
          total_amount: totalAmount,
          unit_price: TONY_THANH_AUTOMATION.unitPrice,
          automation_status: tonyThanhServiceDate && parsed.items.length > 0 && reviewCount === 0 ? "po_evidence_only" : "parsed_needs_review",
          reason: tonyThanhServiceDate && parsed.items.length > 0 && reviewCount === 0
            ? "Tony/Anh Thanh text order parsed as NPP operational evidence; trusted ledger/CSV remains accounting truth"
            : "Tony/Anh Thanh email needs review because date, body lines, route mapping, or reply/update semantics were incomplete",
          parent_customer_name: parsed.parent?.customerName || TONY_THANH_AUTOMATION.parentCustomerName,
          revenue_posting_allowed: false,
          trusted_ledger_required: true,
          needs_review: parsed.needsReview,
          route_aliases: TONY_THANH_ROUTE_ALIASES.map((entry) => ({ customer: entry.canonical, aliases: entry.aliases })),
          lines: parsed.items.map((item) => ({
            raw_line: item.raw_line,
            gmail_message_id: item.gmail_message_id,
            subject: item.email_subject,
            timestamp: item.received_at,
            po_order_date: item.po_order_date,
            service_date: item.service_date,
            route: item.route,
            route_customer_id: item.route_customer_id,
            route_customer_name: item.route_customer_name,
            ordered_qty: item.ordered_qty,
            exchange_qty: item.exchange_qty,
            makeup_qty: item.makeup_qty,
            physical_qty: item.physical_qty,
            unit_price: item.unit_price,
            line_total: item.line_total,
            confidence: item.confidence,
            review_reasons: item.review_reasons,
          })),
        };

        if (tonyThanhServiceDate && parsed.items.length > 0) {
          parsedItems = parsed.items;
          parsedSubtotal = totalAmount;
          parsedVat = 0;
          parsedTotal = totalAmount;
        }
      }

      if (isVietjetSender) {
        const xlsxAttachments = attachmentParts.filter((a) => a.filename.toLowerCase().endsWith(".xlsx") && a.attachmentId);
        const vietjetItems: any[] = [];
        const parseErrors: string[] = [];
        for (const file of xlsxAttachments) {
          try {
            const attachment = await gmailApi(accessToken, `messages/${m.id}/attachments/${file.attachmentId}`);
            vietjetItems.push(...parseVietjetCumulativeXlsx(decodeBase64UrlToBytes(String(attachment?.data || "")), {
              messageId: m.id,
              subject: subject || "",
              timestamp: receivedAt,
              filename: file.filename,
            }));
          } catch (err) {
            parseErrors.push(err instanceof Error ? err.message : String(err));
          }
        }
        const totalQty = vietjetItems.reduce((sum, item) => sum + Number(item.qty || 0), 0);
        const totalAmount = vietjetItems.reduce((sum, item) => sum + Number(item.line_total || 0), 0);
        vietjetAutomation = {
          rule: VIETJET_AUTOMATION.rule,
          parser: VIETJET_AUTOMATION.parser,
          sender_domain: VIETJET_AUTOMATION.senderDomain,
          source: "gmail_xlsx_attachment_cumulative_schedule",
          service_date_rule: "xlsx_total_by_day_rows_deduped_by_service_date_product_keep_latest",
          product_code: VIETJET_AUTOMATION.productCode,
          product_name: VIETJET_AUTOMATION.productName,
          item_count: vietjetItems.length,
          total_qty: totalQty,
          total_amount: totalAmount,
          unit_price: VIETJET_AUTOMATION.unitPrice,
          automation_status: vietjetItems.length > 0 && parseErrors.length === 0 ? "vietjet_cumulative_evidence_only" : "parse_failed_needs_review",
          reason: vietjetItems.length > 0 && parseErrors.length === 0
            ? "Vietjet cumulative XLSX schedule parsed; monthly preview must dedupe by service_date/product and keep latest Gmail timestamp"
            : "Vietjet XLSX schedule could not be parsed; manual review required",
          revenue_posting_allowed: false,
          trusted_ledger_required: true,
          dedupe_strategy: "keep_latest_gmail_timestamp_per_service_date_product",
          parse_errors: parseErrors,
          lines: vietjetItems,
        };
        if (vietjetItems.length > 0) {
          parsedItems = vietjetItems;
          parsedSubtotal = totalAmount;
          parsedVat = 0;
          parsedTotal = totalAmount;
        }
      }

      if (isCoopmartSender) {
        coopmartAutomation = {
          rule: COOPMART_AUTOMATION.rule,
          parser: COOPMART_AUTOMATION.parser,
          sender: fromEmail,
          source: "gmail_attachment_guardrail",
          automation_status: "coopmart_manual_trusted_ledger_only",
          reason: "Coopmart/Saigon Co-op PO files are mostly empty templates and high-value Coop revenue is trusted-ledger/manual; do not auto-post PO parse revenue",
          revenue_posting_allowed: false,
          trusted_ledger_required: true,
          no_order_template_guardrail: true,
          attachment_names: attachmentNames,
        };
      }

      const poAutomation = thuyDirectDealerAutomation || tonyThanhAutomation || vietjetAutomation || coopmartAutomation || damXesgAutomation || kingfoodAutomation;
      const parseMeta = thuyDirectDealerAutomation
        ? {
            source: "thuy_direct_dealer_gmail_text_body_auto",
            parser: THUY_DIRECT_DEALER_AUTOMATION.parser,
            parsed_at: new Date().toISOString(),
            parse_mode: "thuy_direct_dealer_sender_text_body_rule",
            service_date: thuyDirectDealerServiceDate,
            delivery_date: thuyDirectDealerServiceDate,
            item_count: Number(thuyDirectDealerAutomation.item_count || 0),
            matched_line_count: Number(thuyDirectDealerAutomation.matched_line_count || 0),
            unmatched_line_count: Number(thuyDirectDealerAutomation.unmatched_line_count || 0),
            total_qty: Number(thuyDirectDealerAutomation.total_qty || 0),
            subtotal: parsedSubtotal,
            vat_amount: parsedVat,
            total_amount: parsedTotal,
            automation_status: thuyDirectDealerAutomation.automation_status,
            status: thuyDirectDealerAutomation.automation_status,
            reason: thuyDirectDealerAutomation.reason,
            channel_scope: thuyDirectDealerAutomation.channel_scope,
            revenue_posting_allowed: false,
            manual_revenue_management_required: true,
            double_count_guardrail: thuyDirectDealerAutomation.double_count_guardrail,
            template_id: template?.id || null,
            template_name: template?.template_name || null,
          }
        : tonyThanhAutomation
        ? {
            source: "tony_thanh_gmail_text_body_auto",
            parser: TONY_THANH_AUTOMATION.parser,
            parsed_at: new Date().toISOString(),
            parse_mode: "tony_thanh_sender_text_body_rule",
            po_order_date: tonyThanhPoOrderDate,
            service_date: tonyThanhServiceDate,
            delivery_date: tonyThanhServiceDate,
            date_mapping: "po_order_date_plus_1_day",
            item_count: Number(tonyThanhAutomation.item_count || 0),
            total_qty: Number(tonyThanhAutomation.total_qty || 0),
            subtotal: parsedSubtotal,
            vat_amount: parsedVat,
            total_amount: parsedTotal,
            trusted_ledger_required: true,
            revenue_posting_allowed: false,
            automation_status: tonyThanhAutomation.automation_status,
            status: tonyThanhAutomation.automation_status,
            reason: tonyThanhAutomation.reason,
            template_id: template?.id || null,
            template_name: template?.template_name || null,
          }
        : vietjetAutomation
        ? {
            source: "vietjet_gmail_xlsx_cumulative_auto",
            parser: VIETJET_AUTOMATION.parser,
            parsed_at: new Date().toISOString(),
            parse_mode: "vietjet_cumulative_xlsx_rule",
            service_date: null,
            delivery_date: null,
            date_mapping: "xlsx_service_date_per_line_deduped_by_service_date_product_keep_latest",
            product_code: VIETJET_AUTOMATION.productCode,
            item_count: Number(vietjetAutomation.item_count || 0),
            total_qty: Number(vietjetAutomation.total_qty || 0),
            subtotal: parsedSubtotal,
            vat_amount: parsedVat,
            total_amount: parsedTotal,
            trusted_ledger_required: true,
            revenue_posting_allowed: false,
            automation_status: vietjetAutomation.automation_status,
            status: vietjetAutomation.automation_status,
            reason: vietjetAutomation.reason,
            dedupe_strategy: vietjetAutomation.dedupe_strategy,
            template_id: template?.id || null,
            template_name: template?.template_name || null,
          }
        : coopmartAutomation
        ? {
            source: "coopmart_gmail_guardrail_auto",
            parser: COOPMART_AUTOMATION.parser,
            parsed_at: new Date().toISOString(),
            parse_mode: "coopmart_manual_trusted_ledger_only_guardrail",
            service_date: null,
            delivery_date: null,
            trusted_ledger_required: true,
            revenue_posting_allowed: false,
            automation_status: coopmartAutomation.automation_status,
            status: coopmartAutomation.automation_status,
            reason: coopmartAutomation.reason,
            template_id: template?.id || null,
            template_name: template?.template_name || null,
          }
        : damXesgAutomation
        ? {
            source: "dam_xesg_gmail_text_body_auto",
            parser: DAM_XESG_AUTOMATION.parser,
            parsed_at: new Date().toISOString(),
            parse_mode: "dam_xesg_sender_text_body_rule",
            service_date: damXesgServiceDate,
            delivery_date: damXesgServiceDate,
            item_count: Number(damXesgAutomation.item_count || 0),
            total_qty: Number(damXesgAutomation.total_qty || 0),
            trusted_ledger_required: true,
            automation_status: damXesgAutomation.automation_status,
            status: damXesgAutomation.automation_status,
            reason: damXesgAutomation.reason,
            reconciliation_note: "Parsed body quantities are sent_qty/order evidence only; trusted ledger sold_qty decides accounting revenue when qty deltas exist, including the T4 662 bánh inventory note.",
            template_id: template?.id || null,
            template_name: template?.template_name || null,
          }
        : kingfoodAutomation?.automation_status === "parsed_valid"
          ? {
              source: "kingfood_gmail_sync_auto",
              parser: "po-gmail-sync:kingfood:v1",
              parsed_at: new Date().toISOString(),
              source_xlsx: xlsxFile?.filename || null,
              source_pdf: pdfFile?.filename || null,
              item_count: parsedItems?.length || 0,
              subtotal: parsedSubtotal,
              vat_amount: parsedVat,
              total_amount: parsedTotal,
              amount_includes_vat: true,
              amount_source: "kingfood_po_total_vat_included",
              vat_handling: "no_extra_multiplier",
              subtotal_source: "kingfood_sheet_subtotal_col_33",
              template_id: template?.id || null,
              template_name: template?.template_name || null,
              parse_mode: "kingfood_sender_rule",
            }
          : null;

      const payload = {
        gmail_message_id: m.id,
        gmail_thread_id: m.threadId,
        from_email: fromEmail,
        from_name: fromName,
        email_subject: subject || null,
        body_preview: snippet || null,
        has_attachments: attachmentNames.length > 0,
        attachment_names: attachmentNames,
        received_at: receivedAt,
        matched_customer_id: match?.customerId || null,
        match_status: match ? (poAutomation?.automation_status === "cancel_signal" ? "error" : "pending_approval") : "unmatched",
        revenue_channel: match?.revenueChannel || null,
        po_number: extractPoNumber(subject || ""),
        delivery_date: thuyDirectDealerServiceDate || tonyThanhServiceDate || damXesgServiceDate || extractDeliveryDate(subject || ""),
        production_items: parsedItems,
        subtotal_amount: parsedSubtotal,
        vat_amount: parsedVat,
        total_amount: parsedTotal,
        raw_payload: {
          gmail_id: m.id,
          thread_id: m.threadId,
          snippet,
          subject,
          from,
          template_id: template?.id || null,
          template_name: template?.template_name || null,
          po_automation: poAutomation,
          parse_meta: parseMeta,
          customer_match_resolution: resolvedMatch.resolution,
          customer_match_candidates: resolvedMatch.candidates.map((candidate) => ({
            customer_id: candidate.customerId,
            customer_name: candidate.customerName,
            is_npp: candidate.isNpp,
            supplied_by_npp_customer_id: candidate.suppliedByNppCustomerId,
          })),
        },
      };

      stagedPayloads.push(payload);

      previews.push({
        messageId: m.id,
        threadId: m.threadId,
        fromEmail,
        fromName,
        subject: subject || "(no subject)",
        receivedAt: payload.received_at,
        snippet,
        attachmentNames,
        matchedCustomerId: match?.customerId || null,
        matchStatus: payload.match_status,
        matchResolution: resolvedMatch.resolution,
        matchCandidates: resolvedMatch.candidates.map((candidate) => ({
          customerId: candidate.customerId,
          customerName: candidate.customerName,
          isNpp: candidate.isNpp,
          suppliedByNppCustomerId: candidate.suppliedByNppCustomerId,
        })),
        template: template
          ? {
              id: template.id,
              name: template.template_name,
              fileName: template.file_name,
              parserConfig: template.parser_config,
              samplePreview: template.sample_preview,
              updatedAt: template.updated_at,
            }
          : null,
      });
    }

    for (const payload of stagedPayloads) {
      const shouldImport = mode === "import" && (importMessageIds.size === 0 || importMessageIds.has(payload.gmail_message_id));
      if (!shouldImport) continue;

      const { error } = await supabaseAdmin.from("customer_po_inbox").upsert(payload, { onConflict: "gmail_message_id" });
      if (error) {
        upsertErrorCount += 1;
        if (upsertErrors.length < 5) {
          upsertErrors.push({ messageId: payload.gmail_message_id, error: String(error.message || error) });
        }
        continue;
      }
      synced += 1;
    }

    const { count: inboxCount } = await supabaseAdmin
      .from("customer_po_inbox")
      .select("id", { count: "exact", head: true });

    return new Response(JSON.stringify({
      success: true,
      mode,
      includeOnlyCrm,
      synced,
      query,
      mailbox: profile?.emailAddress || null,
      resultSizeEstimate: Number(list?.resultSizeEstimate || 0),
      fetched: messages.length,
      previews,
      debug: {
        matchedCount,
        unmatchedCount,
        ambiguousCount,
        nppResolvedCount,
        skippedInvalidFrom,
        skippedNotInCrm,
        skippedNotInCrmSamples,
        upsertErrorCount,
        upsertErrors,
        inboxCount: Number(inboxCount || 0),
      },
    }), {
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[po-gmail-sync] Error", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
