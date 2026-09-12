import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {scope,addedSource} from './scope.mjs';
const candidates=[];
for(const file of [...scope,...addedSource.filter(f=>!f.startsWith('i18n/'))]){
 const sf=ts.createSourceFile(file,fs.readFileSync('src/'+file,'utf8'),99,true);
 assert.equal(sf.parseDiagnostics.length,0,`${file} must parse`);
 function parents(n,predicate){for(let p=n.parent;p;p=p.parent)if(predicate(p))return true;return false;}
 function visit(n){
  const jsx=ts.isJsxText(n),str=ts.isStringLiteralLike(n)||[ts.SyntaxKind.TemplateHead,ts.SyntaxKind.TemplateMiddle,ts.SyntaxKind.TemplateTail].includes(n.kind);
  if(jsx||str){
   const value=n.text.trim().replace(/\s+/g,' ');
   const translated=parents(n,p=>ts.isCallExpression(p)&&p.expression.getText(sf)==='c');
   let attribute=false;
   for(let p=n.parent;p;p=p.parent){if(ts.isJsxElement(p)||ts.isJsxSelfClosingElement(p))break;if(ts.isJsxAttribute(p)){attribute=['className','value','key','id','type','name','htmlFor','variant','size'].includes(p.name.getText(sf));break;}}
   const branch=parents(n,p=>ts.isJsxExpression(p)) && (ts.isConditionalExpression(n.parent)&&[n.parent.whenTrue,n.parent.whenFalse].includes(n) || ts.isBinaryExpression(n.parent)&&n.parent.right===n&&[ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.BarBarToken].includes(n.parent.operatorToken.kind));
   const labelProperty=ts.isPropertyAssignment(n.parent)&&['label','title','description','placeholder'].includes(n.parent.name.getText(sf));
   const uiAttribute=ts.isJsxAttribute(n.parent)&&['title','label','description','placeholder','aria-label','alt'].includes(n.parent.name.getText(sf));
   if(!translated&&!attribute&&((jsx&&/[A-Za-zÀ-ỹ]/.test(value))||(str&&(uiAttribute||((branch||labelProperty)&&/[A-Za-zÀ-ỹ]/.test(value))||/[À-ỹ]|[A-Za-z]+ [A-Za-z]/.test(value)))))candidates.push({file,value});
  }
  ts.forEachChild(n,visit);
 }visit(sf);
}
const unique=[...new Map(candidates.map(c=>[JSON.stringify(c),c])).values()];
if(process.argv.includes('--list')){console.log(JSON.stringify(unique,null,2));process.exit();}
const exceptions=JSON.parse(fs.readFileSync('scripts/i18n/c-warehouse/literal-exceptions.json','utf8'));
for(const exception of exceptions)assert.ok(exception.reason.length>20,JSON.stringify(exception));
const key=e=>JSON.stringify({file:e.file,value:e.value});
assert.deepEqual(unique.filter(c=>!exceptions.some(e=>key(e)===key(c))),[],'Untranslated warehouse UI literal');
assert.deepEqual(exceptions.filter(e=>!unique.some(c=>key(e)===key(c))),[],'Stale exception');
console.log(`PASS: ${scope.length + addedSource.filter(f=>!f.startsWith('i18n/')).length} files parse; ${exceptions.length} individually documented non-UI literals; no unapproved UI literals.`);
