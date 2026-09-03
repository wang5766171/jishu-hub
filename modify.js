const fs = require('fs');
const content = import nodeLogo from "@/assets/agents/nodejs.svg";
import nodeLightLogo from "@/assets/agents/nodejs-light.svg";
import npmLogo from "@/assets/agents/npm.svg";
import npmLightLogo from "@/assets/agents/npm-light.svg";
import pythonLogo from "@/assets/agents/python.svg";
import pythonLightLogo from "@/assets/agents/python-light.svg";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { useAgent } from "@/agents/AgentContext";

interface AgentLogoProps {
  agentId: string;
  size?: number;
  className?: string;
}

function getDynamicLogo(path: string | null, isLight: boolean): string | null {
  if (!path) return null;
  try {
    if (isLight) {
      const lightPath = path.replace('.svg', '-light.svg').replace('-color-light.svg', '-light.svg');
      return new URL(\../assets/agents/\\, import.meta.url).href;
    }
    return new URL(\../assets/agents/\\, import.meta.url).href;
  } catch {
    return null;
  }
}

export function AgentLogo({ agentId, size = 16, className }: AgentLogoProps) {
  const { theme } = useTheme();
  const { agents } = useAgent();
  const isLight = theme === "light";
  
  const agent = agents.find((a) => a.id === agentId);
  const logoSrc = agent ? getDynamicLogo(agent.logo_path, isLight) : null;

  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        width={size}
        height={size}
        draggable={false}
        className={cn("shrink-0 object-contain", className)}
        style={{ width: size, height: size }}
        onError={(e) => {
          if (isLight && agent?.logo_path) {
            e.currentTarget.src = new URL(\../assets/agents/\\, import.meta.url).href;
          }
        }}
      />
    );
  }

  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded bg-muted text-muted-foreground", className)}
      style={{ width: size, height: size }}
    >
      <Bot style={{ width: Math.max(12, size - 4), height: Math.max(12, size - 4) }} />
    </span>
  );
}

export function RuntimeLogo({ runtimeId, size = 16, className }: { runtimeId: string; size?: number; className?: string }) {
  const { theme } = useTheme();
  const isLight = theme === "light";
  
  const logo = isLight ? lightRuntimeLogos[runtimeId] || runtimeLogos[runtimeId] : runtimeLogos[runtimeId];

  if (!logo) return <AgentLogo agentId="" size={size} className={className} />;

  return (
    <img
      src={logo.src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}

const runtimeLogos: Record<string, { src: string }> = {
  node: { src: nodeLogo },
  npm: { src: npmLogo },
  python: { src: pythonLogo },
};

const lightRuntimeLogos: Record<string, { src: string }> = {
  node: { src: nodeLightLogo },
  npm: { src: npmLightLogo },
  python: { src: pythonLightLogo },
};
;
fs.writeFileSync('src/agents/AgentLogo.tsx', content);
