// QA for the shared loading states ("Sổ cái" ledger concept, owner 22/10/2026).
// Renders PageLoader, LoadingState (rows/cards/ledger), LedgerMark and Skeleton in a
// fixture page (no backend) inside the d3 shell theme and a portal theme, then checks:
// nothing shows before the delay, everything shows after it, no horizontal overflow,
// reduced motion stops the loops. Screenshots go to EVIDENCE_DIR.
// Run: PLAYWRIGHT_CORE=<playwright-core dir> node scripts/qa_loading_states.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-loading-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5261);
const { chromium } = createRequire(import.meta.url)(PW.replace(/\/index\.mjs$/, ""));
fs.mkdirSync(EVIDENCE, { recursive: true });

const ENTRY = `
import { createRoot } from "react-dom/client";
import "/src/index.css";
import "/src/styles/bmq-shell.css";
import "/src/styles/bmq-kho.css";
import { PageLoader, LoadingState, LedgerMark } from "@/components/ui/loading";
import { Skeleton } from "@/components/ui/skeleton";

const mode = new URLSearchParams(location.search).get("mode") || "blocks";
if (mode !== "portal") document.documentElement.classList.add("bmq-d3");

function Blocks() {
  return (
    <main style={{ padding: 16, display: "grid", gap: 16, maxWidth: 960, margin: "0 auto" }}>
      <section data-qa="rows"><LoadingState label="Đang tải phiếu trình chi…" rows={4} /></section>
      <section data-qa="cards"><LoadingState variant="cards" rows={2} label="Đang tải phiếu nhập kho..." /></section>
      <section data-qa="flat" style={{ background: "var(--d3-white)", borderRadius: 16, padding: 16 }}>
        <LoadingState flat rows={3} label="Đang tải danh sách PO chờ thiết lập SX — một nhãn rất dài để kiểm tra xuống dòng trên điện thoại 390px…" />
      </section>
      <section data-qa="ledger"><LoadingState variant="ledger" label="Đang tải chi tiết phiếu nhập..." /></section>
      <ul data-qa="kho-ghost" style={{ display: "grid", gap: 8, listStyle: "none", padding: 0 }}>{[0, 1].map((i) => <li key={i} className="d3-kho-row is-ghost"><span className="d3-kho-bar" /><span className="d3-kho-bar is-short" /></li>)}</ul>
      <section data-qa="skeleton" style={{ display: "grid", gap: 8 }}><Skeleton className="h-16" /><Skeleton className="h-4 w-1/2" /></section>
    </main>
  );
}

function Portal() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#fff8fa", color: "#80566a" }}>
      <div role="status" aria-label="Đang tải phiếu lương…"><LedgerMark /></div>
    </div>
  );
}

const view = mode === "page" ? <PageLoader /> : mode === "portal" ? <Portal /> : <Blocks />;
createRoot(document.getElementById("root")).render(view);
`;

const fixtures = {
  name: "qa-loading-fixture",
  resolveId(id) { return id === "/__qa_loading_entry.tsx" ? "\0qa-loading-entry.tsx" : null; },
  load(id) { return id === "\0qa-loading-entry.tsx" ? ENTRY : null; },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/__qa/boot")) {
        // The real index.html without the app bundle: what a phone shows before the JS arrives.
        const raw = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace(/<script type="module"[^>]*><\/script>/, "");
        res.setHeader("content-type", "text/html");
        res.end(raw);
        return;
      }
      if (!req.url?.startsWith("/__qa/loading")) return next();
      const html = await server.transformIndexHtml(req.url, `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__qa_loading_entry.tsx"></script></body></html>`);
      res.setHeader("content-type", "text/html");
      res.end(html);
    });
  },
};

const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || path.join(EVIDENCE, "vite-cache"),
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();

const browser = await chromium.launch({ executablePath: CHROME });
let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass += 1; else failures.push(msg); };

async function open(mode, width, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/__qa/loading?mode=${mode}`);
  await page.waitForSelector("[role=status], .bmq-ld-oven", { state: "attached" });
  return { context, page, errors };
}

// Seek the appear animation to a fixed time so the delay check does not depend on dev-server speed.
const opacityAt = (page, sel, ms) => page.$$eval(sel, (els, t) => els.map((el) => {
  const appear = el.getAnimations().find((a) => a.animationName === "bmq-ld-in");
  if (!appear) return -1;
  appear.pause();
  appear.currentTime = t;
  const value = Number(getComputedStyle(el).opacity);
  appear.play();
  return value;
}), ms);
const opacity = (page, sel) => page.$$eval(sel, (els) => els.map((el) => Number(getComputedStyle(el).opacity)));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

for (const width of [390, 820, 1440]) {
  const { context, page, errors } = await open("blocks", width);
  const early = await opacityAt(page, ".bmq-ld-delay", 250);
  ok(early.length === 4 && early.every((o) => o === 0), `${width}: placeholders visible before the 300 ms delay (${early})`);
  await page.waitForTimeout(900);
  const late = await opacity(page, ".bmq-ld-delay");
  ok(late.every((o) => o > 0.95), `${width}: placeholders not shown after the delay (${late})`);
  ok(!(await overflow(page)), `${width}: horizontal overflow`);
  const labels = await page.$$eval("[role=status]", (els) => els.map((el) => el.getAttribute("aria-label")));
  ok(labels.includes("Đang tải phiếu trình chi…"), `${width}: screen-reader label missing`);
  const visibleText = await page.$$eval("[role=status]", (els) => els.map((el) => el.innerText.trim()).join(""));
  ok(visibleText === "", `${width}: loading states write visible text (${visibleText})`);
  const statuses = await page.locator("[role=status]").count();
  ok(statuses === 4, `${width}: expected 4 status regions, got ${statuses}`);
  const shimmer = await page.$eval(".bmq-ld-line", (el) => getComputedStyle(el).animationName);
  ok(shimmer === "bmq-ld-shimmer", `${width}: shimmer not running (${shimmer})`);
  const sk = await page.$eval(".bmq-ld-skeleton", (el) => getComputedStyle(el).animationName);
  ok(sk === "bmq-ld-shimmer", `${width}: Skeleton not shimmering (${sk})`);
  ok(errors.length === 0, `${width}: page errors ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(EVIDENCE, `blocks-${width}.png`), fullPage: true });
  await context.close();
}

