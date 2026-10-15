import { test } from "node:test";
import assert from "node:assert/strict";

import {
  downloadReceiptImage,
  downloadReceiptImages,
  encodeBase64,
  receiptImageSources,
  RECEIPT_IMAGE_MAX_BYTES,
  type ReceiptStorageClient,
} from "./receipt-images.ts";

/** Build a fake storage client that serves the given (bucket,path) -> bytes. */
function fakeStorage(objects: Record<string, Uint8Array>, options: { type?: string; fail?: boolean } = {}): {
  client: ReceiptStorageClient;
  downloads: string[];
} {
  const downloads: string[] = [];
  const client: ReceiptStorageClient = {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            downloads.push(`${bucket}/${path}`);
            if (options.fail) throw new Error("network down");
            const bytes = objects[`${bucket}/${path}`];
            if (!bytes) return { data: null, error: { message: "not found" } };
            return {
              data: {
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                type: options.type,
              },
              error: null,
            };
          },
        };
      },
    },
  };
  return { client, downloads };
}

test("encodeBase64 matches the canonical encoding including padding", () => {
  assert.equal(encodeBase64(new Uint8Array([])), "");
  assert.equal(encodeBase64(new TextEncoder().encode("a")), "YQ==");
  assert.equal(encodeBase64(new TextEncoder().encode("ab")), "YWI=");
  assert.equal(encodeBase64(new TextEncoder().encode("abc")), "YWJj");
  assert.equal(encodeBase64(new Uint8Array([0xff, 0xfe, 0xfd])), "//79");
});

test("receiptImageSources resolves storage URLs and bare filenames", () => {
  const fromUrl = receiptImageSources(
    "https://project.supabase.co/storage/v1/object/public/invoices/receipts/a%20b.jpg",
  );
  assert.deepEqual(fromUrl[0], { bucket: "invoices", path: "receipts/a b.jpg" });

  const bare = receiptImageSources("abc.jpg");
  assert.ok(bare.some((source) => source.bucket === "invoices" && source.path === "abc.jpg"));
  assert.ok(bare.some((source) => source.bucket === "purchase-orders" && source.path === "purchase-orders/abc.jpg"));
  assert.ok(bare.some((source) => source.bucket === "payment-requests" && source.path === "payment-requests/abc.jpg"));

  // A non-storage http URL is never fetched by the adapter.
  assert.deepEqual(receiptImageSources("https://evil.test/a.jpg"), []);
});

test("downloadReceiptImage falls back across buckets and reports mime", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { client, downloads } = fakeStorage({ "invoices/x.jpg": bytes }, { type: "image/png" });
  const image = await downloadReceiptImage(client, "x.jpg");
  assert.deepEqual(image, { base64: encodeBase64(bytes), mime: "image/png" });
  // It tried the preferred bucket first.
  assert.equal(downloads[0], "invoices/x.jpg");
});

test("downloadReceiptImage skips missing, oversized and failing reads without throwing", async () => {
  const missing = await downloadReceiptImage(fakeStorage({}).client, "nope.jpg");
  assert.equal(missing, null);

  const huge = new Uint8Array(RECEIPT_IMAGE_MAX_BYTES + 1);
  const oversized = await downloadReceiptImage(fakeStorage({ "invoices/big.jpg": huge }).client, "big.jpg");
  assert.equal(oversized, null);

  const thrown = await downloadReceiptImage(fakeStorage({}, { fail: true }).client, "boom.jpg");
  assert.equal(thrown, null);

  const empty = await downloadReceiptImage(fakeStorage({ "invoices/empty.jpg": new Uint8Array([]) }).client, "empty.jpg");
  assert.equal(empty, null);
});

test("downloadReceiptImages loads at most one image per side", async () => {
  const one = new Uint8Array([9, 9]);
  const two = new Uint8Array([8, 8]);
  const { client } = fakeStorage({ "invoices/main.jpg": one, "invoices/photo.jpg": two });
  const images = await downloadReceiptImages(client, "main.jpg", ["photo.jpg"]);
  assert.equal(images.length, 1);
  assert.deepEqual(images[0], { base64: encodeBase64(one), mime: "image/jpeg" });
});

test("downloadReceiptImages tolerates a null main image and a non-array photo list", async () => {
  const bytes = new Uint8Array([7]);
  const { client } = fakeStorage({ "invoices/photo.jpg": bytes });
  const images = await downloadReceiptImages(client, null, ["photo.jpg"] as unknown as string[]);
  assert.equal(images.length, 1);
  const none = await downloadReceiptImages(client, null, undefined as unknown as string[]);
  assert.deepEqual(none, []);
});
