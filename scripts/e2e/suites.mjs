/**
 * 场景包（suites）：把积木按「依赖」组合，供 run.mjs --suite 选择。
 *   smoke        不需要模型与网络——驱动能力 + 输入区菜单 + 导航 + 市场页面
 *   conversation 需要可用模型——会在当前项目新建测试会话（附件用例仅 Windows）
 *   market       需要联网——真实安装扩展（每个安装用例装完即卸；冲突卡一律取消；末条兜失败残留）
 *   fixround     v0.9.8 评审修复轮——十条修复的界面层验证（F7 联网真装一个冲突扩展并选
 *                「停用并安装」，验完卸载即自动恢复；末尾两块还原用例兜失败残留）
 *   full         smoke + conversation + market
 */
import { driverCases } from "./blocks/driver.mjs";
import { composerCases } from "./blocks/composer.mjs";
import { navigationCases } from "./blocks/navigation.mjs";
import { marketCases, marketViewCases } from "./blocks/market.mjs";
import { conversationCases } from "./blocks/conversation.mjs";
import { fixRoundCases, fixRoundCleanupCases, fixRoundReloadCases, fixRoundViewCases } from "./blocks/fix-round.mjs";

// 安装类执行顺序：纯键盘安装在前（候选靠前的留给它），鼠标安装在后，还原最后
const orderedMarket = [...marketCases].sort((a, b) => Number(b.id === "C3") - Number(a.id === "C3") || Number(a.cleanup) - Number(b.cleanup));

const smoke = [...driverCases, ...composerCases, ...navigationCases, ...marketViewCases];
// 修复轮：页面类在前，对话类随后，真装冲突扩展，会重载页面的套装用例（F6）排在全部对话用例
// 之后（重载后几秒内界面未落定，紧跟的对话用例会误判），还原收尾
const fixround = [...fixRoundViewCases, ...fixRoundCases, ...fixRoundReloadCases, ...fixRoundCleanupCases];

export const SUITES = {
  smoke: { name: "基础冒烟", desc: "不需要模型与网络", cases: smoke },
  conversation: { name: "对话", desc: "需要可用模型；在当前项目新建测试会话", cases: conversationCases },
  market: { name: "市场安装", desc: "需要联网；真实安装扩展，装完即卸", cases: orderedMarket },
  fixround: {
    name: "评审修复轮",
    desc: "需要可用模型；F7 另需联网（真装冲突扩展并选「停用并安装」，验完自动恢复）；还原用例始终执行",
    cases: fixround,
  },
  full: { name: "全量", desc: "以上全部", cases: [...smoke, ...conversationCases, ...orderedMarket] },
};
