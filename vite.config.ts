import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const host = process.env.TAURI_DEV_HOST;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/third_party/**"],
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
    exclude: ["third_party", "src-tauri"],
  },
  build: {
    // M7 P2-6: split the heaviest vendor stacks out of the route chunks so the
    // ~774KB chat-page (markdown render stack) and ~488KB index (xyflow) shrink.
    // Conservative: only independent libs are grouped; react stays in the default
    // chunk to avoid jsx-runtime load-order issues.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (
              id.includes("react-markdown") ||
              id.includes("remark-gfm") ||
              id.includes("rehype") ||
              id.includes("highlight.js") ||
              id.includes("lowlight") ||
              id.includes("micromark") ||
              id.includes("mdast") ||
              id.includes("unified") ||
              id.includes("hast-") ||
              id.includes("nlcst") ||
              id.includes("parse-") ||
              id.includes("property-information")
            ) {
              return "markdown";
            }
            if (id.includes("@xyflow")) {
              return "xyflow";
            }
          }
          return undefined;
        },
      },
    },
  },
}));
