import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../fixture/vite.config.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export default {...base,root:here,envDir:here,plugins:base.plugins.filter(p=>p.name!=='exclude-business-pages'),
 define:{__APP_VERSION__:JSON.stringify('1788912000000'),__APP_SEMVER__:JSON.stringify('fixture-people'), 'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('http://127.0.0.1:4306/mock'), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('fixture-only')},
 resolve:{alias:[{find:'@/integrations/supabase/client',replacement:path.join(here,'mock-client.ts')},{find:'@/contexts/AuthContext',replacement:path.join(here,'auth.ts')},...base.resolve.alias.filter(a=>a.find==='@')]},server:{...base.server,port:4306},};
