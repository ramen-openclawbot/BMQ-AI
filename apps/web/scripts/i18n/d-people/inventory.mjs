import ts from 'typescript';
import fs from 'node:fs';
import { files } from './scope.mjs';
export function parse(file,source=fs.readFileSync(file,'utf8')) { return ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS); }
export const text = n => ts.isJsxText(n)?n.text.replace(/\s+/g,' ').trim():ts.isTemplateExpression(n)?n.getText():n.text;
export function candidates(tree) {
 const result=[];
 function visit(n){
  // These hooks are not imported by the assigned pages or their active dependencies.
  if(ts.isFunctionDeclaration(n)&&['useInviteUser','useCancelInvitation','useInvitations'].includes(n.name?.text))return;
  // Existing module metadata is already explicitly bilingual, with canonical keys separate.
  if(ts.isPropertyAssignment(n)&&n.name.getText(tree)==='labelVi'&&n.parent.properties?.some(p=>p.name?.getText(tree)==='labelEn'))return;
  if(ts.isConditionalExpression(n)&&n.condition.getText(tree)==='isVi' && [n.whenTrue,n.whenFalse].every(x=>ts.isStringLiteral(x)||ts.isNoSubstitutionTemplateLiteral(x))) return;
  if(ts.isJsxText(n)&&/[a-zA-ZÀ-ỹ]/.test(text(n)))result.push(n);
  else if((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)) && (/[À-ỹ]/.test(n.text)||ts.isJsxAttribute(n.parent)&&['placeholder','title','alt','aria-label','label'].includes(n.parent.name.text))) result.push(n);
  else if(ts.isTemplateExpression(n)&&/[À-ỹ]/.test(n.getText(tree)))result.push(n);
  ts.forEachChild(n,visit);
 }
 visit(tree);return result;
}
if(process.argv[1]?.endsWith('inventory.mjs'))for(const f of files){const t=parse(f); console.log('\nFILE '+f);for(const n of candidates(t))console.log(t.getLineAndCharacterOfPosition(n.getStart(t)).line+1,JSON.stringify(text(n)),ts.SyntaxKind[n.parent.kind]);}
