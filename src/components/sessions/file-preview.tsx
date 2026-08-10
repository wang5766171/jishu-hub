import { useState } from "react";
import { X, FileText, Link } from "lucide-react";
import { ImageViewer } from "./image-viewer";

interface AttachedFile {
  id: string;
  data: string;
  filename: string;
  label: string;
  isImage: boolean;
  localPath?: string;
}

interface FilePreviewProps {
  files: AttachedFile[];
  onLabelChange: (id: string, label: string) => void;
  onRemove: (id: string) => void;
}

export function FilePreview({ files, onLabelChange, onRemove }: FilePreviewProps) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (files.length === 0) return null;

  return (
    <>
      <div className="flex gap-2 overflow-x-auto p-2 border-t border-border">
        {files.map((file) => {
          // 统一构造预览 src：已有 data: 前缀则直接用，否则补 base64 头。
          const imgSrc = file.data
            ? (file.data.startsWith("data:") ? file.data : `data:image/png;base64,${file.data}`)
            : null;
          return (
          <div key={file.id} className="relative flex-shrink-0 w-20 group">
            {file.isImage && imgSrc ? (
              <img
                src={imgSrc}
                alt={file.label}
                className="w-20 h-20 object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => setPreviewSrc(imgSrc)}
              />
            ) : (
              <div className="w-20 h-20 rounded border bg-muted flex flex-col items-center justify-center gap-1 px-1">
                {file.localPath ? (
                  <Link className="h-6 w-6 text-primary/70" />
                ) : (
                  <FileText className="h-6 w-6 text-muted-foreground" />
                )}
                <span className="text-[9px] text-muted-foreground text-center leading-tight line-clamp-2 w-full">
                  {file.filename}
                </span>
              </div>
            )}
            <button
              onClick={() => onRemove(file.id)}
              className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="h-2.5 w-2.5" />
            </button>
            <input
              value={file.label}
              onChange={(e) => onLabelChange(file.id, e.target.value)}
              className="w-full text-[10px] text-center mt-0.5 border rounded px-0.5 py-0"
            />
          </div>
          );
        })}
      </div>
      {previewSrc && (
        <ImageViewer src={previewSrc} onClose={() => setPreviewSrc(null)} alt="attachment" />
      )}
    </>
  );
}
