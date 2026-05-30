import { useState, useEffect, useMemo, memo } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { FileText } from "lucide-react";

export interface FileRef {
  label: string;
  path: string;
  fullMatch: string;
  isImage: boolean;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);

function getExt(path: string): string {
  const filename = path.split(/[/\\]/).pop() || "";
  const dotIdx = filename.lastIndexOf(".");
  return dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : "";
}

const MARKER_RE = /<!--JISHU_HUB_IMAGES_BEGIN-->([\s\S]*?)<!--JISHU_HUB_IMAGES_END-->/g;
const PATH_RE = /[^\s"'<>]+\.jishu_hub[/\\]session_(?:pics|files)[/\\]\d{8}_\d{6}[/\\]\d+_[^\s"'<>]+/gi;

export function parseFileRefs(text: string): FileRef[] {
  const refs: FileRef[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  const markerRe = new RegExp(MARKER_RE.source, MARKER_RE.flags);
  while ((m = markerRe.exec(text)) !== null) {
    const block = m[1];
    const pathRe = new RegExp(PATH_RE.source, PATH_RE.flags);
    let pm: RegExpExecArray | null;
    while ((pm = pathRe.exec(block)) !== null) {
      const path = pm[0];
      if (seen.has(path)) continue;
      seen.add(path);
      const filename = path.split(/[/\\]/).pop() || "";
      const label = filename.replace(/^\d+_/, "").replace(/\.\w+$/, "");
      const ext = getExt(path);
      refs.push({ label, path, fullMatch: pm[0], isImage: IMAGE_EXTS.has(ext) });
    }
  }

  return refs;
}

const imageCache = new Map<string, Promise<string>>();

function loadImage(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = invokeCommand<string>("read_image_as_data_url", { path });
    imageCache.set(path, p);
  }
  return p;
}

export const InlineImageDisplay = memo(function InlineImageDisplay({ path }: { path: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadImage(path)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [path]);

  if (error) return null;
  if (!dataUrl) {
    return (
      <div className="inline-block w-16 h-16 rounded bg-muted animate-pulse" />
    );
  }

  return (
    <img
      src={dataUrl}
      className="max-h-[120px] rounded cursor-pointer hover:opacity-80 transition-opacity"
      onClick={() => window.open(dataUrl, "_blank")}
    />
  );
});

function InlineFileBadge({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-xs text-muted-foreground border">
      <FileText className="h-3.5 w-3.5" />
      <span className="truncate max-w-[200px]">{label}</span>
    </div>
  );
}

export const InlineImages = memo(function InlineImages({ text }: { text: string }) {
  const refs = useMemo(() => parseFileRefs(text), [text]);
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-1.5">
      {refs.map((ref) =>
        ref.isImage ? (
          <InlineImageDisplay key={ref.path} path={ref.path} />
        ) : (
          <InlineFileBadge key={ref.path} label={ref.label} />
        )
      )}
    </div>
  );
});

export function stripImagePrompt(text: string): string {
  let result = text
    .replace(/<!--JISHU_HUB_IMAGES_BEGIN-->[\s\S]*?<!--JISHU_HUB_IMAGES_END-->/g, "")
    .replace(/<!--JISHU_HUB_IMAGES_BEGIN-->.*?<!--JISHU_HUB_IMAGES_END-->/g, "");
  return result.replace(/\\n/g, "\n").trim();
}
