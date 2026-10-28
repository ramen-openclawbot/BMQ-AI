import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createInvoiceInboxIngestHandler,
  extractMeinvoiceLookupCodes,
  INVOICE_INBOX_BUCKET,
  PDF_AMOUNT_MISMATCH_NOTE,
  PDF_NOT_INVOICE_NOTE,
  PDF_UNREAD_NOTE,
  type GmailMessage,
  type IngestPayload,
  type IngestResult,
  type InvoiceInboxIngestDeps,
  type JevCandidates,
  type PdfReextractPayload,
  type SupplierUploadRow,
  type UnreadPdfInvoice,
} from "./handler.ts";
import type { InvoiceJevEvaluation } from "./jev.ts";

const PDF_TEXT_MAB = readFileSync(
  new URL("./fixtures/pdf-text-mab-1037992.txt", import.meta.url),
  "utf8",
);
const PDF_TEXT_VIETTEL = readFileSync(
  new URL("./fixtures/pdf-text-viettel-6016614.txt", import.meta.url),
  "utf8",
);

const XML_BYTES = new TextEncoder().encode(
  `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon>
    <TTChung>
      <KHHDon>C26TAA</KHHDon>
      <SHDon>SMOKE-123</SHDon>
      <NLap>2026-10-19</NLap>
    </TTChung>
    <NDHDon>
      <NBan>
        <Ten>CÔNG TY TNHH GREEN SM</Ten>
        <MST>0312345678</MST>
      </NBan>
      <TToan>
        <TgTCThue>1000</TgTCThue>
        <TgTThue>100</TgTThue>
        <TgTTTBSo>1100</TgTTTBSo>
      </TToan>
      <DSHHDVu>
        <HHDVu>
          <THHDVu>Hàng mẫu</THHDVu>
          <DVTinh>cái</DVTinh>
          <SLuong>2</SLuong>
          <DGia>500</DGia>
          <ThTien>1000</ThTien>
        </HHDVu>
      </DSHHDVu>
    </NDHDon>
  </DLHDon>
</HDon>`,
);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake invoice");
const MEINVOICE_XML = readFileSync(
  new URL("../_shared/fixtures/meinvoice-namnguyen-00010771.xml", import.meta.url),
  "utf8",
);
const MEINVOICE_CODE = "L5FECPA_4K_5";

function htmlBodyMessage(id: string, html: string): GmailMessage {
  const data = Buffer.from(html, "utf8").toString("base64url");
  return {
    id,
    payload: {
      mimeType: "text/html",
      body: { data, size: html.length },
    },
  };
}

function meinvoiceBodyMessage(code = MEINVOICE_CODE): GmailMessage {
  return htmlBodyMessage(
    "m3",
    `<div>Tra cứu hóa đơn tại https://www.meinvoice.vn/tra-cuu</div>` +
      `<div>Nhập mã số: ${code}</div>`,
  );
}

function newsletterMessage(): GmailMessage {
  return htmlBodyMessage("m4", "<div>Bản tin khuyến mãi tháng 10</div>");
}

function xmlAndPdfMessage(): GmailMessage {
  return {
    id: "m1",
    payload: {
      parts: [
        {
          filename: "invoice.xml",
          mimeType: "application/xml",
          body: { attachmentId: "xml", size: XML_BYTES.length },
        },
        {
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "pdf", size: PDF_BYTES.length },
        },
      ],
    },
  };
}

function pdfOnlyMessage(): GmailMessage {
  return {
    id: "m2",
    payload: {
      parts: [
        {
          filename: "scan.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "pdf", size: PDF_BYTES.length },
        },
      ],
    },
  };
}

const CREATED: IngestResult = {
  id: "inv-1",
  status: "pr_created",
  match_source: "amount",
  payment_request_id: "pr-1",
  linked_payment_request_id: null,
  needs_jev: false,
};

const NEEDS_JEV: IngestResult = {
  id: "inv-jev",
  status: "needs_review",
  match_source: "amount_ambiguous",
  payment_request_id: null,
  linked_payment_request_id: null,
  needs_jev: true,
};

