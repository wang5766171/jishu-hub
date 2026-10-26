/**
 * 产物路径台账（v0.9.3 测试期修复20）：从 agent 自身的工具操作推导文件
 * 落位——目录/文件迁移解析为前缀改写规则（mv / git mv / Move-Item），
 * write/edit 的 path 参数作同名最后写入兜底。打开/预览与**显示层**统一经
 * resolveLedgerPath 换算到最终位置；台账从消息流现算（JSONL 回放含全部
 * 工具调用），零持久化、零文件系统遍历（用户裁决：操作是 agent 做的，
 * 从操作记录识别，而不是搜索）。输出保留原始大小写（显示层可用）。
 */

/** 前缀改写规则（目录或文件迁移）。from/to 为归一小写；*Display 保留原大小写。 */
export interface MoveRule {
  from: string;
  to: string;
  fromDisplay: string;
  toDisplay: string;
}

export interface PathLedger {
  /** 时间序移动规则（后解析的排后，resolve 链式追）。 */
  moves: MoveRule[];
  /** 文件名（小写）→ 最后已知位置（norm 小写 + display 原大小写）。 */
  lastWrites: Map<string, { path: string; display: string }>;
}

interface ToolUseLike {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown;
}

/** 归一化 + 字符索引映射（norm 第 i 字符 ↔ 原串位置——前缀改写重建原大小写用）。 */
function normalizeWithMap(p: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "\\" || ch === "/") {
      // 连续分隔符折叠为一个（映射指向首个）。
      map.push(i);
      norm += "/";
      while (i < p.length && (p[i] === "\\" || p[i] === "/")) i += 1;
    } else {
      map.push(i);
      norm += ch.toLowerCase();
      i += 1;
    }
  }
  // 去尾分隔符。
  if (norm.length > 1 && norm.endsWith("/")) {
    norm = norm.slice(0, -1);
    map.length = norm.length;
  }
  return { norm, map };
}

function toForward(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 去引号（bash 单双引号与 PowerShell 引号）。 */
function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function makeRule(srcRaw: string, dstRaw: string): MoveRule {
  const src = toForward(unquote(srcRaw));
  const dst = toForward(unquote(dstRaw));
  return {
    from: normalizeWithMap(src).norm,
    to: normalizeWithMap(dst).norm,
    fromDisplay: src,
    toDisplay: dst,
  };
}

/** 解析移动命令 → 改写规则（识别 mv / git mv / Move-Item / mi；未识别返回空）。 */
export function parseMoveCommand(command: string): MoveRule[] {
  const rules: MoveRule[] = [];
  for (const rawLine of command.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // PowerShell 注释前缀也可能同行——粗略截断。
    const cmd = line.split("#")[0].trim();
    // 复合命令切分（修复20 返工）：agent 常写链式命令
    // `mkdir -p X && mv A B && ls -R`——按行只看首词 mkdir 整行跳过
    //（用户实测：mv 在 && 链中未被识别）。按 shell 分隔符拆段逐段识别。
    for (const segment of cmd.split(/&&|\|\||;|\|/)) {
      rules.push(...parseSingleMoveCommand(segment));
    }
  }
  return rules;
}

/** 单段命令的移动识别（mv / git mv / Move-Item）。 */
function parseSingleMoveCommand(segment: string): MoveRule[] {
  const rules: MoveRule[] = [];
  const cmd = segment.trim();
  if (!cmd) return rules;
  // tokenizer：空白分隔（引号内含空格的路径按引号合并）。
  const tokens: string[] = [];
  const re = /"[^"]*"|'[^']*'|\S+/g;
  for (const m of cmd.matchAll(re)) tokens.push(m[0]);
  if (tokens.length >= 3) {
    const head = tokens[0].toLowerCase();
    let args: string[] = [];
    if (head === "mv") args = tokens.slice(1);
    else if (head === "git" && tokens[1]?.toLowerCase() === "mv") args = tokens.slice(2);
    else if (head === "move-item" || head === "mi") args = tokens.slice(1);
    else return rules;
    // 跳过选项（-r/-Force/-- 等）。
    const paths = args.filter((a) => !a.startsWith("-"));
    if (paths.length === 2) {
      rules.push(makeRule(paths[0], paths[1]));
    } else if (paths.length > 2) {
      // 多源入目录：mv a b c dir → a,b,c 全部改写到 dir 下。
      const dstDir = unquote(paths[paths.length - 1]);
      for (const src of paths.slice(0, -1)) {
        const s = toForward(unquote(src));
        const name = s.split("/").pop() ?? "";
        rules.push(makeRule(src, `${dstDir}/${name}`));
      }
    }
  }
  return rules;
}

