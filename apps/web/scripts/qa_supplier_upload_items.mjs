// QA: supplier upload page (/ncc/hoa-don/<token>) lists every PO line and the total.
// FIXTURE DATA: the supplier-order-upload function is mocked with the PO-000916 shape
// read from production on 19/11/2026; all non-local network is blocked. No real writes.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_supplier_upload_items.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-supplier-upload-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5199);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const MULTI = {
  po_number: "PO-000916", supplier_name: "Kamereo", product_name: "Nước lau nhà Power", quantity: null, unit: null,
  sent_at: "2026-11-10T09:22:03.551937+00:00", upload_count: 0, total_amount: 4600260,
  items: [
    { product_name: "Nước lau nhà Power", quantity: 3, unit: "chai" },
    { product_name: "Nước rửa tay lifebuoy", quantity: 1, unit: "can" },
    { product_name: "Nước tẩy rửa Vim", quantity: 2, unit: "chai" },
    { product_name: "găng tay đen size L", quantity: 3, unit: "hộp" },
    { product_name: "Găng tay đen size M", quantity: 3, unit: "hộp" },
    { product_name: "Bao tay trắng size M", quantity: 3, unit: "hộp" },
    { product_name: "Dầu ăn Tường An 5L x 4 chai (thùng)", quantity: 3, unit: "thùng" },
  ],
};
const OLD_SERVER = { po_number: "PO-000861", supplier_name: "TV Food", product_name: "BƠ PEERLESS", quantity: 100, unit: "kg", sent_at: "2026-10-26T00:00:00Z", upload_count: 0 };

process.env.VITE_SUPABASE_URL ||= "https://qa.supabase.test";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= "qa-anon";
const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error", plugins: [react()],
  cacheDir: "/tmp/bmq-supplier-upload-qa/vite-cache",
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
let failed = false;
try {
  for (const [name, body] of [["multi", MULTI], ["old-server", OLD_SERVER]]) {
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
      await ctx.route("**/*", (r) => {
        const url = r.request().url();
        if (url.includes("/functions/v1/supplier-order-upload")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
        return r.abort();
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${BASE}/ncc/hoa-don/QAtoken_abcdefghijklmnopqrstuvwxyz0123456789`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-bmq-supplier-upload-order]", { timeout: 30000 });
      const text = await page.locator("[data-bmq-supplier-upload-order]").innerText();
      if (name === "multi") {
        assert.equal(await page.locator("[data-bmq-supplier-upload-items] li").count(), 7, "all 7 lines");
        assert.match(text, /7 mặt hàng/);
        assert.match(text, /Dầu ăn Tường An 5L x 4 chai \(thùng\)\s*3 thùng/);
        assert.match(await page.locator("[data-bmq-supplier-upload-total]").innerText(), /4\.600\.260/);
        assert.doesNotMatch(text, /· 0/, "no zero quantity");
      } else {
        assert.match(text, /BƠ PEERLESS · 100 kg/, "older payload still renders");
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `no horizontal overflow ${name} ${viewport.width}`);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${EVIDENCE}/upload-${name}-${viewport.width}.png`, fullPage: true });
      console.log(`PASS ${name} ${viewport.width}`);
      await ctx.close();
    }
  }
  console.log(`ALL SUPPLIER UPLOAD QA CHECKS PASSED — evidence in ${EVIDENCE}`);
} catch (e) {
  failed = true;
  console.error("FAIL", e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
