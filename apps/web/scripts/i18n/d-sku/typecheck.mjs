// Separate processes, package cwd, no emit. Baseline source is read-only.
import ts from 'typescript';import path from 'node:path';
const web=process.cwd(),base=process.argv.includes('--base');
const baseline='/tmp/bmq-i18n-lanes/baseline/apps/web';
const cf=ts.readConfigFile(path.join(web,'tsconfig.app.json'),ts.sys.readFile);
const config=ts.parseJsonConfigFileContent(cf.config,ts.sys,web,{noEmit:true});
const host=ts.createCompilerHost(config.options);
if(base){
 const read=host.readFile.bind(host);
 host.readFile=file=>file.startsWith(web+'/src/')?read(path.join(baseline,path.relative(web,file))):read(file);
 config.fileNames=config.fileNames.filter(f=>ts.sys.fileExists(path.join(baseline,path.relative(web,f))));
}
const program=ts.createProgram(config.fileNames,config.options,host);
const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?path.relative(web,d.file.fileName):null,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}));
console.log(JSON.stringify({errors:diagnostics.length,diagnostics},null,2));process.exitCode=diagnostics.length?1:0;
