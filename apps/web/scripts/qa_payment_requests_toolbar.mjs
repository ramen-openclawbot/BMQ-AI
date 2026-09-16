import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || "/tmp/bmq-filter-evidence";
const PLAYWRIGHT_MODULE =
  process.env.PLAYWRIGHT_MODULE ||
  "/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs";
const CHROMIUM_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
].filter(Boolean);

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const t = {
  paymentRequestsTitle: "Duyệt chi",
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
  status: "Trạng thái",
  supplier: "Nhà cung cấp",
  actions: "Thao tác",
  selected: "Đã chọn",
  total: "Tổng",
  quickApprove: "Duyệt nhanh",
  markAsPaid: "Đánh dấu đã thanh toán",
  noPaymentRequests: "Không có đề nghị duyệt chi nào",
  confirmBulkApprove: "Xác nhận duyệt",
  confirmBulkApproveDesc: "Duyệt {count} phiếu với tổng {amount}",
  approving: "Đang duyệt",
  confirmApproveAction: "Xác nhận",
  cancel: "Hủy",
  delete: "Xóa",
};

const requests = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    request_number: "DC-TV-001",
    title: "Thanh toán TV Food",
    total_amount: 13500000,
    status: "pending",
    payment_status: "unpaid",
    payment_method: "bank_transfer",
    created_at: `${today}T02:00:00.000Z`,
    created_by: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    supplier_id: "supplier-tv",
    goods_receipt_id: "gr-tv",
    invoice_id: null,
    image_url: null,
    suppliers: { id: "supplier-tv", name: "TV Food nhà cung cấp tên rất dài để kiểm tra toolbar desktop" },
    goods_receipts: { receipt_number: "PN-TV-2026-0916" },
    purchase_orders: { po_number: "PO-TV-2026-0916" },
    creator_profile: { full_name: "Kế toán BMQ", email: "accounting@bmq.vn" },
    payment_request_items: [
      { id: "item-tv-1", product_name: "Pate tươi TV Food nhãn dài", raw_product_name: null, quantity: 1, unit_price: 13500000 },
    ],
    payments: [],
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    request_number: "DC-MAN-002",
    title: "Thanh toán thủ công",
    total_amount: 31750000,
    status: "approved",
    payment_status: "partial",
    payment_method: "bank_transfer",
    created_at: `${today}T04:00:00.000Z`,
    created_by: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    supplier_id: "supplier-manual",
    goods_receipt_id: null,
    invoice_id: null,
    image_url: null,
    suppliers: { id: "supplier-manual", name: "NCC thủ công" },
    goods_receipts: null,
    purchase_orders: null,
    creator_profile: { full_name: "Owner BMQ", email: "owner@bmq.vn" },
    payment_request_items: [
      { id: "item-man-1", product_name: "Dịch vụ vận hành", raw_product_name: null, quantity: 1, unit_price: 31750000 },
    ],
    payments: [{ id: "pay-1", amount: 10000000, status: "completed" }],
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    request_number: "DC-WH-003",
    title: "Phiếu nhập kho",
    total_amount: 0,
    status: "rejected",
    payment_status: "unpaid",
    payment_method: "cash",
    created_at: `${today}T05:00:00.000Z`,
    created_by: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    supplier_id: "supplier-wh",
    goods_receipt_id: "gr-wh",
    invoice_id: null,
    image_url: "https://example.invalid/receipt.jpg",
    suppliers: { id: "supplier-wh", name: "Kho nhập dài" },
    goods_receipts: { receipt_number: "PN-WH-003" },
    purchase_orders: { po_number: "PO-WH-003" },
    creator_profile: { full_name: "Kho BMQ", email: "warehouse@bmq.vn" },
    payment_request_items: [
      { id: "item-wh-1", product_name: "Nguyên liệu kho", raw_product_name: null, quantity: 1, unit_price: 0 },
    ],
    payments: [],
  },
];

