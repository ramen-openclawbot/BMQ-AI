import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { readFileSync } from "node:fs";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
  // A stable build identifier (constant per deploy) used to detect stale caches.
  // IMPORTANT: must NOT change on every page load, otherwise it can cause reload loops.
  define: {
    __APP_VERSION__: JSON.stringify(`${Date.now()}`),
    __APP_SEMVER__: JSON.stringify(`v${pkg.version || "0.0.0"}`),
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
