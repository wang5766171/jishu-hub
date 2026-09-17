/**
 * 产物路径台账（v0.9.3 测试期修复20）：从 agent 自身的工具操作推导文件
 * 落位——目录/文件迁移解析为前缀改写规则（mv / git mv / Move-Item），
 * write/edit 的 path 参数作同名最后写入兜底。打开/预览旧产物记录前经
 * resolveLedgerPath 换算到最终位置；台账从消息流现算（JSONL 回放含全部
 * 工具调用），零持久化、零文件系统遍历（用户裁决：操作是 agent 做的，
 * 从操作记录识别，而不是搜索）。
 */

/** 前缀改写规则（目录或文件迁移；小写、反斜杠归一）。 */
interface MoveRule {
  from: string;
  to: string;
}

export interface PathLedger {
  /** 时间序移动规则（后解析的排后，resolve 链式追）。 */
  moves: MoveRule[];
  /** 文件名（小写）→ 最后已知完整路径（小写）。 */
  lastWrites: Map<string, string>;
}

interface ToolUseLike {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown;
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

/** 去引号（bash 单双引号与 PowerShell 引号）。 */
function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 解析移动命令 → 改写规则（识别 mv / git mv / Move-Item / mi；未识别返回空）。 */
export function parseMoveCommand(command: string): MoveRule[] {
  const rules: MoveRule[] = [];
  for (const rawLine of command.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // PowerShell 注释前缀也可能同行——粗略截断。
    const cmd = line.split("#")[0].trim();
    // tokenizer：空白分隔（引号内含空格的路径按引号合并）。
    const tokens: string[] = [];
    const re = /"[^"]*"|'[^']*'|\S+/g;
    for (const m of cmd.matchAll(re)) tokens.push(m[0]);
    if (tokens.length < 3) continue;
    const head = tokens[0].toLowerCase();
    let args: string[] = [];
    if (head === "mv") args = tokens.slice(1);
    else if (head === "git" && tokens[1]?.toLowerCase() === "mv") args = tokens.slice(2);
    else if (head === "move-item" || head === "mi" || head === "mv" ) args = tokens.slice(1);
    else continue;
    // 跳过选项（-r/-Force/-- 等）。
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length === 2) {
      const [src, dst] = paths.map(unquote);
      rules.push({ from: normalize(src), to: normalize(dst) });
    } else if (paths.length > 2) {
      // 多源入目录：mv a b c dir → a,b,c 全部改写到 dir 下。
      const dstDir = normalize(unquote(paths[paths.length - 1]));
      for (const src of paths.slice(0, -1)) {
        const s = normalize(unquote(src));
        const name = s.split("/").pop() ?? "";
        rules.push({ from: s, to: `${dstDir}/${name}` });
      }
    }
  }
  return rules;
}

/** 从消息流构建台账（主会话 PluginMessage 与节点会话原始消息同构消费）。 */
export function buildPathLedger(messages: Array<{ blocks?: ToolUseLike[]; content?: ToolUseLike[] }>): PathLedger {
  const moves: MoveRule[] = [];
  const lastWrites = new Map<string, string>();
  const blocksOf = (m: { blocks?: ToolUseLike[]; content?: ToolUseLike[] }): ToolUseLike[] =>
    m.blocks ?? m.content ?? [];
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (block?.type !== "tool_use") continue;
      const name = (block.text ?? block.name ?? "").toLowerCase();
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const command = typeof input.command === "string" ? input.command : "";
      if ((name === "bash" || name === "powershell") && command) {
        moves.push(...parseMoveCommand(command));
      }
      if (typeof input.path === "string" && input.path.trim()) {
        const p = normalize(input.path);
        lastWrites.set(p.split("/").pop() ?? "", p);
      }
    }
  }
  return { moves, lastWrites };
}

/** 台账解析：移动规则链式前缀改写（最长前缀优先，≤5 跳）→ 同名最后写入
 *  → 原路径照用。返回 null = 无可换算（用原路径，由动作层报错）。 */
export function resolveLedgerPath(path: string, ledger: PathLedger): string | null {
  let current = normalize(path);
  // 链式追：命中任一规则的前缀即改写，最多 5 跳防环。
  for (let hop = 0; hop < 5; hop += 1) {
    const hit = ledger.moves
      .filter((r) => current === r.from || current.startsWith(`${r.from}/`))
      .sort((a, b) => b.from.length - a.from.length)[0];
    if (!hit) break;
    current = current === hit.from ? hit.to : `${hit.to}${current.slice(hit.from.length)}`;
  }
  if (current !== normalize(path)) return current;
  // 兜底：同名最后写入（且与原路径不同才返回——相同则无意义）。
  const name = current.split("/").pop() ?? "";
  const last = ledger.lastWrites.get(name);
  if (last && last !== current) return last;
  return null;
}
