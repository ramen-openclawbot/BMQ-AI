import ts from 'typescript';
import fs from 'node:fs';
const file=process.argv[2]; const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const rows=[];
function visit(n){
 if(ts.isJsxText(n)&&n.text.trim()) rows.push({line:source.getLineAndCharacterOfPosition(n.getStart()).line+1,kind:'jsx',text:n.text.trim().replace(/\s+/g,' ')});
 else if((ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n))&&/[^\u0000-\u007f]/.test(n.getText(source))) rows.push({line:source.getLineAndCharacterOfPosition(n.getStart()).line+1,kind:ts.SyntaxKind[n.kind],text:ts.isTemplateExpression(n)?n.getText(source):n.text,parent:ts.SyntaxKind[n.parent.kind]});
 ts.forEachChild(n,visit);
}visit(source);console.log(JSON.stringify(rows,null,2));
