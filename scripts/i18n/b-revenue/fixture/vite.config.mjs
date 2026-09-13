import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../../../apps/web/scripts/i18n/bcd-fixture/vite.config.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),web=path.resolve(here,'../../../../apps/web');
export default {...base,root:here,envDir:here,define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('http://127.0.0.1:4302/mock'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('fixture-only')},resolve:{alias:[
 {find:'@/integrations/supabase/client',replacement:path.join(here,'mock-client.ts')},
 {find:'@/contexts/AuthContext',replacement:path.join(here,'auth.ts')},
 {find:'@',replacement:path.join(web,'src')},
 ...['react','react-dom','react-router-dom','@tanstack/react-query'].map(name=>({find:name,replacement:path.join(web,'node_modules',name)})),
]},server:{...base.server,port:4302,fs:{allow:[path.resolve(web,'../..'),'/home/ubuntu']}}};
