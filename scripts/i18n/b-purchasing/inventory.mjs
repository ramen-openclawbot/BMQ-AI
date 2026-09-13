import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
export const root=path.resolve(import.meta.dirname,'../../..');
export const require=createRequire(path.join(root,'apps/web/package.json'));
export const ts=require('typescript');
export const files=[...['Suppliers','Invoices','PaymentRequests','GoodsReceipts','PurchaseOrders'].map(x=>`pages/${x}.tsx`),...['EditPaymentRequest','CreateInvoiceFromRequest','EditPurchaseOrder','AddSupplier','SupplierDetails','AddInvoice','EditInvoice','InvoiceDetails','AddPaymentRequest','PaymentRequestDetails','AddGoodsReceipt','GoodsReceiptDetails','AddPurchaseOrder','PurchaseOrderDetails'].map(x=>`components/dialogs/${x}Dialog.tsx`),'components/dashboard/SupplierList.tsx','components/suppliers/ExportSuppliersButton.tsx','components/suppliers/ImportSuppliersButton.tsx','components/settings/SupplierAliasManager.tsx',...['ExportApprovedPDF','ExportApprovedPDFDialog','DriveImportProgressDialog'].map(x=>`components/payment-requests/${x}.tsx`),...['useSuppliers','useInvoices','usePaymentRequests','useGoodsReceipts','usePurchaseOrders','usePurchaseReceiptQueue'].map(x=>`hooks/${x}.ts`)];
export function scan(file) {
 const source=fs.readFileSync(path.join(root,'apps/web/src',file),'utf8'), ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true), rows=[];
 function walk(n){
  if(ts.isJsxText(n)||ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)){
   const value=ts.isTemplateExpression(n)?n.getText(ast):n.text;
   if(value.trim()&&/[a-zA-ZÀ-ỹ]/.test(value)) {
    let p=n.parent, translated=false; for(let i=0;p&&i<5;i++,p=p.parent) if(ts.isConditionalExpression(p)&&/isVi|language/.test(p.condition.getText(ast))) translated=true;
    rows.push({start:n.getStart(ast),end:n.end,line:ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1,kind:ts.SyntaxKind[n.kind],value,translated,parent:n.parent.getText(ast).slice(0,240)});
   }
  }
  if(!ts.isTemplateExpression(n))ts.forEachChild(n,walk);
 }
 walk(ast);return rows;
}
if(process.argv[1]===new URL(import.meta.url).pathname)fs.writeFileSync('/tmp/bmq-i18n-lanes/b-purchasing/inventory.json',JSON.stringify(Object.fromEntries(files.map(f=>[f,scan(f)])),null,2));
