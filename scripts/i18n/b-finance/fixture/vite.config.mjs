import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../../../../apps/web/scripts/i18n/bcd-fixture/vite.config.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const web=path.resolve(here,'../../../../apps/web');
export default {...base,root:here,envDir:here,
 define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('http://127.0.0.1:4301/mock-supabase'),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('fixture-not-a-secret')},
 resolve:{alias:[
  {find:'@/integrations/supabase/client',replacement:path.join(here,'mock-client.ts')},
  {find:'@/contexts/AuthContext',replacement:path.join(here,'auth.ts')},
  ...['react','react-dom','react-router-dom','@tanstack/react-query'].map(find=>({find,replacement:path.join(web,'node_modules',find)})),
  {find:'@',replacement:path.join(web,'src')}
 ]},server:{...base.server,port:4301,fs:{allow:[web,here]}}};
