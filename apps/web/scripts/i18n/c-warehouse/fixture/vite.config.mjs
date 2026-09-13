import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react-swc';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import theme from '../../../../tailwind.config.ts';
const fixture=path.dirname(fileURLToPath(import.meta.url));
const web=path.resolve(fixture,'../../../..');
export default {
 root:fixture,envDir:fixture,plugins:[react()],
 resolve:{alias:[
  {find:'@/integrations/supabase/client',replacement:path.join(fixture,'mock-client.ts')},
  {find:'@/contexts/AuthContext',replacement:path.join(fixture,'auth.ts')},
  {find:'@',replacement:path.join(web,'src')},
 ]},
 css:{postcss:{plugins:[tailwind({...theme,content:[path.join(web,'src/**/*.{ts,tsx}')]}),autoprefixer()]}},
 server:{host:'127.0.0.1',port:4304,strictPort:true,fs:{allow:[web]}},
};
