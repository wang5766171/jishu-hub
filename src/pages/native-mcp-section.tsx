/**
 * 原生 MCP 服务管理区（v0.9.5 需求11 追加三 A）——插件中心「MCP」分类下的
 * 独立区块：管理 `~/.jishu-agent/agent/mcp.json` 的用户原生条目（pi 1.1.0
 * 原生 MCP client 读取；此前只能 `pi mcp add` 或手改 JSON）。
 *
 * 边界（与 Rust commands/native_mcp.rs 同口径）：jishu-hub 聚合条目不在此
 * 显示（由 MCP 解析器启停管理）；项目级 .pi/mcp.json 不介入；OAuth 类服务
 * 只给终端登录指引（GUI 不代做 OAuth 流程）。状态探活经 `jishu mcp list`
 * 子进程（probe=true 时），解析 connected/failed/disabled。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { invokeCommand } from "@/hooks/use-invoke";

interface NativeMcpEntry {
  name: string;
  transport: "http" | "stdio";
  endpoint: string;
  enabled: boolean;
  description: string;
  needs_oauth: boolean;
  status: "connected" | "failed" | "disabled" | "unknown";
}

const STATUS_STYLE: Record<NativeMcpEntry["status"], { cls: string; key: string; fallback: string }> = {
  connected: { cls: "text-[var(--icon-success)]", key: "nativeMcp.connected", fallback: "已连接" },
  failed: { cls: "text-destructive", key: "nativeMcp.failed", fallback: "连接失败" },
  disabled: { cls: "text-muted-foreground", key: "nativeMcp.disabled", fallback: "已停用" },
  unknown: { cls: "text-muted-foreground", key: "nativeMcp.unknown", fallback: "未探测" },
};

export function NativeMcpSection() {
  const { t } = useTranslation();
  const { alert: alertDialog, confirm: confirmDialog, dialogNode } = useConfirmDialog();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const [entries, setEntries] = useState<NativeMcpEntry[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async (probe: boolean) => {
    if (probe) setProbing(true);
    try {
      const list = await invokeCommand<NativeMcpEntry[]>("native_mcp_list", { probe });
      setEntries(list ?? []);
    } catch (err) {
      console.error(err);
      setEntries([]);
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const toggle = async (name: string, enabled: boolean) => {
    setBusyName(name);
    try {
      await invokeCommand("native_mcp_toggle", { name, enabled });
      await load(true);
    } catch (err) {
      console.error(err);
      await alertDialog({ title: tr("nativeMcp.title", "原生 MCP 服务"), description: String(err) });
    } finally {
      setBusyName(null);
    }
  };

  const remove = async (name: string) => {
    const ok = await confirmDialog({
      title: tr("nativeMcp.removeTitle", "删除服务"),
      description: tr("nativeMcp.removeConfirm", "确定删除 {{name}}？jishu 会话下轮不再连接它。").replace("{{name}}", name),
    });
    if (!ok) return;
    setBusyName(name);
    try {
      await invokeCommand("native_mcp_remove", { name });
      await load(false);
    } catch (err) {
      console.error(err);
      await alertDialog({ title: tr("nativeMcp.title", "原生 MCP 服务"), description: String(err) });
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div className="col-span-full rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Server className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{tr("nativeMcp.title", "原生 MCP 服务")}</span>
        <span className="text-[10px] text-muted-foreground">
          {tr("nativeMcp.subtitle", "jishu 直连的 MCP server（pi 原生）；与下方聚合插件互补")}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={probing} onClick={() => void load(true)}>
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {probing ? tr("nativeMcp.probing", "探测中…") : tr("nativeMcp.probe", "探测状态")}
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            {tr("nativeMcp.add", "添加服务")}
          </Button>
        </div>
      </div>
      {entries === null ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {tr("nativeMcp.loading", "读取 mcp.json…")}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {tr("nativeMcp.empty", "暂无原生服务——可经「添加服务」或终端 jishu mcp add 添加（需 OAuth 的服务用终端 jishu mcp login 登录）。")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {entries.map((e) => {
            const st = STATUS_STYLE[e.status];
            return (
              <div key={e.name} className="flex items-center gap-2.5 rounded-md border border-border/40 px-2.5 py-1.5">
                <Switch
                  checked={e.enabled}
                  disabled={busyName === e.name}
                  onCheckedChange={(v) => void toggle(e.name, v)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{e.name}</span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-mono uppercase text-muted-foreground">
                      {e.transport}
                    </span>
                    <span className={`text-[10px] font-medium ${st.cls}`}>{tr(st.key, st.fallback)}</span>
                    {e.needs_oauth && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        {tr("nativeMcp.oauthHint", "OAuth：终端执行 jishu mcp login ")}{e.name}
                      </span>
                    )}
                  </div>
                  <p className="truncate text-[10px] text-muted-foreground" title={e.endpoint}>
                    {e.description || e.endpoint}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  disabled={busyName === e.name}
                  onClick={() => void remove(e.name)}
                  title={tr("nativeMcp.remove", "删除")}
                >
                  {busyName === e.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <AddNativeMcpDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onDone={async () => {
          await load(false);
        }}
      />
      {dialogNode}
    </div>
  );
}

function AddNativeMcpDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { alert: alertDialog } = useConfirmDialog();
  const tr = (key: string, fallback: string) => (t(key) === key ? fallback : t(key));
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const entry: Record<string, unknown> = { description: description || undefined };
      if (transport === "stdio") {
        entry.command = command.trim();
        const argv = args.trim();
        if (argv) entry.args = argv.split(/\s+/);
      } else {
        entry.url = url.trim();
      }
      await invokeCommand("native_mcp_upsert", { name: name.trim(), entry });
      onOpenChange(false);
      setName(""); setCommand(""); setArgs(""); setUrl(""); setDescription("");
      await onDone();
    } catch (err) {
      console.error(err);
      await alertDialog({ title: tr("nativeMcp.title", "原生 MCP 服务"), description: String(err) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tr("nativeMcp.addTitle", "添加原生 MCP 服务")}</DialogTitle>
          <DialogDescription>
            {tr("nativeMcp.addDesc", "写入 ~/.jishu-agent/agent/mcp.json（jishu 会话直连）；需 OAuth 的服务添加后在终端执行 jishu mcp login <名称>。")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button size="sm" variant={transport === "stdio" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setTransport("stdio")}>
              stdio（本地命令）
            </Button>
            <Button size="sm" variant={transport === "http" ? "default" : "outline"} className="h-7 text-xs" onClick={() => setTransport("http")}>
              HTTP（远程）
            </Button>
          </div>
          <Input placeholder={tr("nativeMcp.fName", "名称（字母/数字/_/-）")} value={name} onChange={(e) => setName(e.target.value)} />
          {transport === "stdio" ? (
            <>
              <Input placeholder={tr("nativeMcp.fCommand", "命令，如 npx 或 uvx")} value={command} onChange={(e) => setCommand(e.target.value)} />
              <Input placeholder={tr("nativeMcp.fArgs", "参数（空格分隔），如 -y @modelcontextprotocol/server-filesystem .")} value={args} onChange={(e) => setArgs(e.target.value)} />
            </>
          ) : (
            <Input placeholder={tr("nativeMcp.fUrl", "服务地址，如 https://example.com/mcp")} value={url} onChange={(e) => setUrl(e.target.value)} />
          )}
          <Input placeholder={tr("nativeMcp.fDesc", "描述（可选，一句话说明用途）")} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tr("common.cancel", "取消")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              submitting ||
              !name.trim() ||
              (transport === "stdio" ? !command.trim() : !url.trim())
            }
          >
            {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            {tr("common.add", "添加")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
