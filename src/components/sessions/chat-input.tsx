import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore, useIsSessionStreaming } from "@/hooks/use-stream-store";
import { Button } from "@/components/ui/button";
import { Blocks, Check, ChevronDown, KeyRound, MessagesSquare, Paperclip, Plus, Send, Square, Sparkles } from "lucide-react";
import { FilePreview } from "./file-preview";
import { InteractionComposer } from "./interaction-composer";
import { MessageStaging, type StagedMessage } from "./message-staging";
import { open } from "@tauri-apps/plugin-dialog";
import { formatInteractionReply } from "@/lib/conversation-interaction";
import { getInputHistory, pushInputHistory } from "@/lib/input-history";
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
  slashCommands?: Array<{ name: string; label: string; available: boolean }>;
  /** 斜杠命令执行回调：命令面板选中后调用，输入框自动清空。 */
  onSlashCommand?: (name: string) => void;
  /** 渲染在发送按钮左侧同一行的控件（v0.7.3 需求2：模型选择器+水位圆环）。 */
  trailingControls?: ReactNode;
  onDraftChange?: (value: string) => void;
  onBeforeSend?: (message: string) => Promise<boolean | void> | boolean | void;
  prepareMessageForAgent?: (message: string) => Promise<string> | string;
  onMessageSent?: (chatSessionId: string, userMessage: string) => void;
  onSessionResolved?: (pendingSessionId: string, realSessionId: string) => void | Promise<void>;
  onSubmitMessage?: (message: string) => Promise<{ sessionId?: string } | void>;
  containerClassName?: string;
  panelClassName?: string;
  contextFooter?: ReactNode;
  workModeLabel?: string;
  workModeOptions?: Array<{ value: string; label: string }>;
  workModeValue?: string;
  onWorkModeChange?: (value: string) => void | Promise<void>;
  accessModeLabel?: string;
  accessModeTitle?: string;
  accessModeReadOnly?: boolean;
  accessModeOptions?: Array<{ value: string; label: string }>;
  accessModeValue?: string;
  onAccessModeChange?: (value: string) => void | Promise<void>;
  interactionRequest?: ConversationInteractionRequest | null;
  onInteractionSubmit?: (submission: ConversationInteractionSubmission) => void | Promise<void>;
  /** Called when user clicks "guide" on a staged message during streaming.
   *  For Jishu Agent: steer. For others: parent should stop + send. */
  onGuideStaged?: (content: string) => Promise<void>;
  /** Called when the user clicks the Stop button and the session is aborted. */
  onAbort?: () => void;
  /** When provided, the parent can auto-send staged guides at turn_complete
   *  (Route 2) and share the claimed-id dedup. */
  stagedApiRef?: React.MutableRefObject<StagedGuideApi | null>;
}

function isInsideProject(filePath: string, projectPath: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").toLowerCase();
  const normProject = projectPath.replace(/\\/g, "/").toLowerCase();
  return normFile.startsWith(normProject.endsWith("/") ? normProject : normProject + "/");
}

