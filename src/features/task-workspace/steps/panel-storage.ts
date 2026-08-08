/**
 * 步骤栏折叠态持久化。
 *
 * 与 viewport-storage.ts 同风格：localStorage + try/catch 容错。
 * key 固定（非 per-graph），因为用户偏好是全局的——要么总展开要么总折叠。
 */

const KEY = "jishu:task-steps-panel-open";

export function loadStepsPanelOpen(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    // 默认展开（首次使用时）
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

export function saveStepsPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // Best-effort.
  }
}
