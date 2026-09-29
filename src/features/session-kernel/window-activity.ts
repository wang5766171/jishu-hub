/**
 * v0.9.5 测试期修复（用户实测「系统通知没有效果了」）：应用窗口激活态跟踪。
 *
 * 背景：turn-complete 通知的门控是「正在查看的会话不打扰」——仅后台会话
 * 回合完成时通知。但用户最常见诉求是「最小化窗口等回复，完成时弹通知」：
 * 正在查看的会话在窗口最小化/失焦时同样无任何通知（v0.9.5 起 subagent
 * 集成进主会话工具卡，不再产生后台会话——通知实际触发面归零）。
 *
 * 语义：窗口激活 = 可见（visibilitychange）且聚焦（focus/blur）。两维均由
 * 真实窗口事件驱动（不轮询 document.hasFocus()——过渡瞬间与事件可能瞬时不
 * 一致，且测试环境不可驱动）。失焦（用户在其他应用）或不可见（最小化）都
 * 视为「用户没在看」→ 回合完成应通知。纯窗口级状态，非 React（事件管线在
 * 非 React 语境同步读取）。
 */

let visible = true;
let focused = true;
let attached = false;

function onVisibilityChange(): void {
  visible = document.visibilityState === "visible";
}

function onFocus(): void {
  focused = true;
}

function onBlur(): void {
  focused = false;
}

/** 挂载窗口激活跟踪（app 根部调用一次；返回清理函数便于测试）。 */
export function attachWindowActivityTracking(): () => void {
  if (attached) return () => undefined;
  attached = true;
  visible = document.visibilityState === "visible";
  focused = true;
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    attached = false;
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

/** 事件管线同步读取：应用窗口当前是否激活（可见且聚焦）。 */
export function isAppWindowActive(): boolean {
  return visible && focused;
}

/** 测试口：直写激活态（jsdom 无真实窗口事件）。 */
export function setWindowActiveForTest(active: boolean): void {
  visible = active;
  focused = active;
}