function paymentRequestsFixturePlugin() {
  const modules = new Map([
    [
      "mock:auth",
      `export const useAuth = () => ({ canEditModule: (key) => key === "payment_requests" });`,
    ],
    [
      "mock:language",
      `export const useLanguage = () => ({ language: "vi", t: ${JSON.stringify(t)} });`,
    ],
    [
      "mock:payment-requests",
      `
      const requests = ${JSON.stringify(requests)};
      export const getAllocatedAmount = (request) => (request.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      export const getRemainingPaymentAmount = (request) => Math.max(0, Number(request.total_amount || 0) - getAllocatedAmount(request));
      export const hasOutstandingPayment = (request) => getRemainingPaymentAmount(request) > 0;
      export const usePaymentRequests = () => ({ data: requests, isLoading: false, isError: false, error: null, refetch: async () => ({ data: requests }) });
      export const useDeletePaymentRequest = () => ({ isPending: false, mutateAsync: async () => ({ unlinked_invoice_count: 0 }) });
      export const useBulkMarkPaid = () => ({ isPending: false, mutate: () => undefined });
      export const useBulkApprovePaymentRequest = () => ({ isPending: false, mutate: (_ids, options) => options?.onSuccess?.() });
      export const uploadPaymentRequestImage = async () => ({ path: "fixture" });
      `,
    ],
    [
      "mock:add-dialog",
      `export const AddPaymentRequestDialog = ({ trigger }) => trigger;`,
    ],
    [
      "mock:details-dialog",
      `export const PaymentRequestDetailsDialog = () => null;`,
    ],
    [
      "mock:export-pdf",
      `export const ExportApprovedPDF = () => null;`,
    ],
    [
      "mock:drive-dialog",
      `export const DriveImportProgressDialog = () => null;`,
    ],
    [
      "mock:supabase-client",
      `
      const chain = {
        select: () => chain,
        insert: () => chain,
        update: () => chain,
        upsert: () => chain,
        delete: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      export const supabase = {
        from: () => chain,
        storage: { from: () => ({ upload: async () => ({ data: null, error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
        auth: { getSession: async () => ({ data: { session: null }, error: null }) },
      };
      `,
    ],
    [
      "mock:entry",
      `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      import PaymentRequests from "/src/pages/PaymentRequests.tsx";
      import "/src/index.css";

      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      createRoot(document.getElementById("root")).render(
        React.createElement(QueryClientProvider, { client }, React.createElement(PaymentRequests))
      );
      `,
    ],
  ]);

  return {
    name: "payment-requests-toolbar-fixture",
    enforce: "pre",
    resolveId(source) {
      if (source === "/@payment-requests-fixture") return "mock:entry";
      if (source === "@/contexts/AuthContext") return "mock:auth";
      if (source === "@/contexts/LanguageContext") return "mock:language";
      if (source === "@/hooks/usePaymentRequests") return "mock:payment-requests";
      if (source === "@/integrations/supabase/client") return "mock:supabase-client";
      if (source === "@/components/dialogs/AddPaymentRequestDialog") return "mock:add-dialog";
      if (source === "@/components/dialogs/PaymentRequestDetailsDialog") return "mock:details-dialog";
      if (source === "@/components/payment-requests/ExportApprovedPDF") return "mock:export-pdf";
      if (source === "@/components/payment-requests/DriveImportProgressDialog") return "mock:drive-dialog";
      return null;
    },
    load(id) {
      if (id.endsWith("/src/contexts/AuthContext.tsx")) return modules.get("mock:auth");
      if (id.endsWith("/src/contexts/LanguageContext.tsx")) return modules.get("mock:language");
      if (id.endsWith("/src/hooks/usePaymentRequests.ts")) return modules.get("mock:payment-requests");
      if (id.endsWith("/src/integrations/supabase/client.ts")) return modules.get("mock:supabase-client");
      if (id.endsWith("/src/components/dialogs/AddPaymentRequestDialog.tsx")) return modules.get("mock:add-dialog");
      if (id.endsWith("/src/components/dialogs/PaymentRequestDetailsDialog.tsx")) return modules.get("mock:details-dialog");
      if (id.endsWith("/src/components/payment-requests/ExportApprovedPDF.tsx")) return modules.get("mock:export-pdf");
      if (id.endsWith("/src/components/payment-requests/DriveImportProgressDialog.tsx")) return modules.get("mock:drive-dialog");
      return modules.get(id) || null;
    },
    transformIndexHtml(html) {
      return html.replace(
        '<script type="module" src="/src/main.tsx"></script>',
        '<script type="module" src="/@payment-requests-fixture"></script>',
      );
    },
  };
}

