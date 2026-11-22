import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore, useIsSessionStreaming } from "@/hooks/use-stream-store";
import { Button } from "@/components/ui/button";
import {
  Zap, Blocks, Check, ChevronDown, Download, KeyRound, Loader2, MessagesSquare, Package, Paperclip, Plus, Send, Server, Square, Sparkles, X } from "lucide-react";
// v0.9.8 需求5（合并版）：装备建议条数据源（L1/L0/入门分级）。
import { fetchEquipConfig, fetchEquipmentTags, fetchLatestProfile, fetchWorkspaceScene } from "@/features/equipment/api";
import { buildCatalog, installCommandFor, matchByProfile, matchByTags, matchByWorkspaceScene, officialFallback } from "@/features/equipment/match";
import { FilePreview } from "./file-preview";
import { InteractionComposer } from "./interaction-composer";
import { MessageStaging, type StagedMessage } from "./message-staging";
import { open } from "@tauri-apps/plugin-dialog";
import { formatInteractionReply } from "@/lib/conversation-interaction";
import { getInputHistory, pushInputHistory } from "@/lib/input-history";
import { devLog } from "@/lib/dev-log";
import { fuzzyRank } from "@/lib/fuzzy-match";
import { useProjectFiles } from "@/lib/project-files";
import { Command, FileText } from "lucide-react";
import type {
  ChatSession,
  ConversationInteractionRequest,
  ConversationInteractionSubmission,
  SavedFile,
} from "@/types";
import { cn } from "@/lib/utils";
import { EmbeddedToolPill } from "./embedded-tools";
import { detectAtToken } from "./at-file";

/** 会话工具插件条目（v0.8.1 需求7，后端 session_tool_list）。 */
interface SessionTool {
  id: string;
  display_name: string;
  description: string;
  usage: string;
  enabled: boolean;
  /** M3：有 [tool] 段（可 CLI 注入）；false = 仅 pi 扩展形态。 */
  injectable?: boolean;
  /** 能力类别（cli | mcp | skill | extension）——+ 菜单两级分组；
   * extension = 已装 pi 扩展（v0.9.8 需求5：+ 菜单可引用/消息可点名）。 */
  category?: string;
  /** @[名] 引用时保留消息原文（true=扩展：点名即信息，无说明块可注入）。 */
  keep_text?: boolean;
}

/** v0.9.8 需求7：+ 菜单历史残留件过滤——task-requirements/task-plan 是
 * v0.9.7 去阶段化后保留的编程场景推荐件（自适应插件），「阶段入口」语义
 * 已死，不再作为 + 菜单独立入口。能力保留：后端仍下发（task-artifact
 * 系列工具的会话内价值不受影响），已挂载 pill 与 session_set_tools 通道
 * 照常。按插件 id 过滤（显示名随 i18n 变化，不可作判定键）。 */
const LEGACY_STAGE_PLUGIN_IDS = new Set(["task-requirements", "task-plan"]);

/** 内联工具 token：`@[显示名]`（v0.8.1 需求7）。全局正则——用前 reset /
 * 用后 reset，避免 lastIndex 残留（有 /g 标志时 test 会推进状态）。 */
const TOOL_TOKEN_RE = /@\[([^\]]+)\]/g;

/** 工具 token 管线的最小条目（id + display_name 子集；session_tool_list
 * 返回形态即满足）——评审 P1-15 修复：导出供 chat-page 编辑重发复用同一
 * 剥离/归一实现（单源），组件内 SessionTool 结构兼容可直接传入。 */
export interface ToolTokenSource {
  id: string;
  display_name: string;
  /** v0.9.8 需求5：扩展条目 true——@[名] 保留原文（点名传给 agent），
   * 仅归一 id 进 toolIds（pill 渲染/编辑重发一致）。 */
  keep_text?: boolean;
}

/** 解析消息中的工具 token：剥离文本并把显示名归一为插件 id
 * （35ee638a P0：归一缺失会让后端 set_session_tools 拒绝未知 id）。
 * 未匹配任何插件的 token 原样保留（避免吞字）。 */
export function extractToolTokens(text: string, tools: ToolTokenSource[]): { text: string; toolIds: string[] } {
  const ids: string[] = [];
  const replaced = text.replace(TOOL_TOKEN_RE, (match, name: string) => {
    const tool = tools.find((t) => t.display_name === name);
    if (!tool) return match;
    ids.push(tool.id);
    // v0.9.8 需求5：扩展点名保留原文——pi 扩展无说明块可注入，@[扩展名]
    // 本身就是要让 agent 看到的信息（工具可用性由 pi packages 机制保证）。
    if (tool.keep_text) return match;
    return "";
  });
  TOOL_TOKEN_RE.lastIndex = 0;
  return { text: replaced.trimStart(), toolIds: ids };
}

/** 是否含工具 token（无副作用：独立正则，不动全局 RE 的 lastIndex）。 */
function messageHasToolToken(text: string): boolean {
  return /@\[([^\]]+)\]/.test(text);
}

/** mirror 层文本：把 `@[显示名]` 渲染为 pill，其余文本原样（v0.8.1 需求7
 * ——与 textarea 同字体同 padding，文字层透明时用户看到的是这层）。 */
function renderMirrorText(text: string, tools: SessionTool[]) {
  const parts: import("react").ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOOL_TOKEN_RE.lastIndex = 0;
  while ((match = TOOL_TOKEN_RE.exec(text)) !== null) {
    const name = match[1];
    const tool = tools.find((t) => t.display_name === name);
    if (!tool) continue; // 未匹配插件的 token 按 plain text 走（mirror 层与剥离逻辑一致）
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<EmbeddedToolPill key={`${match.index}-${name}`} name={name} />);
    last = match.index + match[0].length;
  }
  TOOL_TOKEN_RE.lastIndex = 0;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

interface AttachedFile {
  id: string;
  data: string;           // base64 for uploads, empty for local project files
  filename: string;
  label: string;
  isImage: boolean;
  localPath?: string;     // set when file is inside project directory
}

type StagedMessageUpdater = StagedMessage[] | ((prev: StagedMessage[]) => StagedMessage[]);

/**
 * Imperative bridge so the parent (chat-page) can participate in the staging
 * area's lifecycle — specifically Route 2: auto-sending staged guides when the
 * agent's turn completes. The staging state still lives here (Route 1, manual
 * guide, owns it); the parent only reads/claims/clears through this handle.
 *
 * Each method takes a `sessionKey` so the parent can target the session whose
 * turn just completed — even when the user is viewing a DIFFERENT session.
 * Staging state is partitioned by session (`stagedMessagesBySession`), so a
 * background session's turn_complete claims only its own staged guides, never
 * another session's.
 *
 * A per-session claimed-id set backs `claimAll`/`restore` so that whichever
 * route (manual guide mid-turn, or auto-send at turn_complete) claims a message
 * FIRST wins, and the other sees it as already sent — guaranteeing each staged
 * guide is delivered exactly once even across the await boundary.
 */
export interface StagedGuideApi {
  /** Atomically claim ALL unclaimed staged messages for `sessionKey` auto-send:
   *  mark them claimed (blocking concurrent manual guide / re-click), clear
   *  that session's staging UI, and return what was claimed. */
  claimAll(sessionKey: string): StagedMessage[];
  /** Roll back a failed auto-send for `sessionKey`: un-claim the ids and put
   *  the messages back into that session's staging UI so the user can retry. */
  restore(sessionKey: string, messages: StagedMessage[]): void;
}

interface ChatInputProps {
  sessionId: string | null;
  projectPath: string | null;
  /** v0.7.0 需求一：会话绑定的智能体 id（send_message 必填）。 */
  agentId: string | null;
  disabled?: boolean;
  isSessionStreaming?: boolean;
  allowFiles?: boolean;
  agentDisplayName?: string;
  placeholder?: string;
  /** 切换会话时恢复的草稿文本（v0.7.3 需求2-A6）。 */
  initialDraft?: string;
  /** 输入历史的作用域（项目维度；空则禁用历史导航）。 */
  historyScope?: string | null;
  /** 斜杠命令清单（A2）：行首 `/` 触发，available=false 的命令不显示。 */
  /** 需求7 补充：mode=insert（pi 动态命令）——面板选中后插入 `/name `
   * 到输入框由用户补参再发送（pi prompt 通道原生路由扩展命令/模板展开），
   * 不清空草稿不回调；缺省 run=hub 本地执行（builtin 子集/GUI 特有）。 */
  slashCommands?: Array<{
    name: string;
    label: string;
    available: boolean;
    mode?: "run" | "insert";
  }>;
  /** 斜杠命令执行回调：命令面板选中后调用，输入框自动清空。 */
  onSlashCommand?: (name: string) => void;
  /** 渲染在发送按钮左侧同一行的控件（v0.7.3 需求2：模型选择器+水位圆环）。 */
  trailingControls?: ReactNode;
  onDraftChange?: (value: string) => void;
  onBeforeSend?: (message: string) => Promise<boolean | void> | boolean | void;
  prepareMessageForAgent?: (message: string) => Promise<string> | string;
  onMessageSent?: (chatSessionId: string, userMessage: string, toolIds?: string[]) => void;
  onSessionResolved?: (pendingSessionId: string, realSessionId: string) => void | Promise<void>;
  onSubmitMessage?: (message: string) => Promise<{ sessionId?: string } | void>;
  containerClassName?: string;
  panelClassName?: string;
  contextFooter?: ReactNode;
  workModeLabel?: string;
  workModeOptions?: Array<{ value: string; label: string }>;
  workModeValue?: string;
  onWorkModeChange?: (value: string) => void | Promise<void>;
  /** 需求2 追加：任务不询问模式（任务模式下显示开关——开启后 agent 不再
   * 提问，全部按推荐执行）。 */
  taskNoAsk?: boolean;
  onTaskNoAskChange?: (enabled: boolean) => void;
  accessModeLabel?: string;
  accessModeTitle?: string;
  accessModeReadOnly?: boolean;
  accessModeOptions?: Array<{ value: string; label: string; description?: string }>;
  accessModeValue?: string;
  onAccessModeChange?: (value: string) => void | Promise<void>;
  interactionRequest?: ConversationInteractionRequest | null;
  onInteractionSubmit?: (submission: ConversationInteractionSubmission) => void | Promise<void>;
  /** Called when user clicks "guide" on a staged message during streaming.
   *  For Jishu Agent: steer. For others: parent should stop + send. */
  onGuideStaged?: (content: string, toolIds?: string[]) => Promise<void>;
  /** Called when the user clicks the Stop button and the session is aborted. */
  onAbort?: () => void;
  /** When provided, the parent can auto-send staged guides at turn_complete
   *  (Route 2) and share the claimed-id dedup. */
  stagedApiRef?: React.MutableRefObject<StagedGuideApi | null>;
  /** v0.9.8 需求6：空会话（新对话起始态）时展示场景联动建议条——按引导
   *  选择的场景推荐「已装未挂」工具，点击注入 pill。仅默认工作空间生效。 */
  showSceneSuggest?: boolean;
}

