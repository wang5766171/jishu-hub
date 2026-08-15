/**
 * 输入历史与会话草稿（v0.7.3 需求2-A6，对齐 Pi TUI 的输入历史能力）。
 *
 * 历史：按项目维度存储最近发送的消息（去重、最新在前、上限 100 条，
 * 与 TUI editor 历史上限一致）；供输入框 ↑ 回溯。
 * 草稿：按「项目+会话」维度存储未发送的输入文本，切换会话可恢复。
 *
 * 存储介质为 localStorage——仅本机 GUI 状态，不涉 agent 数据，
 * 不走后端持久化。
 */

const HISTORY_LIMIT = 100;

const historyStorageKey = (projectId: string) => `jishu-hub:input-history:${projectId}`;
const draftStorageKey = (sessionKey: string) => `jishu-hub:draft:${sessionKey}`;

function readJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function getInputHistory(projectId: string | null | undefined): string[] {
  if (!projectId) return [];
  try {
    return readJsonArray(localStorage.getItem(historyStorageKey(projectId)));
  } catch {
    return [];
  }
}

export function pushInputHistory(projectId: string | null | undefined, text: string): void {
  const value = text.trim();
  if (!projectId || !value) return;
  try {
    const list = getInputHistory(projectId).filter((item) => item !== value);
    list.unshift(value);
    localStorage.setItem(historyStorageKey(projectId), JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    // 存储不可用（隐私模式/配额）时静默降级为无历史
  }
}

export function getSessionDraft(sessionKey: string | null | undefined): string {
  if (!sessionKey) return "";
  try {
    return localStorage.getItem(draftStorageKey(sessionKey)) ?? "";
  } catch {
    return "";
  }
}

export function setSessionDraft(sessionKey: string | null | undefined, text: string): void {
  if (!sessionKey) return;
  try {
    if (text) {
      localStorage.setItem(draftStorageKey(sessionKey), text);
    } else {
      localStorage.removeItem(draftStorageKey(sessionKey));
    }
  } catch {
    // 同上：静默降级
  }
}