interface FakeCalls {
  list: number;
  get: number;
  attachment: number;
  upload: string[];
  ingest: IngestPayload[];
  apply: { invoiceId: string; templateId: string; confidence: number; reason: string }[];
  settings: { key: string; value: string }[];
  extract: number;
  meinvoice: string[];
  pdfText: number;
  pdfExtract: string[];
  download: { bucket: string; path: string }[];
  reextract: { id: string; payload: PdfReextractPayload }[];
  notes: { id: string; note: string }[];
}

interface FakeOptions {
  messages?: { id: string }[];
  message?: GmailMessage;
  token?: string | null;
  ingestResult?: IngestResult;
  candidates?: JevCandidates;
  evaluation?: InvoiceJevEvaluation | null;
  evaluatorError?: Error;
  uploads?: SupplierUploadRow[];
  download?: Uint8Array;
  downloadError?: Error;
  meinvoiceXml?: string | null;
  meinvoiceError?: Error;
  pdfText?: string;
  pdfTextByPath?: Record<string, string>;
  pdfTextError?: Error;
  pdfExtraction?: unknown | ((text: string) => unknown);
  pdfExtractError?: Error;
  unreadPdfs?: UnreadPdfInvoice[];
  listUnreadPdfsError?: Error;
  reextractError?: Error;
  setNoteError?: Error;
}

function fakeDeps(options: FakeOptions = {}): {
  deps: InvoiceInboxIngestDeps;
  calls: FakeCalls;
  refs: Set<string>;
} {
  const refs = new Set<string>();
  const calls: FakeCalls = {
    list: 0,
    get: 0,
    attachment: 0,
    upload: [],
    ingest: [],
    apply: [],
    settings: [],
    extract: 0,
    meinvoice: [],
    pdfText: 0,
    pdfExtract: [],
    download: [],
    reextract: [],
    notes: [],
  };
  const candidates: JevCandidates = options.candidates ?? {
    invoice: {
      id: "inv-jev",
      seller_name: "GREEN SM",
      invoice_number: "SMOKE-123",
      invoice_date: "2026-10-19",
      total_amount: 1100,
      lines: [],
    },
    templates: [{ id: "t1", label: "Chi phí", cadence: "irregular", amount_median: 1100 }],
  };

  const deps: InvoiceInboxIngestDeps = {
    getWorkerSecret: async () => "worker-secret",
    authenticate: async () => ({ userId: "user-1", owner: true }),
    getSetting: async () => null,
    setSetting: async (key, value) => {
      calls.settings.push({ key, value });
    },
    getInvoiceGmailAccessToken: async () => options.token === undefined ? "token" : options.token,
    gmail: {
      listMessages: async () => {
        calls.list += 1;
        return options.messages ?? [{ id: "m1" }];
      },
      getMessage: async () => {
        calls.get += 1;
        return options.message ?? xmlAndPdfMessage();
      },
      getAttachment: async (_token, _messageId, attachmentId) => {
        calls.attachment += 1;
        return attachmentId === "pdf" ? PDF_BYTES : XML_BYTES;
      },
    },
    listSupplierUploads: async () => options.uploads ?? [],
    downloadStorage: async (bucket, path) => {
      calls.download.push({ bucket, path });
      if (options.downloadError) throw options.downloadError;
      return options.download ?? new TextEncoder().encode(path);
    },
    uploadStorage: async (_bucket, path) => {
      calls.upload.push(path);
      return { reused: false };
    },
    sourceRefExists: async (value, exact) => {
      if (exact) return refs.has(value);
      return [...refs].some((ref) => ref.startsWith(value));
    },
    fetchMeinvoiceXml: async (code) => {
      calls.meinvoice.push(code);
      if (options.meinvoiceError) throw options.meinvoiceError;
      return options.meinvoiceXml === undefined ? MEINVOICE_XML : options.meinvoiceXml;
    },
    ingest: async (payload) => {
      calls.ingest.push(payload);
      refs.add(payload.source_ref);
      return options.ingestResult ?? CREATED;
    },
    getJevCandidates: async () => candidates,
    applyJevTemplate: async (invoiceId, templateId, confidence, reason) => {
      calls.apply.push({ invoiceId, templateId, confidence, reason });
      return {
        id: invoiceId,
        status: "pr_created",
        match_source: "jev",
        payment_request_id: "pr-jev",
        linked_payment_request_id: null,
        needs_jev: false,
      };
    },
    extractInvoicePage: async () => {
      calls.extract += 1;
      return {
        supplier_name: "GREEN SM",
        invoice_number: "IMG-1",
        invoice_date: "2026-10-20",
        vat_amount: 100,
        items: [{ product_name: "Hàng", quantity: 2, unit_price: 500 }],
      };
    },
    extractPdfText: async (bytes) => {
      calls.pdfText += 1;
      if (options.pdfTextError) throw options.pdfTextError;
      if (options.pdfTextByPath) {
        const path = new TextDecoder().decode(bytes);
        return options.pdfTextByPath[path] ?? "";
      }
      return options.pdfText ?? "";
    },
    extractInvoiceFromText: async (text) => {
      calls.pdfExtract.push(text);
      if (options.pdfExtractError) throw options.pdfExtractError;
      if (typeof options.pdfExtraction === "function") {
        return options.pdfExtraction(text);
      }
      return options.pdfExtraction ?? {};
    },
    listUnreadPdfInvoices: async () => {
      if (options.listUnreadPdfsError) throw options.listUnreadPdfsError;
      return options.unreadPdfs ?? [];
    },
    reextractInvoice: async (id, payload) => {
      calls.reextract.push({ id, payload });
      if (options.reextractError) throw options.reextractError;
      return { id, status: "matched" };
    },
    setInvoiceNote: async (id, note) => {
      calls.notes.push({ id, note });
      if (options.setNoteError) throw options.setNoteError;
    },
    evaluator: () => async () => {
      if (options.evaluatorError) throw options.evaluatorError;
      return options.evaluation ?? { template_id: "t1", confidence: 0.95, reason: "ok" };
    },
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  };

  return { deps, calls, refs };
}

function makeRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/functions/v1/invoice-inbox-ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function run(
  deps: InvoiceInboxIngestDeps,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const handler = createInvoiceInboxIngestHandler(deps);
  const response = await handler(makeRequest(body, headers));
  return { response, body: await response.json() as Record<string, any> };
}

test("XML + PDF cùng thư: một ingest dùng file PDF", async () => {
  const { deps, calls } = fakeDeps();
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].source_ref, "gmail:m1:invoice.xml");
  assert.equal(calls.ingest[0].file_name, "invoice.pdf");
  assert.equal(calls.ingest[0].file_mime, "application/pdf");
  assert.equal(calls.ingest[0].total_amount, 1100);
  assert.equal(calls.upload.length, 1);
});

test("chạy lại cùng messageId không tải lại", async () => {
  const { deps, calls } = fakeDeps();
  await run(deps, { source: "email" });
  const second = await run(deps, { source: "email" });

  assert.equal(second.response.status, 200);
  assert.equal(second.body.email.skipped, 1);
  assert.equal(calls.get, 1);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.upload.length, 1);
});

test("thư chỉ có PDF: ingest kèm note PDF chưa đọc được", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m2" }],
    message: pdfOnlyMessage(),
  });
  const { body } = await run(deps, { source: "email" });

  assert.equal(body.email.ingested, 1);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].source_ref, "gmail:m2:scan.pdf");
  assert.equal(calls.ingest[0].note, PDF_UNREAD_NOTE);
  assert.equal(calls.ingest[0].file_mime, "application/pdf");
  assert.equal(calls.ingest[0].total_amount, undefined);
});

test("thiếu token Gmail: not_connected, không lỗi", async () => {
  const { deps, calls } = fakeDeps({ token: null });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.reason, "not_connected");
  assert.equal(body.email.scanned, 0);
  assert.equal(calls.list, 0);
  assert.equal(calls.ingest.length, 0);
});

test("worker secret sai: 401", async () => {
  const { deps } = fakeDeps();
  const { response, body } = await run(deps, { source: "all" }, {
    "x-worker-secret": "wrong",
  });

  assert.equal(response.status, 401);
  assert.equal(body.code, "unauthorized");
});

test("user không phải owner: 403", async () => {
  const { deps } = fakeDeps();
  deps.authenticate = async () => ({ userId: "user-2", owner: false });
  const { response, body } = await run(deps, { source: "all" }, {
    authorization: "Bearer fake-token",
  });

  assert.equal(response.status, 403);
  assert.equal(body.code, "forbidden");
});

