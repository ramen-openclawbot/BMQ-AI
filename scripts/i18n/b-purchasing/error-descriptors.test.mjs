import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {root,ts} from './inventory.mjs';
function load(name){const source=fs.readFileSync(path.join(root,'apps/web/src/i18n',name+'.ts'),'utf8');const exports={};new Function('exports','require',ts.transpile(source,{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}))(exports,id=>id.endsWith('/format')?load('format'):{useLanguage(){throw new Error('Hook must not run in unit tests');}});return exports;}
const api=load('purchasingCopy'),copy=load('goodsReceiptPurchasing').goodsReceiptPurchasing,drive=load('drivePurchasing').drivePurchasing;
test('local error survives throw/catch as descriptor and switches language at render',()=>{
 let stored;try{throw new api.PurchasingLocalError({copyKey:'yourSessionExpiredPleaseSignInAgain'});}catch(error){stored=api.purchasingErrorMessage(error,'unknownError');}
 assert.deepEqual(stored,{copyKey:'yourSessionExpiredPleaseSignInAgain'});
 for(const lang of ['en','vi','en'])assert.equal(api.renderPurchasingMessage(copy[lang],stored),copy[lang].yourSessionExpiredPleaseSignInAgain);
});
test('Drive interpolated local error keeps values across catch and later EN/VI rendering',()=>{
 for(const key of ['message167','message168']) {
  let stored;try{throw new api.PurchasingLocalError({copyKey:key,values:{v0:2}});}catch(error){stored=api.purchasingErrorMessage(error,'anErrorOccurred');}
  assert.deepEqual(stored,{copyKey:key,values:{v0:2}});
  for(const lang of ['en','vi'])assert.equal(api.renderPurchasingMessage(drive[lang],stored),load('format').formatText(drive[lang][key],{v0:2}));
 }
});
test('unknown local failures remain descriptors, while backend errors including equal local text stay verbatim',()=>{
 assert.deepEqual(api.purchasingErrorMessage(undefined,'ocrFailed'),{copyKey:'ocrFailed'});
 const localText=copy.en.ocrFailed;
 for(const error of [new Error(localText),{message:localText},new Error('Backend $& {v0}')]){
  const stored=api.purchasingErrorMessage(error,'ocrFailed');assert.equal(stored,error.message);
  for(const lang of ['en','vi'])assert.equal(api.renderPurchasingMessage(copy[lang],stored),error.message);
 }
});
test('confirmed component sinks propagate descriptors and render with current module copy',()=>{
 const read=file=>fs.readFileSync(path.join(root,'apps/web/src',file),'utf8');
 const add=read('components/dialogs/AddGoodsReceiptDialog.tsx'),hook=read('hooks/useGoodsReceipts.ts'),details=read('components/dialogs/GoodsReceiptDetailsDialog.tsx'),driveSource=read('components/payment-requests/DriveImportProgressDialog.tsx');
 assert.ok(add.includes('setScanError({ copyKey: "yourSessionExpiredPleaseSignInAgain" })'));
 assert.ok(add.includes('renderPurchasingMessage(pc, scanError)'));
 assert.ok(add.includes('renderPurchasingMessage(pc, f.error)'));
 assert.ok(hook.includes('setOcrError(purchasingErrorMessage(err, "ocrFailed"))'));
 assert.ok(details.includes('renderPurchasingMessage(pc, ocrDelivery.ocrError)'));
 assert.ok(read('pages/GoodsReceipts.tsx').includes('renderPurchasingMessage(pc, purchasingErrorMessage(error, "unableToReceiveGoods"))'));
 for(const source of [add,hook,driveSource]){
  assert.doesNotMatch(source,/new Error\((?:pc\.|formatText\(pc\.)/);
  assert.doesNotMatch(source,/message: err\.message/);
 }
 for(const key of ['unableToReadBankSlipInformation','noAmountFoundOnTheBankSlip','message167','message168'])assert.ok(driveSource.includes(`new PurchasingLocalError({ copyKey: "${key}"`));
});
