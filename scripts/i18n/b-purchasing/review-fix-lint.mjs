import fs from 'node:fs';
import path from 'node:path';
import {root,require,ts} from './inventory.mjs';
const source=['apps/web/src/pages/GoodsReceipts.tsx','apps/web/src/i18n/purchasingCopy.ts','apps/web/src/components/payment-requests/DriveImportProgressDialog.tsx','apps/web/src/components/dialogs/AddGoodsReceiptDialog.tsx','apps/web/src/hooks/useGoodsReceipts.ts','apps/web/src/components/dialogs/GoodsReceiptDetailsDialog.tsx'];
const fixture=['scripts/i18n/b-purchasing/fixture/main.tsx','scripts/i18n/b-purchasing/fixture/mock-client.ts'];
const {ESLint}=require('eslint'),eslint=new ESLint({cwd:path.join(root,'apps/web')});
const messages=[];
for(const file of source){const result=await eslint.lintText(fs.readFileSync(path.join(root,file),'utf8'),{filePath:path.join(root,file)});for(const row of result)for(const m of row.messages)messages.push({file,...m});}
const syntax=[];
for(const file of [...source,...fixture]){const result=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});for(const d of result.diagnostics||[])syntax.push({file,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')});}
console.log(JSON.stringify({lintedSourceFiles:source.length,messages,syntaxOnlyFiles:source.length+fixture.length,syntaxDiagnostics:syntax,fullTypecheck:'NOT RUN; parent sequential gate required'},null,2));if(messages.length||syntax.length)process.exitCode=1;
