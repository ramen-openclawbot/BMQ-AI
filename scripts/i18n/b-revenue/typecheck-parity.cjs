// No emit/build; compare every diagnostic field against integration baseline source in memory.
const ts=require('../../../apps/web/node_modules/typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const repo=process.cwd(),web=path.join(repo,'apps/web'),baseline=process.env.BMQ_I18N_BASELINE||'/tmp/bmq-i18n-lanes/baseline',out='/tmp/bmq-i18n-lanes/b-revenue';
process.chdir(web);
const configFile=ts.readConfigFile(path.join(web,'tsconfig.app.json'),ts.sys.readFile),config=ts.parseJsonConfigFileContent(configFile.config,ts.sys,web,{noEmit:true});
function diagnostics(base){const host=ts.createCompilerHost(config.options),get=host.getSourceFile.bind(host);if(base)host.getSourceFile=(file,language,onError,createNew)=>{const relative=path.relative(repo,file),original=path.join(baseline,relative);return relative.startsWith('apps/web/src/')&&fs.existsSync(original)?ts.createSourceFile(file,fs.readFileSync(original,'utf8'),language,true):get(file,language,onError,createNew)};return ts.getPreEmitDiagnostics(ts.createProgram(config.fileNames,config.options,host)).map(d=>({file:d.file?path.relative(web,d.file.fileName):null,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:null,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))}
if(process.argv.includes('--worker')){console.log(JSON.stringify(diagnostics(process.argv.includes('--base'))));}else{
const {execFileSync}=require('node:child_process');
const run=base=>JSON.parse(execFileSync(process.execPath,[__filename,'--worker',...(base?['--base']:[])],{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024}));
const base=run(true),current=run(false);
fs.writeFileSync(path.join(out,'typecheck-parity.json'),JSON.stringify({baseline,baselineDiagnostics:base,currentDiagnostics:current},null,2));assert.equal(base.length,55);assert.deepEqual(current,base);console.log('PASS: all 55 baseline diagnostics match exactly (file, line, code, full message); no emit/build.');
}
