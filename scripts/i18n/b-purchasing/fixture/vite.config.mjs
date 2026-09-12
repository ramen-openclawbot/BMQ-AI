import path from 'node:path';
import fs from 'node:fs';
import base from '../../../../apps/web/scripts/i18n/bcd-fixture/vite.config.mjs';
const here=import.meta.dirname, root=path.resolve(here,'../../../..'),web=path.join(root,'apps/web');
const packages=JSON.parse(fs.readFileSync(path.join(web,'package.json'),'utf8')).dependencies;
export default {...base,define:{"import.meta.env.VITE_SUPABASE_URL":JSON.stringify("https://backend.example.invalid"),"import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY":JSON.stringify("fixture-only")},root:here,envDir:here,resolve:{alias:[
 {find:'@baseline/AddInvoiceDialog',replacement:'/tmp/bmq-i18n-lanes/baseline/apps/web/src/components/dialogs/AddInvoiceDialog.tsx'},
 {find:'@/integrations/supabase/client',replacement:path.join(here,'mock-client.ts')},
 {find:'@/contexts/AuthContext',replacement:path.join(here,'auth.ts')},
 {find:'@',replacement:path.join(web,'src')},
 ...Object.keys(packages).map(name=>({find:name,replacement:path.join(web,'node_modules',name)})),
]},server:{host:'127.0.0.1',port:4300,strictPort:true,fs:{allow:[root,"/tmp/bmq-i18n-lanes/baseline"]}}};
