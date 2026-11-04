import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEALER_CART_FAST_REPLY_MAX_CHARS,
  DEALER_CART_FAST_REPLY_PHRASES,
  dealerCartFastReply,
  normalizeDealerCartFastReplyText,
  type DealerCartFastReplyGroup,
} from "./dealer-cart-fast-reply.ts";

const GROUPS: DealerCartFastReplyGroup[] = ["greeting", "thanks", "help"];
const EXAMPLE_ORDER = "Bánh mì que 50 cái";
const EXAMPLE_REPEAT = "Như đơn hôm qua";

const GROUP_VARIANTS: Record<DealerCartFastReplyGroup, string[]> = {
  greeting: [
    "Chào shop 👋",
    "chao shop",
    "XIN CHÀO",
    "Chào em ạ 🌟",
    "Hello!!!",
    "Alo shop",
    "chào buổi sáng 🌞",
  ],
  thanks: [
    "Cảm ơn em nhiều!",
    "cam on nhe",
    "OK",
    "Oke nhé 👍",
    "Được rồi...",
    "Dạ",
    "Vâng",
    "Tốt",
  ],
  help: [
    "Hướng dẫn sử dụng?",
    "huong dan",
    "HELP",
    "Cách đặt hàng 🛒",
    "Làm sao đặt hàng???",
    "Trợ lý làm được gì",
    "dùng thế nào",
  ],
};

Deno.test("normalize bỏ dấu tiếng Việt, đ, dấu câu, emoji và gộp khoảng trắng", () => {
  assertEquals(normalizeDealerCartFastReplyText("  CHÀO   Shop!!! 👋 "), "chao shop");
  assertEquals(normalizeDealerCartFastReplyText("Được rồi..."), "duoc roi");
  assertEquals(normalizeDealerCartFastReplyText("Cảm ơn nhé 🌟"), "cam on nhe");
  assertEquals(normalizeDealerCartFastReplyText("Làm sao đặt hàng???"), "lam sao dat hang");
});

for (const group of GROUPS) {
  Deno.test(`fast reply ${group}: có dấu, không dấu, hoa, emoji, dấu câu`, () => {
    for (const variant of GROUP_VARIANTS[group]) {
      const result = dealerCartFastReply(variant);
      assertEquals(result?.group, group, variant);
      assert(result.reply.includes(EXAMPLE_ORDER), variant);
      assert(result.reply.includes(EXAMPLE_REPEAT), variant);
    }
  });
}

Deno.test("mọi câu trong ba tập đã chuẩn hoá, không quá 40 ký tự và khớp đúng nhóm", () => {
  const seen = new Map<string, DealerCartFastReplyGroup>();

  for (const group of GROUPS) {
    for (const phrase of DEALER_CART_FAST_REPLY_PHRASES[group]) {
      assertEquals(normalizeDealerCartFastReplyText(phrase), phrase, phrase);
      assert(phrase.length <= DEALER_CART_FAST_REPLY_MAX_CHARS, phrase);
      assert(!/\d/.test(phrase), phrase);
      assertEquals(seen.has(phrase), false, `câu bị trùng giữa các nhóm: ${phrase}`);
      seen.set(phrase, group);
      assertEquals(dealerCartFastReply(phrase)?.group, group, phrase);
    }
  }
});

Deno.test("câu đặt hàng hoặc có số không bao giờ khớp lối tắt", () => {
  const orderMessages = [
    "chào em, cho 50 bánh mì que",
    "ok thêm 20 cái",
    "như đơn hôm qua",
    "bánh mì que 50",
    "chao em cho 10 cai",
    "ok 20",
    "Rạch Giá 200 đổi 10",
  ];

  for (const message of orderMessages) {
    assertEquals(dealerCartFastReply(message), null, message);
  }
});

Deno.test("câu rỗng, chỉ emoji hoặc dài trên 40 ký tự trả null", () => {
  for (const message of ["", "   ", "👋👋", "-", "...", "chào em, cho mình hỏi"]) {
    assertEquals(dealerCartFastReply(message), null, message);
  }

  const longGreeting = `chao ${"a".repeat(40)}`;
  assert(longGreeting.length > DEALER_CART_FAST_REPLY_MAX_CHARS);
  assertEquals(dealerCartFastReply(longGreeting), null);

  const longEmoji = `chào shop ${"👋".repeat(30)}`;
  assert(longEmoji.length > DEALER_CART_FAST_REPLY_MAX_CHARS);
  assertEquals(dealerCartFastReply(longEmoji), null);

  assertEquals(dealerCartFastReply("a".repeat(41)), null);
  assertEquals(dealerCartFastReply(undefined), null);
  assertEquals(dealerCartFastReply(null), null);
});

Deno.test("reply mỗi nhóm khác nhau và có ví dụ gõ đơn", () => {
  const replies = GROUPS.map((group) => dealerCartFastReply(DEALER_CART_FAST_REPLY_PHRASES[group][0])?.reply);

  replies.forEach((reply) => assert(reply));
  assertEquals(new Set(replies).size, GROUPS.length);

  for (const reply of replies) {
    assert(reply!.includes(EXAMPLE_ORDER));
    assert(reply!.includes(EXAMPLE_REPEAT));
    assert(reply!.includes("đại lý"));
  }
});
