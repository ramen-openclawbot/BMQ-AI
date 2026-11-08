// Browser QA for GPS check-in/out on luong.banhmique.vn (Bếp Q7 pilot).
//
// FIXTURE SESSION + FIXTURE DATA: the browser maps luong.banhmique.vn to the local Vite server,
// Chrome gives a fake camera stream, Playwright gives a fake GPS fix, and every Supabase Edge
// Function call is answered from the fixtures below. All other non-local network is blocked;
// nothing reaches production. This proves the screens and the client flow (camera → compress →
// location → multipart send → refresh). It is not real-device acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_luong_attendance.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-luong-attendance-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5189);
const HOST = "luong.banhmique.vn";
const FAKE_SUPABASE = "https://qa-fixture.supabase.co";
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const INCOMPLETE = "Ngày công không được tính, vui lòng liên hệ quản lý duyệt";

function todayPayload(events, consented) {
  const hasIn = events.some((e) => e.event_kind === "in" && e.decision === "accepted");
  const hasOut = events.some((e) => e.event_kind === "out" && e.decision === "accepted");
  return {
    success: true,
    employee: { code: "BEP-007" },
    gate_enabled: true,
    site_configured: true,
    site_name: "Bếp Q7",
    site_radius_m: 50,
    consent: { required_version: "2026-11-09", accepted: consented, accepted_at: consented ? new Date().toISOString() : null, withdrawn_at: null },
    today: { work_date: today, status: hasIn && hasOut ? "complete" : hasIn ? "missing_out" : "missing_in", events },
    incomplete_days: [{ work_date: yesterday, status: "missing_out", message: INCOMPLETE }],
  };
}

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-luong-attendance-qa/vite-cache",
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
  args: [
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${PORT}`,
  ],
});
const results = [];
const record = (name, detail = {}) => {
  results.push({ name, ...detail });
  console.log("PASS", name);
};

async function open(viewport, { geolocation = true, checkinDecision = "accepted", reason = null, consented = true } = {}) {
  const context = await browser.newContext({
    viewport,
    locale: "vi-VN",
    reducedMotion: "reduce",
    permissions: geolocation ? ["geolocation", "camera"] : ["camera"],
    geolocation: geolocation ? { latitude: 10.7501, longitude: 106.6501, accuracy: 9 } : undefined,
  });
  await context.addInitScript(() => localStorage.setItem("bmq_payslip_session", "psp_qa"));
  const state = { events: [], checkins: [], consented, consentCalls: [] };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();
    const fn = url.match(/\/functions\/v1\/([\w-]+)/)?.[1];
    if (url.startsWith(FAKE_SUPABASE) && fn) {
      let body;
      if (fn === "payslip-list") {
        body = { employee: { code: "BEP-007", name: "Trần Văn Minh", groupName: "Bếp bánh" }, payslips: [] };
      } else if (fn === "payslip-attendance-today") {
        assert.equal(request.headers()["x-payslip-session"], "psp_qa");
        assert.match(request.headers()["x-payslip-device"] ?? "", /^[0-9a-f-]{36}$/);
        body = todayPayload(state.events, state.consented);
      } else if (fn === "payslip-attendance-consent") {
        const payload = JSON.parse(request.postData() || "{}");
        state.consentCalls.push(payload);
        state.consented = payload.action === "accept";
        body = { success: true, consent: todayPayload([], state.consented).consent };
      } else if (fn === "payslip-attendance-checkin") {
        const buffer = request.postDataBuffer() ?? Buffer.alloc(0);
        const text = buffer.toString("latin1");
        const kind = /name="kind"\r\n\r\n(\w+)/.exec(text)?.[1];
        const lat = /name="lat"\r\n\r\n([\d.]+)/.exec(text)?.[1];
        const selfieType = /name="selfie"; filename="[^"]*"\r\nContent-Type: ([\w/]+)/.exec(text)?.[1];
        state.checkins.push({ kind, lat, selfieType, bytes: buffer.length });
        if (checkinDecision === "accepted") {
          state.events.push({ event_kind: kind, decision: "accepted", work_date: today, server_received_at: new Date().toISOString(), distance_m: 12 });
        }
        body = { success: true, decision: checkinDecision, reason_code: reason, suspected_proxy: reason === "device_used_by_other", distance_m: 12, work_date: today, event_id: "e1" };
      } else {
        body = { error: "QA fixture: not mocked" };
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (url.startsWith(`http://${HOST}:${PORT}`) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Chấm công" }).waitFor({ timeout: 20_000 });
  return { context, page, errors, state };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll("button, [role='button'], input:not([type='hidden'])")]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); })
  .map((el) => `${(el.textContent || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
  { width: 1440, height: 900 },
];

try {
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors, state } = await open(viewport);
    await page.getByText(INCOMPLETE).first().waitFor();
    assert.ok((await overflow(page)) <= 0, `no overflow ${w}`);
    assert.deepEqual(await smallTargets(page), [], `thumb targets ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/home-${w}.png`, fullPage: true });

    // Check in: camera sheet opens on a live (fake) stream, capture sends a compressed JPEG + GPS.
    await page.getByRole("button", { name: "Chấm vào" }).click();
    const dialog = page.getByRole("dialog", { name: "Chấm vào" });
    await dialog.waitFor();
    const capture = dialog.getByRole("button", { name: "Chụp và chấm công" });
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0;
    }, null, { timeout: 15_000 });
    await page.screenshot({ path: `${EVIDENCE}/camera-${w}.png` });
    assert.ok(await capture.isEnabled(), "capture enabled once the stream plays");
    await capture.click();
    await page.getByText("Đã ghi nhận chấm công.").waitFor({ timeout: 15_000 });
    assert.equal(state.checkins.length, 1);
    assert.equal(state.checkins[0].kind, "in");
    assert.equal(state.checkins[0].lat, "10.7501");
    assert.equal(state.checkins[0].selfieType, "image/jpeg");
    assert.ok(state.checkins[0].bytes < 320 * 1024, `selfie compressed: ${state.checkins[0].bytes}`);
    await page.getByRole("button", { name: "Chấm ra" }).waitFor();
    assert.equal(await page.locator("video").count(), 0, "camera closed after sending");
    await page.screenshot({ path: `${EVIDENCE}/after-in-${w}.png`, fullPage: true });
    assert.deepEqual(errors, [], `page errors ${w}`);
    record(`check-in flow ${w}`, { bytes: state.checkins[0].bytes });
    await context.close();
  }

  // Consent gate: the agreement appears before any camera/location request.
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors, state } = await open(viewport, { consented: false });
    await page.getByRole("button", { name: "Chấm vào" }).click();
    const sheet = page.getByRole("dialog", { name: /Thoả thuận sử dụng hình ảnh/ });
    await sheet.waitFor();
    assert.equal(await page.locator("video").count(), 0, "no camera before consent");
    const accept = sheet.getByRole("button", { name: /Tôi đồng ý/ });
    assert.equal(await accept.isEnabled(), false, "accept disabled until the box is ticked");
    assert.ok((await overflow(page)) <= 0, `no overflow consent ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/consent-${w}.png` });
    await sheet.getByRole("checkbox").click();
    await accept.click();
    await page.getByRole("dialog", { name: "Chấm vào" }).waitFor({ timeout: 15_000 });
    assert.deepEqual(state.consentCalls, [{ action: "accept", version: "2026-11-09", session_token: "psp_qa" }]);
    assert.deepEqual(errors, []);
    record(`consent before camera ${w}`);
    await context.close();
  }

  // View and withdraw.
  {
    const { context, page, errors, state } = await open({ width: 390, height: 844 });
    await page.getByRole("button", { name: /Thoả thuận hình ảnh và vị trí \(đã đồng ý\)/ }).click();
    const sheet = page.getByRole("dialog", { name: /Thoả thuận sử dụng hình ảnh/ });
    await sheet.getByRole("button", { name: "Rút lại đồng ý" }).click();
    await page.screenshot({ path: `${EVIDENCE}/consent-withdraw-390.png` });
    await sheet.getByRole("button", { name: "Rút lại", exact: true }).click();
    await page.getByRole("button", { name: "Xem thoả thuận hình ảnh và vị trí" }).waitFor({ timeout: 10_000 });
    assert.equal(state.consentCalls.at(-1)?.action, "withdraw");
    assert.deepEqual(errors, []);
    record("withdraw consent");
    await context.close();
  }

  // Rejected decision shows the server reason.
  {
    const { context, page, errors } = await open({ width: 390, height: 844 }, { checkinDecision: "rejected", reason: "outside_geofence" });
    await page.getByRole("button", { name: "Chấm vào" }).click();
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 15_000 });
    await page.getByRole("button", { name: "Chụp và chấm công" }).click();
    const alert = page.getByRole("alert").filter({ hasText: /phạm vi/ });
    await alert.waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${EVIDENCE}/rejected-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record("rejected outside radius shows reason");
    await context.close();
  }

  // Location permission denied: nothing is sent, guidance is shown inside the sheet.
  {
    const { context, page, errors, state } = await open({ width: 390, height: 844 }, { geolocation: false });
    await page.getByRole("button", { name: "Chấm vào" }).click();
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 15_000 });
    await page.getByRole("button", { name: "Chụp và chấm công" }).click();
    await page.getByRole("dialog").getByRole("alert").waitFor({ timeout: 20_000 });
    const text = await page.getByRole("dialog").getByRole("alert").innerText();
    assert.match(text, /Chrome/, `guidance mentions Chrome: ${text}`);
    assert.equal(state.checkins.length, 0, "no check-in sent without location");
    await page.screenshot({ path: `${EVIDENCE}/location-denied-390.png` });
    assert.deepEqual(errors, []);
    record("location denied shows Chrome guidance, sends nothing", { text });
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-luong-attendance.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} LUONG ATTENDANCE QA CHECKS PASSED — evidence in ${EVIDENCE}`);