async function rect(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, `Missing bounding box for ${locator}`);
  return box;
}

function assertNoHorizontalOverflow(metrics, label) {
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `${label} overflows horizontally: scrollWidth=${metrics.scrollWidth}, clientWidth=${metrics.clientWidth}`,
  );
}

async function checkDesktopToolbar(page, width, sidebarWidth = 0) {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto("/", { waitUntil: "networkidle" });
  // Synthetic layout shell: reserve the same horizontal space as a sidebar.
  await page.locator('#root').evaluate((node, space) => { node.style.marginLeft = `${space}px`; node.style.padding = "24px"; }, sidebarWidth);
  await page.locator('[data-bmq-payables-toolbar="v2"]').waitFor({ state: "visible" }).catch(async (error) => {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `toolbar-timeout-${width}.html`), await page.content());
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `toolbar-timeout-${width}.png`), fullPage: true });
    throw error;
  });

  const toolbar = page.locator('[data-bmq-payables-toolbar="v2"]');
  const searchRow = page.locator('[data-bmq-payables-search-row="v2"]');
  const filterRow = page.locator('[data-bmq-payables-filter-row="v3"]');
  const dateRange = page.locator('[data-bmq-payables-date-range="v3"]');
  const status = page.getByRole("combobox", { name: /trạng thái/i });
  const source = page.getByRole("combobox", { name: /nguồn/i });
  const fromDate = page.getByLabel("Từ ngày");
  const toDate = page.getByLabel("Đến ngày");

  await filterRow.waitFor({ state: "visible" });

  const toolbarMetrics = await toolbar.evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  assertNoHorizontalOverflow(toolbarMetrics, `toolbar ${width}`);

  const pageMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assertNoHorizontalOverflow(pageMetrics, `page ${width}`);

  const [filterBox, dateBox, statusBox, sourceBox, searchBox, searchRowBox] = await Promise.all([
    rect(filterRow),
    rect(dateRange),
    rect(status),
    rect(source),
    rect(page.getByPlaceholder(/Tìm theo mã phiếu/i)),
    rect(searchRow),
  ]);

  for (const [name, box] of [
    ["date", dateBox],
    ["status", statusBox],
    ["source", sourceBox],
  ]) {
    const expectedY = width < 1280 && name !== "date" ? dateBox.y + dateBox.height + 12 : filterBox.y;
    assert.ok(Math.abs(box.y - expectedY) < 2, `${name} moved off planned filter row at ${width}`);
    assert.ok(Math.abs(box.height - 48) <= 1, `${name} height is ${box.height} at ${width}`);
  }

  assert.ok(dateBox.width >= 330, `date range too narrow at ${width}: ${dateBox.width}`);
  assert.ok(statusBox.width >= 180, `status select too narrow at ${width}: ${statusBox.width}`);
  assert.ok(sourceBox.width >= 180, `source select too narrow at ${width}: ${sourceBox.width}`);
  assert.ok(searchBox.width >= 300, `search input too narrow at ${width}: ${searchBox.width}`);
  assert.ok(searchRowBox.height <= 54, `search row became too tall at ${width}: ${searchRowBox.height}`);

  await expectDateValue(fromDate, today);
  await expectDateValue(toDate, today);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `toolbar-${width}-sidebar-${sidebarWidth}.png`), fullPage: true });
}

