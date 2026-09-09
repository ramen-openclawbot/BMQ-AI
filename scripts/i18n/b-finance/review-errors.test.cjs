const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ts=require('../../../apps/web/node_modules/typescript');
const cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const js=ts.transpile(fs.readFileSync(file,'utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022});new Function('exports','require',js)(exports,name=>load(path.resolve(path.dirname(file),name+'.ts')));return exports;}
const api=load('apps/web/src/lib/finance-ui-error.ts'),{financeControl:copy}=load('apps/web/src/i18n/financeControl.ts');
const {financeMessage,FinanceUiError,financeErrorMessage,retainFinanceError,scanFailureDetail,ocrFileFailure,combinedOcrFailure,readFinanceMessage}=api;
const fallback=financeMessage(vi=>vi?'Lỗi OCR chưa xác định':'Unknown OCR failure');
for(const type of ['unc','qtm'])for(const successful of [0,1])test(`${type} ${successful?'partial':'total'}: settled local/backend failures retain EN→VI→EN`,async()=>{
 const local=new FinanceUiError(financeMessage(vi=>copy[vi?'vi':'en'].failedToScanSlip),false);
 // The genuine backend text deliberately equals local English copy. Provenance is explicit.
 const server=new Error(copy.en.failedToScanSlip);
 const settled=await Promise.allSettled([Promise.reject(local),Promise.reject(server)]);
 const messages=settled.map((result,i)=>ocrFileFailure(type,`file-${i}`,result.reason));
 const aggregate=combinedOcrFailure([{type:type.toUpperCase(),successful,total:successful+2}],messages);
 const retained=retainFinanceError(new FinanceUiError(aggregate,false),fallback,false);
 for(const isVi of [false,true,false]){
  const text=readFinanceMessage(financeErrorMessage(retained,fallback),isVi);
  assert.ok(text.includes(`file-0: ${copy[isVi?'vi':'en'].failedToScanSlip}`),text);
  assert.ok(text.includes(`file-1: ${copy.en.failedToScanSlip}`),text);
  assert.ok(text.includes(`${successful}/${successful+2}`));
  assert.ok(text.includes(isVi?'file chưa đọc được':'files still failed'));
 }
});
test('nested 401 detail resolves within each language; other server details are never translated',()=>{
 const detail=scanFailureDetail(401,{});
 const nested=new FinanceUiError(financeMessage(vi=>`${vi?'Không quét được':'Scan failed'}: ${readFinanceMessage(detail,vi)}`),false);
 const retained=financeErrorMessage(nested,fallback);
 for(const vi of [false,true,false])assert.ok(readFinanceMessage(retained,vi).endsWith(copy[vi?'vi':'en'].sessionExpired));
 for(const message of [copy.en.sessionExpired,copy.vi.sessionExpired,'SERVER giữ nguyên $&'])assert.deepEqual(scanFailureDetail(500,{error:message}),{vi:message,en:message});
});
test('unknown local fallbacks stay structured; backend Error/object/string details remain verbatim',()=>{
 for(const error of [undefined,null,{},new Error('')])assert.deepEqual(financeErrorMessage(error,fallback),fallback);
 for(const message of [copy.en.failedToScanSlip,copy.vi.failedToScanSlip,'SERVER giữ nguyên $&'])for(const error of [new Error(message),{message},message])assert.deepEqual(financeErrorMessage(error,fallback),{vi:message,en:message});
});
test('combined UNC/QTM failures cap preview at eight without changing counts',()=>{
 const messages=Array.from({length:10},(_,i)=>ocrFileFailure(i%2?'qtm':'unc',`file-${i}`,new Error(`SERVER-${i}`)));
 const aggregate=combinedOcrFailure([{type:'UNC',successful:0,total:5},{type:'QTM',successful:2,total:5}],messages);
 for(const text of Object.values(aggregate)){assert.ok(text.includes('0/5'));assert.ok(text.includes('2/5'));assert.ok(text.includes('SERVER-7'));assert.ok(!text.includes('SERVER-8'));}
 const empty=combinedOcrFailure([{type:'UNC',successful:0,total:1}],[]);assert.match(empty.vi,/Vui lòng/);assert.match(empty.en,/Please verify/);
});
test('outer catch retains original structured error and still stops close continuation',async()=>{
 const original=new FinanceUiError(combinedOcrFailure([{type:'QTM',successful:0,total:1}],[ocrFileFailure('qtm','file',undefined)]),false);
 let closed=false;
 async function reconcile(){try{throw original;}catch(error){throw retainFinanceError(error,fallback,false);}}
 await assert.rejects(async()=>{await reconcile();closed=true;},error=>error===original);
 assert.equal(closed,false);
 const wrapped=retainFinanceError(undefined,fallback,false);assert.ok(wrapped instanceof FinanceUiError);assert.deepEqual(wrapped.uiMessage,fallback);
});