test("Jev trả template id lạ: không apply", async () => {
  const { deps, calls } = fakeDeps({
    ingestResult: NEEDS_JEV,
    evaluation: { template_id: "t-other", confidence: 0.99, reason: "lạ" },
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.jev.asked, 1);
  assert.equal(body.jev.applied, 0);
  assert.equal(body.needs_review, 1);
  assert.equal(calls.apply.length, 0);
});

test("Jev confidence 0.5: không apply", async () => {
  const { deps, calls } = fakeDeps({
    ingestResult: NEEDS_JEV,
    evaluation: { template_id: "t1", confidence: 0.5, reason: "không chắc" },
  });
  const { body } = await run(deps, { source: "email" });

  assert.equal(body.jev.asked, 1);
  assert.equal(body.jev.applied, 0);
  assert.equal(calls.apply.length, 0);
});

test("Jev timeout: giữ needs_review, ghi errors, không ném", async () => {
  const { deps, calls } = fakeDeps({
    ingestResult: NEEDS_JEV,
    evaluatorError: new Error("jev_timeout"),
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.needs_review, 1);
  assert.equal(body.jev.applied, 0);
  assert.equal(calls.apply.length, 0);
  assert.ok(body.errors.length >= 1);
});

test("Jev confidence 0.95 và id hợp lệ: apply một lần", async () => {
  const { deps, calls } = fakeDeps({
    ingestResult: NEEDS_JEV,
    evaluation: { template_id: "t1", confidence: 0.95, reason: "khớp" },
  });
  const { body } = await run(deps, { source: "email" });

  assert.equal(body.jev.asked, 1);
  assert.equal(body.jev.applied, 1);
  assert.equal(body.created_prs, 1);
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.apply[0].templateId, "t1");
});

test("dry_run: đọc và đếm nhưng không upload / không gọi RPC ghi", async () => {
  const { deps, calls } = fakeDeps();
  const { response, body } = await run(deps, { source: "email", dry_run: true });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.ingest.length, 0);
  assert.equal(calls.settings.length, 0);
  assert.equal(calls.apply.length, 0);
});

test("link NCC: XML dùng supplier_id và purchase_order_id của request", async () => {
  const upload: SupplierUploadRow = {
    id: "u1",
    storage_path: "deliveries/inv.xml",
    file_name: "inv.xml",
    mime_type: "application/xml",
    size_bytes: XML_BYTES.length,
    supplier_id: "sup-1",
    purchase_order_id: "po-1",
  };
  const { deps, calls } = fakeDeps({ uploads: [upload], download: XML_BYTES });
  const { response, body } = await run(deps, { source: "supplier_link" });

  assert.equal(response.status, 200);
  assert.equal(body.supplier_link.ingested, 1);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].source, "supplier_link");
  assert.equal(calls.ingest[0].source_ref, "supplier_upload:u1");
  assert.equal(calls.ingest[0].supplier_id, "sup-1");
  assert.equal(calls.ingest[0].purchase_order_id, "po-1");
  assert.equal(calls.ingest[0].file_mime, "application/xml");
  assert.equal(calls.ingest[0].total_amount, 1100);
  assert.match(calls.upload[0], /^incoming\/2026-10\/[0-9a-f]{16}\.xml$/);
});

test("meInvoice: thư chỉ có HTML + mã số được nạp từ XML tra cứu", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m3" }],
    message: meinvoiceBodyMessage(),
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(body.email.skipped, 0);
  assert.deepEqual(calls.meinvoice, [MEINVOICE_CODE]);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].source, "email");
  assert.equal(calls.ingest[0].source_ref, `gmail:m3:meinvoice:${MEINVOICE_CODE}`);
  assert.equal(calls.ingest[0].invoice_number, "00010771");
  assert.equal(calls.ingest[0].invoice_series, "1C26TNN");
  assert.equal(calls.ingest[0].invoice_date, "2026-10-20");
  assert.equal(calls.ingest[0].total_amount, 2430000);
  assert.equal(calls.ingest[0].file_name, "1C26TNN_00010771.xml");
  assert.equal(calls.ingest[0].file_mime, "application/xml");
  assert.match(calls.upload[0], /^incoming\/2026-10\/[0-9a-f]{16}\.xml$/);
});

