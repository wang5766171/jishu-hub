import openAiLogo from "@/assets/agents/openai.svg";
import codexAppLogo from "@/assets/agents/codex-color.svg";
import claudeLogo from "@/assets/agents/claude.svg";
import openCodeLogo from "@/assets/agents/opencode.svg";
import nodeLogo from "@/assets/agents/nodejs.svg";
import npmLogo from "@/assets/agents/npm.svg";
import pythonLogo from "@/assets/agents/python.svg";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentLogoProps {
  agentId: string;
  size?: number;
  className?: string;
}

export function AgentLogo({ agentId, size = 16, className }: AgentLogoProps) {
  const logo = agentLogos[agentId];

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
  const logo = runtimeLogos[runtimeId];

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

const runtimeLogos: Record<string, { src: string }> = {
  node: { src: nodeLogo },
  npm: { src: npmLogo },
  python: { src: pythonLogo },
};
