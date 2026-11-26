/**
 * 场景包（suites）：把积木按「依赖」组合，供 run.mjs --suite 选择。
 *   smoke        不需要模型与网络——驱动能力 + 输入区菜单 + 导航 + 市场页面
 *   conversation 需要可用模型——会在当前项目新建测试会话（附件用例仅 Windows）
 *   market       需要联网——真实安装扩展（每个安装用例装完即卸；冲突卡一律取消；末条兜失败残留）
 *   fixround     v0.9.8 评审修复轮——十条修复的界面层验证（F7 联网真装一个冲突扩展并选
 *                「停用并安装」，验完卸载即自动恢复；末尾两块还原用例兜失败残留）
 *   compact      v0.9.8 需求7 补充轮——斜杠命令与上下文压缩（每个用例先往新会话发两条
 *                各约 9 万字符的消息使会话可压缩；EC-5 会真的取消一次压缩）
 *   search       v0.9.8 需求23 搜索体验优化与补充轮——SE-1~SE-3、SE-7、SE-8、SE-11、SE-13、SE-15 不需要模型；
 *                SE-4~SE-6、SE-9、SE-10、SE-12、SE-14 需要可用模型（SE-4 起新建一个带独一无二关键词的
 *                测试会话，往里发四条短消息，留在项目里；SE-14 另新建一个会话发一条带工具标签的消息）。
 *                SE-14、SE-15 是评审修复轮 R2 的工具标签用例（用户裁决 8）：SE-14 量内联形态（自己造数），
 *                SE-15 量尾随形态（在项目已有会话里找，找不到就跳过——这种形态没有可靠的自动化造数）
 *   unread       v0.9.8 需求24 任务会话的绿点点击后无法消除——UN-1 任务会话 / UN-2 普通会话回归；
 *                需要可用模型（在会话里发一条慢消息，回合结束前切走，造出一笔未读）
 *   tasksession  v0.9.8 需求24 续 任务会话与普通会话统一成一套——TS-1 打开就在底部 / TS-2 翻上去离开
 *                回来停在原处 / TS-3 重开后在底部、后台来了新回复回来在最底部 / TS-4 切节点 / TS-5 读盘期间
 *                切走晚到的结果不留痕迹 / TS-6 从翻上去的会话切过去不空白（后两块不需要模型）；
 *                前四块要模型（TS-4 会造一个带任务图的任务；TS-1、TS-3 会重载页面）
 *   approval     v0.9.8 评审修复轮 R2（用户裁决 9）——工具执行审批：AP-1 同意 / AP-2 不同意 / AP-3 框架
 *                默认不替用户放行 + APX-1 还原；需要可用模型；会切换访问权限档位（用例内还原）
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
import { taskSessionCases } from "./blocks/task-session.mjs";
import { approvalCases } from "./blocks/approval.mjs";

// 安装类执行顺序：纯键盘安装在前（候选靠前的留给它），鼠标安装在后，还原最后
const orderedMarket = [...marketCases].sort((a, b) => Number(b.id === "C3") - Number(a.id === "C3") || Number(a.cleanup) - Number(b.cleanup));

const smoke = [...driverCases, ...composerCases, ...navigationCases, ...marketViewCases];
// 修复轮：页面类在前，对话类随后，真装冲突扩展，会重载页面的套装用例（F6）排在全部对话用例
// 之后（重载后几秒内界面未落定，紧跟的对话用例会误判），还原收尾
const fixround = [...fixRoundViewCases, ...fixRoundCases, ...fixRoundReloadCases, ...fixRoundCleanupCases];

export const SUITES = {
  smoke: { name: "基础冒烟", desc: "不需要模型与网络；C4c 会切换访问权限档位（用例内切回并读回）", cases: smoke },
  conversation: { name: "对话", desc: "需要可用模型；在当前项目新建测试会话", cases: conversationCases },
  market: { name: "市场安装", desc: "需要联网；真实安装扩展，装完即卸", cases: orderedMarket },
  fixround: {
    name: "评审修复轮",
    desc: "需要可用模型；F7 另需联网（真装冲突扩展并选「停用并安装」，验完自动恢复）；还原用例始终执行",
    cases: fixround,
  },
  compact: {
    name: "斜杠命令与压缩",
    desc: "需要可用模型；每个用例先往新会话发两条各约 9 万字符的消息使会话可压缩（占用模型用量，测试会话留在项目里）；EC-5 会真的取消一次压缩；EC-10、EC-11 验证回合进行中发的 /compact 进待发送区、回合结束才执行；EC-11 另在 /compact 前后各排一条消息，核对三条按顺序执行",
    cases: compactCases,
  },
  search: {
    name: "搜索体验",
    desc: "v0.9.8 需求23 搜索体验优化与补充轮 + 评审修复轮 R2 的工具标签用例：SE-1~SE-3、SE-7、SE-8、SE-11、SE-13、SE-15 不需要模型；SE-4~SE-6、SE-9、SE-10、SE-12、SE-14 需要可用模型（新建一个带独一无二关键词的测试会话，往里发四条短消息；SE-14 另新建一个会话发一条带工具标签的消息；都留在项目里）。SE-15 会打开侧栏搜「@[」命中的最多 5 个已有会话",
    cases: searchCases,
  },
  unread: {
    name: "未读标记",
    desc: "v0.9.8 需求24：行首绿点 / 红点（没看过的回合结果）点开后不再出现——UN-1 任务会话、UN-2 普通会话回归；需要可用模型（发一条慢消息并在回合结束前切走，造出未读；会话留在项目里；项目里没有任务会话时造一个不调用工具的带任务图的任务）",
    cases: unreadCases,
  },
  tasksession: {
    name: "任务会话",
    desc: "v0.9.8 需求24 续 + 评审修复轮 R2：任务会话与普通会话走同一个打开函数——TS-1 打开就停在底部、在底部离开回来还在底部，TS-2 翻上去离开回来停在原处，TS-3 重开后在底部、在底部离开且后台来了新回复回来停在最底部，TS-4 切节点（自己造一个带任务图的任务），TS-5 读盘期间切走晚到的结果不留痕迹，TS-6 从翻上去的会话切过去不空白、落在最底部；TS-1~TS-4 要模型，TS-1、TS-3 会重载页面",
    cases: taskSessionCases,
  },
  approval: {
    name: "工具执行审批",
    desc: "v0.9.8 评审修复轮 R2（用户裁决 9：同意与不同意各有自动化）——AP-1 点「仅本次允许」命令真的执行、AP-2 点「拒绝」命令没有执行、AP-3 框架默认不替用户放行（按 Esc 拒绝并报错）；需要可用模型；会切换访问权限档位（用例内 try/finally 切回、APX-1 兜底、切回后读回核对）",
    cases: approvalCases,
  },
  full: { name: "全量", desc: "冒烟 + 对话 + 市场；不含评审修复、斜杠命令与压缩、搜索、未读标记、任务会话、工具执行审批这几个专项包（各自有模型用量或环境代价，单独跑）", cases: [...smoke, ...conversationCases, ...orderedMarket] },
};
