import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from '../fixture/vite.config.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export default {
  ...base,
  root: here,
  envDir: here,
  plugins: base.plugins.filter(p => p.name !== 'exclude-business-pages'),
  resolve: { alias: [
    { find: '@/integrations/supabase/client', replacement: path.join(here, 'mock-client.ts') },
    { find: '@/contexts/AuthContext', replacement: path.join(here, 'auth.ts') },
    ...base.resolve.alias.filter(a => a.find === '@'),
  ] },
  server: { ...base.server, port: 4197 },
};
