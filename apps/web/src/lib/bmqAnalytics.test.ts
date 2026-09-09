import { chatText } from "./bmqChatLocale.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsRequest, parseAnalyticsResponse, readAnalyticsError, type AnalyticsMessage } from "./bmqAnalytics.ts";

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
