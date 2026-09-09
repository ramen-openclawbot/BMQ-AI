// Run from apps/web, one compiler process at a time with NODE_OPTIONS capped at 1024 MB.
import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
const web=process.cwd(),base='/tmp/bmq-i18n-lanes/baseline/apps/web';
if(!fs.existsSync(path.join(web,'tsconfig.app.json')))throw Error('Run from apps/web');
const baseline=process.argv.includes('--base');
const configFile=ts.readConfigFile('tsconfig.app.json',ts.sys.readFile);
const config=ts.parseJsonConfigFileContent(configFile.config,ts.sys,web,{noEmit:true});
const host=ts.createCompilerHost(config.options);
if(baseline){const read=host.readFile.bind(host);host.readFile=file=>{const rel=path.relative(web,file);const original=path.join(base,rel);return rel.startsWith('src/')&&fs.existsSync(original)?fs.readFileSync(original,'utf8'):read(file);};config.fileNames=config.fileNames.filter(file=>!file.includes('/src/')||fs.existsSync(path.join(base,path.relative(web,file))));}
const program=ts.createProgram(config.fileNames,config.options,host);
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?path.relative(web,d.file.fileName):null,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
console.log(JSON.stringify({mode:baseline?'baseline':'current',errors:diagnostics.length,diagnostics},null,2));process.exitCode=diagnostics.length?1:0;
