import { useEffect, useState } from "react";
import { invokeCommand } from "@/hooks/use-invoke";
import { useAgent } from "@/agents";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentStatus } from "@/agents/types";

export function EnvCheckPage({ onComplete }: { onComplete?: () => void }) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<{node_installed: boolean; python_installed: boolean} | null>(null);
  const { agents, refreshHealth } = useAgent();
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<Record<string, string>>({});

  useEffect(() => {
    invokeCommand<any>("check_environment").then(setEnv).catch(console.error);
  }, []);

  const openUrl = (url: string) => {
    invokeCommand("open_url", { url }).catch(console.error);
  };

  const handleInstallAgent = async (agent: AgentStatus) => {
    const cmd = agent.install_hint;
    if (!cmd) return;

    setInstallingId(agent.id);
    setInstallError(prev => ({ ...prev, [agent.id]: "" }));
    
    try {
      await invokeCommand("install_agent_command", { command: cmd });
      // The health check might take a moment, refresh context
      await refreshHealth();
    } catch (err) {
      setInstallError(prev => ({ ...prev, [agent.id]: String(err) }));
    } finally {
      setInstallingId(null);
    }
  };

  const getAgentStatusText = (agent: AgentStatus) => {
    if (agent.health.installed) {
       return agent.health.version ? `v${agent.health.version}` : t("env.installed");
    }
    return t("env.notInstalled");
  };

  if (!env) return <div className="p-8">{t("env.checking")}</div>;

  return (
    <div className="p-8 max-w-2xl mx-auto flex flex-col h-full overflow-y-auto">
      <h1 className="text-2xl font-bold mb-2">{t("env.title")}</h1>
      <p className="text-muted-foreground mb-6">{t("env.desc")}</p>
      
      <div className="space-y-4">
        <div className="flex items-center justify-between p-4 border rounded-lg bg-card">
          <div className="flex items-center gap-3">
            {env.node_installed ? <CheckCircle2 className="text-emerald-500" /> : <XCircle className="text-destructive" />}
            <div>
              <h3 className="font-semibold">{t("env.nodeTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("env.nodeDesc")}</p>
            </div>
          </div>
          {!env.node_installed && (
            <Button onClick={() => openUrl("https://nodejs.org/")}>{t("env.download")}</Button>
          )}
        </div>
        
        <div className="flex items-center justify-between p-4 border rounded-lg bg-card">
          <div className="flex items-center gap-3">
            {env.python_installed ? <CheckCircle2 className="text-emerald-500" /> : <XCircle className="text-destructive" />}
            <div>
              <h3 className="font-semibold">{t("env.pythonTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("env.pythonDesc")}</p>
            </div>
          </div>
          {!env.python_installed && (
            <Button onClick={() => openUrl("https://www.python.org/downloads/")}>{t("env.download")}</Button>
          )}
        </div>

        <h2 className="text-xl font-bold mt-8 mb-4">{t("env.agentsTitle")}</h2>
        {agents.map(agent => (
           <div key={agent.id} className="flex flex-col border rounded-lg mb-4 bg-card overflow-hidden">
             <div className="flex items-center justify-between p-4">
               <div className="flex items-center gap-3">
                 {agent.health.installed ? <CheckCircle2 className="text-emerald-500" /> : <XCircle className="text-destructive" />}
                 <div>
                   <h3 className="font-semibold">{agent.display_name}</h3>
                   <p className="text-sm text-muted-foreground">{getAgentStatusText(agent)}</p>
                 </div>
               </div>
               {!agent.health.installed && (
                 <Button 
                   onClick={() => handleInstallAgent(agent)}
                   disabled={installingId === agent.id}
                   size="sm"
                 >
                   {installingId === agent.id ? (
                     <>
                       <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                       {t("env.installing")}
                     </>
                   ) : t("env.install")}
                 </Button>
               )}
             </div>
             {installError[agent.id] && (
               <div className="px-4 pb-3">
                 <p className="text-[11px] text-destructive bg-destructive/10 p-2 rounded border border-destructive/20 line-clamp-2">
                   {installError[agent.id]}
                 </p>
               </div>
             )}
           </div>
        ))}
      </div>
      
      {onComplete && (
        <Button className="mt-8 w-full" size="lg" onClick={onComplete}>{t("env.enterWorkspace")}</Button>
      )}
    </div>
  );
}
