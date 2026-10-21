// Browser QA for the Impeccable pass on the two staff portals that run on their own hosts:
// baocao.banhmique.vn (kiosk daily report) and payroll.banhmique.vn (payslips + missions).
//
// FIXTURE SESSION + FIXTURE DATA: the browser maps both hosts to the local Vite server, a fake
// session token is put in localStorage and every Supabase edge function call is answered from
// the fixtures below; all other non-local network is blocked and no call reaches production.
// This proves layout of the signed-in screens; it is not real-staff acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_impeccable_portals.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-impeccable-portals-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5188);
const FAKE_SUPABASE = "https://qa-fixture.supabase.co";
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const FUNCTIONS = {
  "report-session": () => ({
    success: true,
    actor_type: "report_staff",
    staff: { full_name: "Nguyễn Thị Hồng Nhung" },
    location: { code: "KIOSK-Q10", name: "Kiosk Quận 10", address: "285 Cách Mạng Tháng 8, Q.10" },
    attendance_enabled: false,
  }),
  "report-bootstrap": () => ({
    success: true,
    report_date: today,
    staff: { full_name: "Nguyễn Thị Hồng Nhung" },
    location: { code: "KIOSK-Q10", name: "Kiosk Quận 10" },
    opening_inventory_rows: [{ product_code: "banh_mi_que", opening_quantity: 40 }, { product_code: "pate", opening_quantity: 6 }],
    report: null,
  }),
  "payslip-list": () => ({
    employee: { code: "BEP-007", name: "Trần Văn Minh", groupName: "Bếp Q7" },
    payslips: [
      {
        periodId: "p-2026-09", periodName: "Lương tháng 9/2026", dateFrom: "2026-09-01", dateTo: "2026-09-30", publishedAt: "2026-10-05T03:00:00Z",
        employeeCode: "BEP-007", employeeName: "Trần Văn Minh", netPay: 8650000,
        lines: [
          { key: "days", label: "Ngày công", value: 26, unit: "day" },
          { key: "ot", label: "Giờ tăng ca", value: 12.5, unit: "hour" },
          { key: "base", label: "Lương cơ bản", value: 7800000, unit: "vnd" },
          { key: "bonus", label: "Thưởng chuyên cần", value: 500000, unit: "vnd" },
          { key: "otpay", label: "Tiền tăng ca", value: 350000, unit: "vnd" },
        ],
      },
      {
        periodId: "p-2026-08", periodName: "Lương tháng 8/2026", dateFrom: "2026-08-01", dateTo: "2026-08-31", publishedAt: "2026-09-05T03:00:00Z",
        employeeCode: "BEP-007", employeeName: "Trần Văn Minh", netPay: 8120000,
        lines: [{ key: "base", label: "Lương cơ bản", value: 7800000, unit: "vnd" }],
      },
    ],
  }),
  "payslip-missions": () => ({
    missions: [
      { id: "m1", periodId: "p-2026-10", code: "DUNG-GIO", name: "Đi làm đúng giờ cả tháng", description: "Không đi trễ buổi nào trong tháng 10.", mode: "auto", status: "published", reason: null, rewardVnd: 300000, acceptDeadline: "2026-10-31", acceptedAt: null },
    ],
  }),
};

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-impeccable-portals-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1", allowedHosts: true },
  define: {
    __APP_VERSION__: JSON.stringify("qa"),
    __APP_SEMVER__: JSON.stringify("vqa"),
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(FAKE_SUPABASE),
    "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"),
  },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [react()],
});
await server.listen();

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--host-resolver-rules=MAP baocao.banhmique.vn 127.0.0.1, MAP payroll.banhmique.vn 127.0.0.1"],
});
const results = [];
const record = (name, detail = {}) => {
  results.push({ name, ...detail });
  console.log("PASS", name);
};

async function open(host, storage, viewport) {
  const context = await browser.newContext({ viewport, locale: "vi-VN", reducedMotion: "reduce" });
  await context.addInitScript((entries) => { for (const [k, v] of entries) localStorage.setItem(k, v); }, Object.entries(storage));
  const calls = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const fn = url.match(/\/functions\/v1\/([\w-]+)/)?.[1];
    if (url.startsWith(FAKE_SUPABASE) && fn) {
      calls.push(fn);
      const body = FUNCTIONS[fn] ? FUNCTIONS[fn]() : { error: "QA fixture: not mocked" };
      return route.fulfill({ status: FUNCTIONS[fn] ? 200 : 400, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.startsWith(`http://${host}:${PORT}`) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://${host}:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  return { context, page, errors, calls };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// Interactive controls narrower/shorter than a thumb (ignoring hidden ones and inline text links).
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll("button, [role='button'], input:not([type='hidden']), select")]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); })
  .map((el) => `${(el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
const fullShot = (page, file) => page.screenshot({ path: file, fullPage: true });

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

try {
  for (const viewport of WIDTHS) {
    {
      const { context, page, errors, calls } = await open("baocao.banhmique.vn", { bmq_report_session_token: "qa-token" }, viewport);
      assert.ok(calls.includes("report-bootstrap"), `kiosk report bootstrapped: ${calls}`);
      const ov = await overflow(page);
      const small = process.env.SHOTS_ONLY ? [] : await smallTargets(page);
      await fullShot(page, `${EVIDENCE}/baocao-${viewport.width}.png`);
      if (!process.env.SHOTS_ONLY) {
        assert.ok(ov <= 0, `no overflow baocao ${viewport.width}: ${ov}`);
        assert.deepEqual(small, [], `thumb-sized controls baocao ${viewport.width}`);
      }
      assert.deepEqual(errors, []);
      record(`baocao ${viewport.width}`, { ov, small: process.env.SHOTS_ONLY ? await smallTargets(page) : small });
      await context.close();
    }
    {
      const { context, page, errors, calls } = await open("payroll.banhmique.vn", { bmq_payslip_session: "qa-token" }, viewport);
      assert.ok(calls.includes("payslip-list"), `payslips listed: ${calls}`);
      const ov = await overflow(page);
      await fullShot(page, `${EVIDENCE}/payroll-list-${viewport.width}.png`);
      const small = await smallTargets(page);
      if (!process.env.SHOTS_ONLY) {
        assert.ok(ov <= 0, `no overflow payroll ${viewport.width}: ${ov}`);
        assert.deepEqual(small, [], `thumb-sized controls payroll ${viewport.width}`);
      }
      // Open the latest payslip.
      await page.getByText("Lương tháng 9/2026").first().click();
      await page.waitForTimeout(800);
      const ov2 = await overflow(page);
      await fullShot(page, `${EVIDENCE}/payroll-detail-${viewport.width}.png`);
      if (!process.env.SHOTS_ONLY) assert.ok(ov2 <= 0, `no overflow payslip detail ${viewport.width}: ${ov2}`);
      assert.deepEqual(errors, []);
      record(`payroll ${viewport.width}`, { ov, ov2, small });
      await context.close();
    }
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-impeccable-portals.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} IMPECCABLE PORTAL QA CHECKS PASSED — evidence in ${EVIDENCE}`);