for (const width of [390, 1440]) {
  const { context, page } = await open("page", width);
  const bar = await page.$eval(".bmq-ld-bar", (el) => getComputedStyle(el).position);
  ok(bar === "fixed", `${width}: route bar not pinned (${bar})`);
  const early = await opacityAt(page, ".bmq-ld-oven", 550);
  ok(early[0] === 0, `${width}: ledger showed before 0.6 s (${early})`);
  await page.waitForTimeout(900);
  ok((await opacity(page, ".bmq-ld-oven"))[0] > 0.95, `${width}: ledger not shown after 0.6 s`);
  ok(!(await overflow(page)), `${width}: page loader overflow`);
  const post = await page.$$eval(".bmq-ld-entry", (els) => [...new Set(els.map((el) => getComputedStyle(el).animationName))]);
  ok(post.length === 1 && post[0] === "bmq-ld-post", `${width}: ledger entries not posting (${post})`);
  await page.screenshot({ path: path.join(EVIDENCE, `page-${width}.png`) });
  const box = await page.$eval(".bmq-ld-ledger", (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  // Freeze the posting loop at a few moments and capture each frame.
  for (const t of [250, 520, 900, 1500]) {
    await page.evaluate((ms) => document.querySelectorAll(".bmq-ld-entry").forEach((el) => el.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms; })), t);
    await page.screenshot({ path: path.join(EVIDENCE, `ledger-${width}-${t}ms.png`), clip: { x: box.x - 24, y: box.y - 24, width: box.w + 48, height: box.h + 48 } });
  }
  await context.close();
}

{
  const { context, page } = await open("portal", 390);
  await page.waitForTimeout(800);
  ok((await opacity(page, ".bmq-ld-oven"))[0] > 0.95, "portal: ledger not shown");
  ok(!(await overflow(page)), "portal: overflow");
  await page.screenshot({ path: path.join(EVIDENCE, "portal-390.png") });
  await context.close();
}

{
  const { context, page } = await open("blocks", 390, { reduced: true });
  await page.waitForTimeout(500);
  const names = await page.$$eval(".bmq-ld-line, .bmq-ld-skeleton, .bmq-ld-entry", (els) => [...new Set(els.map((el) => getComputedStyle(el).animationName))]);
  ok(names.length === 1 && names[0] === "none", `reduced motion: shimmer still runs (${names})`);
  const shown = await opacity(page, ".bmq-ld-delay");
  ok(shown.every((o) => o > 0.95), `reduced motion: placeholders hidden (${shown})`);
  await context.close();
}

{
  // Kho screens keep their own ghost rows; they must shimmer too (owner screenshot 22/10).
  const { context, page } = await open("blocks", 390);
  const kho = await page.$$eval("[data-qa=kho-ghost] .d3-kho-bar", (els) => [...new Set(els.map((el) => getComputedStyle(el).animationName))]);
  ok(kho.length === 1 && kho[0] === "d3-kho-shimmer", `kho ghost rows static (${kho})`);
  await context.close();
}

for (const width of [390, 1440]) {
  // Boot loader inside index.html covers the blank screen before React mounts.
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/__qa/boot`);
  await page.waitForTimeout(1100);
  const boot = await page.evaluate(() => {
    const svg = document.querySelector(".bmq-boot svg");
    return {
      shown: svg ? Number(getComputedStyle(svg).opacity) : -1,
      posting: [...document.querySelectorAll(".bmq-boot .e")].every((el) => getComputedStyle(el).animationName === "bmq-boot-post"),
      text: document.querySelector("#root")?.innerText.trim() ?? "missing",
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  ok(boot.shown > 0.95 && boot.posting, `${width}: boot ledger not animating (${JSON.stringify(boot)})`);
  ok(boot.text === "" && !boot.overflow, `${width}: boot loader text/overflow (${JSON.stringify(boot)})`);
  await page.screenshot({ path: path.join(EVIDENCE, `boot-${width}.png`) });
  await context.close();
}

await browser.close();
await server.close();
console.log(JSON.stringify({ pass, failures, evidence: EVIDENCE }, null, 2));
if (failures.length) { console.error(`LOADING STATES QA FAILED ${failures.length}`); process.exit(1); }
console.log(`LOADING STATES QA PASSED ${pass}/${pass}`);
