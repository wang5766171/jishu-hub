// 需求4 F5/D4-6/D4-7（v0.9.8）：GUI 适配预填草稿——单一实现，两处入口
//（市场引导卡/已装页持久入口）共用。内容=官方信息源四通道 + 第 0 步适配
// 价值判定 + 事实告知「客户端是编译产物无源码」（用户裁决：补信息供给，
// 不设禁令；文案随 i18n 双语）。
type TFunc = (key: string, opts?: Record<string, unknown>) => string;

export function buildGuiAdaptDraft(
  t: TFunc,
  info: { title: string; packageName?: string; description?: string },
): string {
  const rawPkg = info.packageName ?? info.title;
  // 关系键不带版本（npm:@scope/pkg@1.0 → npm:@scope/pkg）。
  const pkgKey = rawPkg.replace(/^npm:/, "").replace(/@[^/]+$/, "");
  // defaultValue=中文全文兜底（zh.json 同文；en.json 提供英文）。
  const fallback =
    `我刚安装了扩展「${info.title}」（包：${rawPkg}）。请为它做 GUI 适配，按以下步骤：\n` +
    `0. 先判定该扩展是否需要界面呈现：工具输出给人看（正文/结果/状态）→ 继续适配；工具是给模型用的（记忆/检查/格式化类，输出供下一轮推理消费）→ 直接告诉我「该扩展是纯底层工具，无需界面适配」和理由，并执行 jishu-cli extensions verdict npm:${pkgKey} noneeded --note "<理由>" 落档后结束，不开发；\n` +
    `1. 官方资料（随技能同目录部署；hub 客户端是编译产物、无源码可读，不需要找）：读 jishu-plugin-authoring 技能及其同目录的 API.md（第六节「挂载与 payload 契约」）与 hub-page-capabilities.md（挂载位九类）；\n` +
    `2. 探查扩展本体：~/.jishu-agent/agent/npm/node_modules/ 下该包目录的 README → package.json → dist 入口（registerTool 处即工具清单与 details 形状）；jishu-cli extensions list 可看登记簿现况；\n` +
    `3. 按能力特征选挂载位（技能里有对号入座表），开发适配插件并在 plugin.toml 声明适配关系：[[adapt]] 段 extension = "npm:${pkgKey}"；\n` +
    `4. 产出走确认卡流程，我确认后启用。`;
  const viaI18n = t("market.guiAdaptDraft", {
    defaultValue: fallback,
    title: info.title,
    pkg: rawPkg,
    pkgKey,
  });
  return viaI18n || fallback;
}
