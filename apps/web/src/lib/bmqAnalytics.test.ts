import { chatText } from "./bmqChatLocale.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRequest, isBoundCostFollowUp, parseAnalyticsResponse, readAnalyticsError, type AnalyticsMessage } from "./bmqAnalytics.ts";

test("request contains only current page and last six role/text messages, never IDs or credentials", () => {
  const history: AnalyticsMessage[] = Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`, role: index % 2 ? "assistant" : "user", text: `message ${index}` }));
  const request = buildAnalyticsRequest(" Doanh thu? ", "/finance-control/revenue", "Doanh thu", history);
  assert.equal(request.question, "Doanh thu?");
  assert.deepEqual(request.page, { route: "/finance-control/revenue", label: "Doanh thu", filters: {} });
  assert.equal(request.history.length, 6);
  assert.deepEqual(request.history[0], { role: "user", text: "message 4" });
  assert.deepEqual(Object.keys(request).sort(), ["history", "language", "page", "question"]);
});

test("history is bounded and does not mutate displayed messages", () => {
  const history: AnalyticsMessage[] = [{ id: "1", role: "assistant", text: "a".repeat(10000) }];
  assert.equal(buildAnalyticsRequest("x", "/", "BMQ", history).history[0].text.length, 2000);
  assert.equal(history[0].text.length, 10000);
});

test("malformed or error-only responses cannot appear as successful answers", () => {
  for (const payload of [null, { answer: "" }, { error: "denied" }, { answer: "fake", requestId: "1" }]) {
    assert.throws(() => parseAnalyticsResponse(payload), /chưa hợp lệ/);
  }
  const result = parseAnalyticsResponse({ answer: "Kết quả", requestId: "r1", provenance: { lane: "fast", model: null, queries: [], elapsedMs: 23 } });
  assert.equal(result.answer, "Kết quả");
});


test("selected filters are retained separately from the current route", () => {
  assert.deepEqual(buildAnalyticsRequest("Doanh thu", "/finance-control/revenue", "Doanh thu", [], { period: "2026-09", status: "posted" }).page,
    { route: "/finance-control/revenue", label: "Doanh thu", filters: { period: "2026-09", status: "posted" } });
});

test("HTTP guidance is bounded and malformed or network errors stay generic", async () => {
  const guidance = await readAnalyticsError({ context: Response.json({ error: "Luna chưa cấu hình" }) });
  assert.equal(guidance, "Luna chưa cấu hình");
  assert.equal((await readAnalyticsError({ context: Response.json({ error: "a".repeat(700) }) })).length, 500);
  for (const error of [new Error("raw transport details"), { context: new Response("not JSON") }, { context: Response.json({ error: { stack: "internal" } }) }]) {
    assert.equal(await readAnalyticsError(error), "Chưa gửi được câu hỏi tới BMQ. Vui lòng thử lại.");
  }
});


test("request follows app language without rewriting old history; English client failures", async () => {
  const history: AnalyticsMessage[] = [{id:"old",role:"assistant",text:"Kết quả cũ"}];
  const en = buildAnalyticsRequest("Revenue today", "/", "Dashboard", history, {}, "en");
  assert.equal(en.language,"en"); assert.equal(en.history[0].text,"Kết quả cũ");
  assert.equal(buildAnalyticsRequest("x", "/", "Dashboard", history, {}, "vi").language,"vi");
  assert.throws(()=>parseAnalyticsResponse(null,"en"), /Invalid BMQ response/);
  assert.match(await readAnalyticsError(new Error("network"),"en"),/Please retry/);
});

test("UI error copy follows language switches in both directions",()=>{
  const vi="Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.";
  const en=chatText(vi,"en"); assert.match(en,/sign in again/);assert.equal(chatText(en,"vi"),vi);
  assert.equal(chatText("constructor","en"),"constructor");
});

test('customer choice survives response parsing and next request without changing visible history',()=>{
  const customerSelection={request:{kind:'npp_receivable',customer:'Thanh',product:'',time_range:'2026-09-01/2026-09-07',limit:20},candidates:[{name:'Đại lý cấp 1 - Anh Thanh',code:'npp-thanh'}]};
  const response=parseAnalyticsResponse({answer:'Chọn khách',requestId:'r1',provenance:{lane:'customer',model:null,queries:[],elapsedMs:2,customerSelection}});
  const message:AnalyticsMessage={id:response.requestId,role:'assistant',text:response.answer,customerSelection:response.provenance.customerSelection};
  const request=buildAnalyticsRequest('Đại lý cấp 1 - Anh Thanh','/','Home',[message],{},'vi');
  assert.deepEqual(request.history[0].customerSelection,customerSelection);
  assert.equal(request.history[0].text,'Chọn khách');
  assert.equal(buildAnalyticsRequest('x','/','Home',[{...message,role:'user'}]).history[0].customerSelection,undefined);
  assert.equal(parseAnalyticsResponse({answer:'Done',requestId:'r2',provenance:{lane:'customer',model:null,queries:[],elapsedMs:2}}).provenance.customerSelection,undefined);
});

test('bounded cost context round-trips through response and history and never leaves assistant turns',()=>{
  const costContext={v:1,user:'u1',conv:'c1',iat:1,exp:2,snap:'snap-1',scope:{kind:'pending_summary',month:'2026-09',category_code:null,review_status:'needs_review'},sig:'a'.repeat(64)};
  const response=parseAnalyticsResponse({answer:'Tổng chi phí',requestId:'r1',provenance:{lane:'cost',model:null,queries:[],elapsedMs:2,costContext}});
  assert.deepEqual(response.provenance.costContext,costContext);
  const message:AnalyticsMessage={id:response.requestId,role:'assistant',text:response.answer,costContext:response.provenance.costContext};
  const request=buildAnalyticsRequest('Lấy một dòng làm ví dụ','/finance-control/classification','Phân loại chi phí',[message],{},'vi');
  assert.deepEqual(request.history[0].costContext,costContext);
  assert.equal(buildAnalyticsRequest('x','/','Home',[{...message,role:'user'}]).history[0].costContext,undefined);
  assert.equal(parseAnalyticsResponse({answer:'Done',requestId:'r2',provenance:{lane:'cost',model:null,queries:[],elapsedMs:2}}).provenance.costContext,undefined);
});

test('the current conversation id is sent only when the bounded context is enabled',()=>{
  const withId=buildAnalyticsRequest('x','/finance-control/classification','Phân loại chi phí',[],{},'vi','conv-1234-5678');
  assert.equal(withId.conversationId,'conv-1234-5678');
  assert.deepEqual(Object.keys(withId).sort(),['conversationId','history','language','page','question']);
  const without=buildAnalyticsRequest('x','/finance-control/classification','Phân loại chi phí',[],{},'vi');
  assert.equal(without.conversationId,undefined);
  assert.ok(!('conversationId' in without));
});

test('the analytics reset control has an accessible label translated for English',()=>{
  assert.equal(chatText('Tạo cuộc trò chuyện mới','en'),'Start a new conversation');
  assert.equal(chatText('Start a new conversation','vi'),'Tạo cuộc trò chuyện mới');
});

const validCostBlock = {
  v: 1, kind: 'cost_line', mode: 'example', month: '2026-09',
  line: { classificationId: 'c2', sourceNumber: 'PR-002', sourceDate: '2026-09-12', supplierName: 'NCC Hai', productName: 'Pate gan', amount: 8344200, categoryLabel: 'Chi phí bánh mì', categoryCode: 'COGS_BMQ_BREAD', reviewStatus: 'needs_review', confidence: '0', classificationSource: 'fallback' },
  evidence: { stored: true, rule: null, alias: null, aliasStatus: null },
  notes: ['Không có rule nào được gắn với phân loại này; lý do lịch sử không có sẵn và hệ thống không tự suy diễn.'],
  source: { name: 'Supabase.cost_classification_line_details', observedAt: '2026-09-16T21:37:45Z', snapshotId: 'snap-1', semanticVersion: 'bmq-cost-classification-v2', selectionRule: 'largest_line_amount_then_source_date_then_classification_id', matchCount: 2, truncated: true, disclaimer: 'Không phải báo cáo kiểm toán.' },
  followUp: 'line_explanation',
};

test('a validated cost business block round-trips, while invalid optional presentation degrades to text', () => {
  const parsed = parseAnalyticsResponse({ answer: 'Dòng chi phí ví dụ · 09/2026', requestId: 'r1', provenance: { lane: 'cost', model: null, queries: [], elapsedMs: 2, costBlock: validCostBlock } });
  assert.equal(parsed.provenance.costBlock?.line.amount, 8344200);
  assert.equal(parsed.provenance.costBlock?.line.classificationId, 'c2');
  assert.equal(parsed.provenance.costBlock?.line.reviewStatus, 'needs_review');
  const message: AnalyticsMessage = { id: parsed.requestId, role: 'assistant', text: parsed.answer, costBlock: parsed.provenance.costBlock };
  assert.equal(message.costBlock?.followUp, 'line_explanation');
  // Tampered structures are dropped, never partially trusted; the text stays visible.
  for (const bad of [{ ...validCostBlock, line: { ...validCostBlock.line, amount: '8344200' } }, { ...validCostBlock, line: { ...validCostBlock.line, productName: '' } }, { ...validCostBlock, v: 2 }, { ...validCostBlock, followUp: 'anything' }]) {
    const degraded = parseAnalyticsResponse({ answer: 'Dòng chi phí ví dụ · 09/2026', requestId: 'r2', provenance: { lane: 'cost', model: null, queries: [], elapsedMs: 2, costBlock: bad } });
    assert.equal(degraded.answer, 'Dòng chi phí ví dụ · 09/2026');
    assert.equal(degraded.provenance.costBlock, undefined);
  }
  assert.equal(parseAnalyticsResponse({ answer: 'x', requestId: 'r3', provenance: { lane: 'cost', model: null, queries: [], elapsedMs: 1 } }).provenance.costBlock, undefined);
  // A legacy card is never echoed into the next request; only the signed context is.
  const request = buildAnalyticsRequest('Vì sao dòng này?', '/finance-control/classification', 'Phân loại chi phí', [message], {}, 'vi');
  assert.equal('costBlock' in request.history[0], false);
});

test('a cost follow-up is offered only for the current user, conversation and unexpired signed context', () => {
  const now = 1_000_000;
  const context = (over: Record<string, unknown> = {}) => ({ v: 1, user: 'u1', conv: 'conv-1234-5678', iat: now, exp: now + 60_000, snap: 'snap-1', scope: { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' }, sig: 'a'.repeat(64), ...over });
  assert.equal(isBoundCostFollowUp(context(), { userId: 'u1', conversationId: 'conv-1234-5678', now }), true);
  assert.equal(isBoundCostFollowUp(context(), { userId: 'u2', conversationId: 'conv-1234-5678', now }), false);
  assert.equal(isBoundCostFollowUp(context(), { userId: 'u1', conversationId: 'conv-9999-0000', now }), false);
  assert.equal(isBoundCostFollowUp(context({ exp: now + 1000 }), { userId: 'u1', conversationId: 'conv-1234-5678', now }), false);
  assert.equal(isBoundCostFollowUp(context({ conv: 'short' }), { userId: 'u1', conversationId: 'short', now }), false);
  assert.equal(isBoundCostFollowUp(null, { userId: 'u1', conversationId: 'conv-1234-5678', now }), false);
  assert.equal(isBoundCostFollowUp(context(), { userId: null, conversationId: 'conv-1234-5678', now }), false);
  // The signed selection must name the exact card row, or the follow-up is refused.
  const withSelection = context({ selection: { line_ref: 'c2', classification_id: 'c2' } });
  assert.equal(isBoundCostFollowUp(withSelection, { userId: 'u1', conversationId: 'conv-1234-5678', now, classificationId: 'c2' }), true);
  assert.equal(isBoundCostFollowUp(withSelection, { userId: 'u1', conversationId: 'conv-1234-5678', now, classificationId: 'c9' }), false);
  assert.equal(isBoundCostFollowUp(context(), { userId: 'u1', conversationId: 'conv-1234-5678', now, classificationId: 'c2' }), false);
});
