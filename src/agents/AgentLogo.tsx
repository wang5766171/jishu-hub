import codexAppLogo from "@/assets/agents/codex-color.svg";
import codexLightLogo from "@/assets/agents/codex-light.svg";
import claudeLogo from "@/assets/agents/claude.svg";
import claudeLightLogo from "@/assets/agents/claude-light.svg";
import openCodeLogo from "@/assets/agents/opencode.svg";
import openCodeLightLogo from "@/assets/agents/opencode-light.svg";
import nodeLogo from "@/assets/agents/nodejs.svg";
import nodeLightLogo from "@/assets/agents/nodejs-light.svg";
import npmLogo from "@/assets/agents/npm.svg";
import npmLightLogo from "@/assets/agents/npm-light.svg";
import pythonLogo from "@/assets/agents/python.svg";
import pythonLightLogo from "@/assets/agents/python-light.svg";
import { Bot, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

interface AgentLogoProps {
  agentId: string;
  size?: number;
  className?: string;
}

export function AgentLogo({ agentId, size = 16, className }: AgentLogoProps) {
  const { theme } = useTheme();
  const isLight = theme === "light";
  
  const logo = isLight ? lightAgentLogos[agentId] || agentLogos[agentId] : agentLogos[agentId];

  if (logo) {
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

  // Special case: jishu-self uses Sparkles icon
  if (agentId === "jishu-self") {
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center rounded bg-primary/10 text-primary", className)}
        style={{ width: size, height: size }}
      >
        <Sparkles style={{ width: Math.max(12, size - 4), height: Math.max(12, size - 4) }} />
      </span>
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

const agentLogos: Record<string, { src: string }> = {
  "claude-code": { src: claudeLogo },
  codex: { src: codexAppLogo },
  opencode: { src: openCodeLogo },
};

const lightAgentLogos: Record<string, { src: string }> = {
  "claude-code": { src: claudeLightLogo },
  codex: { src: codexLightLogo },
  opencode: { src: openCodeLightLogo },
};

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
