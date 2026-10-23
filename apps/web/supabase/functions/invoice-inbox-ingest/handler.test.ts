import test from "node:test";
import assert from "node:assert/strict";

import {
  createInvoiceInboxIngestHandler,
  PDF_UNREAD_NOTE,
  type GmailMessage,
  type IngestPayload,
  type IngestResult,
  type InvoiceInboxIngestDeps,
  type JevCandidates,
  type SupplierUploadRow,
} from "./handler.ts";
import type { InvoiceJevEvaluation } from "./jev.ts";

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
    downloadStorage: async () => options.download ?? new Uint8Array(),
    uploadStorage: async (_bucket, path) => {
      calls.upload.push(path);
      return { reused: false };
    },
    sourceRefExists: async (value, exact) => {
      if (exact) return refs.has(value);
      return [...refs].some((ref) => ref.startsWith(value));
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