/** 从消息流构建台账（主会话 PluginMessage 与节点会话原始消息同构消费）。 */
export function buildPathLedger(messages: Array<{ blocks?: ToolUseLike[]; content?: ToolUseLike[] }>): PathLedger {
  const moves: MoveRule[] = [];
  const lastWrites = new Map<string, { path: string; display: string }>();
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
        const display = toForward(input.path);
        lastWrites.set(display.split("/").pop()?.toLowerCase() ?? "", {
          path: normalizeWithMap(display).norm,
          display,
        });
      }
    }
  }
  return { moves, lastWrites };
}

/** 台账解析：移动规则链式前缀改写（最长前缀优先，≤5 跳）→ 同名最后写入。
 * 返回最终位置（保留原大小写，正斜杠）；null = 无可换算（用原路径）。 */
export function resolveLedgerPath(path: string, ledger: PathLedger): string | null {
  const original = toForward(path);
  const { norm: norm0, map } = normalizeWithMap(original);
  let norm = norm0;
  let display = original;
  for (let hop = 0; hop < 5; hop += 1) {
    const hit = ledger.moves
      .filter((r) => (r.from ? norm === r.from || norm.startsWith(`${r.from}/`) : false))
      .sort((a, b) => b.from.length - a.from.length)[0];
    if (!hit) break;
    if (norm === hit.from) {
      norm = hit.to;
      display = hit.toDisplay;
    } else {
      // 前缀改写：从映射取「规则前缀之后」的原串后缀（跳过分隔符），保留大小写。
      const afterSep = map[hit.from.length + 1];
      const suffix = afterSep !== undefined ? original.slice(afterSep) : "";
      norm = `${hit.to}${norm.slice(hit.from.length)}`;
      display = `${hit.toDisplay}/${suffix}`;
    }
  }
  if (norm !== norm0) return display;
  // 兜底：同名最后写入（且与原路径不同才有意义）。
  // 返工（防反向改写）：lastWrites 记录的常是**移动前**的写入位置（write
  // 先于 mv 发生）——若直接采用会把已换算到新位置的路径改写回旧位置
  //（用户实测：显示层正确新路径，预览/打开报 os error 2）。因此兜底前先
  // 沿移动规则追链到最终位置：追链结果 == 当前路径（当前已是最终位）或
  // 追链后仍与记录不一致（状态混乱）都不改写；仅当写入位置从未被移动过
  // 才采用该兜底。
  const name = norm.split("/").pop() ?? "";
  const last = ledger.lastWrites.get(name);
  if (last && last.path !== norm) {
    let finalNorm = last.path;
    for (let guard = 0; guard < 5; guard += 1) {
      const h = ledger.moves
        .filter((r) => (r.from ? finalNorm === r.from || finalNorm.startsWith(`${r.from}/`) : false))
        .sort((a, b) => b.from.length - a.from.length)[0];
      if (!h) break;
      finalNorm = finalNorm === h.from ? h.to : `${h.to}${finalNorm.slice(h.from.length)}`;
    }
    if (finalNorm === last.path) return last.display;
  }
  return null;
}
