// Type-check only. Never calls emit/build. Baseline sources are substituted in memory.
import ts from 'typescript';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const repo=path.resolve(web,'../..');
process.chdir(web);
const baseline=process.argv.includes('--base');
const configFile=ts.readConfigFile(path.join(web,'tsconfig.app.json'),ts.sys.readFile);
const config=ts.parseJsonConfigFileContent(configFile.config,ts.sys,web,{noEmit:true});
const host=ts.createCompilerHost(config.options);
if(baseline){
  const originals=new Map();
  const changed=execFileSync('git',['diff','--name-only','--','apps/web/src'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const file of changed)originals.set(path.join(repo,file),execFileSync('git',['show',`eac7ee887ae44494b9187865fe9766b3ccf49e16:${file}`],{cwd:repo,encoding:'utf8'}));
  const getSource=host.getSourceFile.bind(host);
  host.getSourceFile=(file,language,onError,createNew)=>originals.has(file)?ts.createSourceFile(file,originals.get(file),language,true):getSource(file,language,onError,createNew);
  config.fileNames=config.fileNames.filter(f=>!f.includes('/src/i18n/')&&!f.endsWith('/StaffUiContext.tsx'));
}
const program=ts.createProgram(config.fileNames,config.options,host);
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?path.relative(web,d.file.fileName):null,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
console.log(JSON.stringify({mode:baseline?'base':'current',noEmit:true,errors:diagnostics.length,diagnostics},null,2));
process.exitCode=diagnostics.length?1:0;
