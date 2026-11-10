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

const MISSION = {
  id: "offer-1",
  campaign: {
    title: "Chấm công chăm chỉ",
    summary: "Áp dụng Bếp bánh, từ 10/11 đến 30/11",
    starts_on: "2026-11-10",
    ends_on: "2026-11-30",
    items: [
      { key: "regular", label: "Chấm công đều trên app", detail: "Đủ giờ vào và ra mọi ngày đi làm", kind: "attendance_regular", amount_vnd: 100000 },
      { key: "punctual", label: "Đúng giờ 100%", detail: "Không đi trễ buổi nào", kind: "punctual", amount_vnd: 100000 },
      { key: "ticket", label: "Vé bốc thăm quý IV", detail: "Hoàn thành ít nhất 1 nhiệm vụ", kind: "draw_ticket", amount_vnd: 0 },
    ],
    rules: ["Vi phạm hoặc bị kỷ luật trong thời gian nhiệm vụ: không áp dụng toàn bộ thưởng.", "Nghỉ việc trước ngày bốc thăm: không tham gia bốc thăm."],
    draw: { quarter: "2026-Q4", prize_vnd: 5000000 },
  },
};
function missionPayload(status) {
  if (!status) return { success: true, offer: null };
  return { success: true, offer: { ...MISSION, status, progress: status === "accepted" ? [
    { key: "regular", kind: "attendance_regular", met: true, detail: { days_with_in: 1, days_complete: 1, days_missing_out: 0, on_time_days: 1, min_days: 1, grace_minutes: 0, cutoff: "07:00" } },
    { key: "punctual", kind: "punctual", met: true, detail: { days_with_in: 1, days_complete: 1, days_missing_out: 0, on_time_days: 1, min_days: 1, grace_minutes: 0, cutoff: "07:00" } },
  ] : [], review: null, ticket: null } };
}

function mondayAfter(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (8 - dow));
  return d.toISOString().slice(0, 10);
}
const plus = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const SHIFT_WEEK = mondayAfter(today);
function shiftPayload(my) {
  const types = [["ca-0430", "04:30"], ["ca-0600", "06:00"], ["ca-0700", "07:00"], ["ca-0800", "08:00"]];
  return { success: true, week: {
    eligible: true,
    week: { week_start: SHIFT_WEEK, status: "open", opens_at: new Date(Date.now() - 86400000).toISOString(), deadline: new Date(Date.now() + 3 * 86400000).toISOString(), can_edit: true, closed_dates: [plus(SHIFT_WEEK, 3)] },
    shift_types: types.map(([code, start], i) => ({ code, label: `Ca ${start}`, start_time: start, end_time: null, sort: i + 1, active: true })),
    days: Array.from({ length: 7 }, (_, i) => ({
      work_date: plus(SHIFT_WEEK, i), closed: i === 3,
      my: my && i !== 3 ? { shift_code: my[i] ?? null, state: i === 5 ? "waitlist" : "registered", source: "employee", previous_shift_code: null } : null,
      shifts: [
        { code: "ca-0430", registered: i === 0 ? 0 : 1, needed: 1, full: i !== 0, need_more: i === 0 },
        { code: "ca-0600", registered: 2, needed: 2, full: true, need_more: false },
        { code: "ca-0700", registered: 3, needed: 4, full: false, need_more: false },
        { code: "ca-0800", registered: 1, needed: 4, full: false, need_more: false },
      ],
      quota_groups: [], off_count: i === 5 ? 2 : 0, off_full: i === 5, total_staff: 6,
    })),
    suggestion: my ? [] : Array.from({ length: 7 }, (_, i) => ({ work_date: plus(SHIFT_WEEK, i), shift_code: i === 6 ? null : "ca-0700", state: "registered", carried: true })),
    current_week: [{ work_date: today, shift_code: "ca-0700", state: "registered", source: "employee" }, { work_date: plus(today, 1), shift_code: null, state: "registered", source: "manager" }],
    requests: [], can_request: false,
  } };
}
// The running week: already published, so only change/leave requests apply.
const CUR_WEEK = plus(SHIFT_WEEK, -7);
function currentWeekPayload(requests) {
  const base = shiftPayload(null).week;
  return { success: true, week: { ...base,
    week: { week_start: CUR_WEEK, status: "published", opens_at: null, deadline: new Date(Date.now() - 3 * 86400000).toISOString(), can_edit: false, closed_dates: [] },
    days: Array.from({ length: 7 }, (_, i) => ({ ...base.days[i], work_date: plus(CUR_WEEK, i), closed: false,
      my: { shift_code: i === 6 ? null : "ca-0700", state: "registered", source: "employee", previous_shift_code: null } })),
    suggestion: [], requests, can_request: true,
  } };
}