test("meInvoice: chạy lại thì bỏ qua cả message", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m3" }],
    message: meinvoiceBodyMessage(),
  });
  await run(deps, { source: "email" });
  const second = await run(deps, { source: "email" });

  assert.equal(second.response.status, 200);
  assert.equal(second.body.email.skipped, 1);
  assert.equal(calls.get, 1);
  assert.equal(calls.meinvoice.length, 1);
  assert.equal(calls.ingest.length, 1);
});

test("meInvoice: fetch trả null ghi lỗi, không ném", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m3" }],
    message: meinvoiceBodyMessage(),
    meinvoiceXml: null,
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 0);
  assert.equal(body.email.skipped, 1);
  assert.ok(body.errors.length >= 1);
  assert.equal(calls.ingest.length, 0);
  assert.equal(calls.upload.length, 0);
});

test("thư không đính kèm, không có mã meInvoice: vẫn bỏ qua", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m4" }],
    message: newsletterMessage(),
  });
  const { body } = await run(deps, { source: "email" });

  assert.equal(body.email.ingested, 0);
  assert.equal(body.email.skipped, 1);
  assert.equal(body.errors.length, 0);
  assert.equal(calls.meinvoice.length, 0);
  assert.equal(calls.ingest.length, 0);
});

test("extractMeinvoiceLookupCodes: văn bản tiếng Việt", () => {
  const text = `Tra cứu tại https://www.meinvoice.vn/tra-cuu\nNhập mã số: ${MEINVOICE_CODE}`;
  assert.deepEqual(extractMeinvoiceLookupCodes(text), [MEINVOICE_CODE]);
});

test("extractMeinvoiceLookupCodes: bản không dấu", () => {
  assert.deepEqual(
    extractMeinvoiceLookupCodes("meinvoice.vn - nhap ma so: ABC12345"),
    ["ABC12345"],
  );
});

test("extractMeinvoiceLookupCodes: link Code= / transactionID=", () => {
  assert.deepEqual(
    extractMeinvoiceLookupCodes(
      "https://www.meinvoice.vn/tra-cuu?Code=XYZ_123-abc " +
        "https://www.meinvoice.vn/tra-cuu?transactionID=ABC12345",
    ),
    ["XYZ_123-abc", "ABC12345"],
  );
});

const MAB_EXTRACTION = {
  seller_name: "CÔNG TY TNHH MM MEGA MARKET (VIỆT NAM)",
  seller_tax_code: "0302249586",
  buyer_tax_code: "0311840107",
  invoice_number: "1037992",
  invoice_series: "1C26MAB",
  invoice_date: "21/10/2026",
  subtotal: "1.317.651",
  vat_amount: "66.433",
  total_amount: "1.384.084",
  lines: [
    {
      name: "GAN HEO",
      unit: "KY",
      quantity: "10,016",
      unit_price: "116.393",
      amount: "982.000",
      vat_rate: "5",
    },
  ],
};

test("PDF có chữ, AI đọc hợp lệ: nạp số liệu đã tách", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m2" }],
    message: pdfOnlyMessage(),
    pdfText: PDF_TEXT_MAB,
    pdfExtraction: MAB_EXTRACTION,
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(calls.pdfText, 1);
  assert.deepEqual(calls.pdfExtract, [PDF_TEXT_MAB.trim().slice(0, 12_000)]);
  assert.equal(calls.ingest.length, 1);
  const payload = calls.ingest[0];
  assert.equal(payload.source_ref, "gmail:m2:scan.pdf");
  assert.equal(payload.file_mime, "application/pdf");
  assert.equal(payload.seller_name, "CÔNG TY TNHH MM MEGA MARKET (VIỆT NAM)");
  assert.equal(payload.seller_tax_code, "0302249586");
  assert.equal(payload.invoice_number, "1037992");
  assert.equal(payload.invoice_series, "1C26MAB");
  assert.equal(payload.invoice_date, "2026-10-21");
  assert.equal(payload.subtotal, 1317651);
  assert.equal(payload.vat_amount, 66433);
  assert.equal(payload.total_amount, 1384084);
  assert.equal(payload.note, undefined);
  assert.equal((payload.raw as { source: string }).source, "pdf_text");
  assert.equal((payload.raw as { lines: unknown[] }).lines.length, 1);
});

