import fs from 'node:fs';import path from 'node:path';import {root,files,ts} from './inventory.mjs';
export function candidates(){const result=[];
 for(const file of files){const source=fs.readFileSync(path.join(root,'apps/web/src',file),'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 function walk(n){if(ts.isJsxText(n)||ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)){
  const text=ts.isTemplateExpression(n)?n.head.text+n.templateSpans.map(s=>s.literal.text).join(''):n.text;
  let translated=false;for(let p=n.parent;p;p=p.parent)if(ts.isConditionalExpression(p)&&/isVi|language/.test(p.condition.getText()))translated=true;
  if(ts.isTemplateExpression(n)&&n.templateSpans.some(s=>/\b(?:isVi|language)\b/.test(s.expression.getText())))translated=true;
  const jsx=ts.isJsxText(n),attribute=ts.isJsxAttribute(n.parent)&&['placeholder','title','alt','aria-label'].includes(n.parent.name.getText());
  const thrown=ts.isNewExpression(n.parent)&&n.parent.expression.getText()==='Error';
  if(!translated&&/[\p{L}]/u.test(text)&&(/[À-ỹ]/.test(text)||jsx||attribute||thrown))result.push({file,kind:ts.SyntaxKind[n.kind],value:ts.isTemplateExpression(n)?n.getText():n.text.trim().replace(/\s+/g,' '),line:ast.getLineAndCharacterOfPosition(n.getStart()).line+1,parent:n.parent.getText().slice(0,200)});
 }
 if(!ts.isTemplateExpression(n))ts.forEachChild(n,walk);
 }walk(ast);
 }return result;
}
if(process.argv.includes('--inventory'))console.log(JSON.stringify(candidates(),null,2));else{
 const exceptions=JSON.parse(fs.readFileSync(new URL('./literal-exceptions.json',import.meta.url),'utf8'));const found=candidates();const key=r=>JSON.stringify([r.file,r.kind,r.value]);const counts=new Map();for(const row of found)counts.set(key(row),(counts.get(key(row))||0)+1);
 const unexpected=found.filter(r=>!exceptions.some(e=>key(e)===key(r))),stale=exceptions.filter(e=>counts.get(key(e))!==e.count||!e.reason?.trim());const output={files:files.length,remainingOccurrences:found.length,documentedExceptions:exceptions.length,unexpected,stale};fs.writeFileSync('/tmp/bmq-i18n-lanes/b-purchasing/literal-guard.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));if(unexpected.length||stale.length)process.exitCode=1;
}
