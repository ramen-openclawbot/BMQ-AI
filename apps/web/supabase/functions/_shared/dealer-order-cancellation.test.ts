import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeSelfCancellationIds } from "./dealer-order-cancellation.ts";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

Deno.test("normalizes and deduplicates one to twenty cancellation ids", () => {
  assertEquals(normalizeSelfCancellationIds([id("1").toUpperCase(), ` ${id("1")} `, id("2")]), [id("1"), id("2")]);
  assertEquals(normalizeSelfCancellationIds(Array.from({ length: 20 }, (_, index) => id(String(index + 1))))?.length, 20);
});

Deno.test("rejects empty oversized and malformed cancellation selections", () => {
  assertEquals(normalizeSelfCancellationIds([]), null);
  assertEquals(normalizeSelfCancellationIds(Array.from({ length: 21 }, (_, index) => id(String(index + 1)))), null);
  assertEquals(normalizeSelfCancellationIds(["not-an-order-id"]), null);
  assertEquals(normalizeSelfCancellationIds("not-an-array"), null);
});
