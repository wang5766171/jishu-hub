/**
 * app-nav —— 跨页面导航事件（v0.9.5 需求1 GUI 改造 · 批次5）。
 *
 * 背景：会话区（能力中心弹层/挂件右键菜单）需要跳转管理页指定 tab
 * （插件中心），但 App 的页面状态在顶层、会话组件嵌套深——props 透传
 * 成本高。采用与 panel-activation / install-spotlight 同款的事件模式：
 * 发送方 dispatch，App/manage-page 各自订阅。
 */

export interface ManageNavDetail {
  /** 管理页目标 tab（manage-page 侧栏 id，如 "plugins"）；缺省保持当前。 */
  tab?: string;
}

const NAV_MANAGE_EVENT = "jishu:navigate-manage";

/** 最近一次导航请求（十九轮修复：chat→manage 条件挂载下，事件派发时
 * manage-page 尚未挂载、其监听不存在——tab 落默认「项目管理」。open 时
 * 留存，manage-page 挂载时 consume 补投递。） */
let lastManageNav: ManageNavDetail | null = null;

/** 请求跳转管理页（可带目标 tab）。 */
export function openManagePage(tab?: string): void {
  lastManageNav = { tab };
  window.dispatchEvent(new CustomEvent<ManageNavDetail>(NAV_MANAGE_EVENT, { detail: { tab } }));
}

/** manage-page 挂载时取走最近一次导航请求（无则 null；一次性消费）。 */
export function consumePendingManageNav(): ManageNavDetail | null {
  const detail = lastManageNav;
  lastManageNav = null;
  return detail;
}

/** 订阅导航请求（App 换页 / manage-page 切 tab 各自消费）。返回退订函数。 */
export function onManageNav(handler: (detail: ManageNavDetail) => void): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ManageNavDetail>).detail ?? {});
  };
  window.addEventListener(NAV_MANAGE_EVENT, listener);
  return () => window.removeEventListener(NAV_MANAGE_EVENT, listener);
}
