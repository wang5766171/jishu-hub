# Jishu Hub v0.4.1 Release Plan

This document outlines the changes to be implemented in the v0.4.1 release.

## 1. Title Bar Optimization
*   **Status**: Completed.
*   **Details**: Replaced manual drag event handling with native `-webkit-app-region: drag` for a smooth, native-like window dragging experience on Windows without the "toggle drag" bug.

## 2. About Menu Update
*   **Target**: `src/App.tsx`
*   **Details**: Update the Gitee link from `https://gitee.com/wangzwa/claude-hub` to `https://gitee.com/wangzwa/jishu-hub`.

## 3. Project Initialization Fix
*   **Target**: `src/components/projects/project-card.tsx` and backend command.
*   **Details**: Investigate and fix the issue where clicking the "not initialized" alert on a new project does nothing. We will ensure that the init command properly triggers terminal execution or provides feedback.

## 4. Session List Search Restoration
*   **Target**: `src/pages/chat-page.tsx`, `src/components/sessions/session-list.tsx`, `src/lib/session-search.ts`
*   **Details**: Restore the session list search functionality that was lost in v0.4.0. The search box in the sidebar should filter the list of sessions based on content/titles, indicating the number of matching sessions, in addition to the right-pane content search.

## 5. Title Bar Menu Renaming
*   **Target**: `src/App.tsx`, `src/i18n/zh.json`, `src/i18n/en.json`
*   **Details**: Rename the "Config" (配置) button in the title bar to "Manage" (管理) to prevent user confusion with the "Config" menu item inside the Manage page itself.

## 6. Sidebar Collapse UI Optimization (AI Polish)
*   **Target**: `src/components/layout/sidebar.tsx`
*   **Details**: When the left sidebar is collapsed, it retains three icons. Currently, the height of these icons or their container changes, causing a UI jump. Ensure the collapsed state maintains the exact same height for these elements as the expanded state.

## 7. Font Size Step Adjustments
*   **Target**: `src/hooks/use-font-size.ts`, `src/index.css`
*   **Details**: Adjust the font size progression. The current "Small" will become "Medium". Based on this new baseline, we will add new "Small", "Large", and "Extra Large" options with smaller, more granular steps to avoid drastic sizing changes.