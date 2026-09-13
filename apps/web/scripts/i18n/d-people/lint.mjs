import { ESLint } from 'eslint';import fs from 'node:fs';import {files} from './scope.mjs';
const lint=new ESLint();const baseline=process.argv.includes('--base');const reports=[];
for(const file of baseline?files:[...files,'src/hooks/usePeopleCopy.ts','src/hooks/usePeopleLabels.ts','src/i18n/people.ts']){
 const text=fs.readFileSync(baseline?'/tmp/bmq-i18n-lanes/d-people/original/'+file:file,'utf8');const [result]=await lint.lintText(text,{filePath:file});reports.push({file,messages:result.messages,errorCount:result.errorCount,warningCount:result.warningCount});}
console.log(JSON.stringify(reports,null,2));process.exitCode=reports.some(r=>r.errorCount)?1:0;
