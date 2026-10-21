// Offline tests for the signed Q7 material issue page-image contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  MAX_PAGE_BYTES,
  MAX_PAGES,
  MaterialIssuePagesError,
  buildManifest,
  manifestPath,
  pagePath,
  pagesPrefix,
  parsePageFields,
  validateManifest,
} from "./material-issue-pages.ts";

const SIGNED_PATH = "q7/issue-1/revision-2/signed/abc123.pdf";
const PDF_SHA = "a".repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const jpegFile = (bytes: Uint8Array = JPEG, type = "image/jpeg") =>
  new File([bytes], "p.jpg", { type });

const manifestFor = (bytesByPage: Uint8Array[]) =>
  buildManifest(PDF_SHA, bytesByPage.map((bytes, index) => ({
    page: index + 1,
    path: pagePath(SIGNED_PATH, index + 1),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  })));

test("paths sit beside the signed PDF in its .pages prefix", () => {
  assert.equal(pagesPrefix(SIGNED_PATH), `${SIGNED_PATH}.pages`);
  assert.equal(pagePath(SIGNED_PATH, 3), `${SIGNED_PATH}.pages/p3.jpg`);
  assert.equal(manifestPath(SIGNED_PATH), `${SIGNED_PATH}.pages/manifest.json`);
  assert.equal(MAX_PAGES, 8);
  assert.equal(MAX_PAGE_BYTES, 3 * 1024 * 1024);
});

test("valid page fields are parsed in page order and a matching manifest validates", async () => {
  const second = new Uint8Array([...JPEG, 0x01]);
  const pages = await parsePageFields([
    ["issue_id", "issue-1"],
    ["page_count", "2"],
    ["page_2", jpegFile(second)],
    ["page_1", jpegFile()],
  ], 2);

  assert.deepEqual(pages.map((page) => page.page), [1, 2]);
  assert.deepEqual(pages[0].bytes, JPEG);
  assert.deepEqual(pages[1].bytes, second);

  const manifest = manifestFor([JPEG, second]);
  assert.deepEqual(validateManifest(manifest, PDF_SHA), { ok: true, pages: manifest.pages });
});

test("a missing page field is rejected", async () => {
  await assert.rejects(
    () => parsePageFields([["page_1", jpegFile()]], 2),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_missing",
  );
  await assert.rejects(
    () => parsePageFields([["page_2", jpegFile()]], 1),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_missing",
  );
});

test("wrong page order in the manifest is rejected", () => {
  const manifest = manifestFor([JPEG, JPEG]);
  manifest.pages = [manifest.pages[1], manifest.pages[0]];
  assert.deepEqual(validateManifest(manifest, PDF_SHA), { ok: false, code: "pages_mismatch" });
});

test("too many pages are rejected for upload and manifest", async () => {
  const entries: [string, unknown][] = [];
  for (let page = 1; page <= MAX_PAGES + 1; page += 1) entries.push([`page_${page}`, jpegFile()]);
  await assert.rejects(
    () => parsePageFields(entries, MAX_PAGES + 1),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_missing",
  );

  const manifest = manifestFor(Array.from({ length: MAX_PAGES + 1 }, () => JPEG));
  assert.deepEqual(validateManifest(manifest, PDF_SHA), { ok: false, code: "pages_mismatch" });
});

test("non-JPEG bytes and non-JPEG content types are rejected", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(
    () => parsePageFields([["page_1", jpegFile(png)]], 1),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_mismatch",
  );
  await assert.rejects(
    () => parsePageFields([["page_1", jpegFile(JPEG, "image/png")]], 1),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_mismatch",
  );
});

test("an oversized page is rejected", async () => {
  const oversized = new Uint8Array(MAX_PAGE_BYTES + 1);
  oversized.set(JPEG);
  await assert.rejects(
    () => parsePageFields([["page_1", jpegFile(oversized)]], 1),
    (error: unknown) => error instanceof MaterialIssuePagesError && error.code === "pages_mismatch",
  );
});

test("a manifest from another signed PDF is rejected", () => {
  const manifest = manifestFor([JPEG]);
  assert.deepEqual(
    validateManifest(manifest, "b".repeat(64)),
    { ok: false, code: "pages_mismatch" },
  );
});

test("malformed or missing manifests never validate", () => {
  assert.deepEqual(validateManifest(null, PDF_SHA), { ok: false, code: "pages_missing" });
  assert.deepEqual(validateManifest("not json", PDF_SHA), { ok: false, code: "pages_missing" });
  assert.deepEqual(validateManifest({ pdf_sha256: PDF_SHA }, PDF_SHA), { ok: false, code: "pages_missing" });

  const badHash = manifestFor([JPEG]);
  badHash.pages[0].sha256 = "not-a-sha";
  assert.deepEqual(validateManifest(badHash, PDF_SHA), { ok: false, code: "pages_mismatch" });

  const badBytes = manifestFor([JPEG]);
  badBytes.pages[0].bytes = 0;
  assert.deepEqual(validateManifest(badBytes, PDF_SHA), { ok: false, code: "pages_mismatch" });
});
