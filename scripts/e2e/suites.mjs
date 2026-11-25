/**
 * 场景包（suites）：把积木按「依赖」组合，供 run.mjs --suite 选择。
 *   smoke        不需要模型与网络——驱动能力 + 输入区菜单 + 导航 + 市场页面
 *   conversation 需要可用模型——会在当前项目新建测试会话（附件用例仅 Windows）
 *   market       需要联网——真实安装扩展（每个安装用例装完即卸；冲突卡一律取消；末条兜失败残留）
 *   fixround     v0.9.8 评审修复轮——十条修复的界面层验证（F7 联网真装一个冲突扩展并选
 *                「停用并安装」，验完卸载即自动恢复；末尾两块还原用例兜失败残留）
 *   compact      v0.9.8 需求7 补充轮——斜杠命令与上下文压缩（每个用例先往新会话发两条
 *                各约 9 万字符的消息使会话可压缩；EC-5 会真的取消一次压缩）
 *   search       v0.9.8 需求23 搜索体验优化与补充轮——SE-1~SE-3、SE-7、SE-8、SE-11 不需要模型；
 *                SE-4~SE-6、SE-9、SE-10、SE-12 需要可用模型（新建一个带独一无二关键词的测试会话，
 *                往里发四条短消息，留在项目里）
 *   unread       v0.9.8 需求24 任务会话的绿点点击后无法消除——UN-1 任务会话 / UN-2 普通会话回归；
 *                需要可用模型（在会话里发一条慢消息，回合结束前切走，造出一笔未读）
 *   full         smoke + conversation + market
 */
import { driverCases } from "./blocks/driver.mjs";
import { composerCases } from "./blocks/composer.mjs";
import { navigationCases } from "./blocks/navigation.mjs";
import { marketCases, marketViewCases } from "./blocks/market.mjs";
import { conversationCases } from "./blocks/conversation.mjs";
import { fixRoundCases, fixRoundCleanupCases, fixRoundReloadCases, fixRoundViewCases } from "./blocks/fix-round.mjs";
import { compactCases } from "./blocks/compact.mjs";
import { searchCases } from "./blocks/search.mjs";
import { unreadCases } from "./blocks/unread.mjs";

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
  compact: {
    name: "斜杠命令与压缩",
    desc: "需要可用模型；每个用例先往新会话发两条各约 9 万字符的消息使会话可压缩（占用模型用量，测试会话留在项目里）；EC-5 会真的取消一次压缩",
    cases: compactCases,
  },
  search: {
    name: "搜索体验",
    desc: "v0.9.8 需求23 搜索体验优化与补充轮：SE-1~SE-3、SE-7、SE-8、SE-11 不需要模型；SE-4~SE-6、SE-9、SE-10、SE-12 需要可用模型（新建一个带独一无二关键词的测试会话，往里发四条短消息，留在项目里）",
    cases: searchCases,
  },
  unread: {
    name: "未读标记",
    desc: "v0.9.8 需求24：行首绿点 / 红点（没看过的回合结果）点开后不再出现——UN-1 任务会话、UN-2 普通会话回归；需要可用模型（发一条慢消息并在回合结束前切走，造出未读；会话留在项目里）",
    cases: unreadCases,
  },
  full: { name: "全量", desc: "以上全部", cases: [...smoke, ...conversationCases, ...orderedMarket] },
};