const ChatInputBase = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput({
  sessionId,
  projectPath,
  agentId,
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
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [interactionSubmitting, setInteractionSubmitting] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const [stagedMessagesBySession, setStagedMessagesBySession] = useState<Record<string, StagedMessage[]>>({});
  const [guideLoading, setGuideLoading] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      // @ 文件：光标前最近 @，@ 之前须为行首或空白，token 内无空白
      if (!allowFiles) {
        setAtToken(null);
        return;
      }
      const beforeCaret = value.slice(0, caret);
      const atIdx = beforeCaret.lastIndexOf("@");
      if (
        atIdx >= 0 &&
        (atIdx === 0 || /\s/.test(beforeCaret[atIdx - 1])) &&
        !/\s/.test(beforeCaret.slice(atIdx + 1))
      ) {
        setAtToken(beforeCaret.slice(atIdx + 1));
        setSuggestIndex(0);
      } else {
        setAtToken(null);
      }
    },
    [allowFiles],
  );

  const commitSlash = useCallback(
    (name: string) => {
      closeSuggestions();
      setMessage("");
      onDraftChange?.("");
      onSlashCommand?.(name);
    },
    [closeSuggestions, onDraftChange, onSlashCommand],
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

  useImperativeHandle(ref, () => textareaRef.current!, []);

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
        setStagedMessagesForSession(sessionKey, (prev) => [...prev, ...messages]);
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

  const sendPreparedMessage = async (fullMessage: string, clearComposer: boolean) => {
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

    const pendingId = sessionId || `pending-${Date.now()}`;
    setActiveSessionId(pendingId);
    const agentMessage = await prepareMessageForAgent?.(fullMessage) ?? fullMessage;

    if (onSubmitMessage) {
      if (onMessageSent) onMessageSent(pendingId, fullMessage);
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

    streamStore.start(pendingId, fullMessage);
    if (onMessageSent) onMessageSent(pendingId, fullMessage);

    const chatSession = await invokeCommand<ChatSession>(
      "send_message",
      {
        agentId: agentId ?? "",
        projectPath,
        sessionId: pendingId,
        message: agentMessage,
      },
    );

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
      setCurrentStagedMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), content: message.trim() },
      ]);
      setMessage("");
      onDraftChange?.("");
      setFiles([]);
      return;
    }

    setSending(true);
    try {
      let fullMessage = message.trim();
      // 输入历史记录用户原始输入（A6）：发送即入列，与附件组装后的内容无关
      pushInputHistory(historyScope, message);
      setHistoryPos(null);
      draftBeforeHistoryRef.current = "";

      const localFiles = files.filter((f) => f.localPath && projectPath && isInsideProject(f.localPath, projectPath));
      const externalPathFiles = files.filter((f) => f.localPath && !(projectPath && isInsideProject(f.localPath, projectPath!)));
      const uploadFiles = files.filter((f) => !f.localPath);

      if (allowFiles && (localFiles.length > 0 || uploadFiles.length > 0)) {
        const allFileLines: string[] = [];

        // Local project files: reference directly
        for (const f of localFiles) {
          allFileLines.push(`${f.label}: ${f.localPath}`);
        }

        // External files: copy to session_files
        const filesToUpload = [...uploadFiles, ...externalPathFiles];
        if (filesToUpload.length > 0) {
          // Read base64 for external path files (from URI-list paste)
          for (const f of externalPathFiles) {
            if (!f.data && f.localPath) {
              try {
                f.data = await invokeCommand<string>("read_file_as_base64", { path: f.localPath });
              } catch { f.data = ""; }
            }
          }
          const inputFiles = filesToUpload.map((f) => ({
            data: f.data,
            filename: f.filename,
            label: f.label || null,
          }));
          const saved = await invokeCommand<SavedFile[]>("save_session_files", {
            projectPath,
            files: inputFiles,
          });
          for (const s of saved) {
            allFileLines.push(`${s.label}（批次 ${s.batch_id}）: ${s.path}`);
          }
        }

        if (!fullMessage) {
          fullMessage = t("projects.defaultFileMessage");
        }
        const fileListStr = allFileLines.join("\n");
        fullMessage += `\n\n<!--JISHU_HUB_IMAGES_BEGIN-->\n[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]\n${fileListStr}\n<!--JISHU_HUB_IMAGES_END-->`;
      }

      await sendPreparedMessage(fullMessage, true);
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
  const handleGuideStaged = async (id: string, content: string) => {
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
      if (onGuideStaged) {
        // Caller handles delivery (steer for Pi RPC / ACP).
        await onGuideStaged(content);
      } else {
        // CLI/embedded agents have no mid-turn steer. Stop the current turn
        // first, then send. The abort MUST be awaited so its streamStore.drop
        // settles before sendPreparedMessage's streamStore.start — an
        // un-awaited abort racing with the send was what corrupted stream
        // state and cleared the UI previously.
        if (isStreaming) {
          await handleAbort();
        }
        await sendPreparedMessage(content, true);
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
      // Only drop the abort key (the canonical id the backend tracked). The
      // aborted turn's turn_complete handler in chat-page already drops the
      // resolved id (cid). Dropping sessionId/activeSessionId here too would
      // race that handler: while `abort_chat`'s IPC is in flight the
      // turn_complete(Aborted) event arrives and is processed — which may start
      // a NEW stream (e.g. sending a queued guide) under the resolved id. This
      // subsequent drop would then wipe that freshly-started "thinking" state.
      streamStore.drop(abortKey);
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
    <div className={cn("mx-auto w-full max-w-[var(--message-content-max-width)] px-4 pb-4 pt-2", containerClassName)}>
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
              onSend={handleGuideStaged}
              sendLoadingId={guideLoading}
            />
          </div>
        )}
        <FilePreview files={files} onLabelChange={handleLabelChange} onRemove={handleRemoveFile} />

        {(suggestionsActive || slashFilter !== null || atToken !== null) && (
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
            ) : fileItems.length > 0 ? (
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
            ) : (
              <div className="px-2.5 py-2 text-xs text-muted-foreground/70">{t("sessions.atFileNoMatch")}</div>
            )}
          </div>
        )}

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
          className="w-full resize-none bg-transparent px-4 py-3 text-sm focus:outline-none min-h-[76px] max-h-[220px]"
          style={{ height: "auto", overflow: "hidden" }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = Math.min(target.scrollHeight, 220) + "px";
          }}
        />

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
                  <button
                    type="button"
                    onClick={() => {
                      setToolMenuOpen(false);
                      handleFileSelect();
                    }}
                    disabled={disabled || sending || isStreaming || !allowFiles}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Paperclip className="h-4 w-4 text-[var(--icon-action)]" />
                    <span>{t("sessions.attachFile")}</span>
                  </button>
                  <button
                    type="button"
                    disabled
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground opacity-55"
                  >
                    <Sparkles className="h-4 w-4 text-[var(--icon-theme)]" />
                    <span className="flex-1">{t("sessions.skillsComingSoon")}</span>
                    <span className="text-[0.72em]">{t("sessions.comingSoon")}</span>
                  </button>
                  <button
                    type="button"
                    disabled
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground opacity-55"
                  >
                    <Blocks className="h-4 w-4 text-[var(--icon-config)]" />
                    <span className="flex-1">{t("sessions.pluginsComingSoon")}</span>
                    <span className="text-[0.72em]">{t("sessions.comingSoon")}</span>
                  </button>
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
                    <div className="absolute bottom-[calc(100%+0.45rem)] left-0 z-[80] w-44 rounded-xl border border-border bg-popover p-1.5 shadow-xl">
                      {accessModeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setAccessMenuOpen(false);
                            onAccessModeChange?.(option.value);
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-fast hover:bg-accent/60"
                        >
                          <span className="flex-1">{option.label}</span>
                          {option.value === accessModeValue && <Check className="h-4 w-4 text-[var(--icon-action)]" />}
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