function isInsideProject(filePath: string, projectPath: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").toLowerCase();
  const normProject = projectPath.replace(/\\/g, "/").toLowerCase();
  return normFile.startsWith(normProject.endsWith("/") ? normProject : normProject + "/");
}

/** v0.9.1 需求3 #1：ChatInput 命令句柄——focus 沿用原 textarea 转发语义；
 * restoreTexts 供 chat-page 在收到 steer_queue_cleared（停止清队）时把被清空
 * 的排队文本追加回草稿，不打字丢失。setText（需求9 #8）为替换语义——
 * 预填场景（创建插件/流水线）用：旧草稿+新预填追加会累积两份。 */
export interface ChatInputHandle {
  focus: () => void;
  restoreTexts: (texts: string[]) => void;
  setText: (text: string) => void;
}

const ChatInputBase = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput({
  sessionId,
  projectPath,
  agentId,
  showSceneSuggest = false,
  disabled = false,
  isSessionStreaming: isSessionStreamingProp = false,
  allowFiles = true,
  agentDisplayName,
  placeholder: placeholderOverride,
  initialDraft,
  historyScope,
  slashCommands,
  onSlashCommand,
  trailingControls,
  onDraftChange,
  onBeforeSend,
  prepareMessageForAgent,
  onMessageSent,
  onSessionResolved,
  onSubmitMessage,
  containerClassName,
  panelClassName,
  contextFooter,
  workModeLabel,
  workModeOptions = [],
  workModeValue,
  onWorkModeChange,
  taskNoAsk,
  onTaskNoAskChange,
  accessModeLabel,
  accessModeTitle,
  accessModeReadOnly = true,
  accessModeOptions = [],
  accessModeValue,
  onAccessModeChange,
  interactionRequest = null,
  onInteractionSubmit,
  onGuideStaged,
  onAbort,
  stagedApiRef,
}: ChatInputProps, ref) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  // v0.9.1 需求3 #1：命令句柄的 fresh mirror——restoreTexts 经 useImperativeHandle
  // 空依赖暴露，须读最新草稿而非挂载期闭包值。
  const messageRef = useRef(message);
  messageRef.current = message;
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [interactionSubmitting, setInteractionSubmitting] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  // 需求20 第二轮：+ 菜单两级——MCP 服务 / Skill 子菜单展开态（null = 收起）。
  // v0.9.8 需求5（归需求7 补充）：extension=已装 pi 扩展子菜单。
  const [toolSubmenu, setToolSubmenu] = useState<"mcp" | "skill" | "extension" | null>(null);
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [stagedMessagesBySession, setStagedMessagesBySession] = useState<Record<string, StagedMessage[]>>({});
  // v0.8.1 需求7：会话工具插件（+[菜单] 列表 + token 归一依据）。
  const [sessionTools, setSessionTools] = useState<SessionTool[]>([]);
  const [guideLoading, setGuideLoading] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // v0.9.1 需求4 测试期修复二：输入框根容器——高度等比伸缩的宽度基准测量点。
  const inputRootRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stagingSessionKey = sessionId ?? "__new_session__";
  const stagedMessages = stagedMessagesBySession[stagingSessionKey] ?? [];
  // Single source of truth for "this staged message was already claimed/sent".
  // Mutated SYNCHRONOUSLY before any await by BOTH routes (manual guide here,
  // auto-send via stagedApiRef in the parent), so whichever claims first wins
  // and the other short-circuits — exactly-once across the race window.
  const claimedStagedIdsBySessionRef = useRef<Map<string, Set<string>>>(new Map());
  // ── 输入历史（v0.7.3 需求2-A6）──────────────────────────────────────────
  // historyPos：null = 不在历史浏览；数字 = 当前指向的历史下标。
  // 浏览前的输入文本存 ref，Down 回到底部或用户编辑时恢复。
  const [historyPos, setHistoryPos] = useState<number | null>(null);
  const draftBeforeHistoryRef = useRef("");
  const historyListRef = useRef<string[]>([]);
  historyListRef.current = getInputHistory(historyScope);

  // 切换会话时恢复该会话的草稿（此前行为是残留上一会话的文本，改为按会话恢复）。
  // 初始挂载也走此路径；initialDraft 仅在 sessionId 变化时读取，避免父组件
  // 每次 render 的新字符串导致输入被意外重置。
  const initialDraftRef = useRef(initialDraft);
  initialDraftRef.current = initialDraft;
  useEffect(() => {
    setHistoryPos(null);
    setMessage(initialDraftRef.current ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── 输入建议（A2 斜杠命令 + A1 @ 文件引用）───────────────────────────────
  // slashFilter：行首 "/" 且未出现空白时激活命令面板；
  // atToken：光标前最近的 @ token（@ 前须为行首/空白）激活文件补全。
  const [slashFilter, setSlashFilter] = useState<string | null>(null);
  const [atToken, setAtToken] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const atActive = atToken !== null && allowFiles;
  const projectFiles = useProjectFiles(projectPath, atActive);

  const slashFilterText = slashFilter ?? "";
  const slashItems = (slashCommands ?? []).filter(
    (cmd) =>
      cmd.available &&
      (slashFilterText === "" ||
        cmd.name.toLowerCase().includes(slashFilterText.toLowerCase()) ||
        cmd.label.toLowerCase().includes(slashFilterText.toLowerCase())),
  );
  const fileItems = atToken !== null ? fuzzyRank(atToken, projectFiles, (f) => f, 12) : [];
  const suggestionsActive = slashFilter !== null ? slashItems.length > 0 : fileItems.length > 0;

  const closeSuggestions = useCallback(() => {
    setSlashFilter(null);
    setAtToken(null);
    setSuggestIndex(0);
  }, []);

  const updateSuggestions = useCallback(
    (value: string, caret: number) => {
      // 斜杠：行首 / 开头且尚无空白（不支持参数，输入空格即关闭）
      if (value.startsWith("/") && !/\s/.test(value)) {
        setSlashFilter(value.slice(1));
        setAtToken(null);
        setSuggestIndex(0);
        return;
      }
      setSlashFilter(null);
      // @ 文件（v0.9.0 需求10：行中触发——@ 前是非 ASCII 词字符即可，中文
      // 语句中间 @ 可用；邮箱/路径保护与关闭条件见 at-file.ts 规则单点）。
      if (!allowFiles) {
        setAtToken(null);
        return;
      }
      const token = detectAtToken(value.slice(0, caret));
      if (token !== null) {
        setAtToken(token);
        setSuggestIndex(0);
      } else {
        setAtToken(null);
      }
    },
    [allowFiles],
  );

  const commitSlash = useCallback(
    (name: string) => {
      // 需求7 补充：pi 动态命令（insert）——替换行首 "/filter" 为 "/name "
      // 保留其余草稿，用户补参后正常发送（pi 端 prompt 原生展开/执行）。
      const entry = slashCommands?.find((c) => c.name === name);
      if (entry?.mode === "insert") {
        closeSuggestions();
        const token = `/${name} `;
        setMessage((prev) => {
          // 截掉行首 "/" + 当前过滤串，替换为 "/name "（保留其余草稿）。
          const next = slashFilter !== null && prev.startsWith("/")
            ? prev.slice(0, Math.max(0, prev.length - slashFilter.length - 1)) + token
            : prev + token;
          onDraftChange?.(next);
          return next;
        });
        return;
      }
      closeSuggestions();
      setMessage("");
      onDraftChange?.("");
      onSlashCommand?.(name);
    },
    [closeSuggestions, onDraftChange, onSlashCommand, slashCommands, slashFilter],
  );

  const commitFile = useCallback(
    (relPath: string) => {
      const textarea = textareaRef.current;
      const caret = textarea?.selectionStart ?? message.length;
      const beforeCaret = message.slice(0, caret);
      const atIdx = beforeCaret.lastIndexOf("@");
      if (atIdx < 0) {
        closeSuggestions();
        return;
      }
      const basename = relPath.split("/").pop() || relPath;
      const next =
        message.slice(0, atIdx) + basename + message.slice(caret);
      closeSuggestions();
      setMessage(next);
      onDraftChange?.(next);
      // 复用既有附件管线：项目内文件以路径引用（发送时拼 JISHU_HUB_IMAGES 块）
      if (projectPath) {
        const localPath = `${projectPath.replace(/[\\/]+$/, "")}/${relPath}`;
        setFiles((prev) => {
          if (prev.some((f) => f.localPath?.replace(/\\/g, "/").toLowerCase() === localPath.replace(/\\/g, "/").toLowerCase())) {
            return prev;
          }
          const ext = basename.includes(".") ? basename.split(".").pop()!.toLowerCase() : "";
          const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
          return [
            ...prev,
            {
              id: `at-${Date.now()}`,
              data: "",
              filename: basename,
              label: basename.replace(/\.\w+$/, ""),
              isImage: imageExts.has(ext),
              localPath,
            },
          ];
        });
      }
      requestAnimationFrame(() => {
        const pos = atIdx + basename.length;
        textarea?.setSelectionRange(pos, pos);
        textarea?.focus();
      });
    },
    [closeSuggestions, message, onDraftChange, projectPath],
  );
  // Always-fresh mirror of the ENTIRE stagedMessagesBySession map so the
  // stagedApiRef methods (set up once) can target ANY session's staging array
  // by key — not just the currently-viewed session. This is what lets Route 2
  // auto-send a background session's staged guides when its turn completes
  // while the user is viewing a different conversation.
  const stagedBySessionRef = useRef<Record<string, StagedMessage[]>>(stagedMessagesBySession);
  stagedBySessionRef.current = stagedMessagesBySession;

  const claimedIdsForSession = useCallback((key: string) => {
    let ids = claimedStagedIdsBySessionRef.current.get(key);
    if (!ids) {
      ids = new Set<string>();
      claimedStagedIdsBySessionRef.current.set(key, ids);
    }
    return ids;
  }, []);

  const setStagedMessagesForSession = useCallback((key: string, updater: StagedMessageUpdater) => {
    setStagedMessagesBySession((prev) => {
      const current = prev[key] ?? [];
      const next = typeof updater === "function" ? updater(current) : updater;
      if (next.length === 0) {
        if (!(key in prev)) return prev;
        const rest = { ...prev };
        delete rest[key];
        return rest;
      }
      return { ...prev, [key]: next };
    });
  }, []);

  const setCurrentStagedMessages = useCallback((updater: StagedMessageUpdater) => {
    setStagedMessagesForSession(stagingSessionKey, updater);
  }, [setStagedMessagesForSession, stagingSessionKey]);

  // v0.8.1 需求7：按会话加载工具插件启用集（M0 修复：键 = 会话身份
  // stagingSessionKey——此前误用 activeSessionId（流式中止引用，每轮流结束
  // 必被置 null），导致切会话不刷新、写入全部落到暂存键）。
  // Array.isArray 防御：测试/异常环境下后端返回形状不符时不炸渲染。
  useEffect(() => {
    let cancelled = false;
    invokeCommand<SessionTool[]>("session_tool_list", { sessionId: stagingSessionKey })
      .then((tools) => {
        if (!cancelled) setSessionTools(Array.isArray(tools) ? tools : []);
      })
      .catch(() => {
        if (!cancelled) setSessionTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [stagingSessionKey]);

  // ── v0.9.8 需求5（合并版，原需求6 重写）：输入框装备建议条 ──────────────
  // 新对话起始态：任务信号驱动的装备推荐（静态场景字段三守卫退役——存量
  // 用户零可见的根因）。数据源分级（设计 §4.2）：
  //   L1 最近任务画像（task_profiles）→ L0 输入草稿关键词 ∩ 标签库
  //   → 都空回落官方入门推荐（stars 排序 top3）。
  // 条目两类：未装件（点击出浮卡：星级+描述+安装钮，meta.via=input-bar）
  // + 已装未挂件（curated 非 required ∩ sessionTools 可注入 → @[注入]）。
  // 配置闸：总开关 + input_bar 链路开关；× 关闭落 settings 持久化。
  const [sceneSuggest, setSceneSuggest] = useState<{
    origin: "workspace" | "profile" | "draft" | "fallback";
    originNote?: string;
    installItems: Array<{ ref: string; title: string; stars: number; kind?: string; description?: string }>;
    mountItems: Array<{ id: string; title: string }>;
  } | null>(null);
  // 草稿 debounce 快照（L0 用；避免每个按键触发重算）。
  const [draftSnapshot, setDraftSnapshot] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDraftSnapshot(message), 400);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!showSceneSuggest) {
      setSceneSuggest(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [dismissed, config] = await Promise.all([
          invokeCommand<boolean>("get_scene_suggest_dismissed").catch(() => false),
          fetchEquipConfig(),
        ]);
        if (cancelled || dismissed || !config.enabled || !config.input_bar) {
          setSceneSuggest(null);
          return;
        }
        // 目录合并 + 已装态（派生态现场交叉算）。
        const [curated, tagRows, pluginList, skillInstalled, piSources, profile, wsScene] = await Promise.all([
          invokeCommand<Array<{ id: string; kind: string; title: string; description: string; required: boolean; tags?: string[]; stars?: number }>>(
            "market_list_curated",
            { scene: null },
          ).catch(() => []),
          fetchEquipmentTags(),
          invokeCommand<{ plugins: Array<{ id: string }> }>("plugin_list").catch(() => null),
          invokeCommand<Record<string, string>>("skillhub_installed").catch(() => ({})),
          invokeCommand<string[]>("pi_package_installed_sources").catch(() => []),
          fetchLatestProfile(),
          projectPath ? fetchWorkspaceScene(projectPath) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        const installedRefs = new Set<string>();
        for (const p of pluginList?.plugins ?? []) installedRefs.add(`curated:${p.id}`);
        for (const slug of Object.keys(skillInstalled ?? {})) installedRefs.add(`skillhub:${slug}`);
        for (const src of piSources ?? []) {
          const at = src.lastIndexOf("@");
          installedRefs.add(`pi:${at > 0 ? src.slice(0, at) : src}`);
        }
        const catalog = buildCatalog(curated ?? [], tagRows);
        const input = { catalog, installedRefs, officialOnly: !config.third_party };
        // 分级（用户裁决「按项目定位」）：工作区场景（本地零推理，冷启动
        // 即有——代码目录推编程件）→ L1 画像 → L0 草稿 → 官方入门回落。
        let origin: "workspace" | "profile" | "draft" | "fallback" = "fallback";
        let hits = profile ? matchByProfile(profile, input, 3) : [];
        if (hits.length >= 2) {
          origin = "profile";
        } else if (wsScene) {
          const scenePicks = matchByWorkspaceScene(wsScene.scene, input, 3);
          if (scenePicks.length > 0) {
            origin = "workspace";
            hits = scenePicks.map((entry) => ({ entry, score: entry.stars, hitTags: [] }));
          }
        }
        if (origin === "fallback") {
          hits = matchByTags(draftSnapshot, input, 3);
          if (hits.length > 0) origin = "draft";
        }
        const installItems =
          hits.length > 0
            ? hits.map((h) => ({
                ref: h.entry.ref,
                title: h.entry.title,
                stars: h.entry.stars,
                kind: h.entry.kind,
                description: h.entry.description,
              }))
            : officialFallback(input, 3).map((e) => ({
                ref: e.ref,
                title: e.title,
                stars: e.stars,
                kind: e.kind,
                description: e.description,
              }));
        // 已装未挂：curated 非 required ∩ 可注入 sessionTools（点击 @[注入]）。
        // 不按 enabled 过滤：那是「本会话是否已挂载」选中态，未挂恰是建议对象。
        const mountItems = (curated ?? [])
          .filter((c) => !c.required)
          .filter((c) => sessionTools.some((t) => t.id === c.id && t.injectable !== false))
          .slice(0, 2)
          .map((c) => ({ id: c.id, title: c.title }));
        if (installItems.length === 0 && mountItems.length === 0) {
          setSceneSuggest(null);
          return;
        }
        if (!cancelled) {
          setSceneSuggest({
            origin,
            originNote:
              origin === "profile"
                ? profile?.keywords.slice(0, 3).join(" / ")
                : origin === "workspace"
                  ? wsScene?.basis.slice(0, 2).join(" / ")
                  : undefined,
            installItems,
            mountItems,
          });
          devLog(
            "capability",
            `equip-suggest ${origin}: install=${installItems.map((i) => i.ref).join(",")} mount=${mountItems.map((i) => i.id).join(",")}`,
          );
        }
      } catch {
        if (!cancelled) setSceneSuggest(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // sessionTools 后到（会话工具清单异步装载）+ 草稿快照变化重算 L0
    // + 工作区切换（projectPath）重算场景。
  }, [showSceneSuggest, projectPath, sessionTools, draftSnapshot]);

  const handleDismissSceneSuggest = useCallback(() => {
    setSceneSuggest(null);
    invokeCommand("set_scene_suggest_dismissed", { value: true }).catch(() => {});
  }, []);

  // 未装件浮卡（点击建议条胶囊展开：星级+描述+安装）。
  const [suggestPopover, setSuggestPopover] = useState<{ ref: string; title: string; stars: number; kind?: string; description?: string } | null>(null);
  const [suggestInstalling, setSuggestInstalling] = useState(false);
  const handleSuggestInstall = useCallback(async (item: { ref: string; title: string }) => {
    setSuggestInstalling(true);
    try {
      const target = installCommandFor(item.ref);
      if (target) {
        await invokeCommand(target.command, { ...target.args, meta: { via: "input-bar", title: item.title } });
        setSuggestPopover(null);
        // 装成即从建议条摘除该件（下次重算自然刷新）。
        setSceneSuggest((prev) =>
          prev ? { ...prev, installItems: prev.installItems.filter((i) => i.ref !== item.ref) } : prev,
        );
      }
    } catch {
      // 失败保留浮卡（用户可重试）；错误展示从简——安装链已有完整反馈面。
    } finally {
      setSuggestInstalling(false);
    }
  }, []);

  /** 在光标处插入 `@[显示名] ` token（+ 菜单点击入口）。 */
  const insertToolToken = useCallback((displayName: string) => {
    const textarea = textareaRef.current;
    const token = `@[${displayName}] `;
    if (!textarea) {
      setMessage((prev) => prev + token);
      return;
    }
    const caret = textarea.selectionStart ?? message.length;
    const next = message.slice(0, caret) + token + message.slice(caret);
    setMessage(next);
    onDraftChange?.(next);
    requestAnimationFrame(() => {
      const pos = caret + token.length;
      textarea.setSelectionRange(pos, pos);
      textarea.focus();
    });
  }, [message, onDraftChange]);

  /** v0.9.1 需求4 修复五（重构，取代修复四的运行时同步）：「外滚内长」——
   * 固定高度的滚动容器（inputScrollRef）内，mirror（in-flow 撑起内容高度）
   * 与 textarea（absolute 覆盖同几何、自身 overflow hidden 永不内部滚动）随
   * 同一条滚动条整体滚动。两层对齐由 DOM 构造保证，无需 scrollTop/滚动条
   * 占宽逐项同步（修复四的同步方案在 WebView2 下滚动后仍出现两层视口错位
   * 重影，用户 2026-09-05 二次实测）。 */
  const inputScrollRef = useRef<HTMLDivElement>(null);
  /** mirror（in-flow 文本层）引用——撑高量测基准（见 syncProportionalInputHeight）。 */
  const inputMirrorRef = useRef<HTMLDivElement>(null);

  /** v0.9.1 需求4 测试期修复二/六：输入框高度随宽度等比伸缩——基准：初始
   * 内容宽 820px ↔ 空态高 76px；宽度自适应（70%）后高度同比变高（用户裁决：
   * 保持初始宽高比）；窄于基准不缩。
   *
   * 修复六（用户 2026-09-06 新裁决，取代修复四"恒定高度"）：内容可撑高
   * 输入框，但有**约 11 行文字**的高度上限——超出上限才内部滚动；发送后
   * 消息清空即回到初始高度。高度 = clamp(mirror 内容高, 76×scale 地板,
   * (11×20+24)×scale 上限)：20px = text-sm 行高（1.25rem），24 = mirror
   * 自身 py-3 上下 padding。量高用 mirror.offsetHeight（真实文本层）——
   * 不能用 scroller.scrollHeight（≥ clientHeight，收缩时读不出更小值，
   * 撑高后删行就缩不回去了）。
   *
   * 宽度守卫（修复三）：写高度会改变容器尺寸、再次触发 ResizeObserver——
   * 回声通知宽度未变，跳过即断开回环（否则浏览器报「ResizeObserver loop
   * completed with undelivered notifications」）；内容驱动路径（键入/粘贴/
   * 回填/发送清空，经 [message] effect）传 force 绕过守卫。 */
  const lastProportionalWidthRef = useRef(0);
  const syncProportionalInputHeight = useCallback((options?: { force?: boolean }) => {
    const root = inputRootRef.current;
    const scroller = inputScrollRef.current;
    const mirror = inputMirrorRef.current;
    if (!root || !scroller) return;
    const width = root.clientWidth;
    if (width <= 0) return;
    if (!options?.force && width === lastProportionalWidthRef.current) return;
    lastProportionalWidthRef.current = width;
    const scale = Math.max(1, width / 820);
    const minH = Math.round(76 * scale);
    const maxH = Math.round((11 * 20 + 24) * scale);
    const contentH = mirror?.offsetHeight ?? 0;
    const h = Math.max(minH, Math.min(contentH, maxH));
    scroller.style.height = `${h}px`;
    scroller.style.minHeight = `${minH}px`;
    scroller.style.maxHeight = `${maxH}px`;
  }, []);

  /** 内容变化即时重算高度：键入/粘贴/回填/发送清空统一入口——发送后
   * message 归空，mirror 塌回 padding 高度，高度落回地板即"恢复初始高度"。 */
  useEffect(() => {
    syncProportionalInputHeight({ force: true });
  }, [message, syncProportionalInputHeight]);

  /** 键入/回填后跟随光标：光标在末尾（常见键入与停止回填场景）滚到底；
   * 中间位置不打断用户滚轮（textarea 全内容高度、自身不滚，光标定位由
   * 用户滚动控制）。 */
  const scrollInputCaretIntoView = useCallback(() => {
    const scroller = inputScrollRef.current;
    const textarea = textareaRef.current;
    if (!scroller || !textarea) return;
    if ((textarea.selectionStart ?? 0) >= textarea.value.length - 1) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  // 容器宽度变化（窗口缩放/最大化/侧栏开合）即时重算；挂载时先同步一次。
  // RO 回调走宽度守卫（自身写高度引发的回声通知宽度未变，跳过断开回环）。
  useEffect(() => {
    const root = inputRootRef.current;
    if (!root) return;
    syncProportionalInputHeight();
    const observer = new ResizeObserver(() => syncProportionalInputHeight());
    observer.observe(root);
    return () => observer.disconnect();
  }, [syncProportionalInputHeight]);

  /** M2：+ 菜单勾选切换会话启用集（会话级真源；乐观更新 + 失败回滚提示，
   * 不再静默吞错）。key 与发送同源（stagingSessionKey——新会话勾选落暂存
   * 键，首条消息由后端 compose 前迁移到会话键）。 */
  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      // v0.9.1 需求3 #1：停止清队回填——被清空的排队文本追加到草稿尾部
      // （多条换行拼接），同步草稿持久化（onDraftChange）并聚焦、光标置末。
      restoreTexts: (texts: string[]) => {
        const addition = texts.filter((text) => text.trim().length > 0).join("\n");
        if (!addition) return;
        const current = messageRef.current;
        const next = current.trim().length > 0 ? `${current}\n${addition}` : addition;
        messageRef.current = next;
        setMessage(next);
        onDraftChange?.(next);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          const pos = next.length;
          textarea.setSelectionRange(pos, pos);
          textarea.focus();
          // 程序性回填（末尾）后滚动容器跟到底，尾部可见（修复五结构）。
          scrollInputCaretIntoView();
        });
      },
      // 需求9 #8：替换语义回填——预填专用（restoreTexts 追加语义保留给停止
      // 清队回填），同步草稿持久化避免 localStorage 旧草稿闭环再混入。
      setText: (text: string) => {
        const next = text;
        messageRef.current = next;
        setMessage(next);
        onDraftChange?.(next);
        if (!next) return;
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          const pos = next.length;
          textarea.setSelectionRange(pos, pos);
          textarea.focus();
          scrollInputCaretIntoView();
        });
      },
    }),
    [onDraftChange, scrollInputCaretIntoView],
  );

  // Expose the staging-area lifecycle to the parent (Route 2: auto-send at
  // turn_complete). Set up ONCE on mount; methods take an explicit sessionKey
  // and read live refs so they always target the right session — including a
  // background session whose turn completed while the user views another.
  useEffect(() => {
    if (!stagedApiRef) return;
    stagedApiRef.current = {
      claimAll: (sessionKey: string) => {
        const claimedIds = claimedIdsForSession(sessionKey);
        const staged = stagedBySessionRef.current[sessionKey] ?? [];
        const unclaimed = staged.filter((m) => !claimedIds.has(m.id));
        for (const m of unclaimed) claimedIds.add(m.id);
        setStagedMessagesForSession(sessionKey, []);
        return unclaimed;
      },
      restore: (sessionKey: string, messages: StagedMessage[]) => {
        const claimedIds = claimedIdsForSession(sessionKey);
        for (const m of messages) claimedIds.delete(m.id);
        // 需求11 #2 逐条发送：放回=保序插回**队首**（领取时的原序在前，
        // 失败回滚与「发一条放回剩余」都不被打乱；期间新暂存的排其后）。
        setStagedMessagesForSession(sessionKey, (prev) => [...messages, ...prev]);
      },
    };
  }, [claimedIdsForSession, setStagedMessagesForSession, stagedApiRef]);

  // Derive whether current session is streaming (per-session, parallel-safe)
  const isOwnStreaming = useIsSessionStreaming(sessionId);
  const isOwnAbortStreaming = useIsSessionStreaming(activeSessionId);
  const isStreaming = isSessionStreamingProp || isOwnStreaming || isOwnAbortStreaming;

  // Reset sending state when stream finishes for this session
  useEffect(() => {
    if (!isStreaming && sending) {
      setSending(false);
      setActiveSessionId(null);
    }
  }, [isStreaming, sending]);

  // When the user switches to a different session, clear the local "active" abort
  // reference so the Stop button targets the new session, not the previous send.
  // Also reset the claimed-id dedup set — claimed ids are UUIDs unique to the
  // prior session's staged messages and no longer relevant.
  useEffect(() => {
    setActiveSessionId(null);
  }, [sessionId]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      setToolMenuOpen(false);
      setWorkModeMenuOpen(false);
      setAccessMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const placeholder = placeholderOverride ?? (
    files.length === 0
      ? t("sessions.chatPlaceholder")
      : files.length === 1
        ? t("sessions.chatPlaceholderSingleFile", { agent: agentDisplayName ?? t("sessions.currentAgent") })
        : t("sessions.chatPlaceholderMultiFile")
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!allowFiles) return;
      const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
      const items = e.clipboardData.items;
      const osFiles = e.clipboardData.files;

      // 1. OS file copy (Windows: files appear in clipboardData.files, not items)
      if (osFiles && osFiles.length > 0) {
        let hasNonText = false;
        for (let i = 0; i < items.length; i++) {
          if (!items[i].type.startsWith("text/")) { hasNonText = true; break; }
        }
        if (!hasNonText) {
          e.preventDefault();
          // Get actual file paths from system clipboard via backend
          invokeCommand<string[]>("get_clipboard_file_paths").then((clipPaths) => {
            const newFiles: AttachedFile[] = [];
            Array.from(osFiles).forEach((file, i) => {
              const filename = file.name || `file-${i + 1}`;
              const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
              const isImage = imageExts.has(ext) || file.type.startsWith("image/");
              const idx = files.length + i + 1;

              // Match clipboard path by filename
              const clipPath = clipPaths?.find((p) => {
                const clipName = p.replace(/\\/g, "/").split("/").pop();
                return clipName === filename;
              });

              if (clipPath && projectPath && isInsideProject(clipPath, projectPath)) {
                // Project-local file: reference path directly, no base64 needed
                newFiles.push({
                  id: `paste-${Date.now()}-${i}`,
                  data: "",
                  filename,
                  label: isImage ? t("projects.imageLabel", { index: idx }) : filename.replace(/\.\w+$/, ""),
                  isImage,
                  localPath: clipPath,
                });
              } else {
                // External file or unknown path: read base64
                const reader = new FileReader();
                reader.onload = () => {
                  const base64 = (reader.result as string).split(",")[1];
                  const entry: AttachedFile = {
                    id: `paste-${Date.now()}-${i}`,
                    data: base64,
                    filename,
                    label: isImage ? t("projects.imageLabel", { index: idx }) : filename.replace(/\.\w+$/, ""),
                    isImage,
                  };
                  if (clipPath) entry.localPath = clipPath;
                  setFiles((prev) => [...prev, entry]);
                };
                reader.readAsDataURL(file);
                return; // skip push below, handled in async callback
              }

              setFiles((prev) => [...prev, ...newFiles.splice(0)]);
            });

            // Push any remaining local files that were added synchronously
            if (newFiles.length > 0) {
              setFiles((prev) => [...prev, ...newFiles]);
            }
          }).catch(() => {
            // Fallback: read as base64 without path detection
            const newFiles: AttachedFile[] = [];
            Array.from(osFiles).forEach((file, i) => {
              const filename = file.name || `file-${i + 1}`;
              const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
              const isImage = imageExts.has(ext) || file.type.startsWith("image/");
              const idx = files.length + i + 1;
              const reader = new FileReader();
              reader.onload = () => {
                const base64 = (reader.result as string).split(",")[1];
                newFiles.push({
                  id: `paste-${Date.now()}-${i}`,
                  data: base64,
                  filename,
                  label: isImage ? t("projects.imageLabel", { index: idx }) : filename.replace(/\.\w+$/, ""),
                  isImage,
                });
                if (newFiles.length === osFiles.length) {
                  setFiles((prev) => [...prev, ...newFiles]);
                }
              };
              reader.readAsDataURL(file);
            });
          });
          return;
        }
      }

      // 2. Blob-based paste (screenshots, image copies from browser, etc.)
      const newFiles: AttachedFile[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("text/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(",")[1];
          const idx = files.length + newFiles.length + 1;
          const isImage = file.type.startsWith("image/");
          newFiles.push({
            id: `paste-${Date.now()}-${i}`,
            data: base64,
            filename: file.name || (isImage ? `pasted-image-${idx}.png` : `pasted-file-${idx}`),
            label: isImage ? t("projects.imageLabel", { index: idx }) : (file.name || `文件${idx}`).replace(/\.\w+$/, ""),
            isImage,
          });
          setFiles((prev) => [...prev, ...newFiles.splice(0)]);
        };
        reader.readAsDataURL(file);
      }
    },
    [allowFiles, files.length, projectPath, t]
  );

  const handleFileSelect = async () => {
    if (!allowFiles || !projectPath || disabled || sending || isStreaming) return;
    const selected = await open({ multiple: true, directory: false });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];

    const newFiles: AttachedFile[] = paths.map((filePath, i) => {
      const filename = filePath.replace(/\\/g, "/").split("/").pop() || "file";
      const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
      const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
      const isImage = imageExts.has(ext);
      const local = isInsideProject(filePath, projectPath);
      const idx = files.length + i + 1;

      return {
        id: `file-${Date.now()}-${i}`,
        data: local ? "" : "",  // will be filled below if needed
        filename,
        label: isImage ? t("projects.imageLabel", { index: idx }) : filename.replace(/\.\w+$/, ""),
        isImage,
        localPath: local ? filePath : undefined,
      };
    });

    // For external files, read base64 via backend command
    for (let i = 0; i < newFiles.length; i++) {
      if (!newFiles[i].localPath) {
        try {
          const base64 = await invokeCommand<string>("read_file_as_base64", { path: paths[i] });
          newFiles[i].data = base64;
        } catch {
          newFiles[i].data = "";
        }
      }
    }

    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleLabelChange = (id: string, label: string) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, label } : f)));
  };

  const handleRemoveFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  // 发送目标会话 id（M0 修复：与 sendPreparedMessage 同源——续聊用真实
  // sessionId，新会话用 pending-<ts>；调用方先算好传入，保证工具集写入键
  // 与 send_message 携带的 sessionId 严格一致，不再各算各的）。
  const nextPendingId = useCallback(
    () => sessionId || `pending-${Date.now()}`,
    [sessionId],
  );

  /** M5 → v0.9.0 需求3 方案 C：发送/引导共用的消息组装（单源）。用户裁决保持
   * workbuddy 形态：本条消息里的 @[token] 集合 = 本条工具集（所见即所得，空
   * token = 本条不带工具，覆盖写入会话集合）。消息文本不再嵌 [JISHU-TOOLS]
   * 标记——工具快照以 toolIds 返回值显式传递（流式渲染/引导占位用），回放
   * 由后端从注入块派生（extract_tool_snapshot）。任何新增的用户消息出口
   * 必须走这里（§16.8 组装单源）。 */
  // v0.9.4 需求8 补充（用户实测：steer 带附件/图片丢失）：附件上传管线
  // 提取共用——普通发送与引导暂存（steering）同源。返回文件标记行
  //（批次/路径引用，模型经 Read 工具查看），空数组表示无附件。
  const saveInputFiles = useCallback(
    async (inputFiles: AttachedFile[]): Promise<string[]> => {
      if (!projectPath || inputFiles.length === 0) return [];
      const localFiles = inputFiles.filter((f) => f.localPath && projectPath && isInsideProject(f.localPath, projectPath));
      const externalPathFiles = inputFiles.filter((f) => f.localPath && !(projectPath && isInsideProject(f.localPath, projectPath)));
      const uploadFiles = inputFiles.filter((f) => !f.localPath);
      const allFileLines = [];
      for (const f of localFiles) {
        allFileLines.push(`${f.label}: ${f.localPath}`);
      }
      const filesToUpload = [...uploadFiles, ...externalPathFiles];
      if (filesToUpload.length > 0) {
        for (const f of externalPathFiles) {
          if (!f.data && f.localPath) {
            try {
              f.data = await invokeCommand("read_file_as_base64", { path: f.localPath });
            } catch { f.data = ""; }
          }
        }
        const payload = filesToUpload.map((f) => ({
          data: f.data,
          filename: f.filename,
          label: f.label || null,
        }));
        const saved = await invokeCommand<SavedFile[]>("save_session_files", {
          projectPath,
          // v0.9.7 需求5 E5：默认空间上传按会话分目录（新会话首传为 null，
          // 后端沿平铺——首条消息带附件先于会话创建）。
          sessionId: sessionId ?? null,
          files: payload,
        });
        for (const sv of saved) {
          allFileLines.push(`${sv.label}（批次 ${sv.batch_id}）: ${sv.path}`);
        }
      }
      return allFileLines;
    },
    [projectPath, sessionId],
  );

  const composeOutgoing = useCallback(
    async (rawText: string): Promise<{ message: string; sessionKey: string; toolIds: string[] }> => {
      const sessionKey = nextPendingId();
      const hasTokens = TOOL_TOKEN_RE.test(rawText);
      TOOL_TOKEN_RE.lastIndex = 0;
      if (!hasTokens && !sessionTools.some((t) => t.enabled)) {
        return { message: rawText, sessionKey, toolIds: [] };
      }
      const { text: strippedText, toolIds } = extractToolTokens(rawText, sessionTools);
      try {
        await invokeCommand("session_set_tools", { sessionId: sessionKey, toolIds });
        setSessionTools((prev) =>
          prev.map((t) => ({ ...t, enabled: toolIds.includes(t.id) })),
        );
      } catch (err) {
        // 写入失败不阻塞发送（消息照发，仅本条不注入）；用户可从控制台
        // 警告与「工具没生效」的现象回溯——阻塞会导致普通消息也发不出。
        console.warn("Failed to sync session tools:", err);
      }
      return { message: strippedText, sessionKey, toolIds };
    },
    [nextPendingId, sessionTools],
  );

  const sendPreparedMessage = async (
    fullMessage: string,
    clearComposer: boolean,
    pendingIdOverride?: string,
    toolIds?: string[],
  ) => {
    if (!projectPath) {
      throw new Error("project path is required");
    }

    const handled = await onBeforeSend?.(fullMessage);
    if (handled) {
      if (clearComposer) {
        setMessage("");
        onDraftChange?.("");
        setFiles([]);
      }
      setSending(false);
      setActiveSessionId(null);
      return;
    }

    const pendingId = pendingIdOverride ?? (sessionId || `pending-${Date.now()}`);
    setActiveSessionId(pendingId);
    const agentMessage = await prepareMessageForAgent?.(fullMessage) ?? fullMessage;

    if (onSubmitMessage) {
      if (onMessageSent) onMessageSent(pendingId, fullMessage, toolIds);
      const result = await onSubmitMessage(fullMessage);
      if (result?.sessionId && result.sessionId !== pendingId) {
        setActiveSessionId(result.sessionId);
      }
      if (clearComposer) {
        setMessage("");
        onDraftChange?.("");
        setFiles([]);
      }
      setSending(false);
      setActiveSessionId(null);
      return;
    }

    streamStore.start(pendingId, fullMessage, toolIds ?? []);
    if (onMessageSent) onMessageSent(pendingId, fullMessage, toolIds);

    const chatSession = await invokeCommand<ChatSession>(
      "send_message",
      {
        agentId: agentId ?? "",
        projectPath,
        sessionId: pendingId,
        message: agentMessage,
      },
    );
    // v0.9.4 需求12：send 受理确认（spawn 完成 + prompt 已发出）——阶段文案
    // 从②「正在赶来」切③「思考中」（模型首响应慢不再误导为连接中）。
    // C20：携带 process_id（连接世代）——新进程重连不凭旧记忆直升③。
    streamStore.noteProcess(pendingId, chatSession.process_id);
    streamStore.markPromptAccepted(pendingId, chatSession.process_id);

    setActiveSessionId(chatSession.session_id);
    await onSessionResolved?.(pendingId, chatSession.session_id);
    if (chatSession.session_id !== pendingId) {
      streamStore.alias(pendingId, chatSession.session_id);
    }

    if (clearComposer) {
      setMessage("");
      onDraftChange?.("");
      setFiles([]);
    }
  };

  const handleSend = async () => {
    if (!projectPath || disabled) return;
    if (!message.trim() && files.length === 0) return;

    // If the agent is currently streaming, stage the message instead of
    // interrupting the output. The user can then click "Guide" on the
    // staged message to deliver it (stop+send or steer).
    if (isStreaming) {
      // v0.9.4 需求8 补充：暂存同步入列（files 随行，UI 即时可见）；附件
      // 上传后台执行并回填 fileLines——旧实现 files 直接丢弃，带图引导
      // 丢失附件（用户实测）。引导发送时若上传未完成则兜底等待。
      const stagedId = crypto.randomUUID();
      const stagedFiles = files;
      setCurrentStagedMessages((prev) => [
        ...prev,
        {
          id: stagedId,
          content: message.trim(),
          files: stagedFiles,
          // v0.9.8 需求3：入队即捕获会话发送上下文（面单写地址）——Route 2
          // 自动发送消费此值，不再读当前界面项目（双项目并行串台根因）。
          context: { projectPath: projectPath ?? "", agentId: agentId ?? "" },
        },
      ]);
      void saveInputFiles(stagedFiles)
        .then((lines) => {
          if (lines.length > 0) {
            setStagedMessagesForSession(stagingSessionKey, (prev) =>
              prev.map((m) => (m.id === stagedId ? { ...m, fileLines: lines } : m)),
            );
          }
        })
        .catch((err) => console.warn("Failed to save staged files:", err));
      setMessage("");
      onDraftChange?.("");
      setFiles([]);
      return;
    }

    setSending(true);
    try {
      let fullMessage = message.trim();
      // v0.8.1 内联工具 pill（M0/M2 修订语义 → v0.9.0 需求3 元数据化）：
      // - 会话级真源 = + 菜单勾选（session-tools.json，跨消息/重启保持）；
      // - @[token] = 本条追加——归一为 id 后**并集**写入会话集合（不覆盖、
      //   空消息不再清空勾选）；本条快照以 toolIds 元数据传递（流式渲染/
      //   引导占位用），回放由后端从注入块派生（extract_tool_snapshot）；
      // - 写入键 = 本条 send_message 携带的 sessionId（nextPendingId 同源，
      //   新会话为 pending-<ts>，续聊为真实 id）——修前用 activeSessionId
      //   （流式引用，非流式恒 null）导致写入全部落到暂存键、注入永不命中。
      const pendingId = nextPendingId();
      const composed = await composeOutgoing(fullMessage);
      fullMessage = composed.message;
      // 输入历史记录用户原始输入（A6）：发送即入列，与附件组装后的内容无关
      pushInputHistory(historyScope, message);
      setHistoryPos(null);
      draftBeforeHistoryRef.current = "";

      if (allowFiles && files.length > 0) {
        const allFileLines = await saveInputFiles(files);
        if (!fullMessage) {
          fullMessage = t("projects.defaultFileMessage");
        }
        if (allFileLines.length > 0) {
          const fileListStr = allFileLines.join("\n");
          fullMessage += `\n\n<!--JISHU_HUB_IMAGES_BEGIN-->\n[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]\n${fileListStr}\n<!--JISHU_HUB_IMAGES_END-->`;
        }
      }

      await sendPreparedMessage(fullMessage, true, pendingId, composed.toolIds);
    } catch (err) {
      console.error("Failed to send message:", err);
      setSending(false);
    }
  };

  // Guide a staged message — deliver it to the agent.
  // For ACP/Pi-RPC agents (onGuideStaged provided): steer — inject the text
  // mid-turn without interrupting output.
  // For CLI/embedded agents (no onGuideStaged): stop the current generation,
  // then send as a new message.
  const handleGuideStaged = async (id: string, rawContent: string) => {
    if (!projectPath || disabled) return;
    // exactly-once: if this staged message was already claimed — by a prior
    // click of the same button (claude multi-click), or by Route 2's auto-send
    // racing this manual click — do nothing. Claim synchronously BEFORE any
    // await so a concurrent Route 2 sees it as already sent.
    const claimedIds = claimedIdsForSession(stagingSessionKey);
    if (claimedIds.has(id)) return;
    claimedIds.add(id);
    setGuideLoading(id);
    try {
      // M5：引导路径与普通发送共用同一工具管线——剥 @[token]、归一 id、
      // 写消息头标记（回放 pill）、并集写入会话集（注入生效）。修前引导
      // 完全绕过：token 原文进 prompt、无 pill、无注入。
      const { message, sessionKey, toolIds } = await composeOutgoing(rawContent);
      // v0.9.4 需求8 补充：引导消息附加暂存附件的标记行（与普通发送同通道
      // ——文件落盘 + Read 引用）。上传未完成时在此兜底等待（guide loading
      // 态已覆盖等待期）。
      const staged = stagedMessages.find((m) => m.id === id);
      let fullGuide = message;
      if (staged) {
        let fileLines = staged.fileLines;
        if (!fileLines && staged.files && staged.files.length > 0) {
          const lines = await saveInputFiles(staged.files as AttachedFile[]);
          if (lines.length > 0) {
            fileLines = lines;
            setStagedMessagesForSession(stagingSessionKey, (prev) =>
              prev.map((m) => (m.id === id ? { ...m, fileLines: lines } : m)),
            );
          }
        }
        if (fileLines && fileLines.length > 0) {
          fullGuide = `${message}\n\n<!--JISHU_HUB_IMAGES_BEGIN-->\n[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]\n${fileLines.join("\n")}\n<!--JISHU_HUB_IMAGES_END-->`;
        }
      }
      if (onGuideStaged) {
        // Caller handles delivery (steer for Pi RPC / ACP).
        await onGuideStaged(fullGuide, toolIds);
      } else {
        // CLI/embedded agents have no mid-turn steer. Stop the current turn
        // first, then send. The abort MUST be awaited so its streamStore.drop
        // settles before sendPreparedMessage's streamStore.start — an
        // un-awaited abort racing with the send was what corrupted stream
        // state and cleared the UI previously.
        if (isStreaming) {
          await handleAbort();
        }
        await sendPreparedMessage(message, true, sessionKey, toolIds);
      }
      setCurrentStagedMessages((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      console.error("Failed to guide staged message:", err);
      // Delivery failed — un-claim so the message stays in staging and can be
      // retried (by manual click or a later Route 2 turn_complete).
      claimedIds.delete(id);
    } finally {
      setGuideLoading(null);
    }
  };

  const handleInteractionSubmit = async (
    submission: ConversationInteractionSubmission,
  ) => {
    if (!interactionRequest || disabled || interactionSubmitting) return;

    setInteractionSubmitting(true);
    try {
      if (onInteractionSubmit) {
        await onInteractionSubmit(submission);
      } else {
        const reply = formatInteractionReply(interactionRequest, submission);
        await sendPreparedMessage(reply, false);
      }
    } catch (err) {
      console.error("Failed to submit interaction:", err);
      throw err;
    } finally {
      setInteractionSubmitting(false);
    }
  };

  const handleAbort = async () => {
    if (onSubmitMessage && onAbort) {
      await onAbort();
      setSending(false);
      setActiveSessionId(null);
      return;
    }

    // Prefer the abortKey recorded by the store when we started the stream.
    // It tracks the canonical id the backend registered the process under,
    // even if a real session id was later resolved.
    const abortKey =
      streamStore.getState(sessionId)?.abortKey
      ?? streamStore.getState(activeSessionId)?.abortKey
      ?? activeSessionId
      ?? sessionId;
    if (abortKey) {
      await invokeCommand("abort_chat", { sessionId: abortKey });
      await onAbort?.();
      // v0.9.4 需求7 测试期重构：此处不再 drop 任何流键——抢先 drop 会让
      // 晚到的 turn_complete(Aborted)（唯一回合终结者：重复提交防重 + steering
      // 重发收口 + 流 drop）被 pushTracked 拒绝，收口死。流的生命周期归属
      // turn_complete 处理；极端丢失（进程崩溃）由重挂载对账（chat_turn_active）
      // 兜底。
      setSending(false);
      setActiveSessionId(null);
    } else {
      await onAbort?.();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!allowFiles || !projectPath || sending) return;

    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length === 0) return;

    const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);
    const newFiles: AttachedFile[] = droppedFiles.map((file, i) => {
      const filename = file.name;
      const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
      const isImage = imageExts.has(ext) || file.type.startsWith("image/");
      const idx = files.length + i + 1;
      return {
        id: `drop-${Date.now()}-${i}`,
        data: "",
        filename,
        label: isImage ? t("projects.imageLabel", { index: idx }) : filename.replace(/\.\w+$/, ""),
        isImage,
      };
    });

    // Read base64 for each dropped file
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i];
      const base64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      });
      newFiles[i].data = base64;
    }

    setFiles((prev) => [...prev, ...newFiles]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // ── 输入建议键盘交互（A2/A1）：激活时优先于发送与历史导航 ─────────────
    if (suggestionsActive) {
      const listLength = slashFilter !== null ? slashItems.length : fileItems.length;
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? -1 : 1;
        setSuggestIndex((prev) => (prev + delta + listLength) % listLength);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (slashFilter !== null) {
          commitSlash(slashItems[Math.min(suggestIndex, listLength - 1)].name);
        } else {
          commitFile(fileItems[Math.min(suggestIndex, listLength - 1)].item);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSuggestions();
        return;
      }
    }
    // ── v0.8.1 需求7：内联工具 pill 整体删除——Backspace/Delete 命中完整
    // `@[显示名]` token 时一次删整段，不退化为逐字删（mirror 层 pill 的
    // 原子性对齐：视觉是一个整体，删除也必须是一个整体）。 ──────────────
    if (e.key === "Backspace" || e.key === "Delete") {
      const textarea = e.currentTarget as HTMLTextAreaElement;
      const caret = textarea.selectionStart ?? 0;
      if (caret === (textarea.selectionEnd ?? caret)) {
        const before = message.slice(0, caret);
        const after = message.slice(caret);
        const hit = e.key === "Backspace" ? before.match(/@\[[^\]]*\]$/) : after.match(/^@\[[^\]]*\]/);
        if (hit) {
          e.preventDefault();
          const next =
            e.key === "Backspace"
              ? before.slice(0, before.length - hit[0].length) + after
              : before + after.slice(hit[0].length);
          setMessage(next);
          onDraftChange?.(next);
          requestAnimationFrame(() => {
            const pos = e.key === "Backspace" ? before.length - hit[0].length : caret;
            textarea.setSelectionRange(pos, pos);
          });
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // ── 输入历史导航（A6）───────────────────────────────────────────────────
    // ↑：输入为空，或光标位于首行行首时进入/后退历史（多行编辑的行首 ↑ 不劫持）。
    // ↓：仅在历史浏览中响应，回退到更近的历史，浏览到底则恢复浏览前草稿。
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const textarea = e.currentTarget as HTMLTextAreaElement;
      const history = historyListRef.current;
      const caretToEnd = (text: string) => {
        requestAnimationFrame(() => {
          textarea.setSelectionRange(text.length, text.length);
        });
      };
      if (e.key === "ArrowUp" && history.length > 0) {
        const beforeCaret = message.slice(0, textarea.selectionStart ?? 0);
        const firstLine = !beforeCaret.includes("\n");
        const atLineStart = beforeCaret.length === 0 || beforeCaret.endsWith("\n");
        if (message.length === 0 || (firstLine && atLineStart)) {
          e.preventDefault();
          const nextPos = historyPos === null ? 0 : Math.min(historyPos + 1, history.length - 1);
          if (historyPos === null) draftBeforeHistoryRef.current = message;
          setHistoryPos(nextPos);
          setMessage(history[nextPos]);
          caretToEnd(history[nextPos]);
          return;
        }
      }
      if (e.key === "ArrowDown" && historyPos !== null) {
        e.preventDefault();
        if (historyPos > 0) {
          const nextPos = historyPos - 1;
          setHistoryPos(nextPos);
          setMessage(history[nextPos]);
          caretToEnd(history[nextPos]);
        } else {
          setHistoryPos(null);
          setMessage(draftBeforeHistoryRef.current);
          caretToEnd(draftBeforeHistoryRef.current);
          draftBeforeHistoryRef.current = "";
        }
        return;
      }
    }
  };

  return (
    <div ref={inputRootRef} className={cn("mx-auto w-full max-w-[var(--message-content-max-width)] px-4 pb-4 pt-2", containerClassName)}>
      {/* v0.9.8 需求5（合并版）：装备建议条（新对话起始态；L1/L0/入门分级，
          未装件点击浮卡安装 + 已装未挂件 @[注入]——两类胶囊视觉区分：
          安装类=实线+星级，挂载类=虚线+Plus 徽标「已装可挂载」，不再混作
          「推荐安装」误导（用户实测：全装环境只剩挂载件时被当成只会推荐
          需求讨论/流程规划）。 */}
      {sceneSuggest && (sceneSuggest.installItems.length > 0 || sceneSuggest.mountItems.length > 0) && (
        <div
          data-scene-suggest={sceneSuggest.origin}
          className="relative mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--icon-theme)]" />
          <span>
            {sceneSuggest.installItems.length === 0
              ? t("sessions.equipSuggestMountable", "已装可快速挂载")
              : sceneSuggest.origin === "workspace"
                ? t("sessions.equipSuggestByProject", "按当前项目推荐")
                : sceneSuggest.origin === "profile"
                  ? t("sessions.equipSuggestByTask", { defaultValue: "按最近任务推荐", note: sceneSuggest.originNote ?? "" })
                  : sceneSuggest.origin === "draft"
                    ? t("sessions.equipSuggestByDraft", "按你输入的内容推荐")
                    : t("sessions.equipSuggestFallback", "为你推荐")}
          </span>
          {sceneSuggest.installItems.map((item) => (
            <button
              key={item.ref}
              type="button"
              data-equip-suggest={item.ref}
              onClick={() => setSuggestPopover(suggestPopover?.ref === item.ref ? null : item)}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-background/70 px-2.5 py-0.5 text-foreground/85 transition-fast hover:border-primary/60 hover:text-foreground"
            >
              <span className="font-mono text-[9px] text-amber-500">{"★".repeat(Math.max(1, Math.min(5, item.stars)))}</span>
              {item.title}
            </button>
          ))}
          {sceneSuggest.mountItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-mount-suggest={item.id}
              title={t("sessions.equipSuggestMountHint", "已安装——点击挂载到本会话")}
              onClick={() => insertToolToken(item.title)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/70 bg-background/70 px-2.5 py-0.5 text-foreground/75 transition-fast hover:border-primary/50 hover:text-foreground"
            >
              <Plus className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
              {item.title}
            </button>
          ))}
          <button
            type="button"
            onClick={handleDismissSceneSuggest}
            title={t("sessions.sceneSuggestDismiss")}
            className="ml-auto rounded-md p-0.5 text-muted-foreground/70 transition-fast hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          {/* 未装件浮卡：星级+描述+安装（不直接装——设计内定：先确认再装）。 */}
          {suggestPopover && (
            <div
              data-equip-popover={suggestPopover.ref}
              className="absolute left-3 top-full z-30 mt-1 w-72 rounded-lg border border-border/70 bg-popover p-3 text-xs shadow-lg"
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-foreground">{suggestPopover.title}</span>
                <span className="font-mono text-[10px] text-amber-500">{"★".repeat(Math.max(1, Math.min(5, suggestPopover.stars)))}</span>
              </div>
              {suggestPopover.description && (
                <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                  {suggestPopover.description}
                </p>
              )}
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  type="button"
                  className="rounded-md border border-border/60 px-2 py-1 text-[10px] hover:bg-accent/50"
                  onClick={() => setSuggestPopover(null)}
                >
                  {t("common.cancel", "取消")}
                </button>
                <button
                  type="button"
                  disabled={suggestInstalling}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
                  onClick={() => void handleSuggestInstall(suggestPopover)}
                >
                  {suggestInstalling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  {t("market.install", "安装")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div
        className={cn(
          "relative flex flex-col overflow-visible rounded-2xl border border-input bg-card shadow-sm focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-shadow",
          panelClassName,
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {interactionRequest ? (
          <InteractionComposer
            request={interactionRequest}
            disabled={disabled}
            submitting={interactionSubmitting}
            onSubmit={handleInteractionSubmit}
          />
        ) : null}
        {stagedMessages.length > 0 && (
          <div className="px-3 pt-2">
            <MessageStaging
              messages={stagedMessages}
              onEdit={(id, content) =>
                setCurrentStagedMessages((prev) =>
                  prev.map((m) => (m.id === id ? { ...m, content } : m)),
                )
              }
              onDelete={(id) =>
                setCurrentStagedMessages((prev) => prev.filter((m) => m.id !== id))
              }
              onReorder={(fromId, toId) =>
                setCurrentStagedMessages((prev) => {
                  const from = prev.findIndex((m) => m.id === fromId);
                  const to = prev.findIndex((m) => m.id === toId);
                  if (from < 0 || to < 0 || from === to) return prev;
                  const next = [...prev];
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  return next;
                })
              }
              onSend={handleGuideStaged}
              sendLoadingId={guideLoading}
              toolNames={Object.fromEntries(
                Array.isArray(sessionTools)
                  ? sessionTools.map((t) => [t.id, t.display_name])
                  : [],
              )}
            />
          </div>
        )}
        <FilePreview files={files} onLabelChange={handleLabelChange} onRemove={handleRemoveFile} />

        {/* 需求9（回归修复）：@ 无匹配时不弹层——能带出补全才算引入文件，
            带不出即普通 @ 文本输出（atToken 兜底条件移除；slash 的
            slashNoMatch 提示保留——命令集合封闭，提示有价值）。 */}
        {(suggestionsActive || slashFilter !== null) && (
          <div className="absolute bottom-[calc(100%-0.35rem)] left-3 z-[90] max-h-56 w-80 overflow-auto rounded-xl border border-border bg-popover p-1.5 shadow-xl">
            {slashFilter !== null ? (
              slashItems.length > 0 ? (
                slashItems.map((cmd, i) => (
                  <button
                    key={cmd.name}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitSlash(cmd.name);
                    }}
                    onMouseEnter={() => setSuggestIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-fast",
                      i === Math.min(suggestIndex, slashItems.length - 1)
                        ? "bg-accent/70 text-foreground"
                        : "text-muted-foreground hover:bg-accent/40",
                    )}
                  >
                    <Command className="h-3.5 w-3.5 shrink-0 text-[var(--icon-action)]" />
                    <span className="font-mono font-medium">/{cmd.name}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{cmd.label}</span>
                  </button>
                ))
              ) : (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/70">{t("sessions.slashNoMatch")}</div>
              )
            ) : (
              fileItems.map(({ item }, i) => (
                <button
                  key={item}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitFile(item);
                  }}
                  onMouseEnter={() => setSuggestIndex(i)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-fast",
                    i === Math.min(suggestIndex, fileItems.length - 1)
                      ? "bg-accent/70 text-foreground"
                      : "text-muted-foreground hover:bg-accent/40",
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--icon-folder)]" />
                  <span className="truncate font-mono" dir="ltr">{item}</span>
                </button>
              ))
            )}
          </div>
        )}

        {/* v0.8.1 需求7 内联工具 pill：mirror 层方案——textarea 文字透明
            （caret 仍可见），同字体同 padding 视觉层把 `@[工具名]` token
            渲染成 pill，其余文本原样显示。
            v0.9.1 需求4 修复五「外滚内长」重构：固定高度滚动容器内，
            mirror（in-flow 撑内容高度）与 textarea（absolute 覆盖同几何、
            overflow hidden 自身不滚）随同一条滚动条整体滚动——两层对齐由
            DOM 构造保证（滚动条占宽对两层同时生效），杜绝滚动后重影。
            修复六（用户 2026-09-06 裁决，取代修复四恒定高度）：内容可撑高
            （上限约 11 行文字），超出才整体滚动；发送清空回初始高度。 */}
        <div
          ref={inputScrollRef}
          className="min-h-[76px] overflow-x-hidden overflow-y-auto"
        >
          {/* 修复五补充：min-h-full——空草稿时 mirror（in-flow）只剩 padding
              高度，absolute 的 textarea 会塌到 ~24px、placeholder 只露半行；
              内层以滚动容器高度为最小值，空态铺满、长文超出照常滚动。 */}
          <div className="relative min-h-full">
            <div
              ref={inputMirrorRef}
              aria-hidden
              className="pointer-events-none whitespace-pre-wrap break-words px-4 py-3 text-sm"
            >
              {renderMirrorText(message, sessionTools)}
              {/* 尾部换行对齐（撑满后回车重影根因，测试期修复19）：div 的
                  pre-wrap 不渲染末尾换行的空行而 textarea 计入——两层高度
                  分叉，textarea 被浏览器自动内滚一行与 mirror 错位成重影；
                  补零宽字符让 mirror 同样产出该空行，两层始终同高。 */}
              {message.endsWith("\n") ? "\u200b" : null}
            </div>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => {
                if (historyPos !== null) {
                  // 用户在历史浏览中编辑：退出浏览模式，从当前显示文本继续
                  setHistoryPos(null);
                  draftBeforeHistoryRef.current = "";
                }
                const value = e.target.value;
                const caret = e.target.selectionStart ?? value.length;
                setMessage(value);
                updateSuggestions(value, caret);
                onDraftChange?.(value);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={cn(
                "absolute inset-0 z-10 h-full w-full resize-none overflow-hidden bg-transparent px-4 py-3 text-sm focus:outline-none",
                messageHasToolToken(message) && "text-transparent caret-foreground",
              )}
              style={{ overflow: "hidden" }}
              onInput={() => {
                // 需求4 修复五：光标在末尾时滚动容器跟到底（中间位置不打断
                // 用户滚轮）。
                scrollInputCaretIntoView();
              }}
            />
          </div>
        </div>

        {/* v0.8.0 需求4 补充：底部两侧允许换行 + min-w-0——右侧预览顶开
            聊天区收窄时，模式/权限/模型等 chips 折行而不是溢出输入框。
            行上声明 @container：行宽 <560px 时各 chip 切换为图标展示。 */}
        <div className="@container flex items-end justify-between gap-2 pl-2 pr-2.5 pb-2 pt-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <div ref={toolbarRef} className="relative flex min-w-0 flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setToolMenuOpen((open) => !open);
                  setWorkModeMenuOpen(false);
                  setAccessMenuOpen(false);
                }}
                disabled={disabled || sending || isStreaming}
                title={t("sessions.addContext")}
              >
                <Plus className="h-4 w-4" strokeWidth={2.3} />
              </Button>
              {toolMenuOpen && (
                <div className="absolute bottom-[calc(100%+0.45rem)] left-0 z-[80] w-44 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                  {/* v0.9.8 需求7：+ 菜单按「输入素材 / 能力挂载」两类归组
                      （信息架构分层，历史平铺混合菜单收敛为两级）。 */}
                  <div className="px-2.5 pb-1 pt-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {t("sessions.menuGroupInput", "输入素材")}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setToolMenuOpen(false);
                      setToolSubmenu(null);
                      handleFileSelect();
                    }}
                    disabled={disabled || sending || isStreaming || !allowFiles}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Paperclip className="h-4 w-4 text-[var(--icon-action)]" />
                    <span>{t("sessions.attachFile")}</span>
                  </button>
                  {sessionTools.length > 0 && (() => {
                    // 需求20 第二轮：两级分组——CLI 插件平铺；MCP 服务 / Skill
                    // 折叠子菜单（点组名展开，点具体服务插入 pill）。选中即注入
                    // 提示小节；未选中经解析器通道仍在线可用（动态性）。
                    // v0.9.1 需求8：不可注入项（MCP/SKILL 解析器等 pi 扩展形态）
                    // 此前渲染成置灰，用户裁决直接不显示——分组时即过滤。
                    // v0.9.8 需求7：CLI 平铺段追加过滤 LEGACY_STAGE_PLUGIN_IDS
                    //（去阶段化历史残留件，入口收敛——能力保留，仅不展示）。
                    const injectable = (t: SessionTool) => t.injectable !== false;
                    const cliTools = sessionTools.filter(
                      (t) =>
                        (!t.category || t.category === "cli") &&
                        injectable(t) &&
                        !LEGACY_STAGE_PLUGIN_IDS.has(t.id),
                    );
                    const mcpTools = sessionTools.filter((t) => t.category === "mcp" && injectable(t));
                    const skillTools = sessionTools.filter((t) => t.category === "skill" && injectable(t));
                    // v0.9.8 需求5（合并版）：已装 pi 扩展同款可引用（推荐
                    // 能推扩展，用户也得能主动点名——体验一致）。
                    const extensionTools = sessionTools.filter((t) => t.category === "extension" && injectable(t));
                    const hasSelectableTools =
                      cliTools.length + mcpTools.length + skillTools.length + extensionTools.length > 0;
                    // v0.9.1 需求8：子项图标与所属类型组一致（MCP→Server、
                    // Skill→Sparkles），CLI 插件保持 Blocks——内置服务与类型
                    // 标识视觉统一（用户裁决，原全部为 Blocks 四小方形）。
                    const renderToolButton = (tool: SessionTool, Icon: typeof Blocks, iconColor: string, indent = false) => (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          setToolMenuOpen(false);
                          setToolSubmenu(null);
                          insertToolToken(tool.display_name);
                        }}
                        disabled={disabled || sending || isStreaming}
                        title={tool.description}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-45",
                          indent && "pl-4",
                        )}
                      >
                        <Icon className={cn("h-4 w-4 shrink-0", iconColor)} />
                        <span className="flex-1 truncate">{tool.display_name}</span>
                      </button>
                    );
                    return (
                    hasSelectableTools && (
                    <div className="my-1 border-t border-border/60 pt-1">
                      <div className="px-2.5 pb-1 pt-0.5 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                        {t("sessions.menuGroupAbility", "能力挂载")}
                      </div>
                      {cliTools.length > 0 && cliTools.map((tool) => renderToolButton(tool, Blocks, "text-[var(--icon-config)]"))}
                      {mcpTools.length > 0 && (
                        <>
                          <button
                            type="button"
                            aria-expanded={toolSubmenu === "mcp"}
                            onClick={() => setToolSubmenu((cur) => (cur === "mcp" ? null : "mcp"))}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60"
                          >
                            <Server className="h-4 w-4 shrink-0 text-[var(--icon-action)]" />
                            <span className="flex-1">{t("sessions.mcpSection", "MCP 服务")}</span>
                            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", toolSubmenu === "mcp" && "rotate-180")} />
                          </button>
                          {toolSubmenu === "mcp" && mcpTools.map((tool) => renderToolButton(tool, Server, "text-[var(--icon-action)]", true))}
                        </>
                      )}
                      {skillTools.length > 0 && (
                        <>
                          <button
                            type="button"
                            aria-expanded={toolSubmenu === "skill"}
                            onClick={() => setToolSubmenu((cur) => (cur === "skill" ? null : "skill"))}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60"
                          >
                            <Sparkles className="h-4 w-4 shrink-0 text-[var(--icon-theme)]" />
                            <span className="flex-1">{t("sessions.skillSection", "Skill")}</span>
                            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", toolSubmenu === "skill" && "rotate-180")} />
                          </button>
                          {toolSubmenu === "skill" && skillTools.map((tool) => renderToolButton(tool, Sparkles, "text-[var(--icon-theme)]", true))}
                        </>
                      )}
                      {extensionTools.length > 0 && (
                        <>
                          <button
                            type="button"
                            aria-expanded={toolSubmenu === "extension"}
                            onClick={() => setToolSubmenu((cur) => (cur === "extension" ? null : "extension"))}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60"
                          >
                            <Package className="h-4 w-4 shrink-0 text-[var(--icon-config)]" />
                            <span className="flex-1">{t("sessions.extensionSection", "扩展")}</span>
                            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", toolSubmenu === "extension" && "rotate-180")} />
                          </button>
                          {toolSubmenu === "extension" && extensionTools.map((tool) => renderToolButton(tool, Package, "text-[var(--icon-config)]", true))}
                        </>
                      )}
                      {/* 需求15-F10：CLI 平铺与 MCP 组均空（已装件多为 pi 扩展
                          形态被设计过滤）时给一行占位说明——否则组内只剩
                          Skill 一项，用户无从得知为什么没有别的。 */}
                      {cliTools.length === 0 && mcpTools.length === 0 && extensionTools.length === 0 && (
                        <div className="px-2.5 pb-1 pt-0.5 text-[0.7rem] leading-relaxed text-muted-foreground/60">
                          {t("sessions.abilityEmptyHint", "暂无可挂载的插件工具，可在插件市场安装")}
                        </div>
                      )}
                    </div>
                    )
                    );
                  })()}
                </div>
              )}
              {workModeOptions.length > 0 && workModeValue && (
                <div className="relative">
                  <button
                    type="button"
                    aria-label={workModeLabel}
                    aria-haspopup="menu"
                    aria-expanded={workModeMenuOpen}
                    disabled={disabled || sending || isStreaming}
                    title={workModeLabel}
                    onClick={() => {
                      setWorkModeMenuOpen((open) => !open);
                      setToolMenuOpen(false);
                      setAccessMenuOpen(false);
                    }}
                    className={cn(
                      "inline-flex h-8 min-w-[5.5rem] max-w-[9rem] items-center justify-between gap-1.5 rounded-full border border-border/50 bg-background/80 px-3 text-xs text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 @max-[559px]:min-w-0 @max-[559px]:px-2",
                      workModeMenuOpen && "border-primary/45 bg-primary/8 text-foreground shadow-sm",
                    )}
                  >
                    <MessagesSquare className="hidden h-3.5 w-3.5 @max-[559px]:inline-flex" />
                    <span className="min-w-0 truncate @max-[559px]:hidden">
                      {workModeOptions.find((option) => option.value === workModeValue)?.label ?? workModeValue}
                    </span>
                    <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", workModeMenuOpen && "rotate-180")} />
                  </button>
                  {workModeMenuOpen && (
                    <div className="absolute bottom-[calc(100%+0.45rem)] left-0 z-[80] w-32 origin-bottom-left rounded-xl border border-border bg-popover p-1 shadow-xl">
                      {workModeOptions.map((option) => {
                        const selected = option.value === workModeValue;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              setWorkModeMenuOpen(false);
                              onWorkModeChange?.(option.value);
                            }}
                            className={cn(
                              "flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs transition-fast hover:bg-accent/60",
                              selected ? "font-medium text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <span className={cn(
                              "h-1.5 w-1.5 rounded-full",
                              selected ? "bg-primary" : "bg-transparent",
                            )} />
                            <span className="flex-1 whitespace-nowrap">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {workModeValue === "task" && onTaskNoAskChange && (
                // 评审 P1-11 修复：直出中文改 t()；评审 #17 配合后端作用域
                // 收窄——文案明确「仅任务会话生效，普通对话不受影响」。
                <button
                  type="button"
                  disabled={disabled || sending || isStreaming}
                  title={
                    taskNoAsk
                      ? t("sessions.taskNoAskOn", "不询问已开启：本任务会话内不再提问，全部按推荐执行（点击关闭）")
                      : t("sessions.taskNoAskOff", "任务会话内开启不询问：开启后本会话不再提问，全部按推荐执行（普通对话不受影响）")
                  }
                  onClick={() => onTaskNoAskChange(!taskNoAsk)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-fast disabled:cursor-not-allowed disabled:opacity-50",
                    taskNoAsk
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border/50 bg-background/80 text-muted-foreground hover:bg-accent/45 hover:text-foreground",
                  )}
                >
                  <Zap className="h-3.5 w-3.5" />
                  <span className="whitespace-nowrap">{t("sessions.taskNoAsk", "不询问")}</span>
                </button>
              )}
              {accessModeLabel && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (accessModeReadOnly || accessModeOptions.length === 0) return;
                      setAccessMenuOpen((open) => !open);
                      setToolMenuOpen(false);
                      setWorkModeMenuOpen(false);
                    }}
                    disabled={disabled || sending || isStreaming}
                    title={accessModeTitle ?? t("sessions.accessMode")}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-2.5 text-xs text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground",
                      accessModeReadOnly && "cursor-default hover:bg-background/80 hover:text-muted-foreground",
                    )}
                  >
                    <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--icon-config)]" />
                    <span className="max-w-[8rem] truncate @max-[559px]:hidden">{accessModeLabel}</span>
                    {!accessModeReadOnly && <ChevronDown className="h-3 w-3" />}
                  </button>
                  {accessMenuOpen && !accessModeReadOnly && (
                    <div className="absolute bottom-[calc(100%+0.45rem)] left-0 z-[80] w-60 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                      {accessModeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setAccessMenuOpen(false);
                            onAccessModeChange?.(option.value);
                          }}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-fast hover:bg-accent/60",
                            option.value === accessModeValue ? "bg-accent/30" : "",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 text-sm text-foreground">
                              <span>{option.label}</span>
                            </div>
                            {option.description && (
                              <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground/70">
                                {option.description}
                              </div>
                            )}
                          </div>
                          {option.value === accessModeValue && (
                            <Check className="mt-1 h-4 w-4 shrink-0 text-[var(--icon-action)]" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            {trailingControls ? (
              <span className="mr-2.5 inline-flex min-w-0 flex-wrap items-center justify-end gap-1.5">{trailingControls}</span>
            ) : null}
            {isStreaming && !(message.trim() || files.length > 0) ? (
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                className="h-8 w-8 rounded-full"
                onClick={handleAbort}
                aria-label={t("sessions.stop")}
                title={t("sessions.stop")}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="button"
                variant={(message.trim() || files.length > 0) ? "default" : "secondary"}
                size="icon-sm"
                className={`h-8 w-8 rounded-full transition-colors transition-shadow ${
                  (message.trim() || files.length > 0)
                    ? "bg-[var(--icon-send-bg)] text-[var(--icon-send-fg)] shadow-sm hover:opacity-90"
                    : "text-muted-foreground opacity-50"
                }`}
                style={(message.trim() || files.length > 0) ? { backgroundColor: 'var(--icon-send-bg)', color: 'var(--icon-send-fg)' } : undefined}
                onClick={handleSend}
                disabled={disabled || (!message.trim() && files.length === 0)}
                aria-label={t("sessions.send")}
                title={t("sessions.send")}
              >
                <Send className="h-4 w-4 ml-[2px]" />
              </Button>
            )}
          </div>
        </div>
        {contextFooter}
      </div>
    </div>
  );
});

export const ChatInput = memo(ChatInputBase);
