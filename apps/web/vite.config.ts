import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { existsSync, readFileSync, renameSync } from "node:fs";
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
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    {
      // Vercel serves a real /index.html at "/" before any rewrite, which would
      // stop the payroll host rewrite below. Ship the main page as app.html so
      // vercel.json picks app.html or payroll.html by host for every path.
      name: "bmq-root-html-as-app",
      apply: "build",
      closeBundle() {
        const built = path.resolve(__dirname, "dist/index.html");
        if (existsSync(built)) renameSync(built, path.resolve(__dirname, "dist/app.html"));
      },
    },
  ].filter(Boolean),
  // payroll.html is the same app with payroll.banhmique.vn share tags; vercel.json
  // serves it for that host so link previews show the payslip page, not the admin.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        payroll: path.resolve(__dirname, "payroll.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
