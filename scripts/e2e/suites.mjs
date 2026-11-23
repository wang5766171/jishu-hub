/**
 * 场景包（suites）：把积木按「依赖」组合，供 run.mjs --suite 选择。
 *   smoke        不需要模型与网络——驱动能力 + 输入区菜单 + 导航 + 市场页面
 *   conversation 需要可用模型——会在当前项目新建测试会话（附件用例仅 Windows）
 *   market       需要联网——真实安装一个扩展并在结束时卸载（冲突卡一律取消）
 *   full         以上全部
 */
import { driverCases } from "./blocks/driver.mjs";
import { composerCases } from "./blocks/composer.mjs";
import { navigationCases } from "./blocks/navigation.mjs";
import { marketCases, marketViewCases } from "./blocks/market.mjs";

// 安装类执行顺序：纯键盘安装在前（候选靠前的留给它），鼠标安装在后，还原最后
const orderedMarket = [...marketCases].sort((a, b) => Number(b.id === "C3") - Number(a.id === "C3") || Number(a.cleanup) - Number(b.cleanup));
import { conversationCases } from "./blocks/conversation.mjs";

const smoke = [...driverCases, ...composerCases, ...navigationCases, ...marketViewCases];

export const SUITES = {
  smoke: { name: "基础冒烟", desc: "不需要模型与网络", cases: smoke },
  conversation: { name: "对话", desc: "需要可用模型；在当前项目新建测试会话", cases: conversationCases },
  market: { name: "市场安装", desc: "需要联网；真实安装扩展并在结束时卸载", cases: orderedMarket },
  full: { name: "全量", desc: "以上全部", cases: [...smoke, ...conversationCases, ...orderedMarket] },
};
