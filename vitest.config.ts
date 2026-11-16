import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // pi 扩展契约测试（src/pi-extensions/）：pi workspace 包名在 hub 根不可
      // 解析——别名到 Type 构建器测试替身（schema 形态与契约断言无关）。
      "@earendil-works/pi-ai": path.resolve(
        __dirname,
        "./src/pi-extensions/__stubs__/pi-ai.ts",
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // src-tauri 只排除构建产物——resources/extensions 下有 pi 扩展契约测试
      //（vitest 收集；tsc 不扫 src-tauri，pi workspace 包名经别名解析）。
      "**/src-tauri/target/**",
      "**/third_party/**",
      // git worktree 位于仓库目录树内（.claude/worktrees/<name>/），若不排除，
      // 主仓跑 vitest 会连 worktree 的用例一起收集 → 两份 React 实例混用，
      // 报出大量 "Cannot read properties of null (reading 'useContext')" 假失败。
      "**/.claude/worktrees/**",
    ],
  },
});
