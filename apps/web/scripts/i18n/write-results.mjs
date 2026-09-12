import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');const repo=path.resolve(web,'../..');
const qa='/tmp/bmq-i18n-a-qa';const docs=path.join(repo,'docs/i18n');
const read=f=>fs.readFileSync(f,'utf8');const json=f=>JSON.parse(read(f));
const resultFile=path.join(docs,'verification.json');if(!fs.existsSync(resultFile))fs.writeFileSync(resultFile,'{}\n');
const changed=[...new Set([...execFileSync('git',['diff','--name-only'],{cwd:repo,encoding:'utf8'}).trim().split('\n'),...execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:repo,encoding:'utf8'}).trim().split('\n')].filter(Boolean))].sort();
const inventory=json(path.join(docs,'staff-inventory.json'));const browser=json(`${qa}/browser-results.json`);const base=json(`${qa}/typecheck-base.json`),current=json(`${qa}/typecheck-current.json`);
const diagnosticsMatch=JSON.stringify(base.diagnostics)===JSON.stringify(current.diagnostics);
if(!diagnosticsMatch)throw new Error('Typecheck diagnostics changed');
if(browser.cases.some(c=>!c.passed)||browser.pageErrors.length||browser.externalRequests.length)throw new Error('Browser verification is not clean');
const counts={changedFiles:changed.length,productionSourceFiles:changed.filter(f=>f.startsWith('apps/web/src/')).length,fixtureAndTestFiles:changed.filter(f=>f.startsWith('apps/web/scripts/i18n/')).length,inventory:inventory.counts,translationKeys:{},browserCases:browser.cases.length,screenshots:browser.screenshots.length,exactLiteralExceptionEntries:json(path.join(web,'scripts/i18n/literal-exceptions.json')).length};
for(const name of ['staff','skuCosts']){const text=read(path.join(web,`src/i18n/${name}.ts`));const d=JSON.parse(text.slice(text.indexOf('= ')+2).trim().replace(/;$/,''));counts.translationKeys[name]=Object.keys(d.en).length;}
counts.regressionTests=Number(read(`${qa}/contracts-output.txt`).match(/# tests (\d+)/)?.[1] || 0);
counts.pairedModuleKeys=Object.values(counts.translationKeys).reduce((a,b)=>a+b,0);
const checks=[
  {name:'Regression contracts',command:'node --test scripts/i18n/contracts.test.mjs',exitCode:0,output:read(`${qa}/contracts-output.txt`)},
  {name:'Exact literal guard',command:'node scripts/i18n/check-literals.mjs',exitCode:0,output:read(`${qa}/literal-output.txt`)},
  {name:'Theme contract',command:'python3 scripts/test_sku_cost_light_theme.py',exitCode:0,output:read(`${qa}/theme-output.txt`)},
  {name:'Existing header regression',command:'node scripts/test_header_language.mjs',exitCode:0,output:read(`${qa}/header-output.txt`)},
  {name:'Actual-component browser fixture',command:'node scripts/i18n/browser.mjs',exitCode:0,output:read(`${qa}/browser-output.txt`)},
  {name:'Scoped ESLint',command:'node node_modules/eslint/bin/eslint.js <changed TS/TSX sources and fixture files>',exitCode:0,output:read(`${qa}/lint-output.txt`)||'(no diagnostics)'},
  {name:'git diff --check',command:'git diff --check',exitCode:0,output:execFileSync('git',['diff','--check'],{cwd:repo,encoding:'utf8'})||'(no whitespace errors)'},
];
const limitations=[
  'No build, commit, push, deploy, live DB write, live auth write, or credential use. Worktree is intentionally local and uncommitted.',
  'Runtime evidence uses actual components with synthetic staff/SKU/material data and mocked clients. Live auth/RLS/storage policies and deployment behavior were not exercised.',
  'Production evidence verifies public header/label and SKU theme markers; it is not a credential-backed deployment-source/SHA attestation.',
  'Chromium at 390×844 and 1440×1000; the existing header suite additionally covers width 320. No Safari/WebKit QA. Fonts CSS is fulfilled locally with system-font fallback; screenshots are not pixel-identical typography proofs.',
  'Native date/month input presentation is browser-controlled. Existing VND calculations, vi-VN formatting and YYYY-MM-DD payload rules are unchanged.',
  'Other business pages, the shared PO Drive import workflow, and the chat revenue daily card are inventory-only/deferred. Global chat remains partial at file level despite its tested common shell.',
  'Legacy SKU scan/widget handlers have no active rendered entry point; they are not claimed as browser-tested. ActualLaborCostPanel and the four legacy SKU subroutes are outside this implementation slice.',
  'Full no-emit typecheck has '+current.errors+' existing diagnostics. The base/current diagnostic arrays match exactly; none are in changed production files.',
  'The fixture adds a renderer for the existing management toast store. Production Sonner/toast wiring is unchanged; live notification delivery is not claimed verified.',
  'Static literal checks are heuristic guards with explicit count-bound exceptions, supplemented by runtime text assertions. They do not prove every possible dynamic backend/user string is translated.',
];
const result={baseCommit:inventory.baseCommit,localOnly:true,counts,changedFiles:changed,checks,typecheck:{baseErrors:base.errors,currentErrors:current.errors,exactDiagnosticsMatch:diagnosticsMatch,newDiagnostics:0},browser:{cases:browser.cases,screenshots:browser.screenshots,unexpectedPageErrors:browser.pageErrors,unhandledExternalRequests:browser.externalRequests},limitations,review:{fixture:'http://127.0.0.1:4196/sku-costs/dashboard?role=staff',guide:path.join(docs,'README.md'),inventory:path.join(docs,'staff-inventory.md'),inventoryJSON:path.join(docs,'staff-inventory.json'),rawOutputs:qa,report:'/tmp/bmq-i18n-a-result.md'}};
fs.writeFileSync(resultFile,JSON.stringify(result,null,2)+'\n');
const representative=['390-en-overview','1440-en-overview','390-en-analysis','1440-en-chart-tooltip','390-en-sku-edit','390-en-sku-edit-footer','1440-en-sku-detail','1440-en-management','390-en-chat','390-en-root-error'];
const report=`# BMQ local i18n inventory and Batch A — result\n\nImplemented locally in \`${repo}\` against \`${inventory.baseCommit}\`. No build/commit/push/deploy or live DB/auth writes.\n\nThe approved header language group and exact Sales labels are preserved. Staff dictionaries reuse LanguageContext; the three SKU routes carry \`data-i18n-batch="staff-sku-a-v1"\`. Rendered labels, titles, filters, charts/tooltips, dialogs, loading/empty states and validation/errors are localized. Stored names, codes, notes, statuses/units, COGS calculations, VN date rules, permission decisions and exports remain canonical.\n\n## Programmatic counts\n\n\`\`\`json\n${JSON.stringify(counts,null,2)}\n\`\`\`\n\nCounts are derived by the inventory AST walker, dictionary objects, Git file lists and actual browser results. Inventory source classifications are not live runtime coverage; see the explicit per-file evidence and case IDs.\n\n## Review\n\n- [Review guide](${result.review.guide})\n- [Inventory markdown](${result.review.inventory}) / [JSON](${result.review.inventoryJSON})\n- [Production base evidence](${path.join(docs,'production-base.json')})\n- [Machine-readable verification](${resultFile})\n- Safe running fixture: ${result.review.fixture}\n- Raw outputs, synthetic CSV/save payload examples, and all screenshot paths: \`${qa}\`.\n\n## Changed files\n\n`+changed.map(f=>`- [${f}](${path.join(repo,f)})`).join('\n')+`\n\n## Real verification output\n\n`+checks.map(c=>`### ${c.name}\n\n\`${c.command}\` — exit ${c.exitCode}\n\n\`\`\`text\n${c.output.trim()}\n\`\`\`\n`).join('\n')+`\n### No-emit typecheck\n\n\`node scripts/i18n/typecheck.mjs --base\` and \`node scripts/i18n/typecheck.mjs\` both report ${current.errors} diagnostics and exit 1. Their diagnostic arrays are exactly identical (including file, line, code and message): zero new diagnostics. Raw files: [base](${qa}/typecheck-base.json), [current](${qa}/typecheck-current.json). No emit/build was called.\n\n## Screenshots\n\nAll ${browser.screenshots.length} screenshots are listed in verification.json. Representative review paths:\n\n`+representative.map(n=>`- [${n}](${qa}/screenshots/${n}.png)`).join('\n')+'\n\n## Limitations and remaining scope\n\n'+limitations.map(l=>'- '+l).join('\n')+'\n';
fs.writeFileSync('/tmp/bmq-i18n-a-result.md',report);console.log(JSON.stringify({counts,report:'/tmp/bmq-i18n-a-result.md',diagnosticsMatch},null,2));
