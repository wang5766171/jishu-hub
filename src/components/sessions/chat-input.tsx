import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle, memo } from "react";
import { useTranslation } from "react-i18next";
import { invokeCommand } from "@/hooks/use-invoke";
import { Button } from "@/components/ui/button";
import { Send, Square, Paperclip } from "lucide-react";
import { FilePreview } from "./file-preview";
import { open } from "@tauri-apps/plugin-dialog";
import type { ChatSession, SavedFile } from "@/types";

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
  allowFiles?: boolean;
  onMessageSent?: (chatSessionId: string, userMessage: string) => void;
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
  allowFiles = true,
  onMessageSent,
}: ChatInputProps, ref) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [sending, setSending] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => textareaRef.current!, []);

  // Reset sending state when parent clears disabled (stream finished)
  useEffect(() => {
    if (!disabled) {
      setSending(false);
      setActiveSessionId(null);
    }
  }, [disabled]);

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
    if (!projectPath || sending) return;
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
    if (activeSessionId) {
      await invokeCommand("abort_chat", { sessionId: activeSessionId });
      setSending(false);
      setActiveSessionId(null);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!allowFiles || !projectPath || disabled || sending) return;

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
    <div className="mx-auto w-full max-w-[var(--message-content-max-width)] px-4 pb-4 pt-2">
      <div
        className="relative flex flex-col rounded-2xl border border-input bg-card shadow-sm focus-within:ring-1 focus-within:ring-ring focus-within:border-ring transition-shadow"
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
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 py-3 text-sm focus:outline-none min-h-[52px] max-h-[200px]"
          style={{ height: "auto", overflow: "hidden" }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = "auto";
            target.style.height = Math.min(target.scrollHeight, 200) + "px";
          }}
        />

        <div className="flex items-center justify-between px-3 pb-3 pt-1">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
              onClick={handleFileSelect}
              disabled={disabled || sending || !allowFiles}
              title={t("sessions.attachImage")}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            {sending ? (
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
                disabled={disabled || (!message.trim() && files.length === 0)}
              >
                <Send className="h-4 w-4 ml-[2px]" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const ChatInput = memo(ChatInputBase);
