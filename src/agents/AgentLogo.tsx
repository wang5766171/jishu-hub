import openAiLogo from "@/assets/agents/openai.svg";
import openAiMono from "@/assets/agents/openai-mono.svg";
import codexAppLogo from "@/assets/agents/codex-color.svg";
import codexMono from "@/assets/agents/codex-mono.svg";
import claudeLogo from "@/assets/agents/claude.svg";
import claudeMono from "@/assets/agents/claude-mono.svg";
import openCodeLogo from "@/assets/agents/opencode.svg";
import openCodeMono from "@/assets/agents/opencode-mono.svg";
import nodeLogo from "@/assets/agents/nodejs.svg";
import nodeMono from "@/assets/agents/nodejs-mono.svg";
import npmLogo from "@/assets/agents/npm.svg";
import npmMono from "@/assets/agents/npm-mono.svg";
import pythonLogo from "@/assets/agents/python.svg";
import pythonMono from "@/assets/agents/python-mono.svg";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

interface AgentLogoProps {
  agentId: string;
  size?: number;
  className?: string;
}

function pickLogo(color: string, mono: string, theme: string) {
  return theme === "light" ? mono : color;
}

export function AgentLogo({ agentId, size = 16, className }: AgentLogoProps) {
  const { theme } = useTheme();
  const entry = agentLogoMap[agentId];
  const src = entry ? pickLogo(entry.color, entry.mono, theme) : null;

  if (src) {
    return (
      <img
        src={src}
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
  const { theme } = useTheme();
  const entry = runtimeLogoMap[runtimeId];

  if (!entry) return <AgentLogo agentId="" size={size} className={className} />;

  const src = pickLogo(entry.color, entry.mono, theme);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}

const agentLogoMap: Record<string, { color: string; mono: string }> = {
  "claude-code": { color: claudeLogo, mono: claudeMono },
  codex: { color: codexAppLogo, mono: codexMono },
  opencode: { color: openCodeLogo, mono: openCodeMono },
};

const runtimeLogoMap: Record<string, { color: string; mono: string }> = {
  node: { color: nodeLogo, mono: nodeMono },
  npm: { color: npmLogo, mono: npmMono },
  python: { color: pythonLogo, mono: pythonMono },
};
