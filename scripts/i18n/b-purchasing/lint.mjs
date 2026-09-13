import fs from 'node:fs';
import path from 'node:path';
import {root,require,files} from './inventory.mjs';
const {ESLint}=require('eslint');
const web=path.join(root,'apps/web');
const eslint=new ESLint({cwd:web});
const dictionaries=['purchasingCopy','supplierPurchasing','invoicePurchasing','paymentRequestPurchasing','goodsReceiptPurchasing','purchaseOrderPurchasing','drivePurchasing'].map(f=>`i18n/${f}.ts`);
const out='/tmp/bmq-i18n-lanes/b-purchasing', all=[...files,...dictionaries], rows=[];
for(const file of all){
 const filePath=path.join(web,'src',file),basePath=path.join(process.env.BMQ_I18N_BASELINE||'/tmp/bmq-i18n-lanes/baseline','apps/web/src',file);
 const base=fs.existsSync(basePath)?(await eslint.lintText(fs.readFileSync(basePath,'utf8'),{filePath}))[0].messages:[];
 const current=(await eslint.lintText(fs.readFileSync(filePath,'utf8'),{filePath}))[0].messages;
 const key=m=>JSON.stringify([m.ruleId,m.severity,m.message]);const remaining=base.map(key),added=[];
 for(const message of current){const at=remaining.indexOf(key(message));if(at<0)added.push(message);else remaining.splice(at,1);}
 rows.push({file,baseline:base,current,added,removed:remaining});
}
fs.writeFileSync(`${out}/lint-results.json`,JSON.stringify(rows,null,2));
const added=rows.flatMap(r=>r.added.map(m=>({file:r.file,...m})));console.log(JSON.stringify({files:rows.length,baselineMessages:rows.reduce((s,r)=>s+r.baseline.length,0),currentMessages:rows.reduce((s,r)=>s+r.current.length,0),added},null,2));if(added.length)process.exitCode=1;
