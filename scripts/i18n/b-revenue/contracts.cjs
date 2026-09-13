const ts=require('../../../apps/web/node_modules/typescript');
const fs=require('fs'), assert=require('node:assert/strict');
const pages=['RevenueManagementDashboard','RevenueSourceDetail','FinanceRevenueControl','RevenueDailyReview','PointRevenueManagement'];
function contract(name){const source=fs.readFileSync(`apps/web/src/pages/${name}.tsx`,'utf8'),sf=ts.createSourceFile(name,source,99,true,4);const classes=[],writes=[],values=[],math=[];function visit(n){
 if(ts.isJsxAttribute(n)&&n.name.text==='className')classes.push(n.getText(sf));
 if(ts.isJsxAttribute(n)&&n.name.text==='value'&&n.initializer&&ts.isStringLiteral(n.initializer))values.push(n.getText(sf));
 if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&['rpc','insert','update','upsert','delete'].includes(n.expression.name.text))writes.push(n.getText(sf));
 if(ts.isBinaryExpression(n)&&[ts.SyntaxKind.AsteriskToken,ts.SyntaxKind.SlashToken,ts.SyntaxKind.MinusToken].includes(n.operatorToken.kind)) math.push(n.getText(sf));
 ts.forEachChild(n,visit)}visit(sf);return {classes,writes,values,math};}
const actual=Object.fromEntries(pages.map(p=>[p,contract(p)]));
const baseline='scripts/i18n/b-revenue/preservation.json';
if(process.argv.includes('--capture'))fs.writeFileSync(baseline,JSON.stringify(actual,null,2));else{assert.deepEqual(actual,JSON.parse(fs.readFileSync(baseline)));console.log('PASS: exact class expressions, write call arguments, option values and arithmetic expressions preserved across 5 actual pages');}
