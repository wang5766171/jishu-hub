import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { invokeCommand } from "@/hooks/use-invoke";
import { Terminal, Package, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { AgentStatus } from "./types";
import { MIN_NODE_VERSION, nodeVersionSatisfies } from "./version-constants";

/** check_environment 返回的 EnvStatus 的精简视图（结构类型兼容完整返回）。 */
interface EnvData {
  node_installed: boolean;
  node_version: string | null;
}

interface InstallAgentDialogProps {
  agent: AgentStatus | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled: () => void;
}

export function InstallAgentDialog({ agent, open, onOpenChange, onInstalled }: InstallAgentDialogProps) {
  const [nodeInstalled, setNodeInstalled] = useState<boolean | null>(null);
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [nativePkgExists, setNativePkgExists] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState<string | null>(null); // 'npm' | 'native'
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (open && agent) {
      setSuccess(false);
      setError(null);
      setInstalling(null);
      
      invokeCommand<EnvData>("check_environment").then((env) => {
        setNodeInstalled(env.node_installed);
        setNodeVersion(env.node_version);
      });
      
      const pkg = agent.install_package_manager ?? "choco";
      invokeCommand<boolean>("check_prerequisite", { command: pkg }).then(setNativePkgExists);
    }
  }, [open, agent]);

  if (!agent) return null;

  const nodeOk =
    nodeInstalled === true && nodeVersionSatisfies(nodeVersion, MIN_NODE_VERSION);
  const nodeTooOld =
    nodeInstalled === true &&
    nodeVersion !== null &&
    !nodeVersionSatisfies(nodeVersion, MIN_NODE_VERSION);

  // Auto-installed agents (e.g. jishu-self) — show a different message
  if (agent.auto_installed) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" />
              {agent.display_name}
            </DialogTitle>
          </DialogHeader>
          <div className="py-6">
            <div className="flex flex-col items-center justify-center py-4 space-y-3 text-center">
              <Package className="h-12 w-12 text-muted-foreground" />
              <div className="space-y-1">
                <p className="font-medium text-lg">Jishu Agent 随应用自动安装</p>
                <p className="text-sm text-muted-foreground">如果检测异常，请重新安装 Jishu Hub 应用</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const handleInstall = async (method: "npm" | "native") => {
    const cmd = method === "npm" ? agent.install_hint : agent.native_install_command;
    if (!cmd) return;

    setInstalling(method);
    setError(null);
    try {
      await invokeCommand("install_agent_command", { command: cmd });
      setSuccess(true);
      setTimeout(() => {
        onInstalled();
        onOpenChange(false);
      }, 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(null);
    }
  };

  const nativePkgName = agent.install_package_manager ?? "choco";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-primary" />
            安装 {agent.display_name}
          </DialogTitle>
        </DialogHeader>
        
        <div className="py-6 space-y-6">
          {success ? (
            <div className="flex flex-col items-center justify-center py-4 space-y-3 text-center">
              <CheckCircle2 className="h-12 w-12 text-[var(--icon-success)] animate-in zoom-in" />
              <div className="space-y-1">
                <p className="font-medium text-lg">安装成功</p>
                <p className="text-sm text-muted-foreground">正在刷新状态...</p>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                {agent.id === "jishu-self" ? (
                  <div className="p-4 rounded-xl border border-border bg-card/50 hover:bg-accent/5 transition-colors space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-blue-500/10 text-blue-500">
                          <Package className="h-4 w-4" />
                        </div>
                        <span className="font-medium">通过本地 Node 环境运行安装</span>
                      </div>
                      {nodeInstalled === false && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> 需要 Node.js
                        </span>
                      )}
                      {nodeTooOld && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Node 版本过低
                        </span>
                      )}
                    </div>
                    {nodeTooOld && (
                      <p className="text-xs text-amber-700 dark:text-amber-300 -mt-1">
                        当前 v{nodeVersion}，Jishu Agent 需要 Node.js ≥ v{MIN_NODE_VERSION}，请升级 Node.js 后重试。
                      </p>
                    )}
                    <code className="block text-[11px] font-mono p-2 bg-muted rounded border text-muted-foreground break-all">
                      npm install && npm run build
                    </code>
                    <Button 
                      className="w-full"
                      variant={nodeOk ? "default" : "outline"}
                      disabled={!!installing || !nodeOk}
                      onClick={() => handleInstall("native")}
                    >
                      {installing === "native" ? <Loader2 className="h-4 w-4 animate-spin" /> : "一键安装"}
                    </Button>
                  </div>
                ) : (
                  <div className="p-4 rounded-xl border border-border bg-card/50 hover:bg-accent/5 transition-colors space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-red-500/10 text-red-500">
                          <Package className="h-4 w-4" />
                        </div>
                        <span className="font-medium">通过 NPM 安装</span>
                      </div>
                      {nodeInstalled === false && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> 需要 Node.js
                        </span>
                      )}
                    </div>
                    <code className="block text-[11px] font-mono p-2 bg-muted rounded border text-muted-foreground break-all">
                      {agent.install_hint}
                    </code>
                    <Button 
                      className="w-full"
                      variant={nodeInstalled ? "default" : "outline"}
                      disabled={!!installing || nodeInstalled === false}
                      onClick={() => handleInstall("npm")}
                    >
                      {installing === "npm" ? <Loader2 className="h-4 w-4 animate-spin" /> : "立即安装"}
                    </Button>
                  </div>
                )}

                {/* Native Method */}
                {agent.native_install_command && agent.id !== "jishu-self" && (
                  <div className="p-4 rounded-xl border border-border bg-card/50 hover:bg-accent/5 transition-colors space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-md bg-blue-500/10 text-blue-500">
                          <Terminal className="h-4 w-4" />
                        </div>
                        <span className="font-medium">通过 {nativePkgName} 安装</span>
                      </div>
                      {nativePkgExists === false && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> 需要 {nativePkgName}
                        </span>
                      )}
                    </div>
                    <code className="block text-[11px] font-mono p-2 bg-muted rounded border text-muted-foreground break-all">
                      {agent.native_install_command}
                    </code>
                    <Button 
                      className="w-full" 
                      variant={nativePkgExists ? "default" : "outline"}
                      disabled={!!installing || nativePkgExists === false}
                      onClick={() => handleInstall("native")}
                    >
                      {installing === "native" ? <Loader2 className="h-4 w-4 animate-spin" /> : "立即安装"}
                    </Button>
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-xs font-mono whitespace-pre-wrap break-all border border-destructive/20 max-h-32 overflow-y-auto">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {!success && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!installing}>
              取消
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