async function open(viewport, { geolocation = true, checkinDecision = "accepted", reason = null, consented = true, mission = null, shifts = false } = {}) {
  const context = await browser.newContext({
    viewport,
    locale: "vi-VN",
    reducedMotion: "reduce",
    permissions: geolocation ? ["geolocation", "camera"] : ["camera"],
    geolocation: geolocation ? { latitude: 10.7501, longitude: 106.6501, accuracy: 9 } : undefined,
  });
  await context.addInitScript(() => localStorage.setItem("bmq_payslip_session", "psp_qa"));
  const state = { events: [], checkins: [], consented, consentCalls: [], mission, missionCalls: [], shiftCalls: [], shiftMine: null, requestCalls: [], requests: [] };
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
      } else if (fn === "payslip-shifts") {
        const payload = JSON.parse(request.postData() || "{}");
        if (!shifts) { body = { success: true, week: { eligible: false } }; }
        else {
          if (payload.action === "request") {
            state.requestCalls.push(payload);
            const row = { id: `req-${state.requests.length + 1}`, work_date: payload.work_date, kind: payload.kind, from_shift_code: "ca-0700", to_shift_code: payload.to_shift_code, reason: payload.reason, state: "pending", decision_note: null, created_at: new Date().toISOString(), decided_at: null };
            state.requests.unshift(row);
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, request: row, coverage: null }) });
            return;
          }
          if (payload.action === "cancel_request") {
            state.requestCalls.push(payload);
            const row = state.requests.find((item) => item.id === payload.request_id);
            row.state = "cancelled";
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, request: row }) });
            return;
          }
          if (payload.week_start === CUR_WEEK) {
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentWeekPayload(state.requests)) });
            return;
          }
          if (payload.action === "submit") { state.shiftCalls.push(payload); state.shiftMine = Object.fromEntries(payload.entries.map((e) => [Math.round((Date.parse(e.work_date) - Date.parse(SHIFT_WEEK)) / 86400000), e.shift_code])); }
          body = shiftPayload(state.shiftMine);
        }
      } else if (fn === "payslip-mission") {
        const payload = JSON.parse(request.postData() || "{}");
        state.missionCalls.push(payload);
        if (payload.action === "respond") state.mission = payload.decision === "accept" ? "accepted" : "declined";
        body = missionPayload(state.mission);
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

  // Mission: the gift opens right after an accepted check-in; accept shows the monthly card.
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors, state } = await open(viewport, { mission: "pending" });
    await page.locator("[data-mission-pending]").waitFor();
    await page.getByRole("button", { name: "Chấm vào" }).click();
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0, null, { timeout: 15_000 });
    await page.getByRole("button", { name: "Chụp và chấm công" }).click();
    const gift = page.getByRole("dialog", { name: "Bạn có một món quà bất ngờ!" });
    await gift.waitFor({ timeout: 15_000 });
    assert.ok((await gift.innerText()).includes("5.000.000đ"), "draw prize shown from data");
    assert.ok((await overflow(page)) <= 0, `no overflow gift ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/mission-gift-${w}.png` });
    await gift.getByRole("button", { name: "Nhận nhiệm vụ" }).click();
    await page.locator("[data-mission-card]").waitFor({ timeout: 10_000 });
    assert.deepEqual(state.missionCalls.find((c) => c.action === "respond"), { action: "respond", offer_id: "offer-1", decision: "accept", session_token: "psp_qa" });
    await page.locator("[data-mission-card]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/mission-card-${w}.png`, fullPage: true });
    assert.ok((await overflow(page)) <= 0, `no overflow mission card ${w}`);
    assert.deepEqual(errors, []);
    record(`mission gift → accept ${w}`);
    await context.close();
  }
  {
    const { context, page, errors, state } = await open({ width: 390, height: 844 }, { mission: "pending" });
    await page.locator("[data-mission-pending]").click();
    const gift = page.getByRole("dialog", { name: "Bạn có một món quà bất ngờ!" });
    await gift.getByRole("button", { name: "Từ chối" }).click();
    await gift.getByRole("button", { name: "Từ chối" }).last().click();
    await page.locator("[data-mission-pending]").waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(state.mission, "declined");
    assert.equal(await page.locator("[data-mission-card]").count(), 0, "declined mission is hidden");
    assert.deepEqual(errors, []);
    record("mission decline with confirm");
    await context.close();
  }

  // Shift registration: card → sheet → copy last week → submit → week list with waitlist.
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors, state } = await open(viewport, { shifts: true });
    await page.locator("[data-shift-panel]").waitFor({ timeout: 15_000 });
    await page.locator("[data-shift-panel]").scrollIntoViewIfNeeded();
    assert.ok((await overflow(page)) <= 0, `no overflow shift card ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/shift-card-${w}.png`, fullPage: true });
    await page.locator("[data-shift-open]").click();
    const sheet = page.getByRole("dialog", { name: "Đăng ký ca" });
    await sheet.waitFor();
    const submit = sheet.locator("[data-shift-submit]");
    assert.equal(await submit.isEnabled(), false, "submit disabled until every day is chosen");
    await sheet.getByRole("button", { name: "Chép từ tuần trước" }).click();
    assert.equal(await submit.isEnabled(), true);
    // Change Monday to the shift that needs people.
    await sheet.locator(`[data-shift-day="${SHIFT_WEEK}"]`).getByRole("button", { name: "04:30" }).click();
    assert.ok((await sheet.locator(`[data-shift-day="${plus(SHIFT_WEEK, 3)}"]`).innerText()).includes("Bếp nghỉ"));
    assert.ok((await overflow(page)) <= 0, `no overflow shift sheet ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/shift-sheet-${w}.png` });
    await submit.click();
    await page.locator("[data-shift-week]").waitFor({ timeout: 10_000 });
    const sent = state.shiftCalls[0];
    assert.equal(sent.week_start, SHIFT_WEEK);
    assert.equal(sent.entries.length, 6, "closed day is not sent");
    assert.deepEqual(sent.entries[0], { work_date: SHIFT_WEEK, shift_code: "ca-0430" });
    assert.equal(sent.entries.at(-1).shift_code, null, "Sunday off from last week");
    assert.ok((await page.locator("[data-shift-panel]").innerText()).includes("danh sách chờ"));
    await page.locator("[data-shift-week]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/shift-week-${w}.png`, fullPage: true });
    assert.ok((await overflow(page)) <= 0, `no overflow shift week ${w}`);
    assert.deepEqual(errors, []);
    record(`shift registration ${w}`);
    await context.close();
  }

  // Change / leave requests on the running (published) week.
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors, state } = await open(viewport, { shifts: true });
    const panel = page.locator(`[data-shift-requests="${CUR_WEEK}"]`);
    await panel.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(`[data-shift-requests="${SHIFT_WEEK}"]`).count(), 0, "open week takes no request");
    await panel.locator('[data-shift-request="change"]').click();
    let sheet = page.getByRole("dialog", { name: "Xin đổi ca" });
    await sheet.waitFor();
    let submit = sheet.locator("[data-shift-request-submit]");
    assert.equal(await submit.isEnabled(), false, "needs day, shift and reason");
    const dayButtons = sheet.locator("[data-shift-request-day]");
    const firstDay = await dayButtons.first().getAttribute("data-shift-request-day");
    assert.equal(firstDay, today, "past days are not offered");
    const offered = await dayButtons.count();
    await dayButtons.first().click();
    assert.equal(await sheet.locator('[data-shift-request-target="ca-0700"]').count(), 0, "current shift is not a target");
    await sheet.locator('[data-shift-request-target="ca-0600"]').click();
    assert.equal(await submit.isEnabled(), false, "reason still missing");
    await sheet.locator("#shift-request-reason").fill("Sáng đưa con đi khám, xin vào sớm hơn");
    assert.ok((await overflow(page)) <= 0, `no overflow request sheet ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/shift-request-sheet-${w}.png` });
    await submit.click();
    await panel.locator('[data-shift-request-row="pending"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(
      { ...state.requestCalls[0], session_token: undefined },
      { action: "request", work_date: today, kind: "change", to_shift_code: "ca-0600", reason: "Sáng đưa con đi khám, xin vào sớm hơn", session_token: undefined },
    );
    assert.ok((await panel.innerText()).includes("Đổi ca 07:00 → 06:00"));
    assert.ok((await panel.innerText()).includes("Chờ duyệt"));
    // A day with a waiting request is not offered again.
    if (offered > 1) {
      await panel.locator('[data-shift-request="leave"]').click();
      sheet = page.getByRole("dialog", { name: "Báo nghỉ đột xuất" });
      await sheet.waitFor();
      assert.equal(await sheet.locator(`[data-shift-request-day="${today}"]`).count(), 0, "pending day hidden");
      await sheet.getByRole("button", { name: "Đóng" }).click();
    }
    await panel.locator("[data-shift-request-cancel]").click();
    await panel.locator('[data-shift-request-row="cancelled"]').waitFor({ timeout: 10_000 });
    assert.equal(state.requestCalls.at(-1).action, "cancel_request");
    assert.equal(state.requestCalls.at(-1).request_id, "req-1");
    await panel.scrollIntoViewIfNeeded();
    assert.ok((await overflow(page)) <= 0, `no overflow request list ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/shift-request-list-${w}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record(`shift change request ${w}`);
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
