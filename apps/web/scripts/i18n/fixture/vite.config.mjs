import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const fixture = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(fixture, '../../..');
const require = createRequire(path.join(web, 'package.json'));
const react = require('@vitejs/plugin-react-swc');
const tailwind = require('tailwindcss');
const autoprefixer = require('autoprefixer');
import theme from '../../../tailwind.config.ts';
const local = (name) => path.join(fixture, name);
export default {
  root: fixture, envDir: fixture, plugins: [
    { name: 'exclude-business-pages', enforce: 'pre', resolveId(id) {
      if ((id.startsWith('@/pages/') && !/^@\/pages\/SkuCosts(Django|Analysis|Management)$/.test(id)) || id === '@/warehouse/pages/WarehouseHome') return local('outside-scope.tsx');
    } }, react(),
  ],
  resolve: { alias: [
    { find: /^@\/pages\/(?!SkuCosts(?:Django|Analysis|Management)$).+$/, replacement: local("outside-scope.tsx") },
    { find: "@/warehouse/pages/WarehouseHome", replacement: local("outside-scope.tsx") },
    { find: '@/integrations/supabase/client', replacement: local('mock-client.ts') },
    { find: '@/contexts/AuthContext', replacement: local('auth.ts') },
    ...['useAutoSync','useVisibilityRecovery','usePaymentStats','usePurchaseOrders'].map(name => ({ find: `@/hooks/${name}`, replacement: local('hooks.ts') })),
    { find: '@/lib/fetch-with-timeout', replacement: local('hooks.ts') },
    { find: '@/components/payment-requests/DriveImportProgressDialog', replacement: local('outside-scope.tsx') },
    { find: '@', replacement: path.join(web, 'src') },
  ] },
  css: { postcss: { plugins: [tailwind({ ...theme, content: [path.join(web, 'src/**/*.{ts,tsx}')] }), autoprefixer()] } },
  server: { host: '127.0.0.1', port: 4196, strictPort: true, fs: { allow: [web, require.resolve('react').split('/node_modules/')[0]] } },
};
