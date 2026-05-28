import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { streamStore, useIsSessionStreaming } from "@/hooks/use-stream-store";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, KeyRound, Paperclip, Plus, Send, Square, Sparkles, Blocks } from "lucide-react";
import { FilePreview } from "./file-preview";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatSession, SavedFile } from "@/types";
import { cn } from "@/lib/utils";

interface AttachedFile {
  id: string;
  data: string;           // base64 for uploads, empty for local project files
  filename: string;
  label: string;
  isImage: boolean;
  localPath?: string;     // set when file is inside project directory
}

interface ChatInputProps {
  sessionId: string | null;
  projectPath: string | null;
  disabled?: boolean;
  isSessionStreaming?: boolean;
  allowFiles?: boolean;
  onMessageSent?: (chatSessionId: string, userMessage: string) => void;
  containerClassName?: string;
  panelClassName?: string;
  contextFooter?: ReactNode;
  accessModeLabel?: string;
  accessModeTitle?: string;
  accessModeReadOnly?: boolean;
  accessModeOptions?: Array<{ value: string; label: string }>;
  accessModeValue?: string;
  onAccessModeChange?: (value: string) => void | Promise<void>;
}

function isInsideProject(filePath: string, projectPath: string): boolean {
  const normFile = filePath.replace(/\\/g, "/").toLowerCase();
  const normProject = projectPath.replace(/\\/g, "/").toLowerCase();
  return normFile.startsWith(normProject.endsWith("/") ? normProject : normProject + "/");
}

const ChatInputBase = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput({
  sessionId,
  projectPath,
  disabled = false,
  isSessionStreaming: isSessionStreamingProp = false,
  allowFiles = true,
  onMessageSent,
  containerClassName,
  panelClassName,
  contextFooter,
  accessModeLabel,
  accessModeTitle,
  accessModeReadOnly = true,
  accessModeOptions = [],
  accessModeValue,
  onAccessModeChange,
}: ChatInputProps, ref) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [accessMenuOpen, setAccessMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => textareaRef.current!, []);

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
  useEffect(() => {
    setActiveSessionId(null);
  }, [sessionId]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      setToolMenuOpen(false);
      setAccessMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const placeholder =
    files.length === 0
      ? t("sessions.chatPlaceholder")
      : files.length === 1
        ? t("sessions.chatPlaceholderSingleFile")
        : t("sessions.chatPlaceholderMultiFile");

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
    if (!allowFiles || !projectPath) return;
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

  const handleSend = async () => {
    if (!projectPath || sending || isStreaming) return;
    if (!message.trim() && files.length === 0) return;

    setSending(true);
    try {
      let fullMessage = message.trim();

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
        fullMessage += `\n\n<!--CLAUDE_HUB_IMAGES_BEGIN-->\n[用户在本次对话中上传了以下文件，请使用 Read 工具查看对应的文件路径：]\n${fileListStr}\n<!--CLAUDE_HUB_IMAGES_END-->`;
      }

      const chatSession = await invokeCommand<ChatSession>(
        "send_message",
        {
          projectPath,
          sessionId: sessionId,
          message: fullMessage,
        }
      );

      setActiveSessionId(chatSession.session_id);
      if (onMessageSent) onMessageSent(chatSession.session_id, fullMessage);

      setMessage("");
      setFiles([]);
    } catch (err) {
      console.error("Failed to send message:", err);
      setSending(false);
    }
  };

  const handleAbort = async () => {
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
      setSending(false);
      setActiveSessionId(null);
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
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
        <FilePreview files={files} onLabelChange={handleLabelChange} onRemove={handleRemoveFile} />

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          className="w-full resize-none bg-transparent px-4 py-3 text-sm focus:outline-none min-h-[76px] max-h-[220px]"
          style={{ height: "auto", overflow: "hidden" }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = Math.min(target.scrollHeight, 220) + "px";
          }}
        />

        <div className="flex items-end justify-between pl-2 pr-2.5 pb-2 pt-0">
          <div className="flex items-center gap-1">
            <div ref={toolbarRef} className="relative flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setToolMenuOpen((open) => !open);
                  setAccessMenuOpen(false);
                }}
                disabled={sending}
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
                    disabled={sending || !allowFiles}
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
              {accessModeLabel && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      if (accessModeReadOnly || accessModeOptions.length === 0) return;
                      setAccessMenuOpen((open) => !open);
                      setToolMenuOpen(false);
                    }}
                    disabled={sending}
                    title={accessModeTitle ?? t("sessions.accessMode")}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-full border border-border/50 bg-background/80 px-2.5 text-xs text-muted-foreground transition-fast hover:bg-accent/45 hover:text-foreground",
                      accessModeReadOnly && "cursor-default hover:bg-background/80 hover:text-muted-foreground",
                    )}
                  >
                    <KeyRound className="h-3.5 w-3.5 text-[var(--icon-config)]" />
                    <span className="max-w-[8rem] truncate">{accessModeLabel}</span>
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

          <div className="flex items-center gap-1">
            {(sending || isStreaming) ? (
              <Button variant="destructive" size="icon-sm" className="h-8 w-8 rounded-full" onClick={handleAbort}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant={(message.trim() || files.length > 0) ? "default" : "secondary"}
                size="icon-sm"
                className={`h-8 w-8 rounded-full transition-colors transition-shadow ${
                  (message.trim() || files.length > 0)
                    ? "bg-[var(--icon-send-bg)] text-[var(--icon-send-fg)] shadow-sm hover:opacity-90"
                    : "text-muted-foreground opacity-50"
                }`}
                style={(message.trim() || files.length > 0) ? { backgroundColor: 'var(--icon-send-bg)', color: 'var(--icon-send-fg)' } : undefined}
                onClick={handleSend}
                disabled={isStreaming || (!message.trim() && files.length === 0)}
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