test("PDF có chữ nhưng số tiền lệch: nạp kèm note không khớp", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m2" }],
    message: pdfOnlyMessage(),
    pdfText: PDF_TEXT_MAB,
    pdfExtraction: { ...MAB_EXTRACTION, total_amount: "1.000.000" },
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(calls.ingest.length, 1);
  assert.equal(calls.ingest[0].note, PDF_AMOUNT_MISMATCH_NOTE);
  assert.equal(calls.ingest[0].total_amount, undefined);
});

test("PDF catalogue không phải hoá đơn: không gọi AI tách số liệu", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m2" }],
    message: pdfOnlyMessage(),
    pdfText: "LỜI TRỊ ÂN GỬI QUÝ ĐỐI TÁC",
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.equal(calls.pdfExtract.length, 0);
  assert.equal(calls.ingest[0].note, PDF_NOT_INVOICE_NOTE);
});

test("extractPdfText ném lỗi: quay về note PDF chưa đọc được", async () => {
  const { deps, calls } = fakeDeps({
    messages: [{ id: "m2" }],
    message: pdfOnlyMessage(),
    pdfTextError: new Error("unpdf_failed"),
  });
  const { response, body } = await run(deps, { source: "email" });

  assert.equal(response.status, 200);
  assert.equal(body.email.ingested, 1);
  assert.ok(body.errors.length >= 1);
  assert.equal(calls.pdfExtract.length, 0);
  assert.equal(calls.ingest[0].note, PDF_UNREAD_NOTE);
});

test("reprocess_pdf: chỉ reextract dòng ok và trả đủ counts", async () => {
  const unreadPdfs: UnreadPdfInvoice[] = [
    {
      id: "r1",
      file_path: "incoming/2026-10/a.pdf",
      file_name: "a.pdf",
      file_mime: "application/pdf",
    },
    {
      id: "r2",
      file_path: "incoming/2026-10/b.pdf",
      file_name: "b.pdf",
      file_mime: "application/pdf",
    },
    {
      id: "r3",
      file_path: "incoming/2026-10/c.pdf",
      file_name: "c.pdf",
      file_mime: "application/pdf",
    },
  ];
  const { deps, calls } = fakeDeps({
    unreadPdfs,
    pdfTextByPath: {
      "incoming/2026-10/a.pdf": PDF_TEXT_MAB,
      "incoming/2026-10/b.pdf": "LỜI TRỊ ÂN GỬI QUÝ ĐỐI TÁC",
      "incoming/2026-10/c.pdf": PDF_TEXT_VIETTEL,
    },
    pdfExtraction: (text: string) => {
      if (text.includes("MM MEGA MARKET")) return MAB_EXTRACTION;
      if (text.includes("MOBIFONE")) {
        return {
          seller_name: "TỔNG CÔNG TY VIỄN THÔNG MOBIFONE",
          seller_tax_code: "0100686209",
          invoice_number: "6016614",
          invoice_series: "1K26DBK",
          invoice_date: "06/10/2026",
          subtotal: "76.364",
          vat_amount: "7.636",
          total_amount: "100.000",
          lines: [],
        };
      }
      return {};
    },
  });

  const { response, body } = await run(deps, { source: "reprocess_pdf" });

  assert.equal(response.status, 200);
  assert.deepEqual(
    {
      scanned: body.scanned,
      updated: body.updated,
      not_invoice: body.not_invoice,
      mismatch: body.mismatch,
      failed: body.failed,
    },
    { scanned: 3, updated: 1, not_invoice: 1, mismatch: 1, failed: 0 },
  );
  assert.equal(calls.download.length, 3);
  assert.equal(calls.download[0].bucket, INVOICE_INBOX_BUCKET);
  assert.equal(calls.reextract.length, 1);
  assert.equal(calls.reextract[0].id, "r1");
  assert.equal(calls.reextract[0].payload.total_amount, 1384084);
  assert.equal(calls.reextract[0].payload.period, "2026-10");
  assert.equal((calls.reextract[0].payload.raw as { source: string }).source, "pdf_text");
  assert.deepEqual(calls.notes, [
    { id: "r2", note: PDF_NOT_INVOICE_NOTE },
    { id: "r3", note: PDF_AMOUNT_MISMATCH_NOTE },
  ]);
});