async function expectDateValue(locator, expected) {
  const value = await locator.inputValue();
  assert.equal(value, expected);
}

async function chooseSelect(page, combobox, optionName) {
  await combobox.click();
  await page.getByRole("option", { name: optionName }).click();
}

async function checkFilterBehavior(page) {
  await page.setViewportSize({ width: 1366, height: 1100 });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator('[data-bmq-payables-toolbar="v2"]').waitFor({ state: "visible" });

  const resultText = page.getByText(/Hiển thị .* trong .* kết quả/);
  await resultText.waitFor();
  await assertText(resultText, /Hiển thị 1 - 3 trong 3 kết quả/);

  await page.getByPlaceholder(/Tìm theo mã phiếu/i).fill("tv food");
  await assertText(resultText, /Hiển thị 1 - 1 trong 1 kết quả/);
  await assertVisibleText(page, "DC-TV-001");
  await page.getByPlaceholder(/Tìm theo mã phiếu/i).fill("");

  await chooseSelect(page, page.getByRole("combobox", { name: /trạng thái/i }), "Đã duyệt");
  await assertText(resultText, /Hiển thị 1 - 1 trong 1 kết quả/);
  await assertVisibleText(page, "DC-MAN-002");
  await chooseSelect(page, page.getByRole("combobox", { name: /trạng thái/i }), "Tất cả trạng thái");

  await chooseSelect(page, page.getByRole("combobox", { name: /nguồn/i }), "Tạo thủ công / nguồn khác");
  await assertText(resultText, /Hiển thị 1 - 1 trong 1 kết quả/);
  await assertVisibleText(page, "DC-MAN-002");
  await chooseSelect(page, page.getByRole("combobox", { name: /nguồn/i }), "Tất cả nguồn");

  await page.getByLabel("Từ ngày").fill("2099-01-01");
  await page.locator(".lg\\:block").getByText("Không có đề nghị duyệt chi nào").waitFor({ state: "visible" });
  await page.getByLabel("Từ ngày").fill(today);
  await assertText(resultText, /Hiển thị 1 - 3 trong 3 kết quả/);
}

async function assertText(locator, pattern) {
  const deadline = Date.now() + 5000;
  while (!pattern.test(await locator.textContent() || "") && Date.now() < deadline) await locator.page().waitForTimeout(50);
  assert.match(await locator.textContent() || "", pattern);
}

async function assertVisibleText(page, text) {
  await page.locator("table").getByText(text, { exact: false }).first().waitFor({ state: "visible" });
}

async function main() {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    plugins: [paymentRequestsFixturePlugin(), react()],
    resolve: { alias: { "@": path.resolve(ROOT, "src") } },
  });

  await server.listen();
  const address = server.httpServer.address();
  const baseURL = `http://127.0.0.1:${address.port}`;

  const { chromium } = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
  const executablePath = CHROMIUM_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ baseURL });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const publicFont = route.request().method() === 'GET' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);
    return url.origin === baseURL || publicFont ? route.continue() : route.abort();
  });
  const errors = [];
  page.on("requestfailed", (request) => errors.push(`request failed ${request.url()}: ${request.failure()?.errorText}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response ${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.stack || error.message));

  try {
    for (const width of [1024, 1280, 1366, 1440]) {
      for (const sidebarWidth of [0, 64, 256]) await checkDesktopToolbar(page, width, sidebarWidth);
    }
    await checkFilterBehavior(page);

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/", { waitUntil: "networkidle" });
      await page.locator('[data-stitch-section="mobile-summary-filters"]').waitFor({ state: "visible" });
      assertNoHorizontalOverflow(await page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})), `mobile ${width}`);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `mobile-${width}.png`), fullPage: true });
    }

    assert.deepEqual(errors, [], `browser console errors:\n${errors.join("\n")}`);
    console.log(`payment requests toolbar fixture passed; evidence=${EVIDENCE_DIR}`);
  } catch (error) {
    if (errors.length) console.error(`browser fixture errors:\n${errors.join("\n")}`);
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
