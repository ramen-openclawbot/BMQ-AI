/**
 * Exact, model-free replies for greetings, thanks/acknowledgements and usage
 * questions. The edge function uses these to answer without spending the daily
 * assistant quota or calling the AI provider.
 *
 * Matching is intentionally conservative: only a whole normalized message from
 * one of the three phrase sets matches. Anything with a digit, anything longer
 * than 40 characters, and any order-like message falls through to the AI.
 */

export type DealerCartFastReplyGroup = "greeting" | "thanks" | "help";

export type DealerCartFastReply = {
  group: DealerCartFastReplyGroup;
  reply: string;
};

export const DEALER_CART_FAST_REPLY_MAX_CHARS = 40;

export const DEALER_CART_FAST_REPLY_PHRASES: Record<
  DealerCartFastReplyGroup,
  readonly string[]
> = {
  greeting: [
    "chao",
    "xin chao",
    "chao em",
    "chao shop",
    "chao bmq",
    "chao em a",
    "chao anh",
    "chao chi",
    "chao ban",
    "chao nhe",
    "chao ca nha",
    "chao buoi sang",
    "chao buoi chieu",
    "chao buoi toi",
    "hi",
    "hi shop",
    "hello",
    "hello shop",
    "alo",
    "alo shop",
  ],
  thanks: [
    "cam on",
    "cam on em",
    "cam on em nhieu",
    "cam on nhe",
    "cam on nha",
    "cam on a",
    "cam on shop",
    "cam on nhieu",
    "thanks",
    "thank you",
    "ok",
    "oke",
    "okay",
    "ok nhe",
    "ok nha",
    "oke nhe",
    "oke nha",
    "ok em",
    "duoc roi",
    "duoc",
    "da",
    "vang",
    "tot",
    "tot roi",
    "tuyet voi",
  ],
  help: [
    "huong dan",
    "huong dan su dung",
    "huong dan dat hang",
    "huong dan giup minh",
    "dung the nao",
    "su dung the nao",
    "lam the nao",
    "lam sao dat hang",
    "lam sao de dat hang",
    "cach dat hang",
    "cach dung",
    "dat hang the nao",
    "dat hang nhu the nao",
    "tro ly lam duoc gi",
    "tro ly giup duoc gi",
    "em lam duoc gi",
    "ban lam duoc gi",
    "giup voi",
    "giup toi voi",
    "help",
  ],
};

const REPLIES: Record<DealerCartFastReplyGroup, string> = {
  greeting:
    "Chào đại lý! Mình là trợ lý điền giỏ hàng BMQ. Đại lý gõ ví dụ 'Bánh mì que 50 cái' hoặc 'Như đơn hôm qua' nhé.",
  thanks:
    "Cảm ơn đại lý! Khi cần điền giỏ, đại lý gõ ví dụ 'Bánh mì que 50 cái' hoặc 'Như đơn hôm qua' nhé.",
  help:
    "Mình giúp đại lý điền giỏ: gõ món kèm số lượng, ví dụ 'Bánh mì que 50 cái' hoặc 'Như đơn hôm qua'. Mình chỉ đề xuất giỏ, đại lý kiểm tra rồi gửi đơn nhé.",
};

const GROUP_BY_PHRASE = new Map<string, DealerCartFastReplyGroup>();
for (const group of Object.keys(DEALER_CART_FAST_REPLY_PHRASES) as DealerCartFastReplyGroup[]) {
  for (const phrase of DEALER_CART_FAST_REPLY_PHRASES[group]) {
    GROUP_BY_PHRASE.set(phrase, group);
  }
}

/**
 * Lowercase, strip Vietnamese diacritics (including đ), drop punctuation and
 * emoji, trim and collapse whitespace. The result only contains a-z, 0-9 and
 * single spaces.
 */
export function normalizeDealerCartFastReplyText(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return the canned reply for an exact greeting/thanks/help phrase.
 * Messages with digits, messages over 40 characters and order-like messages
 * return null so they keep going through the AI path.
 */
export function dealerCartFastReply(message: unknown): DealerCartFastReply | null {
  if (typeof message !== "string") return null;

  const trimmed = message.trim();
  if (!trimmed || /\d/.test(trimmed)) return null;
  if (trimmed.length > DEALER_CART_FAST_REPLY_MAX_CHARS) return null;

  const normalized = normalizeDealerCartFastReplyText(trimmed);
  if (!normalized || normalized.length > DEALER_CART_FAST_REPLY_MAX_CHARS) return null;
  if (/\d/.test(normalized)) return null;

  const group = GROUP_BY_PHRASE.get(normalized);
  return group ? { group, reply: REPLIES[group] } : null;
}
