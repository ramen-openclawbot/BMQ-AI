import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const scopedFiles = [
  'src/pages/RevenueDailyReview.tsx','src/pages/PayablesManagement.tsx',
  'src/pages/SkuCostsDjango.tsx','src/pages/SkuCostsAnalysis.tsx','src/pages/SkuCostsManagement.tsx',
  'src/components/layout/Header.tsx','src/components/layout/Sidebar.tsx','src/components/AppRoutes.tsx',
  'src/components/SessionRecoveryOverlay.tsx','src/components/sku-costs/SkuCostMenuBar.tsx',
  'src/components/agent/GlobalAgentChatWidget.tsx','src/components/ErrorBoundary.tsx','src/components/OwnerRoute.tsx',
  'src/components/ui/dialog.tsx','src/components/ui/sheet.tsx','src/components/ui/pagination.tsx',
];
const neutral = /^(?:SKU|LC(?: %)?|EN|VN|N\/A|v|VND|PR|PO|CSV|PDF|Excel)$/;
export function scan(file, source) {
  const t = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), found=[];
  function walk(n) {
    let value, kind;
    if (ts.isJsxText(n)) { value=n.getText(t).trim().replace(/\s+/g,' ');kind='JSX'; }
    else if (ts.isStringLiteral(n) && ts.isJsxAttribute(n.parent) && /^(placeholder|title|aria-label|alt)$/.test(n.parent.name.getText(t))) {value=n.text;kind='attribute';}
    else if ((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)) && /[À-ỹ]/.test(n.text)) {value=n.text;kind='literal';}
    else if (ts.isTemplateExpression(n) && /[À-ỹ]/.test(n.head.text+n.templateSpans.map(s=>s.literal.text).join(''))) {value=n.getText(t);kind='template';}
    else if (ts.isStringLiteral(n) && ts.isNewExpression(n.parent) && n.parent.expression.getText(t)==='Error') {value=n.text;kind='error';}
    if(value && /[a-zÀ-ỹ]/i.test(value) && !neutral.test(value)) found.push({file,line:t.getLineAndCharacterOfPosition(n.getStart(t)).line+1,kind,text:value});
    ts.forEachChild(n,walk);
  }
  walk(t);return found;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all=scopedFiles.flatMap(f=>scan(f,fs.readFileSync(path.join(web,f),'utf8')));
  const exceptionsPath=path.join(web,'scripts/i18n/literal-exceptions.json');
  if(process.argv.includes('--list')) {console.log(JSON.stringify(all,null,2));process.exit(0);}
  const exceptions=JSON.parse(fs.readFileSync(exceptionsPath,'utf8'));
  const key=x=>JSON.stringify([x.file,x.kind,x.text]);
  const counts=new Map();all.forEach(x=>counts.set(key(x),(counts.get(key(x))||0)+1));
  const allowed=new Map(exceptions.map(e=>[key(e),e]));
  const failures=all.filter(x=>!allowed.has(key(x)));
  const stale=exceptions.filter(e=>counts.get(key(e))!==e.count || !e.reason);
  if(failures.length||stale.length){console.error(JSON.stringify({untranslated:failures,changedOrStaleExceptions:stale},null,2));process.exit(1);}
  console.log(`PASS untranslated-literal guard: ${scopedFiles.length} files; ${all.length} exact exception occurrences (${exceptions.length} documented entries); no unreviewed candidates.`);
}
