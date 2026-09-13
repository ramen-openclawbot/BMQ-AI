const ts=require('../../../apps/web/node_modules/typescript');
const fs=require('fs');
const file=process.argv[2];const source=fs.readFileSync(file,'utf8');const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
function visit(n){if((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isJsxText(n)||ts.isTemplateExpression(n))&&(/[À-ỹ]/.test(n.getText(tree))||(ts.isJsxText(n)&&/[A-Za-z]/.test(n.text)))) console.log(`${tree.getLineAndCharacterOfPosition(n.getStart(tree)).line+1}\t${ts.SyntaxKind[n.kind]}\t${JSON.stringify(ts.isTemplateExpression(n)?n.getText(tree):n.text.trim().replace(/\s+/g,' '))}`);ts.forEachChild(n,visit)}visit(tree);
