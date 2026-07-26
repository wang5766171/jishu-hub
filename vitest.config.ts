import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/src-tauri/**",
      "**/third_party/**",
      // git worktree 位于仓库目录树内（.claude/worktrees/<name>/），若不排除，
      // 主仓跑 vitest 会连 worktree 的用例一起收集 → 两份 React 实例混用，
      // 报出大量 "Cannot read properties of null (reading 'useContext')" 假失败。
      "**/.claude/worktrees/**",
    ],
  },
});
