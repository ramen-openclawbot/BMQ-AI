// vite.config.ts
import { defineConfig } from "file:///sessions/stoic-modest-pascal/mnt/BMQ-AI/apps/web/node_modules/vite/dist/node/index.js";
import react from "file:///sessions/stoic-modest-pascal/mnt/BMQ-AI/apps/web/node_modules/@vitejs/plugin-react-swc/index.js";
import path from "path";
import { readFileSync } from "node:fs";
import { componentTagger } from "file:///sessions/stoic-modest-pascal/mnt/BMQ-AI/apps/web/node_modules/lovable-tagger/dist/index.js";
var __vite_injected_original_dirname = "/sessions/stoic-modest-pascal/mnt/BMQ-AI/apps/web";
var __vite_injected_original_import_meta_url = "file:///sessions/stoic-modest-pascal/mnt/BMQ-AI/apps/web/vite.config.ts";
var pkg = JSON.parse(readFileSync(new URL("./package.json", __vite_injected_original_import_meta_url), "utf-8"));
var vite_config_default = defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true
      }
    }
  },
  // A stable build identifier (constant per deploy) used to detect stale caches.
  // IMPORTANT: must NOT change on every page load, otherwise it can cause reload loops.
  define: {
    __APP_VERSION__: JSON.stringify(`${Date.now()}`),
    __APP_SEMVER__: JSON.stringify(`v${pkg.version || "0.0.0"}`)
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  }
}));
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvc2Vzc2lvbnMvc3RvaWMtbW9kZXN0LXBhc2NhbC9tbnQvQk1RLUFJL2FwcHMvd2ViXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvc2Vzc2lvbnMvc3RvaWMtbW9kZXN0LXBhc2NhbC9tbnQvQk1RLUFJL2FwcHMvd2ViL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9zZXNzaW9ucy9zdG9pYy1tb2Rlc3QtcGFzY2FsL21udC9CTVEtQUkvYXBwcy93ZWIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHJlYWN0IGZyb20gXCJAdml0ZWpzL3BsdWdpbi1yZWFjdC1zd2NcIjtcbmltcG9ydCBwYXRoIGZyb20gXCJwYXRoXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgY29tcG9uZW50VGFnZ2VyIH0gZnJvbSBcImxvdmFibGUtdGFnZ2VyXCI7XG5cbi8vIGh0dHBzOi8vdml0ZWpzLmRldi9jb25maWcvXG5jb25zdCBwa2cgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhuZXcgVVJMKFwiLi9wYWNrYWdlLmpzb25cIiwgaW1wb3J0Lm1ldGEudXJsKSwgXCJ1dGYtOFwiKSk7XG5cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZygoeyBtb2RlIH0pID0+ICh7XG4gIHNlcnZlcjoge1xuICAgIGhvc3Q6IFwiOjpcIixcbiAgICBwb3J0OiA1MTczLFxuICAgIHByb3h5OiB7XG4gICAgICBcIi9hcGlcIjoge1xuICAgICAgICB0YXJnZXQ6IFwiaHR0cDovL2xvY2FsaG9zdDo4MDAwXCIsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgLy8gQSBzdGFibGUgYnVpbGQgaWRlbnRpZmllciAoY29uc3RhbnQgcGVyIGRlcGxveSkgdXNlZCB0byBkZXRlY3Qgc3RhbGUgY2FjaGVzLlxuICAvLyBJTVBPUlRBTlQ6IG11c3QgTk9UIGNoYW5nZSBvbiBldmVyeSBwYWdlIGxvYWQsIG90aGVyd2lzZSBpdCBjYW4gY2F1c2UgcmVsb2FkIGxvb3BzLlxuICBkZWZpbmU6IHtcbiAgICBfX0FQUF9WRVJTSU9OX186IEpTT04uc3RyaW5naWZ5KGAke0RhdGUubm93KCl9YCksXG4gICAgX19BUFBfU0VNVkVSX186IEpTT04uc3RyaW5naWZ5KGB2JHtwa2cudmVyc2lvbiB8fCBcIjAuMC4wXCJ9YCksXG4gIH0sXG4gIHBsdWdpbnM6IFtyZWFjdCgpLCBtb2RlID09PSBcImRldmVsb3BtZW50XCIgJiYgY29tcG9uZW50VGFnZ2VyKCldLmZpbHRlcihCb29sZWFuKSxcbiAgcmVzb2x2ZToge1xuICAgIGFsaWFzOiB7XG4gICAgICBcIkBcIjogcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuL3NyY1wiKSxcbiAgICB9LFxuICB9LFxufSkpO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFxVSxTQUFTLG9CQUFvQjtBQUNsVyxPQUFPLFdBQVc7QUFDbEIsT0FBTyxVQUFVO0FBQ2pCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsdUJBQXVCO0FBSmhDLElBQU0sbUNBQW1DO0FBQWlLLElBQU0sMkNBQTJDO0FBTzNQLElBQU0sTUFBTSxLQUFLLE1BQU0sYUFBYSxJQUFJLElBQUksa0JBQWtCLHdDQUFlLEdBQUcsT0FBTyxDQUFDO0FBRXhGLElBQU8sc0JBQVEsYUFBYSxDQUFDLEVBQUUsS0FBSyxPQUFPO0FBQUEsRUFDekMsUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLE1BQ0wsUUFBUTtBQUFBLFFBQ04sUUFBUTtBQUFBLFFBQ1IsY0FBYztBQUFBLE1BQ2hCO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQTtBQUFBO0FBQUEsRUFHQSxRQUFRO0FBQUEsSUFDTixpQkFBaUIsS0FBSyxVQUFVLEdBQUcsS0FBSyxJQUFJLENBQUMsRUFBRTtBQUFBLElBQy9DLGdCQUFnQixLQUFLLFVBQVUsSUFBSSxJQUFJLFdBQVcsT0FBTyxFQUFFO0FBQUEsRUFDN0Q7QUFBQSxFQUNBLFNBQVMsQ0FBQyxNQUFNLEdBQUcsU0FBUyxpQkFBaUIsZ0JBQWdCLENBQUMsRUFBRSxPQUFPLE9BQU87QUFBQSxFQUM5RSxTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBVyxPQUFPO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBQ0YsRUFBRTsiLAogICJuYW1lcyI6IFtdCn0K
