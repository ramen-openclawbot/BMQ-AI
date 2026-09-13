import ts from 'typescript';
import fs from 'node:fs';
export const files = ['pages/ProductionPlanning.tsx','pages/Q7MaterialInventory.tsx','pages/material-master/MaterialMasterAdmin.tsx','pages/material-master/MaterialMasterSystemStatus.tsx','pages/ProductionProducts.tsx','pages/ProductionShifts.tsx','pages/QAInspection.tsx','pages/material-master/ControllerDashboard.tsx','pages/material-master/ReconciliationQueue.tsx','components/production/ShiftWorkersPanel.tsx','components/q7-material-inventory/Q7SignedMaterialIssueQueue.tsx'];
export function literals(file) {
 const src=fs.readFileSync('src/'+file,'utf8'), tree=ts.createSourceFile(file,src,99,true,ts.ScriptKind.TSX), out=[];
 function walk(n) {
  if(ts.isConditionalExpression(n)&&/^(isVi|language === ["']vi["'])$/.test(n.condition.getText(tree))) return;
  if(ts.isPropertyAssignment(n)&&['vi','en'].includes(n.name.getText(tree))) return;
  if ((ts.isStringLiteral(n)||ts.isJsxText(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n))&&/[À-ỹ]/.test(n.text)) out.push({file,line:tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1,text:n.text.trim(),kind:ts.SyntaxKind[n.kind],context:n.parent.getText(tree).slice(0,180),start:n.getStart(tree),end:n.end});
  ts.forEachChild(n,walk);
 } walk(tree); return out;
}
if(process.argv[1]?.endsWith('inventory.mjs')) console.log(JSON.stringify(files.flatMap(literals),null,2));
